import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { createTestDeps, jsonRequest } from "../../tests/support";
import { createGame, getGame, health } from "./handlers";

const { deps, close } = createTestDeps();

beforeEach(async () => {
  await deps.db.execute(sql`TRUNCATE games CASCADE`);
});

afterAll(() => close());

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const response = await health(deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("creating and reading a game", () => {
  it("creates a game and returns its board", async () => {
    const created = await createGame(deps, jsonRequest("/api/games", "POST", { name: "Office exchange" }));

    expect(created.status).toBe(201);
    const { id, board } = await created.json();
    expect(board).toEqual({ created: true, name: "Office exchange", version: 1 });

    const fetched = await getGame(deps, id);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ id, board });
  });

  it("rejects a blank name without storing anything", async () => {
    const response = await createGame(deps, jsonRequest("/api/games", "POST", { name: "  " }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "name-required" });
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(0);
  });

  it("rejects a body that is not valid JSON", async () => {
    const request = new Request("http://localhost/api/games", { method: "POST", body: "not json" });

    const response = await createGame(deps, request);

    expect(response.status).toBe(400);
  });

  it("returns 404 for a game that does not exist", async () => {
    const response = await getGame(deps, "00000000-0000-0000-0000-000000000000");

    expect(response.status).toBe(404);
  });

  it("returns 404 for an id that is not a UUID", async () => {
    const response = await getGame(deps, "nope");

    expect(response.status).toBe(404);
  });

  it("keeps the event log append-only: the created event is stored with its sequence number", async () => {
    const created = await createGame(deps, jsonRequest("/api/games", "POST", { name: "Office exchange" }));
    const { id } = await created.json();

    const rows = await deps.db.execute(sql`SELECT seq, type FROM game_events WHERE game_id = ${id}`);

    expect(rows.map((r) => ({ seq: r.seq, type: r.type }))).toEqual([{ seq: 1, type: "GameCreated" }]);
  });
});
