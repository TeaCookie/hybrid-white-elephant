import { inject } from "vitest";
import { FakeEmailSender } from "../src/adapters/fake-email";
import { FakePhotoStorage } from "../src/adapters/fake-photo-storage";
import { createDb } from "../src/db/client";
import type { Deps } from "../src/server/deps";

/** Wires the real database (throwaway, per run) to fake email and photo adapters and a fixed clock. */
export function createTestDeps(now = new Date("2026-12-08T09:00:00Z")) {
  const { db, close } = createDb(inject("testDatabaseUrl"));
  const email = new FakeEmailSender();
  const photos = new FakePhotoStorage();
  const deps: Deps = { db, email, photos, now: () => now };
  return { deps, email, photos, close };
}

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
