import { describe, expect, it } from "vitest";
import {
  decryptEmail,
  emailLookupHash,
  encryptEmail,
  optOutToken,
  verifyOptOutToken,
  type EmailKeys,
} from "./member-crypto";

const keys: EmailKeys = { encryptionKey: Buffer.alloc(32, 1), lookupKey: Buffer.alloc(32, 2) };
const otherKeys: EmailKeys = { encryptionKey: Buffer.alloc(32, 3), lookupKey: Buffer.alloc(32, 4) };

describe("encrypting a member's email", () => {
  it("round-trips and never contains the plaintext", () => {
    const sealed = encryptEmail(keys, "ada@example.com");

    expect(sealed).not.toContain("ada");
    expect(decryptEmail(keys, sealed)).toBe("ada@example.com");
  });

  it("produces a different ciphertext each time for the same address", () => {
    expect(encryptEmail(keys, "ada@example.com")).not.toBe(encryptEmail(keys, "ada@example.com"));
  });

  it("refuses to decrypt with the wrong key or a tampered value", () => {
    const sealed = encryptEmail(keys, "ada@example.com");
    const tampered = sealed.slice(0, -2) + (sealed.endsWith("A") ? "B" : "A") + sealed.slice(-1);

    expect(() => decryptEmail(otherKeys, sealed)).toThrow();
    expect(() => decryptEmail(keys, tampered)).toThrow();
  });
});

describe("the email lookup hash", () => {
  it("is stable for an address, ignoring case, and keyed", () => {
    expect(emailLookupHash(keys, "ada@example.com")).toBe(emailLookupHash(keys, " Ada@Example.com "));
    expect(emailLookupHash(keys, "ada@example.com")).not.toBe(emailLookupHash(keys, "bob@example.com"));
    expect(emailLookupHash(keys, "ada@example.com")).not.toBe(emailLookupHash(otherKeys, "ada@example.com"));
  });

  it("does not contain the address", () => {
    expect(emailLookupHash(keys, "ada@example.com")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("opt-out tokens", () => {
  const memberId = "6f0c3c53-2f5f-4c7e-9a38-0b1f4f7f5a11";

  it("verify for the member and kind they were made for, and only those", () => {
    const token = optOutToken(keys, "stop-emails", memberId);

    expect(verifyOptOutToken(keys, "stop-emails", memberId, token)).toBe(true);
    expect(verifyOptOutToken(keys, "remove-me", memberId, token)).toBe(false);
    expect(verifyOptOutToken(keys, "stop-emails", "6f0c3c53-2f5f-4c7e-9a38-0b1f4f7f5a12", token)).toBe(false);
    expect(verifyOptOutToken(otherKeys, "stop-emails", memberId, token)).toBe(false);
  });

  it("are the same every time, so any email's links keep working", () => {
    expect(optOutToken(keys, "remove-me", memberId)).toBe(optOutToken(keys, "remove-me", memberId));
  });

  it("reject garbage without throwing", () => {
    expect(verifyOptOutToken(keys, "stop-emails", memberId, "")).toBe(false);
    expect(verifyOptOutToken(keys, "stop-emails", memberId, "not-a-token")).toBe(false);
  });
});
