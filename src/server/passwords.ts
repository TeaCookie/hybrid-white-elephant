import { hash, verify } from "@node-rs/argon2";
import { createHash, randomBytes } from "node:crypto";

/** OWASP's minimum argon2id configuration: 19 MiB of memory, 2 passes, 1 lane. */
const OPTIONS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

/** Hashes a password with argon2id. The result embeds its own salt and parameters. */
export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

/** True when the password matches the stored hash. A malformed hash never matches. */
export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real check, so that "no such account" and "wrong password"
 * cannot be told apart by how long the login takes.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  dummyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(await dummyHash, password);
}

/** A fresh unguessable token to put in a link or cookie. Only its hash is stored. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
