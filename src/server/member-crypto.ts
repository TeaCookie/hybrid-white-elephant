import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Two separate secrets: one encrypts addresses, the other makes the keyed lookup hash and opt-out tokens. */
export type EmailKeys = { encryptionKey: Buffer; lookupKey: Buffer };

export type OptOutKind = "stop-emails" | "remove-me";

const IV_BYTES = 12;
const TAG_BYTES = 16;

function clean(email: string): string {
  return email.trim().toLowerCase();
}

/** Encrypts an address with AES-256-GCM. The result is base64url of iv, tag and ciphertext. */
export function encryptEmail(keys: EmailKeys, email: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.encryptionKey, iv);
  const body = Buffer.concat([cipher.update(clean(email), "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}

/** Decrypts a stored address. Throws if the key is wrong or the value was altered. */
export function decryptEmail(keys: EmailKeys, sealed: string): string {
  const raw = Buffer.from(sealed, "base64url");
  if (raw.length <= IV_BYTES + TAG_BYTES) throw new Error("sealed email is malformed");
  const decipher = createDecipheriv("aes-256-gcm", keys.encryptionKey, raw.subarray(0, IV_BYTES));
  decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString("utf8");
}

function mac(keys: EmailKeys, purpose: string, value: string): Buffer {
  return createHmac("sha256", keys.lookupKey).update(`${purpose}:${value}`).digest();
}

/** Keyed hash used to find a member by address (and to stop the same address being invited twice) without storing it. */
export function emailLookupHash(keys: EmailKeys, email: string): string {
  return mac(keys, "email", clean(email)).toString("hex");
}

/**
 * The token in a member's opt-out links. It is derived, not stored, so it is the same in every
 * email that member receives and keeps working for as long as the seat exists.
 */
export function optOutToken(keys: EmailKeys, kind: OptOutKind, memberId: string): string {
  return mac(keys, `optout:${kind}`, memberId).toString("base64url");
}

export function verifyOptOutToken(keys: EmailKeys, kind: OptOutKind, memberId: string, token: string): boolean {
  const expected = mac(keys, `optout:${kind}`, memberId);
  const given = Buffer.from(token, "base64url");
  return given.length === expected.length && timingSafeEqual(given, expected);
}
