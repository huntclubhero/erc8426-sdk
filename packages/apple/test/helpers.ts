import { generateKeyPairSync } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import forge from "node-forge";

/// Test fixtures generated at runtime. No certificate or key is checked in.

export interface TestCerts {
  wwdr: string;
  signerCert: string;
  signerKey: string;
  /// The signer as a forge certificate, for signature assertions.
  signer: forge.pki.Certificate;
}

function rsaKeys(): { privateKey: forge.pki.rsa.PrivateKey; publicKey: forge.pki.rsa.PublicKey } {
  // node:crypto generates in native code; forge's pure JS keygen is far slower.
  const { privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs1", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  const priv = forge.pki.privateKeyFromPem(privateKey) as forge.pki.rsa.PrivateKey;
  return { privateKey: priv, publicKey: forge.pki.setRsaPublicKey(priv.n, priv.e) };
}

function makeCert(
  subject: forge.pki.CertificateField[],
  keys: { publicKey: forge.pki.rsa.PublicKey },
  issuer: { cn: string; key: forge.pki.rsa.PrivateKey },
  ca: boolean,
  serial: string,
): forge.pki.Certificate {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 24 * 3600_000);
  cert.setSubject(subject);
  cert.setIssuer([{ name: "commonName", value: issuer.cn }]);
  cert.setExtensions([{ name: "basicConstraints", cA: ca }]);
  cert.sign(issuer.key, forge.md.sha256.create());
  return cert;
}

/// The subject Apple puts on a Pass Type ID certificate: the pass type as UID
///  (OID 0.9.2342.19200300.100.1.1), the team as OU. `bare` makes a certificate
///  with a common name only, like a self-signed development certificate.
export function makeTestCerts(o: { passTypeId?: string; teamId?: string; bare?: boolean } = {}): TestCerts {
  const caKeys = rsaKeys();
  const ca = makeCert([{ name: "commonName", value: "Test WWDR" }], caKeys, { cn: "Test WWDR", key: caKeys.privateKey }, true, "01");
  const signerKeys = rsaKeys();
  const passTypeId = o.passTypeId ?? "pass.example.test";
  const subject: forge.pki.CertificateField[] = o.bare
    ? [{ name: "commonName", value: "bare test signer" }]
    : [
        { type: "0.9.2342.19200300.100.1.1", value: passTypeId },
        { name: "commonName", value: `Pass Type ID: ${passTypeId}` },
        { name: "organizationalUnitName", value: o.teamId ?? "TEAM123456" },
        { name: "organizationName", value: "Test Org" },
        { name: "countryName", value: "US" },
      ];
  const signer = makeCert(subject, signerKeys, { cn: "Test WWDR", key: caKeys.privateKey }, false, "02");
  return {
    wwdr: forge.pki.certificateToPem(ca),
    signerCert: forge.pki.certificateToPem(signer),
    signerKey: forge.pki.privateKeyToPem(signerKeys.privateKey),
    signer,
  };
}

/// Self-signed TLS identity for a local HTTP/2 server.
export function makeTlsIdentity(cn = "localhost"): { cert: string; key: string } {
  const keys = rsaKeys();
  const cert = makeCert([{ name: "commonName", value: cn }], keys, { cn, key: keys.privateKey }, false, "03");
  cert.setExtensions([{ name: "subjectAltName", altNames: [{ type: 2, value: "localhost" }, { type: 7, ip: "127.0.0.1" }] }]);
  cert.sign(keys.privateKey, forge.md.sha256.create());
  return { cert: forge.pki.certificateToPem(cert), key: forge.pki.privateKeyToPem(keys.privateKey) };
}

/// Minimal zip reader over the central directory (stored and deflate).
export function unzip(data: Uint8Array): Record<string, Buffer> {
  const buf = Buffer.from(data);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("not a zip");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out: Record<string, Buffer> = {};
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory");
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(localOffset + 26);
    const lExtraLen = buf.readUInt16LE(localOffset + 28);
    const start = localOffset + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + compSize);
    out[name] = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/// A 1x1 transparent PNG, built from its bytes rather than a checked-in file.
export const TINY_PNG = new Uint8Array(
  Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
    "base64",
  ),
);
