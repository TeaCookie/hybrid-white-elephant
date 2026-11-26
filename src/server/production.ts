import { ResendEmailSender } from "@/adapters/resend-email";
import { createDb } from "@/db/client";
import type { EmailSender } from "@/ports/email";
import type { PhotoStorage } from "@/ports/photo-storage";
import type { Deps } from "./deps";

function notConfigured(what: string): never {
  throw new Error(`${what} adapter is not configured yet`);
}

// The photo adapter (R2 or Vercel Blob) arrives with the first feature that needs it.
const photos: PhotoStorage = {
  put: async () => notConfigured("Photo storage"),
  get: async () => notConfigured("Photo storage"),
  delete: async () => notConfigured("Photo storage"),
};

function productionEmail(): EmailSender {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;
  if (!apiKey || !from) throw new Error("RESEND_API_KEY and EMAIL_FROM must be set");
  return new ResendEmailSender(apiKey, from);
}

/** Origin used in emailed links: APP_URL if set, otherwise the Vercel production domain. */
function productionBaseUrl(): string {
  const explicit = process.env.APP_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (!explicit) throw new Error("APP_URL is not set");
  const origin = explicit.startsWith("http") ? explicit : `https://${explicit}`;
  return origin.replace(/\/+$/, "");
}

let cached: Deps | undefined;

/** Dependencies for the deployed app. The database connection is created once per server instance. */
export function productionDeps(): Deps {
  if (cached) return cached;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");
  // Email and the base URL are read on first use, so the health check needs only DATABASE_URL.
  cached = {
    db: createDb(url).db,
    email: { send: (message) => productionEmail().send(message) },
    photos,
    now: () => new Date(),
    get baseUrl() {
      return productionBaseUrl();
    },
  };
  return cached;
}
