import type { PassContent, SupersededReason } from "@erc8426/core";

import { randomToken } from "./util.js";

/// Persistence for the Apple side: one record per pass serial, and the device
///  registrations the PassKit web service collects. The interfaces are small
///  so a SQL or KV implementation is a page of code; the in-memory one is for
///  tests and single-process demos.

export interface ApplePassRecord {
  serial: string;
  /// The current per-pass secret. Embedded in the pass and presented by the
  ///  device as `ApplePass <token>`.
  authenticationToken: string;
  /// Tokens retired by a transfer or an owner-requested reset. A device still
  ///  holding one may refresh (and receives the superseded rendering) and may
  ///  unregister, but may never register a new device.
  retiredAuthenticationTokens: string[];
  /// Why each retired token was retired, index-aligned with
  ///  `retiredAuthenticationTokens` (null when unknown). Optional so records
  ///  written before it existed still load; they render the generic wording.
  retiredReasons?: Array<SupersededReason | null>;
  /// Owner the current token was issued to, lowercased. A different owner on
  ///  the next acquisition is a transfer and rotates the token.
  owner?: string;
  /// Drives `Last-Modified`, 304s and the updated-serials list.
  updatedAt: Date;
  /// The latest content, when the format provider manages it.
  content?: PassContent;
}

export interface PassRecordStore {
  getPass(serial: string): Promise<ApplePassRecord | null>;
  putPass(record: ApplePassRecord): Promise<void>;
}

export interface DeviceRegistration {
  deviceLibraryIdentifier: string;
  passTypeIdentifier: string;
  serial: string;
  pushToken: string;
}

export interface DeviceRegistrationStore {
  /// Upsert. Returns true when the (device, pass type, serial) triple was new,
  ///  which is Apple's 201 versus 200.
  register(registration: DeviceRegistration): Promise<boolean>;
  unregister(deviceLibraryIdentifier: string, passTypeIdentifier: string, serial: string): Promise<void>;
  serialsForDevice(deviceLibraryIdentifier: string, passTypeIdentifier: string): Promise<string[]>;
  pushTokensForSerial(passTypeIdentifier: string, serial: string): Promise<string[]>;
  /// Drop every registration carrying this push token. Called on APNs 410
  ///  (the device removed the pass or the app) so it is never pushed again.
  removePushToken(pushToken: string): Promise<void>;
}

export interface ApplePassStore extends PassRecordStore, DeviceRegistrationStore {}

export class MemoryApplePassStore implements ApplePassStore {
  private readonly passes = new Map<string, ApplePassRecord>();
  private readonly registrations = new Map<string, DeviceRegistration>();

  private static key(device: string, passType: string, serial: string): string {
    return JSON.stringify([device, passType, serial]);
  }

  async getPass(serial: string): Promise<ApplePassRecord | null> {
    const r = this.passes.get(serial);
    return r ? { ...r, retiredAuthenticationTokens: [...r.retiredAuthenticationTokens], ...(r.retiredReasons ? { retiredReasons: [...r.retiredReasons] } : {}) } : null;
  }

  async putPass(record: ApplePassRecord): Promise<void> {
    this.passes.set(record.serial, {
      ...record,
      retiredAuthenticationTokens: [...record.retiredAuthenticationTokens],
      ...(record.retiredReasons ? { retiredReasons: [...record.retiredReasons] } : {}),
    });
  }

  async register(r: DeviceRegistration): Promise<boolean> {
    const k = MemoryApplePassStore.key(r.deviceLibraryIdentifier, r.passTypeIdentifier, r.serial);
    const created = !this.registrations.has(k);
    this.registrations.set(k, { ...r });
    return created;
  }

  async unregister(device: string, passType: string, serial: string): Promise<void> {
    this.registrations.delete(MemoryApplePassStore.key(device, passType, serial));
  }

  async serialsForDevice(device: string, passType: string): Promise<string[]> {
    const out = new Set<string>();
    for (const r of this.registrations.values()) {
      if (r.deviceLibraryIdentifier === device && r.passTypeIdentifier === passType) out.add(r.serial);
    }
    return [...out];
  }

  async pushTokensForSerial(passType: string, serial: string): Promise<string[]> {
    const out = new Set<string>();
    for (const r of this.registrations.values()) {
      if (r.passTypeIdentifier === passType && r.serial === serial) out.add(r.pushToken);
    }
    return [...out];
  }

  async removePushToken(pushToken: string): Promise<void> {
    for (const [k, r] of this.registrations) if (r.pushToken === pushToken) this.registrations.delete(k);
  }
}

/// Create the record for a new serial with a fresh random token.
export function newPassRecord(serial: string, owner?: string): ApplePassRecord {
  return {
    serial,
    authenticationToken: randomToken(),
    retiredAuthenticationTokens: [],
    ...(owner ? { owner: owner.toLowerCase() } : {}),
    updatedAt: new Date(),
  };
}

/// How many retired tokens a record keeps. Each one is a device that may
///  still refresh into the superseded rendering; older ones fall off and
///  those devices simply stop updating.
export const MAX_RETIRED_TOKENS = 16;

/// Rotate a pass's token: the current one is retired, a fresh one issued.
///  `reason` is remembered for the retired token so its superseded rendering
///  can say why; it defaults to "transfer" when a new owner is given.
///  Returns the updated record; the caller persists it.
export function rotatedRecord(record: ApplePassRecord, newOwner?: string, reason?: SupersededReason): ApplePassRecord {
  const why = reason ?? (newOwner ? "transfer" : null);
  // Align an older record's reasons (or none) with its tokens before adding.
  const reasons = record.retiredAuthenticationTokens.map((_, i) => record.retiredReasons?.[i] ?? null);
  return {
    ...record,
    authenticationToken: randomToken(),
    retiredAuthenticationTokens: [record.authenticationToken, ...record.retiredAuthenticationTokens].slice(0, MAX_RETIRED_TOKENS),
    retiredReasons: [why, ...reasons].slice(0, MAX_RETIRED_TOKENS),
    owner: newOwner ? newOwner.toLowerCase() : record.owner,
    updatedAt: new Date(),
  };
}

/// Why a retired token was retired, or undefined when the token is not
///  retired or the record does not know.
export function retiredReasonFor(record: ApplePassRecord, token: string): SupersededReason | undefined {
  const i = record.retiredAuthenticationTokens.indexOf(token);
  return i < 0 ? undefined : (record.retiredReasons?.[i] ?? undefined);
}
