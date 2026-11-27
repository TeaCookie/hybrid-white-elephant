/**
 * The game engine: a pure module. It takes the game's event history, a command,
 * the acting member and the current time, and returns new events or a rejection.
 * No database, clock or network access; time is passed in.
 *
 * Board state is always derived from the append-only event log. Every command
 * carries the game version it was based on; a stale one is rejected together
 * with the latest board so the caller can show it.
 *
 * Checks run in a fixed order: permission, then version, then the command's own rules.
 * Later issues add commands by extending `Command`, `GameEvent`, `PERMISSIONS`
 * and `deriveBoard`; the compiler forces a permission row for every new command.
 */

export type Role = "host" | "helper" | "player";

export const ROLES: readonly Role[] = ["host", "helper", "player"];

/** The acting member: their seat in the game and the role that seat holds. */
export type Actor = { memberId: string; role: Role };

/** 0 is Sunday, 6 is Saturday. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

/** A time of day as "HH:MM" on a 24-hour clock, in the game's timezone. */
export type TimeOfDay = string;

/**
 * The house rules the host sets for one game. They are stored as numbered versions
 * (see `RulesChanged`); a new version applies to what happens after it, never before.
 */
export type Rules = {
  /** How many times a gift may be stolen before it locks. */
  stealLimit: number;
  /** Whether a player who was just stolen from may immediately steal the same gift back. */
  immediateStealBack: boolean;
  /** Whether a player may steal again from someone they have already stolen from. */
  repeatStealFromSamePerson: boolean;
  /** The most steals in one chain of turns, or null for no cap. */
  maxStealsPerChain: number | null;
  /** Whether a gift can be locked early. */
  earlyLocking: boolean;
  /** The share of players, by original draw position, offered the final swap. 0 disables it. */
  finalSwapPercent: number;
  /** The game's single IANA timezone. */
  timezone: string;
  /** The days on which the working-day clock runs, kept in ascending order. */
  workingDays: Weekday[];
  workingHours: { start: TimeOfDay; end: TimeOfDay };
  /** When the reminder goes out on the next working morning; always before the work day starts. */
  reminderTime: TimeOfDay;
  /** How many working days a player has to take their turn. */
  deadlineWorkingDays: number;
};

export const DEFAULT_RULES: Rules = {
  stealLimit: 3,
  immediateStealBack: false,
  repeatStealFromSamePerson: false,
  maxStealsPerChain: null,
  earlyLocking: false,
  finalSwapPercent: 0,
  timezone: "UTC",
  workingDays: [1, 2, 3, 4, 5],
  workingHours: { start: "09:00", end: "17:00" },
  reminderTime: "08:00",
  deadlineWorkingDays: 1,
};

export type Command =
  | { type: "CreateGame"; name: string; rules?: Partial<Rules> }
  | { type: "UpdateRules"; changes: Partial<Rules> }
  | { type: "AppointHelper"; memberId: string }
  | { type: "ConfirmPick" };

export type CommandType = Command["type"];

export type GameEvent =
  /** Rule version 1: the rules the game starts with. */
  | { type: "GameCreated"; name: string; at: string; rules: Rules }
  /** The complete rules as of a new numbered version. Applies to what happens after it. */
  | { type: "RulesChanged"; ruleVersion: number; rules: Rules; at: string }
  | { type: "HelperAppointed"; memberId: string; at: string }
  /** Emitted by the turn flow added with the draw; the engine core only reads it. */
  | { type: "TurnStarted"; memberId: string; at: string }
  /** Emitted by the turn flow for the final regular turn. Freezes the final-swap percentage. */
  | { type: "LastRegularTurnStarted"; memberId: string; at: string };

/** One numbered version of the rules and the board version from which it applies. */
export type RuleVersion = {
  version: number;
  rules: Rules;
  /** The board version right after the event that saved this version; it governs commands decided from here on. */
  effectiveFromVersion: number;
};

export type Board = {
  created: boolean;
  name: string | null;
  /** Number of events in the log. */
  version: number;
  helpers: string[];
  /** The member whose turn it is, or null when no turn is under way. */
  turnHolder: string | null;
  /** The rules in force now. Visible to everyone from the start, the final-swap percentage included. */
  rules: Rules;
  /** The number of the rules in force now; 0 before the game exists. */
  ruleVersion: number;
  /** Every version the rules have had, oldest first. */
  ruleVersions: RuleVersion[];
  /** True once the last regular turn has begun; the final-swap percentage can no longer change. */
  finalSwapFrozen: boolean;
};

export type Rejection =
  | "name-required"
  | "already-created"
  | "game-not-created"
  | "member-required"
  | "already-helper"
  | "no-pending-pick"
  | "not-permitted"
  | "self-oversight"
  | "no-changes"
  | "final-swap-frozen"
  | "name-too-long"
  | "unknown-rule"
  | "invalid-rules"
  | "invalid-steal-limit"
  | "invalid-max-steals-per-chain"
  | "invalid-final-swap-percent"
  | "invalid-timezone"
  | "invalid-working-days"
  | "invalid-working-hours"
  | "invalid-reminder-time"
  | "invalid-deadline-length";

export type RulesRejection = Extract<Rejection, `invalid-${string}`>;

export type Decision =
  | { ok: true; events: GameEvent[] }
  | { ok: false; reason: Rejection }
  | { ok: false; reason: "stale-version"; board: Board };

export type DecideInput = {
  history: readonly GameEvent[];
  command: Command;
  /** The game version the command was based on, as last seen by the actor. */
  version: number;
  actor: Actor;
  now: Date;
};

/**
 * Who may issue each command. `oversight` marks commands that confirm or review
 * someone's turn: nobody may do these while it is their own turn.
 */
export const PERMISSIONS: Record<CommandType, { roles: Record<Role, boolean>; oversight: boolean }> = {
  CreateGame: { roles: { host: true, helper: false, player: false }, oversight: false },
  UpdateRules: { roles: { host: true, helper: false, player: false }, oversight: false },
  AppointHelper: { roles: { host: true, helper: false, player: false }, oversight: false },
  ConfirmPick: { roles: { host: true, helper: true, player: false }, oversight: true },
};

// --- Rules ------------------------------------------------------------------

const TIME_OF_DAY = /^(?:[01]\d|2[0-3]):[0-5]\d$/;

const MAX_NAME_LENGTH = 100;
const MIN_STEAL_LIMIT = 1;
const MAX_STEAL_LIMIT = 10;
const MAX_DEADLINE_WORKING_DAYS = 10;

function isTimeOfDay(value: unknown): value is TimeOfDay {
  return typeof value === "string" && TIME_OF_DAY.test(value);
}

/** An IANA zone name such as "America/Vancouver", or "UTC". Abbreviations ("EST") and offsets ("+05:00") are not accepted. */
const IANA_ZONE = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+$/;

function isTimezone(value: unknown): boolean {
  if (typeof value !== "string") return false;
  if (value !== "UTC" && !IANA_ZONE.test(value)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

function isInteger(value: unknown, min: number, max: number): boolean {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/** Whether the host's changes name a rule that does not exist. */
function hasUnknownRule(changes: unknown): boolean {
  if (changes === null || typeof changes !== "object") return false;
  return Object.keys(changes).some((key) => !Object.hasOwn(DEFAULT_RULES, key));
}

/** Lays the host's changes over a set of rules. Unknown keys and undefined values are ignored; the days come out sorted. */
function mergeRules(base: Rules, changes: Partial<Rules> | undefined): Rules {
  const merged: Rules = { ...base, workingHours: { ...base.workingHours }, workingDays: [...base.workingDays] };
  if (changes === null || typeof changes !== "object") return merged;
  const source = changes as Record<string, unknown>;
  const target = merged as Record<string, unknown>;
  for (const key of Object.keys(DEFAULT_RULES)) {
    if (source[key] !== undefined) target[key] = source[key];
  }
  if (Array.isArray(merged.workingDays)) {
    merged.workingDays = [...merged.workingDays].sort((a, b) => a - b);
  }
  return merged;
}

/** The first thing wrong with a complete set of rules, or null when they are all sound. */
export function validateRules(rules: Rules): RulesRejection | null {
  if (
    typeof rules.immediateStealBack !== "boolean" ||
    typeof rules.repeatStealFromSamePerson !== "boolean" ||
    typeof rules.earlyLocking !== "boolean"
  ) {
    return "invalid-rules";
  }
  if (!isInteger(rules.stealLimit, MIN_STEAL_LIMIT, MAX_STEAL_LIMIT)) return "invalid-steal-limit";
  if (rules.maxStealsPerChain !== null && !isInteger(rules.maxStealsPerChain, 1, Number.MAX_SAFE_INTEGER)) {
    return "invalid-max-steals-per-chain";
  }
  if (!isInteger(rules.finalSwapPercent, 0, 100)) return "invalid-final-swap-percent";
  if (!isTimezone(rules.timezone)) return "invalid-timezone";

  const days = rules.workingDays;
  if (!Array.isArray(days) || days.length === 0 || days.some((d) => !isInteger(d, 0, 6)) || new Set(days).size !== days.length) {
    return "invalid-working-days";
  }

  const hours = rules.workingHours as Partial<Rules["workingHours"]> | null;
  if (!hours || !isTimeOfDay(hours.start) || !isTimeOfDay(hours.end) || hours.start >= hours.end) {
    return "invalid-working-hours";
  }
  // The reminder is a morning message sent before the work day begins.
  if (!isTimeOfDay(rules.reminderTime) || rules.reminderTime >= hours.start) return "invalid-reminder-time";

  if (!isInteger(rules.deadlineWorkingDays, 1, MAX_DEADLINE_WORKING_DAYS)) return "invalid-deadline-length";
  return null;
}

function rulesEqual(a: Rules, b: Rules): boolean {
  const canonical = (r: Rules) =>
    JSON.stringify([
      r.stealLimit,
      r.immediateStealBack,
      r.repeatStealFromSamePerson,
      r.maxStealsPerChain,
      r.earlyLocking,
      r.finalSwapPercent,
      r.timezone,
      r.workingDays,
      r.workingHours.start,
      r.workingHours.end,
      r.reminderTime,
      r.deadlineWorkingDays,
    ]);
  return canonical(a) === canonical(b);
}

/**
 * The rules that govern a command decided when the board stood at `boardVersion`.
 * A rule change applies only to commands decided after it, so earlier events keep the
 * rules they were played under.
 */
export function rulesInForce(board: Board, boardVersion: number): Rules {
  let found: Rules | undefined;
  for (const entry of board.ruleVersions) {
    if (entry.effectiveFromVersion <= boardVersion) found = entry.rules;
  }
  return found ?? board.ruleVersions[0]?.rules ?? DEFAULT_RULES;
}

// --- Board ------------------------------------------------------------------

export function deriveBoard(history: readonly GameEvent[]): Board {
  let board: Board = {
    created: false,
    name: null,
    version: 0,
    helpers: [],
    turnHolder: null,
    rules: DEFAULT_RULES,
    ruleVersion: 0,
    ruleVersions: [],
    finalSwapFrozen: false,
  };
  for (const event of history) {
    const version = board.version + 1;
    switch (event.type) {
      case "GameCreated":
        board = {
          ...board,
          created: true,
          name: event.name,
          rules: event.rules,
          ruleVersion: 1,
          ruleVersions: [{ version: 1, rules: event.rules, effectiveFromVersion: version }],
        };
        break;
      case "RulesChanged":
        board = {
          ...board,
          rules: event.rules,
          ruleVersion: event.ruleVersion,
          ruleVersions: [
            ...board.ruleVersions,
            { version: event.ruleVersion, rules: event.rules, effectiveFromVersion: version },
          ],
        };
        break;
      case "HelperAppointed":
        board = { ...board, helpers: [...board.helpers, event.memberId] };
        break;
      case "TurnStarted":
        board = { ...board, turnHolder: event.memberId };
        break;
      case "LastRegularTurnStarted":
        board = { ...board, turnHolder: event.memberId, finalSwapFrozen: true };
        break;
    }
    board = { ...board, version };
  }
  return board;
}

/** Whether the actor may issue this kind of command against this board. */
export function checkPermission(actor: Actor, type: CommandType, board: Board): "not-permitted" | "self-oversight" | null {
  const rule = PERMISSIONS[type];
  if (!rule.roles[actor.role]) return "not-permitted";
  if (rule.oversight && board.turnHolder === actor.memberId) return "self-oversight";
  return null;
}

export function decide({ history, command, version, actor, now }: DecideInput): Decision {
  const board = deriveBoard(history);

  const denied = checkPermission(actor, command.type, board);
  if (denied) return { ok: false, reason: denied };

  if (version !== board.version) return { ok: false, reason: "stale-version", board };

  const at = now.toISOString();
  switch (command.type) {
    case "CreateGame": {
      if (board.created) return { ok: false, reason: "already-created" };
      const name = command.name.trim();
      if (name === "") return { ok: false, reason: "name-required" };
      if (name.length > MAX_NAME_LENGTH) return { ok: false, reason: "name-too-long" };
      if (hasUnknownRule(command.rules)) return { ok: false, reason: "unknown-rule" };
      const rules = mergeRules(DEFAULT_RULES, command.rules);
      const problem = validateRules(rules);
      if (problem) return { ok: false, reason: problem };
      return { ok: true, events: [{ type: "GameCreated", name, at, rules }] };
    }
    case "UpdateRules": {
      if (!board.created) return { ok: false, reason: "game-not-created" };
      if (hasUnknownRule(command.changes)) return { ok: false, reason: "unknown-rule" };
      const rules = mergeRules(board.rules, command.changes);
      const problem = validateRules(rules);
      if (problem) return { ok: false, reason: problem };
      if (rulesEqual(rules, board.rules)) return { ok: false, reason: "no-changes" };
      if (board.finalSwapFrozen && rules.finalSwapPercent !== board.rules.finalSwapPercent) {
        return { ok: false, reason: "final-swap-frozen" };
      }
      return { ok: true, events: [{ type: "RulesChanged", ruleVersion: board.ruleVersion + 1, rules, at }] };
    }
    case "AppointHelper": {
      if (!board.created) return { ok: false, reason: "game-not-created" };
      const memberId = command.memberId.trim();
      if (memberId === "") return { ok: false, reason: "member-required" };
      if (board.helpers.includes(memberId)) return { ok: false, reason: "already-helper" };
      return { ok: true, events: [{ type: "HelperAppointed", memberId, at }] };
    }
    case "ConfirmPick": {
      // Picks arrive with the pick flow; until then there is never one to confirm.
      return { ok: false, reason: "no-pending-pick" };
    }
  }
}
