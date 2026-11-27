import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { DEFAULT_RULES } from "@/engine";
import { gameEvents, games, hosts } from "@/db/schema";
import { createTestDeps, jsonRequest } from "../../tests/support";
import { createGame, getGame, getHostGame, health, listGames, updateRules } from "./handlers";

const { deps, close } = createTestDeps();
let hostId: string;

beforeEach(async () => {
  await deps.db.execute(sql`TRUNCATE hosts CASCADE`);
  hostId = await insertHost("host@example.com");
});

async function insertHost(email: string, verified = true): Promise<string> {
  const [host] = await deps.db
    .insert(hosts)
    .values({ email, passwordHash: "unused", emailVerifiedAt: verified ? new Date() : null })
    .returning({ id: hosts.id });
  return host!.id;
}

async function create(name = "Office exchange", rules?: unknown, host = hostId) {
  return createGame(deps, host, jsonRequest("/api/games", "POST", rules === undefined ? { name } : { name, rules }));
}

async function createdId(name?: string, rules?: unknown, host = hostId): Promise<string> {
  const response = await create(name, rules, host);
  expect(response.status).toBe(201);
  return (await response.json()).id;
}

async function edit(id: string, version: number, changes: unknown, host = hostId) {
  return updateRules(deps, host, id, jsonRequest(`/api/games/${id}/rules`, "POST", { version, changes }));
}

afterAll(() => close());

describe("GET /api/health", () => {
  it("reports ok when the database answers", async () => {
    const response = await health(deps);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
  });
});

describe("GET /api/health when the database is unreachable", () => {
  it("reports an error and logs only the error name and code, never its message", async () => {
    const failing = Object.assign(new Error("connect failed for postgres://user:secret@host/db"), {
      code: "ECONNREFUSED",
    });
    const brokenDeps = { ...deps, db: { execute: async () => Promise.reject(failing) } as unknown as typeof deps.db };
    const logged: unknown[][] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => void logged.push(args));

    const response = await health(brokenDeps);
    spy.mockRestore();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "error" });
    expect(JSON.stringify(logged)).toContain("ECONNREFUSED");
    expect(JSON.stringify(logged)).not.toContain("secret");
  });
});

describe("creating and reading a game", () => {
  it("creates a game and returns its board", async () => {
    const created = await createGame(deps, hostId, jsonRequest("/api/games", "POST", { name: "Office exchange" }));

    expect(created.status).toBe(201);
    const { id, board } = await created.json();
    expect(board).toMatchObject({
      created: true,
      name: "Office exchange",
      version: 1,
      helpers: [],
      turnHolder: null,
      rules: DEFAULT_RULES,
      ruleVersion: 1,
    });

    const fetched = await getGame(deps, id);
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toEqual({ id, board });
  });

  it("rejects a blank name without storing anything", async () => {
    const response = await createGame(deps, hostId, jsonRequest("/api/games", "POST", { name: "  " }));

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "name-required" });
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(0);
  });

  it("rejects a body that is not valid JSON", async () => {
    const request = new Request("http://localhost/api/games", { method: "POST", body: "not json" });

    const response = await createGame(deps, hostId, request);

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
    const created = await createGame(deps, hostId, jsonRequest("/api/games", "POST", { name: "Office exchange" }));
    const { id } = await created.json();

    const rows = await deps.db.execute(sql`SELECT seq, type FROM game_events WHERE game_id = ${id}`);

    expect(rows.map((r) => ({ seq: r.seq, type: r.type }))).toEqual([{ seq: 1, type: "GameCreated" }]);
  });
});


describe("creating a game with rules", () => {
  it("saves the rules the host sets as rule version 1, with the rest left at the defaults", async () => {
    const rules = {
      stealLimit: 2,
      immediateStealBack: true,
      maxStealsPerChain: 4,
      finalSwapPercent: 25,
      timezone: "America/Vancouver",
      workingDays: [1, 2, 3, 4],
      workingHours: { start: "08:30", end: "16:30" },
      reminderTime: "08:00",
      deadlineWorkingDays: 2,
    };

    const response = await create("Office exchange", rules);

    expect(response.status).toBe(201);
    const { board } = await response.json();
    expect(board.rules).toEqual({ ...DEFAULT_RULES, ...rules });
    expect(board.ruleVersion).toBe(1);
  });

  it("gives a new game a one-working-day deadline unless the host says otherwise", async () => {
    const { board } = await (await create()).json();

    expect(board.rules.deadlineWorkingDays).toBe(1);
  });

  it("makes the final-swap percentage visible from the start, to anyone who can read the game", async () => {
    const id = await createdId("Office exchange", { finalSwapPercent: 30 });

    const fetched = await (await getGame(deps, id)).json();

    expect(fetched.board.rules.finalSwapPercent).toBe(30);
  });

  it("rejects an invalid rule, naming it, and stores nothing", async () => {
    const response = await create("Office exchange", { stealLimit: 0 });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid-steal-limit" });
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(0);
  });

  it("rejects rules that are not an object", async () => {
    const response = await create("Office exchange", "strict");

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid-rules" });
  });

  it("ignores rule names it does not know", async () => {
    const { board } = await (await create("Office exchange", { stealLimit: 2, hostIsKing: true })).json();

    expect(board.rules).toEqual({ ...DEFAULT_RULES, stealLimit: 2 });
  });

  it("stores the rules inside the GameCreated event, as the start of the log", async () => {
    const id = await createdId("Office exchange", { stealLimit: 2 });

    const [event] = await deps.db.select({ payload: gameEvents.payload }).from(gameEvents);

    expect(event?.payload).toMatchObject({ type: "GameCreated", rules: { ...DEFAULT_RULES, stealLimit: 2 } });
    expect(id).toBeTruthy();
  });

  it("refuses a host whose email is not verified, and stores nothing", async () => {
    const unverified = await insertHost("new@example.com", false);

    const response = await create("Office exchange", undefined, unverified);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "email-not-verified" });
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(0);
  });

  it("refuses a host id that does not exist", async () => {
    const response = await create("Office exchange", undefined, "00000000-0000-0000-0000-000000000000");

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "not-signed-in" });
  });
});

describe("the limit of three active games", () => {
  it("refuses a fourth active game and stores nothing for it", async () => {
    for (const name of ["One", "Two", "Three"]) await createdId(name);

    const response = await create("Four");

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "too-many-active-games" });
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(3);
    const events = await deps.db.execute(sql`SELECT count(*)::int AS n FROM game_events`);
    expect(events[0]?.n).toBe(3);
  });

  it("lets the host start another once a game has ended", async () => {
    const first = await createdId("One");
    for (const name of ["Two", "Three"]) await createdId(name);
    await deps.db.update(games).set({ endedAt: new Date() }).where(sql`${games.id} = ${first}`);

    const response = await create("Four");

    expect(response.status).toBe(201);
  });

  it("holds the line when games are created at the same moment", async () => {
    const responses = await Promise.all(Array.from({ length: 6 }, (_, i) => create(`Game ${i}`)));

    const statuses = responses.map((r) => r.status).sort();
    expect(statuses).toEqual([201, 201, 201, 409, 409, 409]);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM games`);
    expect(rows[0]?.n).toBe(3);
  });

  it("counts each host's games separately", async () => {
    const other = await insertHost("other@example.com");
    for (const name of ["One", "Two", "Three"]) await createdId(name);

    const response = await create("Theirs", undefined, other);

    expect(response.status).toBe(201);
  });

  it("lets a host run a second, separate game with its own rules and log", async () => {
    const first = await createdId("Marketing", { stealLimit: 2 });
    const second = await createdId("Engineering", { stealLimit: 5 });

    expect((await edit(first, 1, { earlyLocking: true })).status).toBe(200);

    const a = await (await getHostGame(deps, hostId, first)).json();
    const b = await (await getHostGame(deps, hostId, second)).json();
    expect(a.board).toMatchObject({ name: "Marketing", version: 2, ruleVersion: 2 });
    expect(a.board.rules).toMatchObject({ stealLimit: 2, earlyLocking: true });
    expect(b.board).toMatchObject({ name: "Engineering", version: 1, ruleVersion: 1 });
    expect(b.board.rules).toMatchObject({ stealLimit: 5, earlyLocking: false });
  });
});

describe("listing the host's games", () => {
  it("lists only this host's games, newest last", async () => {
    const other = await insertHost("other@example.com");
    const a = await createdId("One");
    const b = await createdId("Two");
    await createdId("Theirs", undefined, other);

    const response = await listGames(deps, hostId);

    expect(response.status).toBe(200);
    const { games: listed } = await response.json();
    expect(listed.map((g: { id: string; name: string }) => [g.id, g.name])).toEqual([
      [a, "One"],
      [b, "Two"],
    ]);
  });

  it("marks ended games so the host can see which count toward the limit", async () => {
    const id = await createdId("One");
    await deps.db.update(games).set({ endedAt: new Date() }).where(sql`${games.id} = ${id}`);

    const { games: listed } = await (await listGames(deps, hostId)).json();

    expect(listed[0]).toMatchObject({ id, active: false });
  });
});

describe("reading a game as its host", () => {
  it("returns the board", async () => {
    const id = await createdId();

    const response = await getHostGame(deps, hostId, id);

    expect(response.status).toBe(200);
    expect((await response.json()).board.name).toBe("Office exchange");
  });

  it("hides another host's game as if it did not exist", async () => {
    const id = await createdId();
    const other = await insertHost("other@example.com");

    expect((await getHostGame(deps, other, id)).status).toBe(404);
  });

  it("returns 404 for an id that is not a UUID", async () => {
    expect((await getHostGame(deps, hostId, "nope")).status).toBe(404);
  });
});

describe("editing the rules", () => {
  it("saves a change as the next numbered rule version and returns the new board", async () => {
    const id = await createdId();

    const response = await edit(id, 1, { stealLimit: 2 });

    expect(response.status).toBe(200);
    const { board } = await response.json();
    expect(board).toMatchObject({ version: 2, ruleVersion: 2 });
    expect(board.rules.stealLimit).toBe(2);
    expect(board.ruleVersions.map((v: { version: number }) => v.version)).toEqual([1, 2]);
  });

  it("appends to the log without touching what was there: earlier rules stay as they were played", async () => {
    const id = await createdId();
    await edit(id, 1, { stealLimit: 2 });
    await edit(id, 2, { stealLimit: 4 });

    const rows = await deps.db.execute(sql`SELECT seq, type, payload FROM game_events WHERE game_id = ${id} ORDER BY seq`);

    expect(rows.map((r) => [r.seq, r.type])).toEqual([
      [1, "GameCreated"],
      [2, "RulesChanged"],
      [3, "RulesChanged"],
    ]);
    expect((rows[0]?.payload as { rules: { stealLimit: number } }).rules.stealLimit).toBe(3);
    expect((rows[1]?.payload as { rules: { stealLimit: number } }).rules.stealLimit).toBe(2);
    expect((rows[2]?.payload as { rules: { stealLimit: number } }).rules.stealLimit).toBe(4);
  });

  it("rejects a change based on a stale version with the latest board, and stores nothing", async () => {
    const id = await createdId();
    await edit(id, 1, { stealLimit: 2 });

    const response = await edit(id, 1, { stealLimit: 5 });

    expect(response.status).toBe(409);
    const body = await response.json();
    expect(body.error).toBe("stale-version");
    expect(body.board).toMatchObject({ version: 2, ruleVersion: 2 });
    expect(body.board.rules.stealLimit).toBe(2);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM game_events WHERE game_id = ${id}`);
    expect(rows[0]?.n).toBe(2);
  });

  it("lets only one of two simultaneous edits from the same version through", async () => {
    const id = await createdId();

    const responses = await Promise.all([edit(id, 1, { stealLimit: 2 }), edit(id, 1, { stealLimit: 4 })]);

    expect(responses.map((r) => r.status).sort()).toEqual([200, 409]);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM game_events WHERE game_id = ${id}`);
    expect(rows[0]?.n).toBe(2);
  });

  it("rejects an invalid rule, naming it", async () => {
    const id = await createdId();

    const response = await edit(id, 1, { timezone: "Mars/Olympus" });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "invalid-timezone" });
  });

  it("rejects a change that changes nothing, so no empty version is saved", async () => {
    const id = await createdId();

    const response = await edit(id, 1, { stealLimit: DEFAULT_RULES.stealLimit });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: "no-changes" });
  });

  it("freezes the final-swap percentage once the last regular turn has begun, but not other rules", async () => {
    const id = await createdId("Office exchange", { finalSwapPercent: 20 });
    await deps.db.insert(gameEvents).values({
      gameId: id,
      seq: 2,
      type: "LastRegularTurnStarted",
      payload: { type: "LastRegularTurnStarted", memberId: "player-9", at: deps.now().toISOString() },
    });

    const refused = await edit(id, 2, { finalSwapPercent: 50 });
    const allowed = await edit(id, 2, { stealLimit: 2 });

    expect(refused.status).toBe(422);
    expect(await refused.json()).toEqual({ error: "final-swap-frozen" });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).board.rules).toMatchObject({ finalSwapPercent: 20, stealLimit: 2 });
  });

  it("answers 404 for another host's game and changes nothing", async () => {
    const id = await createdId();
    const other = await insertHost("other@example.com");

    const response = await edit(id, 1, { stealLimit: 2 }, other);

    expect(response.status).toBe(404);
    const rows = await deps.db.execute(sql`SELECT count(*)::int AS n FROM game_events WHERE game_id = ${id}`);
    expect(rows[0]?.n).toBe(1);
  });

  it("answers 404 for a game that does not exist or an id that is not a UUID", async () => {
    expect((await edit("00000000-0000-0000-0000-000000000000", 1, { stealLimit: 2 })).status).toBe(404);
    expect((await edit("nope", 1, { stealLimit: 2 })).status).toBe(404);
  });

  it("rejects a body that is not JSON, a missing version, and changes that are not an object", async () => {
    const id = await createdId();

    const notJson = await updateRules(deps, hostId, id, new Request("http://localhost/x", { method: "POST", body: "no" }));
    const noVersion = await updateRules(deps, hostId, id, jsonRequest("/x", "POST", { changes: { stealLimit: 2 } }));
    const badChanges = await updateRules(deps, hostId, id, jsonRequest("/x", "POST", { version: 1, changes: [1] }));

    expect(notJson.status).toBe(400);
    expect(await noVersion.json()).toEqual({ error: "invalid-version" });
    expect(noVersion.status).toBe(400);
    expect(badChanges.status).toBe(422);
    expect(await badChanges.json()).toEqual({ error: "invalid-rules" });
  });
});
