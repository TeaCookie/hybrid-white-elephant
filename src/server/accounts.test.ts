import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDeps, jsonRequest } from "../../tests/support";
import {
  currentHost,
  deleteAccount,
  logIn,
  logOut,
  requestPasswordReset,
  resetPassword,
  signUp,
  verifyEmail,
} from "./accounts";
import { createGame } from "./handlers";

const { deps, email, close } = createTestDeps();
const START = new Date("2026-12-08T09:00:00Z");
let clock = START;
deps.now = () => clock;

const EMAIL = "host@example.com";
const PASSWORD = "correct horse battery staple";

beforeEach(async () => {
  clock = START;
  email.reset();
  await deps.db.execute(sql`TRUNCATE hosts CASCADE`);
});

afterAll(() => close());

function tokenFromLastEmail(): string {
  const last = email.sent.at(-1);
  const match = last?.text.match(/token=([A-Za-z0-9_-]+)/);
  if (!match?.[1]) throw new Error("no token link in the last email");
  return match[1];
}

function withCookie(request: Request, cookie: string): Request {
  request.headers.set("cookie", cookie);
  return request;
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie");
  if (!header) throw new Error("no cookie set");
  return header.split(";")[0] ?? "";
}

async function signUpAndVerify(address = EMAIL, password = PASSWORD) {
  await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: address, password }));
  await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token: tokenFromLastEmail() }));
}

async function login(password = PASSWORD, address = EMAIL) {
  return logIn(deps, jsonRequest("/api/auth/login", "POST", { email: address, password }));
}

describe("signing up", () => {
  it("creates an unverified account and emails a verification link", async () => {
    const response = await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));

    expect(response.status).toBe(202);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.to).toBe(EMAIL);
    expect(email.sent[0]?.text).toContain("http://localhost:3000/verify-email?token=");
    const rows = await deps.db.execute(sql`SELECT email_verified_at FROM hosts`);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.email_verified_at).toBeNull();
  });

  it("stores only an argon2id hash, never the password", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));

    const rows = await deps.db.execute(sql`SELECT password_hash FROM hosts`);
    const hash = String(rows[0]?.password_hash);
    expect(hash).toMatch(/^\$argon2id\$/);
    expect(hash).not.toContain(PASSWORD);
    const everything = await deps.db.execute(sql`SELECT row_to_json(h)::text AS j FROM hosts h`);
    expect(String(everything[0]?.j)).not.toContain(PASSWORD);
  });

  it("treats the email case-insensitively", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: "  Host@Example.COM ", password: PASSWORD }));

    const rows = await deps.db.execute(sql`SELECT email FROM hosts`);
    expect(rows[0]?.email).toBe("host@example.com");
  });

  it("rejects an invalid email or a short password", async () => {
    const badEmail = await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: "nope", password: PASSWORD }));
    const shortPassword = await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: "short" }));

    expect(badEmail.status).toBe(422);
    expect(await badEmail.json()).toEqual({ error: "invalid-email" });
    expect(shortPassword.status).toBe(422);
    expect(await shortPassword.json()).toEqual({ error: "password-too-short" });
    expect(email.sent).toHaveLength(0);
  });

  it("answers the same for an address that is already registered, without creating a second account", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));
    email.reset();

    const again = await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: "another password!" }));

    expect(again.status).toBe(202);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM hosts`);
    expect(rows[0]?.n).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0]?.text).not.toContain("token=");
  });
});

describe("verifying the email address", () => {
  it("marks the account verified", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));

    const response = await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token: tokenFromLastEmail() }));

    expect(response.status).toBe(200);
    const rows = await deps.db.execute(sql`SELECT email_verified_at FROM hosts`);
    expect(rows[0]?.email_verified_at).not.toBeNull();
  });

  it("rejects an unknown token", async () => {
    const response = await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token: "bogus" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid-token" });
  });

  it("rejects a token that was already used", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));
    const token = tokenFromLastEmail();
    await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token }));

    const second = await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token }));

    expect(second.status).toBe(400);
  });

  it("rejects an expired token", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));
    const token = tokenFromLastEmail();
    clock = new Date(START.getTime() + 25 * 60 * 60 * 1000);

    const response = await verifyEmail(deps, jsonRequest("/api/auth/verify-email", "POST", { token }));

    expect(response.status).toBe(400);
  });
});

describe("logging in", () => {
  it("starts a session for a verified host", async () => {
    await signUpAndVerify();

    const response = await login();

    expect(response.status).toBe(200);
    const cookie = response.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
    const host = await currentHost(deps, withCookie(new Request("http://localhost/api/account"), cookieFrom(response)));
    expect(host?.email).toBe(EMAIL);
  });

  it("does not store the session token itself", async () => {
    await signUpAndVerify();
    const response = await login();

    const token = cookieFrom(response).split("=")[1] ?? "";
    const rows = await deps.db.execute(sql`SELECT token_hash FROM host_sessions`);
    expect(token.length).toBeGreaterThan(20);
    expect(JSON.stringify(rows)).not.toContain(token);
  });

  it("refuses a wrong password and an unknown email with the same answer", async () => {
    await signUpAndVerify();

    const wrongPassword = await login("not the password");
    const unknown = await login(PASSWORD, "nobody@example.com");

    expect(wrongPassword.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrongPassword.json()).toEqual(await unknown.json());
  });

  it("refuses a host who has not verified their email", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));

    const response = await login();

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "email-not-verified" });
  });

  it("locks the account after five failed attempts, even for the right password", async () => {
    await signUpAndVerify();
    for (let i = 0; i < 5; i++) {
      expect((await login("wrong password")).status).toBe(401);
    }

    const locked = await login();

    expect(locked.status).toBe(429);
    expect(await locked.json()).toEqual({ error: "too-many-attempts" });
    expect(locked.headers.get("retry-after")).toBe("900");
  });

  it("lets the host back in once the lockout has passed", async () => {
    await signUpAndVerify();
    for (let i = 0; i < 5; i++) await login("wrong password");
    clock = new Date(START.getTime() + 15 * 60 * 1000 + 1000);

    const response = await login();

    expect(response.status).toBe(200);
  });

  it("forgets earlier failures after a successful login", async () => {
    await signUpAndVerify();
    for (let i = 0; i < 4; i++) await login("wrong password");
    await login();

    for (let i = 0; i < 4; i++) expect((await login("wrong password")).status).toBe(401);
  });

  it("logging out ends the session", async () => {
    await signUpAndVerify();
    const cookie = cookieFrom(await login());

    const response = await logOut(deps, withCookie(jsonRequest("/api/auth/logout", "POST"), cookie));

    expect(response.status).toBe(204);
    expect(await currentHost(deps, withCookie(new Request("http://localhost/api/account"), cookie))).toBeNull();
  });

  it("does not accept an expired session", async () => {
    await signUpAndVerify();
    const cookie = cookieFrom(await login());
    clock = new Date(START.getTime() + 31 * 24 * 60 * 60 * 1000);

    expect(await currentHost(deps, withCookie(new Request("http://localhost/api/account"), cookie))).toBeNull();
  });
});

describe("resetting a forgotten password", () => {
  it("emails a link, and the new password works while the old one does not", async () => {
    await signUpAndVerify();
    email.reset();

    const asked = await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: EMAIL }));
    expect(asked.status).toBe(202);
    expect(email.sent[0]?.text).toContain("http://localhost:3000/reset-password?token=");

    const reset = await resetPassword(
      deps,
      jsonRequest("/api/auth/reset-password", "POST", { token: tokenFromLastEmail(), password: "a brand new password" }),
    );
    expect(reset.status).toBe(200);
    expect((await login()).status).toBe(401);
    expect((await login("a brand new password")).status).toBe(200);
  });

  it("answers the same, and sends nothing, for an unknown address", async () => {
    const response = await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: "nobody@example.com" }));

    expect(response.status).toBe(202);
    expect(email.sent).toHaveLength(0);
  });

  it("signs the host out everywhere and clears a lockout", async () => {
    await signUpAndVerify();
    const cookie = cookieFrom(await login());
    for (let i = 0; i < 5; i++) await login("wrong password");
    await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: EMAIL }));

    await resetPassword(
      deps,
      jsonRequest("/api/auth/reset-password", "POST", { token: tokenFromLastEmail(), password: "a brand new password" }),
    );

    expect(await currentHost(deps, withCookie(new Request("http://localhost/api/account"), cookie))).toBeNull();
    expect((await login("a brand new password")).status).toBe(200);
  });

  it("stores the new password as an argon2id hash", async () => {
    await signUpAndVerify();
    await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: EMAIL }));
    await resetPassword(
      deps,
      jsonRequest("/api/auth/reset-password", "POST", { token: tokenFromLastEmail(), password: "a brand new password" }),
    );

    const rows = await deps.db.execute(sql`SELECT password_hash FROM hosts`);
    expect(String(rows[0]?.password_hash)).toMatch(/^\$argon2id\$/);
    expect(String(rows[0]?.password_hash)).not.toContain("brand new");
  });

  it("accepts a reset token only once and not after it expires", async () => {
    await signUpAndVerify();
    await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: EMAIL }));
    const token = tokenFromLastEmail();
    const body = { token, password: "a brand new password" };

    expect((await resetPassword(deps, jsonRequest("/api/auth/reset-password", "POST", body))).status).toBe(200);
    expect((await resetPassword(deps, jsonRequest("/api/auth/reset-password", "POST", body))).status).toBe(400);

    await requestPasswordReset(deps, jsonRequest("/api/auth/forgot-password", "POST", { email: EMAIL }));
    const stale = tokenFromLastEmail();
    clock = new Date(START.getTime() + 2 * 60 * 60 * 1000);
    expect(
      (await resetPassword(deps, jsonRequest("/api/auth/reset-password", "POST", { token: stale, password: "yet another password" }))).status,
    ).toBe(400);
  });

  it("does not let a verification token reset a password", async () => {
    await signUp(deps, jsonRequest("/api/auth/signup", "POST", { email: EMAIL, password: PASSWORD }));

    const response = await resetPassword(
      deps,
      jsonRequest("/api/auth/reset-password", "POST", { token: tokenFromLastEmail(), password: "a brand new password" }),
    );

    expect(response.status).toBe(400);
  });
});

describe("deleting an account", () => {
  async function loggedInCookie() {
    await signUpAndVerify();
    return cookieFrom(await login());
  }

  it("removes the host, their sessions, and all their games", async () => {
    const cookie = await loggedInCookie();
    const host = await currentHost(deps, withCookie(new Request("http://localhost/api/account"), cookie));
    await createGame(deps, host!.id, jsonRequest("/api/games", "POST", { name: "Office exchange" }));
    await createGame(deps, host!.id, jsonRequest("/api/games", "POST", { name: "Second exchange" }));

    const response = await deleteAccount(deps, withCookie(jsonRequest("/api/account", "DELETE", { password: PASSWORD }), cookie));

    expect(response.status).toBe(204);
    for (const table of ["hosts", "host_sessions", "host_tokens", "games", "game_events"]) {
      const rows = await deps.db.execute(sql.raw(`SELECT count(*)::int AS n FROM ${table}`));
      expect(rows[0]?.n, table).toBe(0);
    }
  });

  it("leaves other hosts and their games alone", async () => {
    const cookie = await loggedInCookie();
    await signUpAndVerify("other@example.com", "other host password");
    const otherCookie = cookieFrom(await login("other host password", "other@example.com"));
    const other = await currentHost(deps, withCookie(new Request("http://localhost/api/account"), otherCookie));
    await createGame(deps, other!.id, jsonRequest("/api/games", "POST", { name: "Other exchange" }));

    await deleteAccount(deps, withCookie(jsonRequest("/api/account", "DELETE", { password: PASSWORD }), cookie));

    const games = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    const hosts = await deps.db.execute(sql`SELECT count(*)::int AS n FROM hosts`);
    expect(games[0]?.n).toBe(1);
    expect(hosts[0]?.n).toBe(1);
  });

  it("requires the current password", async () => {
    const cookie = await loggedInCookie();

    const response = await deleteAccount(deps, withCookie(jsonRequest("/api/account", "DELETE", { password: "wrong" }), cookie));

    expect(response.status).toBe(401);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM hosts`);
    expect(rows[0]?.n).toBe(1);
  });

  it("requires a signed-in host", async () => {
    const response = await deleteAccount(deps, jsonRequest("/api/account", "DELETE", { password: PASSWORD }));

    expect(response.status).toBe(401);
  });
});
