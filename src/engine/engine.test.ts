import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decide,
  deriveBoard,
  ROLES,
  type Actor,
  type Command,
  type CommandType,
  type GameEvent,
  type Role,
} from "./index";

const now = new Date("2026-12-08T09:00:00Z");
const at = now.toISOString();

const host: Actor = { memberId: "host-1", role: "host" };
const helper: Actor = { memberId: "helper-1", role: "helper" };
const player: Actor = { memberId: "player-1", role: "player" };

const created: GameEvent = { type: "GameCreated", name: "Office exchange", at };

/** A game that exists and whose turn belongs to someone who is not the actor under test. */
const inProgress: GameEvent[] = [
  created,
  { type: "HelperAppointed", memberId: "helper-1", at },
  { type: "TurnStarted", memberId: "player-2", at },
];

function run(command: Command, actor: Actor, history: readonly GameEvent[] = [], version = history.length) {
  return decide({ history, command, version, actor, now });
}

describe("engine: creating a game", () => {
  it("emits a GameCreated event for a named game", () => {
    expect(run({ type: "CreateGame", name: "Office exchange" }, host)).toEqual({ ok: true, events: [created] });
  });

  it("trims the name", () => {
    expect(run({ type: "CreateGame", name: "  Office exchange  " }, host)).toEqual({ ok: true, events: [created] });
  });

  it("rejects a blank name", () => {
    expect(run({ type: "CreateGame", name: "   " }, host)).toEqual({ ok: false, reason: "name-required" });
  });

  it("rejects creating a game that already exists", () => {
    expect(run({ type: "CreateGame", name: "B" }, host, [created])).toEqual({ ok: false, reason: "already-created" });
  });
});

describe("engine: appointing helpers", () => {
  it("emits a HelperAppointed event", () => {
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, [created])).toEqual({
      ok: true,
      events: [{ type: "HelperAppointed", memberId: "helper-2", at }],
    });
  });

  it("rejects appointing before the game exists", () => {
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host)).toEqual({
      ok: false,
      reason: "game-not-created",
    });
  });

  it("rejects a blank member", () => {
    expect(run({ type: "AppointHelper", memberId: " " }, host, [created])).toEqual({
      ok: false,
      reason: "member-required",
    });
  });

  it("rejects appointing the same helper twice", () => {
    const history: GameEvent[] = [created, { type: "HelperAppointed", memberId: "helper-2", at }];
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, history)).toEqual({
      ok: false,
      reason: "already-helper",
    });
  });
});

describe("engine: board derived from the event log", () => {
  it("is empty before anything has happened", () => {
    expect(deriveBoard([])).toEqual({ created: false, name: null, version: 0, helpers: [], turnHolder: null });
  });

  it("reflects the game name and counts events as the version", () => {
    expect(deriveBoard([created])).toEqual({
      created: true,
      name: "Office exchange",
      version: 1,
      helpers: [],
      turnHolder: null,
    });
  });

  it("is derived by replaying every event in order", () => {
    expect(deriveBoard(inProgress)).toEqual({
      created: true,
      name: "Office exchange",
      version: 3,
      helpers: ["helper-1"],
      turnHolder: "player-2",
    });
  });

  it("follows the turn as it moves between members", () => {
    const history: GameEvent[] = [
      ...inProgress,
      { type: "TurnStarted", memberId: "player-3", at },
    ];
    expect(deriveBoard(history).turnHolder).toBe("player-3");
    expect(deriveBoard(history).version).toBe(4);
  });
});

describe("engine: stale versions", () => {
  it("accepts a command based on the current version", () => {
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, inProgress, 3).ok).toBe(true);
  });

  it("rejects a command based on an older version, returning the latest board", () => {
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, inProgress, 1)).toEqual({
      ok: false,
      reason: "stale-version",
      board: deriveBoard(inProgress),
    });
  });

  it("rejects a command claiming a version from the future", () => {
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, inProgress, 99)).toMatchObject({
      ok: false,
      reason: "stale-version",
    });
  });

  it("rejects a stale create when the game already exists", () => {
    expect(run({ type: "CreateGame", name: "B" }, host, [created], 0)).toMatchObject({
      ok: false,
      reason: "stale-version",
    });
  });

  it("checks permission before version, so a stale command from someone not permitted learns nothing", () => {
    expect(run({ type: "AppointHelper", memberId: "x" }, player, inProgress, 0)).toEqual({
      ok: false,
      reason: "not-permitted",
    });
  });

  it("checks version before the command's own rules", () => {
    expect(run({ type: "CreateGame", name: "" }, host, [created], 0)).toMatchObject({
      ok: false,
      reason: "stale-version",
    });
  });
});

describe("engine: permission table", () => {
  /** One valid command per type, for a game in progress. */
  const commands: Record<CommandType, Command> = {
    CreateGame: { type: "CreateGame", name: "New game" },
    AppointHelper: { type: "AppointHelper", memberId: "helper-2" },
    ConfirmPick: { type: "ConfirmPick" },
  };

  /** Written out by hand, not read from the engine, so the test can fail when the table is wrong. */
  const allowed: Record<CommandType, Record<Role, boolean>> = {
    CreateGame: { host: true, helper: false, player: false },
    AppointHelper: { host: true, helper: false, player: false },
    ConfirmPick: { host: true, helper: true, player: false },
  };

  const actors: Record<Role, Actor> = { host, helper, player };

  it("covers every command type", () => {
    expect(Object.keys(allowed).sort()).toEqual(Object.keys(commands).sort());
  });

  for (const type of Object.keys(commands) as CommandType[]) {
    for (const role of ROLES) {
      const expected = allowed[type][role];
      it(`${expected ? "lets" : "stops"} a ${role} ${expected ? "issue" : "issuing"} ${type}`, () => {
        const result = run(commands[type], actors[role], inProgress);
        if (expected) {
          expect(result).not.toEqual({ ok: false, reason: "not-permitted" });
          expect(result).not.toEqual({ ok: false, reason: "self-oversight" });
        } else {
          expect(result).toEqual({ ok: false, reason: "not-permitted" });
        }
      });
    }
  }
});

describe("engine: nobody oversees their own turn", () => {
  it("stops a helper confirming their own turn", () => {
    const history: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "helper-1", at }];
    expect(run({ type: "ConfirmPick" }, helper, history)).toEqual({ ok: false, reason: "self-oversight" });
  });

  it("stops a playing host confirming their own turn", () => {
    const history: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "host-1", at }];
    expect(run({ type: "ConfirmPick" }, host, history)).toEqual({ ok: false, reason: "self-oversight" });
  });

  it("lets the host confirm while a helper has the turn, and the reverse", () => {
    const helperTurn: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "helper-1", at }];
    const hostTurn: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "host-1", at }];
    expect(run({ type: "ConfirmPick" }, host, helperTurn)).toEqual({ ok: false, reason: "no-pending-pick" });
    expect(run({ type: "ConfirmPick" }, helper, hostTurn)).toEqual({ ok: false, reason: "no-pending-pick" });
  });

  it("applies once the turn moves on: the former turn holder may oversee the next turn", () => {
    const history: GameEvent[] = [
      ...inProgress,
      { type: "TurnStarted", memberId: "helper-1", at },
      { type: "TurnStarted", memberId: "player-2", at },
    ];
    expect(run({ type: "ConfirmPick" }, helper, history)).toEqual({ ok: false, reason: "no-pending-pick" });
  });

  it("does not turn a non-oversight command into a self-oversight rejection", () => {
    const history: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "host-1", at }];
    expect(run({ type: "AppointHelper", memberId: "helper-2" }, host, history).ok).toBe(true);
  });

  it("reports not-permitted rather than self-oversight to a role that may never oversee", () => {
    const history: GameEvent[] = [...inProgress, { type: "TurnStarted", memberId: "player-1", at }];
    expect(run({ type: "ConfirmPick" }, player, history)).toEqual({ ok: false, reason: "not-permitted" });
  });
});

describe("engine: purity", () => {
  it("takes time from its input and gives the same answer for the same input", () => {
    const command: Command = { type: "AppointHelper", memberId: "helper-2" };
    const later = new Date("2027-01-01T00:00:00Z");

    const first = decide({ history: inProgress, command, version: 3, actor: host, now });
    const again = decide({ history: inProgress, command, version: 3, actor: host, now });
    const other = decide({ history: inProgress, command, version: 3, actor: host, now: later });

    expect(again).toEqual(first);
    expect(first).toMatchObject({ ok: true, events: [{ at: now.toISOString() }] });
    expect(other).toMatchObject({ ok: true, events: [{ at: later.toISOString() }] });
  });

  it("does not modify the history it is given", () => {
    const history = Object.freeze([...inProgress]);
    expect(() => run({ type: "AppointHelper", memberId: "helper-2" }, host, history)).not.toThrow();
    expect(history).toEqual(inProgress);
  });
});

describe("engine: isolation", () => {
  const dir = new URL(".", import.meta.url);
  const sources = readdirSync(dir)
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .map((name) => ({ name, text: readFileSync(new URL(name, dir), "utf8") }));

  it("imports nothing, so it cannot reach a database, the network or the file system", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/^\s*import\s/m);
      expect(text, name).not.toMatch(/\brequire\s*\(/);
    }
  });

  it("never reads the clock or random numbers itself", () => {
    for (const { name, text } of sources) {
      expect(text, name).not.toMatch(/Date\.now\s*\(|new Date\s*\(\s*\)|Math\.random|performance\.now/);
    }
  });
});
