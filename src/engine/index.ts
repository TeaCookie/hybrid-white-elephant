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

export type Command =
  | { type: "CreateGame"; name: string }
  | { type: "AppointHelper"; memberId: string }
  | { type: "ConfirmPick" };

export type CommandType = Command["type"];

export type GameEvent =
  | { type: "GameCreated"; name: string; at: string }
  | { type: "HelperAppointed"; memberId: string; at: string }
  /** Emitted by the turn flow added with the draw; the engine core only reads it. */
  | { type: "TurnStarted"; memberId: string; at: string };

export type Board = {
  created: boolean;
  name: string | null;
  /** Number of events in the log. */
  version: number;
  helpers: string[];
  /** The member whose turn it is, or null when no turn is under way. */
  turnHolder: string | null;
};

export type Rejection =
  | "name-required"
  | "already-created"
  | "game-not-created"
  | "member-required"
  | "already-helper"
  | "no-pending-pick"
  | "not-permitted"
  | "self-oversight";

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
  AppointHelper: { roles: { host: true, helper: false, player: false }, oversight: false },
  ConfirmPick: { roles: { host: true, helper: true, player: false }, oversight: true },
};

export function deriveBoard(history: readonly GameEvent[]): Board {
  let board: Board = { created: false, name: null, version: 0, helpers: [], turnHolder: null };
  for (const event of history) {
    switch (event.type) {
      case "GameCreated":
        board = { ...board, created: true, name: event.name };
        break;
      case "HelperAppointed":
        board = { ...board, helpers: [...board.helpers, event.memberId] };
        break;
      case "TurnStarted":
        board = { ...board, turnHolder: event.memberId };
        break;
    }
    board = { ...board, version: board.version + 1 };
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
      return { ok: true, events: [{ type: "GameCreated", name, at }] };
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
