import { and, eq, gt, isNull, sql } from "drizzle-orm";
import { hosts, hostSessions, hostTokens } from "@/db/schema";
import type { Deps } from "./deps";
import { hashPassword, hashToken, newToken, verifyAgainstDummy, verifyPassword } from "./passwords";

export const SESSION_COOKIE = "hwe_session";

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128;
const MAX_FAILED_LOGINS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
const VERIFY_TOKEN_MS = 24 * 60 * 60 * 1000;
const RESET_TOKEN_MS = 60 * 60 * 1000;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

async function readBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function normaliseEmail(value: unknown): string | null {
  const email = text(value).trim().toLowerCase();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function passwordProblem(password: string): "password-too-short" | "password-too-long" | null {
  if (password.length < MIN_PASSWORD) return "password-too-short";
  if (password.length > MAX_PASSWORD) return "password-too-long";
  return null;
}

function sessionCookie(deps: Deps, value: string, maxAgeSeconds: number): string {
  const secure = deps.baseUrl.startsWith("https://") ? "; Secure" : "";
  return `${SESSION_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function readSessionToken(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === SESSION_COOKIE && value.length > 0) return value.join("=");
  }
  return null;
}

async function issueToken(deps: Deps, hostId: string, kind: "verify-email" | "reset-password", lifetimeMs: number) {
  const token = newToken();
  await deps.db.insert(hostTokens).values({
    hostId,
    kind,
    tokenHash: hashToken(token),
    expiresAt: new Date(deps.now().getTime() + lifetimeMs),
  });
  return token;
}

/** Marks a one-time token as used and returns whose it was, or null when it is unknown, used, or expired. */
async function consumeToken(deps: Deps, token: string, kind: "verify-email" | "reset-password") {
  const now = deps.now();
  const [row] = await deps.db
    .update(hostTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(hostTokens.tokenHash, hashToken(token)),
        eq(hostTokens.kind, kind),
        isNull(hostTokens.usedAt),
        gt(hostTokens.expiresAt, now),
      ),
    )
    .returning({ hostId: hostTokens.hostId });
  return row?.hostId ?? null;
}

/** The signed-in host for a request, or null when there is no valid session. */
export async function currentHost(deps: Deps, request: Request): Promise<{ id: string; email: string } | null> {
  const token = readSessionToken(request);
  if (!token) return null;
  const [row] = await deps.db
    .select({ id: hosts.id, email: hosts.email })
    .from(hostSessions)
    .innerJoin(hosts, eq(hosts.id, hostSessions.hostId))
    .where(and(eq(hostSessions.tokenHash, hashToken(token)), gt(hostSessions.expiresAt, deps.now())));
  return row ?? null;
}

export async function signUp(deps: Deps, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const email = normaliseEmail(body.email);
  if (!email) return json({ error: "invalid-email" }, 422);
  const password = text(body.password);
  const problem = passwordProblem(password);
  if (problem) return json({ error: problem }, 422);

  // Hash before looking the address up, so a taken address costs the same time as a new one.
  const passwordHash = await hashPassword(password);
  const [created] = await deps.db
    .insert(hosts)
    .values({ email, passwordHash })
    .onConflictDoNothing({ target: hosts.email })
    .returning({ id: hosts.id });

  if (created) {
    const token = await issueToken(deps, created.id, "verify-email", VERIFY_TOKEN_MS);
    await deps.email.send({
      to: email,
      subject: "Verify your email for Hybrid White Elephant",
      text: `Confirm your email address to finish creating your host account:\n\n${deps.baseUrl}/verify-email?token=${token}\n\nThe link works for 24 hours. If you did not sign up, ignore this message.`,
    });
  } else {
    // The same answer goes back either way, so signing up cannot be used to discover who has an account.
    await deps.email.send({
      to: email,
      subject: "You already have a Hybrid White Elephant account",
      text: `Someone tried to sign up with this address, but it already has a host account.\n\nLog in at ${deps.baseUrl}/login, or reset your password at ${deps.baseUrl}/forgot-password if you have forgotten it.`,
    });
  }
  return json({ status: "verification-sent" }, 202);
}

export async function verifyEmail(deps: Deps, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const hostId = await consumeToken(deps, text(body.token), "verify-email");
  if (!hostId) return json({ error: "invalid-token" }, 400);
  await deps.db.update(hosts).set({ emailVerifiedAt: deps.now() }).where(eq(hosts.id, hostId));
  return json({ status: "verified" });
}

/**
 * Counts this attempt before the password is checked, in one atomic statement, so a burst of parallel
 * guesses cannot get past the limit. Returns false while the account is locked. The count is cleared
 * again by a successful login.
 */
async function reserveLoginAttempt(deps: Deps, hostId: string): Promise<boolean> {
  const now = deps.now().toISOString();
  const lockUntil = new Date(deps.now().getTime() + LOCKOUT_MS).toISOString();
  const rows = await deps.db.execute(sql`
    UPDATE hosts SET
      failed_login_count = CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_count + 1 END,
      locked_until = CASE
        WHEN (CASE WHEN locked_until IS NOT NULL THEN 1 ELSE failed_login_count + 1 END) >= ${MAX_FAILED_LOGINS}
        THEN ${lockUntil}::timestamptz
        ELSE NULL
      END
    WHERE id = ${hostId} AND (locked_until IS NULL OR locked_until <= ${now}::timestamptz)
    RETURNING id`);
  return rows.length > 0;
}

export async function logIn(deps: Deps, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const email = normaliseEmail(body.email);
  const password = text(body.password);
  const invalid = () => json({ error: "invalid-credentials" }, 401);

  const [host] = email ? await deps.db.select().from(hosts).where(eq(hosts.email, email)) : [];
  if (!host) {
    await verifyAgainstDummy(password);
    return invalid();
  }

  const now = deps.now();
  if (!(await reserveLoginAttempt(deps, host.id))) {
    const [current] = await deps.db.select({ lockedUntil: hosts.lockedUntil }).from(hosts).where(eq(hosts.id, host.id));
    const until = current?.lockedUntil?.getTime() ?? now.getTime() + LOCKOUT_MS;
    const retryAfter = Math.max(1, Math.ceil((until - now.getTime()) / 1000));
    return json({ error: "too-many-attempts" }, 429, { "retry-after": String(retryAfter) });
  }

  if (!(await verifyPassword(host.passwordHash, password))) return invalid();
  if (!host.emailVerifiedAt) return json({ error: "email-not-verified" }, 403);

  const token = newToken();
  await deps.db.transaction(async (tx) => {
    await tx.update(hosts).set({ failedLoginCount: 0, lockedUntil: null }).where(eq(hosts.id, host.id));
    await tx.insert(hostSessions).values({
      hostId: host.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(now.getTime() + SESSION_MS),
    });
  });
  return json({ id: host.id, email: host.email }, 200, {
    "set-cookie": sessionCookie(deps, token, SESSION_MS / 1000),
  });
}

export async function logOut(deps: Deps, request: Request): Promise<Response> {
  const token = readSessionToken(request);
  if (token) await deps.db.delete(hostSessions).where(eq(hostSessions.tokenHash, hashToken(token)));
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(deps, "", 0) } });
}

export async function requestPasswordReset(deps: Deps, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const email = normaliseEmail(body.email);
  const [host] = email ? await deps.db.select({ id: hosts.id }).from(hosts).where(eq(hosts.email, email)) : [];

  if (email && host) {
    // Only the newest link works.
    await deps.db
      .delete(hostTokens)
      .where(and(eq(hostTokens.hostId, host.id), eq(hostTokens.kind, "reset-password"), isNull(hostTokens.usedAt)));
    const token = await issueToken(deps, host.id, "reset-password", RESET_TOKEN_MS);
    await deps.email.send({
      to: email,
      subject: "Reset your Hybrid White Elephant password",
      text: `Choose a new password here:\n\n${deps.baseUrl}/reset-password?token=${token}\n\nThe link works for one hour. If you did not ask for this, ignore this message.`,
    });
  }
  // Same answer whether or not the address has an account.
  return json({ status: "reset-sent-if-account-exists" }, 202);
}

export async function resetPassword(deps: Deps, request: Request): Promise<Response> {
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const password = text(body.password);
  const problem = passwordProblem(password);
  if (problem) return json({ error: problem }, 422);

  const hostId = await consumeToken(deps, text(body.token), "reset-password");
  if (!hostId) return json({ error: "invalid-token" }, 400);

  const passwordHash = await hashPassword(password);
  await deps.db.transaction(async (tx) => {
    await tx
      .update(hosts)
      .set({
        passwordHash,
        failedLoginCount: 0,
        lockedUntil: null,
        // Following the emailed link proves the host controls the address.
        emailVerifiedAt: sql`coalesce(${hosts.emailVerifiedAt}, ${deps.now().toISOString()}::timestamptz)`,
      })
      .where(eq(hosts.id, hostId));
    await tx.delete(hostSessions).where(eq(hostSessions.hostId, hostId));
  });
  return json({ status: "password-changed" });
}

/** Deletes the signed-in host's account and, through the database cascade, their sessions, tokens and games. */
export async function deleteAccount(deps: Deps, request: Request): Promise<Response> {
  const host = await currentHost(deps, request);
  if (!host) return json({ error: "not-signed-in" }, 401);
  const body = await readBody(request);
  if (!body) return json({ error: "invalid-json" }, 400);

  const [row] = await deps.db.select({ passwordHash: hosts.passwordHash }).from(hosts).where(eq(hosts.id, host.id));
  if (!row || !(await verifyPassword(row.passwordHash, text(body.password)))) {
    return json({ error: "invalid-credentials" }, 401);
  }

  await deps.db.delete(hosts).where(eq(hosts.id, host.id));
  return new Response(null, { status: 204, headers: { "set-cookie": sessionCookie(deps, "", 0) } });
}
