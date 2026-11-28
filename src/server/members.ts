import { and, asc, eq, gt, isNotNull, isNull, sql } from "drizzle-orm";
import { decide, deriveBoard } from "@/engine";
import { gameEvents, games, memberInvites, members, memberSessions } from "@/db/schema";
import { normaliseEmail } from "./accounts";
import type { Deps } from "./deps";
import { loadHistory, rejection } from "./handlers";
import { decryptEmail, emailLookupHash, encryptEmail, verifyOptOutToken, type OptOutKind } from "./member-crypto";
import { sendToMember } from "./member-mail";
import { hashToken, newToken } from "./passwords";

const MAX_INVITES_PER_REQUEST = 50;
const INVITE_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DISPLAY_NAME = 40;

export const MEMBER_COOKIE = "hwe_member";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200, headers?: HeadersInit): Response {
  return Response.json(body, { status, headers });
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

export type InviteStatus = "invited" | "resent" | "already-joined" | "emails-stopped" | "invalid";

/**
 * The host invites players by email. They must confirm they have permission to invite these people.
 * Each address gets one seat; inviting an unclaimed address again sends a fresh link, which replaces the old one.
 */
export async function inviteMembers(deps: Deps, hostId: string, gameId: string, request: Request): Promise<Response> {
  if (!UUID.test(gameId)) return json({ error: "not-found" }, 404);
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  if (body.permissionToInvite !== true) return json({ error: "permission-required" }, 422);
  const emails = body.emails;
  if (!Array.isArray(emails) || emails.length === 0 || emails.length > MAX_INVITES_PER_REQUEST) {
    return json({ error: "invalid-emails" }, 422);
  }
  if (body.plays !== undefined && typeof body.plays !== "boolean") return json({ error: "invalid-plays" }, 422);
  const plays = body.plays ?? true;

  const [game] = await deps.db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.id, gameId), eq(games.hostId, hostId), isNull(games.endedAt)));
  if (!game) return json({ error: "not-found" }, 404);
  const gameName = deriveBoard(await loadHistory(deps.db, gameId)).name ?? "a white elephant exchange";

  const results: { email: string; status: InviteStatus }[] = [];
  const seen = new Set<string>();
  for (const raw of emails) {
    const address = normaliseEmail(raw);
    if (!address) {
      results.push({ email: typeof raw === "string" ? raw : "", status: "invalid" });
      continue;
    }
    if (seen.has(address)) continue;
    seen.add(address);

    const emailHash = emailLookupHash(deps.emailKeys, address);
    const [created] = await deps.db
      .insert(members)
      .values({ gameId, emailCiphertext: encryptEmail(deps.emailKeys, address), emailHash, plays })
      .onConflictDoNothing({ target: [members.gameId, members.emailHash] })
      .returning();
    const [member] = created
      ? [created]
      : await deps.db.select().from(members).where(and(eq(members.gameId, gameId), eq(members.emailHash, emailHash)));
    if (!member) throw new Error("member lookup returned no row");

    if (member.claimedAt) {
      results.push({ email: address, status: "already-joined" });
      continue;
    }
    if (member.emailsStoppedAt) {
      results.push({ email: address, status: "emails-stopped" });
      continue;
    }

    const token = newToken();
    await deps.db.transaction(async (tx) => {
      // Only the newest link works.
      await tx.delete(memberInvites).where(and(eq(memberInvites.memberId, member.id), isNull(memberInvites.usedAt)));
      await tx.insert(memberInvites).values({
        memberId: member.id,
        tokenHash: hashToken(token),
        expiresAt: new Date(deps.now().getTime() + INVITE_MS),
      });
    });
    await sendToMember(
      deps,
      member,
      `You are invited to ${gameName}`,
      `You have been invited to take part in a white elephant gift exchange, "${gameName}".\n\nOpen this link and choose Continue to take your seat:\n\n${deps.baseUrl}/invite?token=${token}\n\nThe link works once, for 14 days.`,
    );
    results.push({ email: address, status: created ? "invited" : "resent" });
  }
  return json({ results });
}

function memberCookie(deps: Deps, value: string, maxAgeSeconds: number): string {
  const secure = deps.baseUrl.startsWith("https://") ? "; Secure" : "";
  return `${MEMBER_COOKIE}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSeconds}${secure}`;
}

function readMemberToken(request: Request): string | null {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [name, ...value] = part.trim().split("=");
    if (name === MEMBER_COOKIE && value.length > 0) return value.join("=");
  }
  return null;
}

export type CurrentMember = {
  id: string;
  gameId: string;
  displayName: string | null;
  plays: boolean;
};

/** The member a request's session cookie belongs to, or null when there is none, it expired, or the seat was removed. */
export async function currentMember(deps: Deps, request: Request): Promise<CurrentMember | null> {
  const token = readMemberToken(request);
  if (!token) return null;
  const [row] = await deps.db
    .select({ id: members.id, gameId: members.gameId, displayName: members.displayName, plays: members.plays })
    .from(memberSessions)
    .innerJoin(members, eq(members.id, memberSessions.memberId))
    .where(
      and(
        eq(memberSessions.tokenHash, hashToken(token)),
        gt(memberSessions.expiresAt, deps.now()),
        isNull(members.removedAt),
      ),
    );
  return row ?? null;
}

/** What the invite screen shows before Continue. Reading it changes nothing, so link scanners cannot burn the invite. */
export async function previewInvite(deps: Deps, request: Request): Promise<Response> {
  const token = new URL(request.url).searchParams.get("token") ?? "";
  const [row] = await deps.db
    .select({ gameId: members.gameId })
    .from(memberInvites)
    .innerJoin(members, eq(members.id, memberInvites.memberId))
    .where(
      and(
        eq(memberInvites.tokenHash, hashToken(token)),
        isNull(memberInvites.usedAt),
        gt(memberInvites.expiresAt, deps.now()),
        isNull(members.removedAt),
      ),
    );
  if (!row) return json({ error: "invalid-token" }, 404);
  const board = deriveBoard(await loadHistory(deps.db, row.gameId));
  return json({ gameName: board.name });
}

/** Continue: uses up the invite, claims the seat and starts a long-lived session. */
export async function claimInvite(deps: Deps, request: Request): Promise<Response> {
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const token = typeof body.token === "string" ? body.token : "";
  const now = deps.now();
  const sessionToken = newToken();

  const memberId = await deps.db.transaction(async (tx) => {
    const [invite] = await tx
      .update(memberInvites)
      .set({ usedAt: now })
      .where(
        and(
          eq(memberInvites.tokenHash, hashToken(token)),
          isNull(memberInvites.usedAt),
          gt(memberInvites.expiresAt, now),
        ),
      )
      .returning({ memberId: memberInvites.memberId });
    if (!invite) return null;
    const [member] = await tx
      .update(members)
      .set({ claimedAt: sql`coalesce(${members.claimedAt}, ${now.toISOString()}::timestamptz)` })
      .where(and(eq(members.id, invite.memberId), isNull(members.removedAt)))
      .returning({ id: members.id });
    if (!member) return null;
    await tx.insert(memberSessions).values({
      memberId: member.id,
      tokenHash: hashToken(sessionToken),
      expiresAt: new Date(now.getTime() + SESSION_MS),
    });
    return member.id;
  });
  if (!memberId) return json({ error: "invalid-token" }, 400);

  const [member] = await deps.db.select({ displayName: members.displayName }).from(members).where(eq(members.id, memberId));
  return json({ memberId, needsDisplayName: member?.displayName == null }, 200, {
    "set-cookie": memberCookie(deps, sessionToken, SESSION_MS / 1000),
  });
}

/** Tidies a display name: trimmed, inner whitespace collapsed. Null when it is empty, too long or has control characters. */
function cleanDisplayName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  // Checked before whitespace is collapsed, so a newline or tab is refused rather than quietly turned into a space.
  if (/\p{C}/u.test(trimmed)) return null;
  const name = trimmed.replace(/\s+/g, " ");
  if (name === "" || [...name].length > MAX_DISPLAY_NAME) return null;
  return name;
}

function isUniqueViolation(error: unknown): boolean {
  for (let e: unknown = error; e instanceof Error; e = (e as { cause?: unknown }).cause) {
    if ((e as { code?: unknown }).code === "23505") return true;
  }
  return false;
}

/** Chooses the signed-in member's display name. Names are unique within a game, ignoring case. */
export async function setDisplayName(deps: Deps, request: Request): Promise<Response> {
  const member = await currentMember(deps, request);
  if (!member) return json({ error: "not-signed-in" }, 401);
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const displayName = cleanDisplayName(body.displayName);
  if (!displayName) return json({ error: "invalid-display-name" }, 422);

  try {
    await deps.db
      .update(members)
      .set({ displayName, displayNameKey: displayName.normalize("NFKC").toLowerCase() })
      .where(eq(members.id, member.id));
  } catch (error) {
    if (isUniqueViolation(error)) return json({ error: "display-name-taken" }, 409);
    throw error;
  }
  return json({ displayName });
}

/** The signed-in member's own view: the game board and who else has taken a seat, by display name only. Never an email. */
export async function getMe(deps: Deps, request: Request): Promise<Response> {
  const me = await currentMember(deps, request);
  if (!me) return json({ error: "not-signed-in" }, 401);
  const board = deriveBoard(await loadHistory(deps.db, me.gameId));
  const roster = await deps.db
    .select({ id: members.id, displayName: members.displayName, plays: members.plays })
    .from(members)
    .where(and(eq(members.gameId, me.gameId), isNull(members.removedAt), isNotNull(members.displayName)))
    .orderBy(asc(members.createdAt), asc(members.id));
  return json({
    memberId: me.id,
    displayName: me.displayName,
    plays: me.plays,
    helper: board.helpers.includes(me.id),
    game: { id: me.gameId, board },
    members: roster.map((m) => ({ ...m, helper: board.helpers.includes(m.id) })),
  });
}

const OPT_OUT_KINDS: readonly OptOutKind[] = ["stop-emails", "remove-me"];

/**
 * Both opt-out links in every email end here, after the member confirms on the page the link opens
 * (the link itself changes nothing, so mail scanners cannot trigger it). The token is derived from the member's id,
 * so a link from any email, old or new, works.
 */
export async function optOut(deps: Deps, request: Request): Promise<Response> {
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const memberId = typeof body.member === "string" ? body.member : "";
  const kind = OPT_OUT_KINDS.find((k) => k === body.kind);
  const token = typeof body.token === "string" ? body.token : "";
  if (!UUID.test(memberId) || !kind || !verifyOptOutToken(deps.emailKeys, kind, memberId, token)) {
    return json({ error: "invalid-link" }, 400);
  }

  const now = deps.now().toISOString();
  const found = await deps.db.transaction(async (tx) => {
    if (kind === "stop-emails") {
      const rows = await tx
        .update(members)
        .set({ emailsStoppedAt: sql`coalesce(${members.emailsStoppedAt}, ${now}::timestamptz)` })
        .where(eq(members.id, memberId))
        .returning({ id: members.id });
      return rows.length > 0;
    }
    const rows = await tx
      .update(members)
      .set({
        emailCiphertext: null,
        emailHash: null,
        displayName: null,
        displayNameKey: null,
        removedAt: sql`coalesce(${members.removedAt}, ${now}::timestamptz)`,
      })
      .where(eq(members.id, memberId))
      .returning({ id: members.id });
    await tx.delete(memberSessions).where(eq(memberSessions.memberId, memberId));
    await tx.delete(memberInvites).where(eq(memberInvites.memberId, memberId));
    return rows.length > 0;
  });
  if (!found) return json({ error: "invalid-link" }, 400);
  return json({ status: kind === "stop-emails" ? "emails-stopped" : "removed" });
}

/** Every seat in the game with its email address. The host is the only one who can ask for this. */
export async function listMembers(deps: Deps, hostId: string, gameId: string): Promise<Response> {
  if (!UUID.test(gameId)) return json({ error: "not-found" }, 404);
  const [game] = await deps.db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.id, gameId), eq(games.hostId, hostId)));
  if (!game) return json({ error: "not-found" }, 404);

  const board = deriveBoard(await loadHistory(deps.db, gameId));
  const rows = await deps.db
    .select()
    .from(members)
    .where(and(eq(members.gameId, gameId), isNull(members.removedAt)))
    .orderBy(asc(members.createdAt), asc(members.id));
  return json({
    members: rows.map((m) => ({
      id: m.id,
      email: m.emailCiphertext ? decryptEmail(deps.emailKeys, m.emailCiphertext) : null,
      displayName: m.displayName,
      plays: m.plays,
      helper: board.helpers.includes(m.id),
      claimed: m.claimedAt !== null,
      emailsStopped: m.emailsStoppedAt !== null,
    })),
  });
}

/**
 * The host appoints a helper: any member of the game, playing or not, at any point in the game.
 * The host sends the game version they were looking at, as with every change to a game.
 */
export async function appointHelper(deps: Deps, hostId: string, gameId: string, request: Request): Promise<Response> {
  if (!UUID.test(gameId)) return json({ error: "not-found" }, 404);
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return json({ error: "invalid-version" }, 400);
  }
  const memberId = typeof body.memberId === "string" ? body.memberId : "";

  const outcome = await deps.db.transaction(async (tx) => {
    // Locking the game's row makes changes to one game take turns, so each sees the last one's events.
    const [game] = await tx
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.hostId, hostId)))
      .for("update");
    if (!game) return { kind: "not-found" } as const;
    if (!UUID.test(memberId)) return { kind: "unknown-member" } as const;
    const [member] = await tx
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.id, memberId), eq(members.gameId, gameId), isNull(members.removedAt)));
    if (!member) return { kind: "unknown-member" } as const;

    const history = await loadHistory(tx, gameId);
    const decision = decide({
      history,
      command: { type: "AppointHelper", memberId },
      version,
      actor: { memberId: hostId, role: "host" },
      now: deps.now(),
    });
    if (!decision.ok) return { kind: "rejected", decision } as const;
    await tx.insert(gameEvents).values(
      decision.events.map((event, index) => ({
        gameId,
        seq: history.length + index + 1,
        type: event.type,
        payload: event,
      })),
    );
    return { kind: "saved", board: deriveBoard([...history, ...decision.events]) } as const;
  });

  switch (outcome.kind) {
    case "not-found":
      return json({ error: "not-found" }, 404);
    case "unknown-member":
      return json({ error: "unknown-member" }, 422);
    case "rejected":
      return rejection(outcome.decision);
    case "saved":
      return json({ id: gameId, board: outcome.board });
  }
}
