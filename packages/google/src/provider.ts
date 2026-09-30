import { createHash, randomBytes } from "node:crypto";

import { FORMAT_GOOGLE, type PassContext, type PassFormatProvider } from "@erc8426/core";

import type { GoogleMessage, GoogleWalletClient } from "./client.js";
import { suffixForSerial } from "./ids.js";
import {
  classIdFor,
  toGoogleClass,
  toGoogleObject,
  type ClassOptions,
  type GoogleObject,
  type GoogleVertical,
} from "./objects.js";

/// The Google format provider. Every acquisition upserts the object through
///  the REST API and mints a short-lived save link that references it by id,
///  so the link stays short and every later PATCH reaches passes already
///  saved: Google pushes object changes to devices itself.

export interface GoogleObjectRecord {
  /// Suffix of the object currently issued for this serial.
  objectSuffix: string;
  vertical: GoogleVertical;
  /// Owner the object was issued to, lowercased.
  owner: string;
  /// Hash of the last object body Google accepted, to skip no-op PATCHes.
  hash?: string;
  /// True once the object was expired as superseded (voided content).
  superseded?: boolean;
}

export interface GoogleObjectStore {
  get(serial: string): Promise<GoogleObjectRecord | null>;
  put(serial: string, record: GoogleObjectRecord): Promise<void>;
  delete(serial: string): Promise<void>;
}

export class MemoryGoogleObjectStore implements GoogleObjectStore {
  private readonly map = new Map<string, GoogleObjectRecord>();
  async get(serial: string) {
    const r = this.map.get(serial);
    return r ? { ...r } : null;
  }
  async put(serial: string, record: GoogleObjectRecord) {
    this.map.set(serial, { ...record });
  }
  async delete(serial: string) {
    this.map.delete(serial);
  }
}

export interface GoogleFormatProviderOptions {
  client: GoogleWalletClient;
  /// One class per collection (or per event, for event tickets).
  classSuffix: string;
  /// Origins allowed to host the save button; see `saveOrigins`.
  origins: string[];
  store?: GoogleObjectStore;
  language?: string;
  unhostedImages?: "throw" | "omit";
  /// Save link lifetime. Defaults to one hour.
  ttlSeconds?: number | null;
  /// Extra class fields, merged over the generated class on first insert.
  classOverrides?: ClassOptions["overrides"];
  redemptionChannel?: ClassOptions["redemptionChannel"];
  /// A notification to attach on notifyUpdate, or null for a silent update.
  messageFor?(ctx: PassContext): GoogleMessage | null;
  /// Shown on a previous owner's object when a transfer supersedes it.
  supersededMessage?: GoogleMessage | null;
  /// When the REST upsert fails, embed the full object in the save link so
  ///  the button still works. Defaults to true. The fallback link is longer
  ///  and does not receive later PATCHes, so onError should alert.
  fatLinkFallback?: boolean;
  /// Non-fatal failures: a superseded object that could not be expired, a
  ///  REST failure that fell back to a fat link, a message that did not send.
  onError?(error: Error, where: string): void;
}

export interface GoogleFormatProvider extends PassFormatProvider {
  readonly format: typeof FORMAT_GOOGLE;
  /// The owner-requested reset, for integrators without the issuer. Every
  ///  saved copy of the serial's current object, a leaked one included, is
  ///  expired and loses its links, and the record is forgotten so the next
  ///  acquisition issues a new object id. (The issuer does this itself: it
  ///  mints a new serial and supersedes the old one, which arrives here as
  ///  voided content and expires the old object the same way.)
  rotate(serial: string): Promise<void>;
  readonly store: GoogleObjectStore;
}

const DEFAULT_SUPERSEDED: GoogleMessage = {
  header: "This pass was replaced",
  body: "A newer pass replaced this one, after the token changed hands or its pass links were reset. This copy no longer shows live links. If you hold the token, add the current pass from the issuer.",
};

function hashOf(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function googleFormatProvider(opts: GoogleFormatProviderOptions): GoogleFormatProvider {
  const client = opts.client;
  const store = opts.store ?? new MemoryGoogleObjectStore();
  const classId = classIdFor({ issuerId: client.issuerId, classSuffix: opts.classSuffix });
  const report = (err: unknown, where: string) =>
    opts.onError?.(err instanceof Error ? err : new Error(String(err)), where);
  let classReady: Promise<void> | null = null;

  /// Create the class on first use and leave an existing one alone: an
  ///  approved class may be customized in the console, and rewriting it can
  ///  send it back to review.
  function ensureClass(ctx: PassContext): Promise<void> {
    if (!classReady) {
      const cls = toGoogleClass(ctx.content, {
        issuerId: client.issuerId,
        classSuffix: opts.classSuffix,
        language: opts.language,
        unhostedImages: opts.unhostedImages,
        overrides: opts.classOverrides,
        redemptionChannel: opts.redemptionChannel,
      });
      classReady = (async () => {
        const type = `${cls.vertical}Class` as const;
        if (await client.get(type, cls.resource.id)) return;
        const r = await client.request("POST", type, cls.resource);
        if (r.status !== 409 && (r.status < 200 || r.status >= 300)) {
          throw new Error(`creating class ${cls.resource.id} failed: ${r.status} ${r.text.slice(0, 300)}`);
        }
      })();
      classReady.catch(() => {
        classReady = null;
      });
    }
    return classReady;
  }

  /// A fresh random object suffix per owner generation. Object ids are
  ///  random rather than derived from the owner, and a new owner gets a new
  ///  object, because a Google object is shared by everyone who saved it:
  ///  patching one object for the new owner would keep the previous owner's
  ///  saved copy live.
  function newSuffix(serial: string): string {
    return `${suffixForSerial(serial)}.${randomBytes(8).toString("hex")}`;
  }

  async function expire(serial: string, record: GoogleObjectRecord): Promise<void> {
    const id = `${client.issuerId}.${record.objectSuffix}`;
    const type = `${record.vertical}Object` as const;
    try {
      await client.patch(type, id, { state: "EXPIRED", linksModuleData: { uris: [] } });
      const msg = opts.supersededMessage === undefined ? DEFAULT_SUPERSEDED : opts.supersededMessage;
      if (msg) await client.addMessage(type, id, msg);
    } catch (err) {
      report(err, `expire superseded object ${id} for ${serial}`);
    }
  }

  async function sync(ctx: PassContext): Promise<{ object: GoogleObject; record: GoogleObjectRecord; ok: boolean }> {
    const serial = ctx.content.serial;
    const owner = ctx.owner.toLowerCase();
    let record = await store.get(serial);
    if (record && record.owner !== owner) {
      await expire(serial, record);
      record = null;
    }
    const object = toGoogleObject(ctx.content, {
      issuerId: client.issuerId,
      classSuffix: opts.classSuffix,
      objectSuffix: record?.objectSuffix ?? newSuffix(serial),
      language: opts.language,
      unhostedImages: opts.unhostedImages,
    });
    // PATCH merges: a field left out keeps its old value on Google's side.
    // So the modules that can carry links or live values are always sent,
    // empty when the content has none, or a superseded object would keep
    // the links it had.
    object.resource.linksModuleData ??= { uris: [] };
    object.resource.textModulesData ??= [];
    // Voided content is a supersede (the issuer voids the old serial when it
    // mints a new one, on transfer or on the owner's rotation). EXPIRED moves
    // every saved copy of this shared object, a leaked one included, out of
    // the active list, and its links are gone with the content's.
    const superseding = Boolean(ctx.content.voided);
    if (superseding) object.resource.state = "EXPIRED";
    const suffix = object.resource.id.slice(client.issuerId.length + 1);
    const hash = hashOf(object.resource);
    const next: GoogleObjectRecord = { objectSuffix: suffix, vertical: object.vertical, owner, hash: record?.hash, superseded: record?.superseded };
    // Record the object id before any network call, so a failed upsert does
    // not mint a different id on the retry.
    if (!record) await store.put(serial, next);
    if (record?.hash === hash) return { object, record: next, ok: true };
    try {
      await ensureClass(ctx);
      await client.upsert(`${object.vertical}Object`, object.resource);
      next.hash = hash;
      const newlySuperseded = superseding && !record?.superseded;
      next.superseded = superseding;
      await store.put(serial, next);
      if (newlySuperseded) {
        const msg = opts.supersededMessage === undefined ? DEFAULT_SUPERSEDED : opts.supersededMessage;
        if (msg) {
          try {
            await client.addMessage(`${object.vertical}Object`, object.resource.id, msg);
          } catch (err) {
            report(err, `superseded message ${object.resource.id}`);
          }
        }
      }
      return { object, record: next, ok: true };
    } catch (err) {
      report(err, `upsert object ${object.resource.id}`);
      return { object, record: next, ok: false };
    }
  }

  return {
    format: FORMAT_GOOGLE,
    store,

    async acquisitionUrl(ctx: PassContext): Promise<string> {
      const { object, ok } = await sync(ctx);
      if (ok) {
        return client.saveUrl({
          origins: opts.origins,
          objectIds: [{ vertical: object.vertical, id: object.resource.id, classId }],
          ttlSeconds: opts.ttlSeconds,
        });
      }
      if (opts.fatLinkFallback === false) throw new Error(`Google object ${object.resource.id} could not be stored`);
      const cls = toGoogleClass(ctx.content, {
        issuerId: client.issuerId,
        classSuffix: opts.classSuffix,
        language: opts.language,
        unhostedImages: opts.unhostedImages,
        overrides: opts.classOverrides,
        redemptionChannel: opts.redemptionChannel,
      });
      return client.saveUrl({ origins: opts.origins, classes: [cls], objects: [object], ttlSeconds: opts.ttlSeconds });
    },

    async notifyUpdate(ctx: PassContext): Promise<void> {
      const { object, ok } = await sync(ctx);
      if (!ok) throw new Error(`Google object ${object.resource.id} could not be updated`);
      const msg = opts.messageFor?.(ctx);
      if (msg) {
        try {
          await client.addMessage(`${object.vertical}Object`, object.resource.id, msg);
        } catch (err) {
          report(err, `addMessage ${object.resource.id}`);
        }
      }
    },

    async rotate(serial: string): Promise<void> {
      const record = await store.get(serial);
      if (!record) return;
      await expire(serial, record);
      await store.delete(serial);
    },
  };
}
