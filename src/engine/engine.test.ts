import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  decide,
  deriveBoard,
  DEFAULT_RULES,
  ROLES,
  rulesInForce,
  type Actor,
  type Command,
  type CommandType,
  type GameEvent,
  type Role,
  type Rules,
} from "./index";

const now = new Date("2026-12-08T09:00:00Z");
const at = now.toISOString();

const host: Actor = { memberId: "host-1", role: "host" };
const helper: Actor = { memberId: "helper-1", role: "helper" };
const player: Actor = { memberId: "player-1", role: "player" };

const created: GameEvent = { type: "GameCreated", name: "Office exchange", at, rules: DEFAULT_RULES };

/** A game that exists and whose turn belongs to someone who is not the actor under test. */
const inProgress: GameEvent[] = [
  created,
  { type: "HelperAppointed", memberId: "helper-1", at },
  { type: "TurnStarted", memberId: "player-2", at },
];

const appointHelper2: Command = { type: "AppointHelper", memberId: "helper-2" };

/** The in-progress game with the turn handed to someone else. */
function withTurn(memberId: string): GameEvent[] {
  return [...inProgress, { type: "TurnStarted", memberId, at }];
}

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

  it("starts with the default rules, whose deadline is one working day", () => {
    const result = run({ type: "CreateGame", name: "Office exchange" }, host);
    expect(result).toMatchObject({ ok: true, events: [{ rules: DEFAULT_RULES }] });
    expect(DEFAULT_RULES.deadlineWorkingDays).toBe(1);
  });

  it("applies the rules the host sets on top of the defaults", () => {
    const rules: Partial<Rules> = {
      stealLimit: 2,
      immediateStealBack: true,
      repeatStealFromSamePerson: true,
      maxStealsPerChain: 5,
      earlyLocking: true,
      finalSwapPercent: 25,
      timezone: "America/Vancouver",
      workingDays: [4, 1, 2, 3],
      workingHours: { start: "08:30", end: "16:30" },
      reminderTime: "08:00",
      deadlineWorkingDays: 2,
    };
    expect(run({ type: "CreateGame", name: "Office exchange", rules }, host)).toEqual({
      ok: true,
      events: [
        {
          type: "GameCreated",
          name: "Office exchange",
          at,
          rules: { ...DEFAULT_RULES, ...rules, workingDays: [1, 2, 3, 4] },
        },
      ],
    });
  });

  it("keeps the defaults for rules the host leaves out", () => {
    const result = run({ type: "CreateGame", name: "G", rules: { stealLimit: 2 } }, host);
    expect(result).toMatchObject({ ok: true, events: [{ rules: { ...DEFAULT_RULES, stealLimit: 2 } }] });
  });

  it("rejects each invalid rule with a reason naming it, and stores nothing", () => {
    const bad: [Partial<Rules>, string][] = [
      [{ stealLimit: 0 }, "invalid-steal-limit"],
      [{ stealLimit: 2.5 }, "invalid-steal-limit"],
      [{ stealLimit: 11 }, "invalid-steal-limit"],
      [{ maxStealsPerChain: 0 }, "invalid-max-steals-per-chain"],
      [{ maxStealsPerChain: 1.5 }, "invalid-max-steals-per-chain"],
      [{ finalSwapPercent: -1 }, "invalid-final-swap-percent"],
      [{ finalSwapPercent: 101 }, "invalid-final-swap-percent"],
      [{ finalSwapPercent: 12.5 }, "invalid-final-swap-percent"],
      [{ timezone: "Mars/Olympus" }, "invalid-timezone"],
      [{ timezone: "" }, "invalid-timezone"],
      [{ workingDays: [] }, "invalid-working-days"],
      [{ workingDays: [1, 1] }, "invalid-working-days"],
      [{ workingDays: [7] as never }, "invalid-working-days"],
      [{ workingHours: { start: "17:00", end: "09:00" } }, "invalid-working-hours"],
      [{ workingHours: { start: "09:00", end: "09:00" } }, "invalid-working-hours"],
      [{ workingHours: { start: "9am", end: "17:00" } }, "invalid-working-hours"],
      [{ workingHours: { start: "09:00", end: "24:00" } }, "invalid-working-hours"],
      [{ reminderTime: "25:00" }, "invalid-reminder-time"],
      [{ reminderTime: "09:00" }, "invalid-reminder-time"],
      [{ reminderTime: "12:00" }, "invalid-reminder-time"],
      [{ deadlineWorkingDays: 0 }, "invalid-deadline-length"],
      [{ deadlineWorkingDays: 11 }, "invalid-deadline-length"],
      [{ deadlineWorkingDays: 1.5 }, "invalid-deadline-length"],
    ];
    for (const [rules, reason] of bad) {
      expect(run({ type: "CreateGame", name: "G", rules }, host), JSON.stringify(rules)).toEqual({ ok: false, reason });
    }
  });

  it("accepts no cap on steals per chain", () => {
    const result = run({ type: "CreateGame", name: "G", rules: { maxStealsPerChain: null } }, host);
    expect(result).toMatchObject({ ok: true, events: [{ rules: { maxStealsPerChain: null } }] });
  });
});

describe("engine: appointing helpers", () => {
  it("emits a HelperAppointed event", () => {
    expect(run(appointHelper2, host, [created])).toEqual({
      ok: true,
      events: [{ type: "HelperAppointed", memberId: "helper-2", at }],
    });
  });

  it("rejects appointing before the game exists", () => {
    expect(run(appointHelper2, host)).toEqual({
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
    expect(run(appointHelper2, host, history)).toEqual({
      ok: false,
      reason: "already-helper",
    });
  });
});

describe("engine: board derived from the event log", () => {
  it("is empty before anything has happened", () => {
    expect(deriveBoard([])).toEqual({
      created: false,
      name: null,
      version: 0,
      helpers: [],
      turnHolder: null,
      rules: DEFAULT_RULES,
      ruleVersion: 0,
      ruleVersions: [],
      finalSwapFrozen: false,
    });
  });

  it("reflects the game name and counts events as the version", () => {
    expect(deriveBoard([created])).toEqual({
      created: true,
      name: "Office exchange",
      version: 1,
      helpers: [],
      turnHolder: null,
      rules: DEFAULT_RULES,
      ruleVersion: 1,
      ruleVersions: [{ version: 1, rules: DEFAULT_RULES, effectiveFromVersion: 1 }],
      finalSwapFrozen: false,
    });
  });

  it("is derived by replaying every event in order", () => {
    expect(deriveBoard(inProgress)).toEqual({
      created: true,
      name: "Office exchange",
      version: 3,
      helpers: ["helper-1"],
      turnHolder: "player-2",
      rules: DEFAULT_RULES,
      ruleVersion: 1,
      ruleVersions: [{ version: 1, rules: DEFAULT_RULES, effectiveFromVersion: 1 }],
      finalSwapFrozen: false,
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

describe("engine: rules are visible from the start", () => {
  it("shows every rule, including the final-swap percentage, on the board of a new game", () => {
    const result = run({ type: "CreateGame", name: "G", rules: { finalSwapPercent: 30 } }, host);
    if (!result.ok) throw new Error("expected the game to be created");
    const board = deriveBoard(result.events);
    expect(board.rules).toEqual({ ...DEFAULT_RULES, finalSwapPercent: 30 });
    expect(board.ruleVersion).toBe(1);
  });
});

describe("engine: versioned rule edits", () => {
  const changed: Rules = { ...DEFAULT_RULES, stealLimit: 2 };
  const changedEvent: GameEvent = { type: "RulesChanged", ruleVersion: 2, rules: changed, at };

  it("saves a change as the next numbered rule version", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, host, [created])).toEqual({
      ok: true,
      events: [changedEvent],
    });
  });

  it("keeps every rule the change leaves out", () => {
    const result = run({ type: "UpdateRules", changes: { earlyLocking: true } }, host, [created]);
    expect(result).toMatchObject({ ok: true, events: [{ rules: { ...DEFAULT_RULES, earlyLocking: true } }] });
  });

  it("numbers each further change in turn", () => {
    const history: GameEvent[] = [created, changedEvent];
    expect(run({ type: "UpdateRules", changes: { stealLimit: 4 } }, host, history)).toMatchObject({
      ok: true,
      events: [{ type: "RulesChanged", ruleVersion: 3, rules: { ...DEFAULT_RULES, stealLimit: 4 } }],
    });
  });

  it("makes the new rules current on the board and keeps the old version in the list", () => {
    const board = deriveBoard([created, changedEvent]);
    expect(board.rules).toEqual(changed);
    expect(board.ruleVersion).toBe(2);
    expect(board.ruleVersions).toEqual([
      { version: 1, rules: DEFAULT_RULES, effectiveFromVersion: 1 },
      { version: 2, rules: changed, effectiveFromVersion: 2 },
    ]);
  });

  it("applies going forward only: earlier events are still read under the rules in force then", () => {
    const history: GameEvent[] = [
      created,
      { type: "HelperAppointed", memberId: "helper-1", at },
      changedEvent,
      { type: "TurnStarted", memberId: "player-2", at },
    ];
    const board = deriveBoard(history);
    // Board versions: 1 created, 2 helper appointed, 3 rules changed, 4 turn started.
    expect(rulesInForce(board, 1)).toEqual(DEFAULT_RULES);
    expect(rulesInForce(board, 2)).toEqual(DEFAULT_RULES);
    expect(rulesInForce(board, 3)).toEqual(changed);
    expect(rulesInForce(board, 4)).toEqual(changed);
  });

  it("rejects a change that changes nothing, so no empty version is saved", () => {
    expect(run({ type: "UpdateRules", changes: {} }, host, [created])).toEqual({ ok: false, reason: "no-changes" });
    expect(run({ type: "UpdateRules", changes: { stealLimit: DEFAULT_RULES.stealLimit } }, host, [created])).toEqual({
      ok: false,
      reason: "no-changes",
    });
    expect(
      run({ type: "UpdateRules", changes: { workingDays: [...DEFAULT_RULES.workingDays].reverse() } }, host, [created]),
    ).toEqual({ ok: false, reason: "no-changes" });
  });

  it("rejects an invalid change with the reason naming the rule", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 0 } }, host, [created])).toEqual({
      ok: false,
      reason: "invalid-steal-limit",
    });
    expect(run({ type: "UpdateRules", changes: { timezone: "Nowhere/Land" } }, host, [created])).toEqual({
      ok: false,
      reason: "invalid-timezone",
    });
  });

  it("checks the rules as a whole: moving the work day cannot strand the reminder after it starts", () => {
    expect(
      run({ type: "UpdateRules", changes: { workingHours: { start: "07:00", end: "15:00" } } }, host, [created]),
    ).toEqual({ ok: false, reason: "invalid-reminder-time" });
  });

  it("rejects changing rules before the game exists", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, host)).toEqual({
      ok: false,
      reason: "game-not-created",
    });
  });

  it("rejects a change based on a stale version, returning the latest board", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, host, [created, changedEvent], 1)).toEqual({
      ok: false,
      reason: "stale-version",
      board: deriveBoard([created, changedEvent]),
    });
  });

  it("is host-only: helpers and players are refused", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, helper, [created])).toEqual({
      ok: false,
      reason: "not-permitted",
    });
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, player, [created])).toEqual({
      ok: false,
      reason: "not-permitted",
    });
  });

  it("is not oversight: a playing host may change rules during their own turn", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2 } }, host, withTurn("host-1")).ok).toBe(true);
  });
});

describe("engine: the final-swap percentage freezes when the last regular turn begins", () => {
  const lastTurn: GameEvent = { type: "LastRegularTurnStarted", memberId: "player-9", at };
  const early: GameEvent[] = [created, { type: "TurnStarted", memberId: "player-8", at }];
  const frozen: GameEvent[] = [...early, lastTurn];

  it("can still be changed at any time before the last regular turn", () => {
    expect(run({ type: "UpdateRules", changes: { finalSwapPercent: 40 } }, host, early)).toMatchObject({
      ok: true,
      events: [{ type: "RulesChanged", rules: { finalSwapPercent: 40 } }],
    });
  });

  it("is frozen once the last regular turn begins", () => {
    expect(deriveBoard(early).finalSwapFrozen).toBe(false);
    expect(deriveBoard(frozen).finalSwapFrozen).toBe(true);
    expect(run({ type: "UpdateRules", changes: { finalSwapPercent: 40 } }, host, frozen)).toEqual({
      ok: false,
      reason: "final-swap-frozen",
    });
  });

  it("gives the last regular turn to its member", () => {
    expect(deriveBoard(frozen).turnHolder).toBe("player-9");
  });

  it("still lets the host change every other rule", () => {
    expect(run({ type: "UpdateRules", changes: { stealLimit: 2, deadlineWorkingDays: 2 } }, host, frozen)).toMatchObject({
      ok: true,
      events: [{ type: "RulesChanged", rules: { stealLimit: 2, deadlineWorkingDays: 2 } }],
    });
  });

  it("does not object when a change repeats the frozen value", () => {
    const result = run({ type: "UpdateRules", changes: { finalSwapPercent: 0, stealLimit: 2 } }, host, frozen);
    expect(result.ok).toBe(true);
  });

  it("stays frozen through later turns and rule changes", () => {
    const later: GameEvent[] = [
      ...frozen,
      { type: "RulesChanged", ruleVersion: 2, rules: { ...DEFAULT_RULES, stealLimit: 2 }, at },
      { type: "TurnStarted", memberId: "player-1", at },
    ];
    expect(deriveBoard(later).finalSwapFrozen).toBe(true);
    expect(run({ type: "UpdateRules", changes: { finalSwapPercent: 10 } }, host, later)).toEqual({
      ok: false,
      reason: "final-swap-frozen",
    });
  });
});

describe("engine: stale versions", () => {
  it("accepts a command based on the current version", () => {
    expect(run(appointHelper2, host, inProgress, 3).ok).toBe(true);
  });

  it("rejects a command based on an older version, returning the latest board", () => {
    expect(run(appointHelper2, host, inProgress, 1)).toEqual({
      ok: false,
      reason: "stale-version",
      board: deriveBoard(inProgress),
    });
  });

  it("rejects a command claiming a version from the future", () => {
    expect(run(appointHelper2, host, inProgress, 99)).toMatchObject({
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
    AppointHelper: appointHelper2,
    ConfirmPick: { type: "ConfirmPick" },
    UpdateRules: { type: "UpdateRules", changes: { stealLimit: 2 } },
  };

  /** Written out by hand, not read from the engine, so the test can fail when the table is wrong. */
  const allowed: Record<CommandType, Record<Role, boolean>> = {
    CreateGame: { host: true, helper: false, player: false },
    AppointHelper: { host: true, helper: false, player: false },
    ConfirmPick: { host: true, helper: true, player: false },
    UpdateRules: { host: true, helper: false, player: false },
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
    const history: GameEvent[] = withTurn("helper-1");
    expect(run({ type: "ConfirmPick" }, helper, history)).toEqual({ ok: false, reason: "self-oversight" });
  });

  it("stops a playing host confirming their own turn", () => {
    const history: GameEvent[] = withTurn("host-1");
    expect(run({ type: "ConfirmPick" }, host, history)).toEqual({ ok: false, reason: "self-oversight" });
  });

  it("lets the host confirm while a helper has the turn, and the reverse", () => {
    const helperTurn: GameEvent[] = withTurn("helper-1");
    const hostTurn: GameEvent[] = withTurn("host-1");
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
    const history: GameEvent[] = withTurn("host-1");
    expect(run(appointHelper2, host, history).ok).toBe(true);
  });

  it("reports not-permitted rather than self-oversight to a role that may never oversee", () => {
    const history: GameEvent[] = withTurn("player-1");
    expect(run({ type: "ConfirmPick" }, player, history)).toEqual({ ok: false, reason: "not-permitted" });
  });
});

describe("engine: purity", () => {
  it("takes time from its input and gives the same answer for the same input", () => {
    const command: Command = appointHelper2;
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
    expect(() => run(appointHelper2, host, history)).not.toThrow();
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
