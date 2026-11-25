import { randomBytes } from "node:crypto";
import postgres from "postgres";
import type { TestProject } from "vitest/node";
import { runMigrations } from "../src/db/migrate";

/**
 * Creates a throwaway database for the HTTP-boundary tests, migrates it, and
 * drops it afterwards. Point TEST_DATABASE_ADMIN_URL at any Postgres you may
 * create databases on; the default matches the CI service and a local dev server.
 */
const adminUrl =
  process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";

export default async function setup(project: TestProject) {
  const name = `hwe_test_${randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl, { max: 1 });
  await admin.unsafe(`CREATE DATABASE ${name}`);

  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  await runMigrations(url.toString());

  project.provide("testDatabaseUrl", url.toString());

  return async () => {
    await admin.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
    await admin.end();
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    testDatabaseUrl: string;
  }
}
