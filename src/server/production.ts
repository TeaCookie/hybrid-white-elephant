import { createDb } from "@/db/client";
import type { EmailSender } from "@/ports/email";
import type { PhotoStorage } from "@/ports/photo-storage";
import type { Deps } from "./deps";

function notConfigured(what: string): never {
  throw new Error(`${what} adapter is not configured yet`);
}

// Real adapters (Resend, R2 or Vercel Blob) arrive with the first features that need them.
const email: EmailSender = { send: async () => notConfigured("Email") };
const photos: PhotoStorage = {
  put: async () => notConfigured("Photo storage"),
  get: async () => notConfigured("Photo storage"),
  delete: async () => notConfigured("Photo storage"),
};

let cached: Deps | undefined;

/** Dependencies for the deployed app. The database connection is created once per server instance. */
export function productionDeps(): Deps {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  cached = { db: createDb(url).db, email, photos, now: () => new Date() };
  return cached;
}
