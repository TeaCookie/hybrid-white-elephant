import { asc, eq, sql } from "drizzle-orm";
import { decide, deriveBoard, type GameEvent } from "@/engine";
import { gameEvents, games } from "@/db/schema";
import type { Deps } from "./deps";

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

async function loadHistory(deps: Deps, gameId: string): Promise<GameEvent[]> {
  const rows = await deps.db
    .select({ payload: gameEvents.payload })
    .from(gameEvents)
    .where(eq(gameEvents.gameId, gameId))
    .orderBy(asc(gameEvents.seq));
  return rows.map((r) => r.payload as GameEvent);
}

/**
 * Not routed yet: the route that calls this with the signed-in host arrives with game creation.
 * The handler exists now so the engine, event log and database are exercised end to end.
 */
export async function createGame(deps: Deps, hostId: string, request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid-json" }, 400);
  }
  const candidate = (body as { name?: unknown } | null)?.name;
  const name = typeof candidate === "string" ? candidate : "";

  const decision = decide({
    history: [],
    command: { type: "CreateGame", name },
    version: 0,
    actor: { memberId: hostId, role: "host" },
    now: deps.now(),
  });
  if (!decision.ok) return json({ error: decision.reason }, 422);

  const id = await deps.db.transaction(async (tx) => {
    const [game] = await tx.insert(games).values({ hostId }).returning({ id: games.id });
    if (!game) throw new Error("game insert returned no row");
    await tx.insert(gameEvents).values(
      decision.events.map((event, index) => ({
        gameId: game.id,
        seq: index + 1,
        type: event.type,
        payload: event,
      })),
    );
    return game.id;
  });

  return json({ id, board: deriveBoard(decision.events) }, 201);
}

/** Not routed yet: reading a game needs a signed-in member, which arrives with invites. */
export async function getGame(deps: Deps, id: string): Promise<Response> {
  if (!UUID.test(id)) return json({ error: "not-found" }, 404);
  const history = await loadHistory(deps, id);
  if (history.length === 0) return json({ error: "not-found" }, 404);
  return json({ id, board: deriveBoard(history) });
}
