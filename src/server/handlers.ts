import { and, asc, count, eq, isNull, sql } from "drizzle-orm";
import { decide, deriveBoard, type Board, type Command, type Decision, type GameEvent, type Rules } from "@/engine";
import type { Db } from "@/db/client";
import { gameEvents, games, hosts } from "@/db/schema";
import type { Deps } from "./deps";

/** A host may have this many games running at once. A game that has ended no longer counts. */
export const MAX_ACTIVE_GAMES = 3;

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status });
}

/**
 * Summarises an error for logs using only its name and code. The message is left out on purpose:
 * driver errors can echo connection strings or other secrets.
 */
export function describeError(error: unknown): { name: string; code?: string } {
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, ...(typeof code === "string" ? { code } : {}) };
  }
  return { name: "UnknownError" };
}

export async function health(deps: Deps): Promise<Response> {
  try {
    await deps.db.execute(sql`SELECT 1`);
    return json({ status: "ok" });
  } catch (error) {
    console.error("health: database check failed", describeError(error));
    return json({ status: "error" }, 503);
  }
}

async function loadHistory(db: Pick<Transaction, "select">, gameId: string): Promise<GameEvent[]> {
  const rows = await db
    .select({ payload: gameEvents.payload })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(gameEvents.seq));
  return rows.map((r) => r.payload as GameEvent);
}

async function readObject(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await request.json();
    return body !== null && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** A rejected decision as an HTTP response: a stale version is a conflict that carries the latest board. */
function rejection(decision: Extract<Decision, { ok: false }>): Response {
  if (decision.reason === "stale-version") return json({ error: decision.reason, board: decision.board }, 409);
  return json({ error: decision.reason }, 422);
}

/**
 * Creates a game for a signed-in host. The host must have a verified email address and
 * may have at most three active games; both are checked with the host's row locked, so
 * games created at the same moment cannot slip past the limit.
 */
export async function createGame(deps: Deps, hostId: string, request: Request): Promise<Response> {
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const name = typeof body.name === "string" ? body.name : "";
  if (body.rules !== undefined && !isPlainObject(body.rules)) return json({ error: "invalid-rules" }, 422);

  const decision = decide({
    history: [],
    command: { type: "CreateGame", name, rules: body.rules as Partial<Rules> | undefined },
    version: 0,
    actor: { memberId: hostId, role: "host" },
    now: deps.now(),
  });
  if (!decision.ok) return rejection(decision);
  const events = decision.events;

  const outcome = await deps.db.transaction(async (tx) => {
    const [host] = await tx
      .select({ verifiedAt: hosts.emailVerifiedAt })
      .from(hosts)
      .where(eq(hosts.id, hostId))
      .for("update");
    if (!host) return { kind: "not-signed-in" } as const;
    if (!host.verifiedAt) return { kind: "unverified" } as const;

    const [active] = await tx
      .select({ n: count() })
      .from(games)
      .where(and(eq(games.hostId, hostId), isNull(games.endedAt)));
    if ((active?.n ?? 0) >= MAX_ACTIVE_GAMES) return { kind: "too-many" } as const;

    const [game] = await tx.insert(games).values({ hostId }).returning({ id: games.id });
    if (!game) throw new Error("game insert returned no row");
    await tx.insert(gameEvents).values(
      events.map((event, index) => ({ gameId: game.id, seq: index + 1, type: event.type, payload: event })),
    );
    return { kind: "created", id: game.id } as const;
  });

  switch (outcome.kind) {
    case "not-signed-in":
      return json({ error: "not-signed-in" }, 401);
    case "unverified":
      return json({ error: "email-not-verified" }, 403);
    case "too-many":
      return json({ error: "too-many-active-games" }, 409);
    case "created":
      return json({ id: outcome.id, board: deriveBoard(events) }, 201);
  }
}

/**
 * Saves a change to a game's rules as the next numbered rule version. The host sends the
 * game version they were looking at; if the game has moved on, the latest board comes back instead.
 */
export async function updateRules(deps: Deps, hostId: string, gameId: string, request: Request): Promise<Response> {
  if (!UUID.test(gameId)) return json({ error: "not-found" }, 404);
  const body = await readObject(request);
  if (!body) return json({ error: "invalid-json" }, 400);
  const version = body.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
    return json({ error: "invalid-version" }, 400);
  }
  if (!isPlainObject(body.changes)) return json({ error: "invalid-rules" }, 422);
  const changes = body.changes as Extract<Command, { type: "UpdateRules" }>["changes"];

  const outcome = await deps.db.transaction(async (tx) => {
    // Locking the game's row makes edits to one game take turns, so each sees the last one's events.
    const [game] = await tx
      .select({ id: games.id })
      .from(games)
      .where(and(eq(games.id, gameId), eq(games.hostId, hostId)))
      .for("update");
    if (!game) return { kind: "not-found" } as const;

    const history = await loadHistory(tx, gameId);
    const decision = decide({
      history,
      command: { type: "UpdateRules", changes },
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
    case "rejected":
      return rejection(outcome.decision);
    case "saved":
      return json({ id: gameId, board: outcome.board });
  }
}

/** The signed-in host's own games, oldest first. `active` games count toward the limit of three. */
export async function listGames(deps: Deps, hostId: string): Promise<Response> {
  const rows = await deps.db
    .select({ id: games.id, endedAt: games.endedAt, createdAt: games.createdAt })
    .from(games)
    .where(eq(games.hostId, hostId))
    .orderBy(asc(games.createdAt), asc(games.id));

  const listed = await Promise.all(
    rows.map(async (row) => {
      const board: Board = deriveBoard(await loadHistory(deps.db, row.id));
      return {
        id: row.id,
        name: board.name,
        active: row.endedAt === null,
        createdAt: row.createdAt.toISOString(),
      };
    }),
  );
  return json({ games: listed });
}

/** A game's board for its own host. Another host's game looks the same as one that does not exist. */
export async function getHostGame(deps: Deps, hostId: string, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "not-found" }, 404);
  const [game] = await deps.db
    .select({ id: games.id })
    .from(games)
    .where(and(eq(games.id, id), eq(games.hostId, hostId)));
  if (!game) return json({ error: "not-found" }, 404);
  const history = await loadHistory(deps.db, id);
  return json({ id, board: deriveBoard(history) });
}

/** Not routed yet: reading a game needs a signed-in member, which arrives with invites. */
export async function getGame(deps: Deps, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "not-found" }, 404);
  const history = await loadHistory(deps.db, id);
  if (history.length === 0) return json({ error: "not-found" }, 404);
  return json({ id, board: deriveBoard(history) });
}
