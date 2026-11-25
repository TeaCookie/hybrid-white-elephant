/**
 * The game engine: a pure module. It takes the game's event history, a command,
 * the acting member and the current time, and returns new events or a rejection.
 * No database, clock or network access; time is passed in.
 *
 * This is the walking-skeleton slice (create a game). The full command set,
 * permission table and stale-version rejection arrive with the engine-core issue.
 */

export type Role = "host" | "helper" | "player";

export type Actor = { role: Role };

export type Command = { type: "CreateGame"; name: string };

export type GameEvent = { type: "GameCreated"; name: string; at: string };

export type Board = { created: boolean; name: string | null; version: number };

export type Rejection = "name-required" | "already-created" | "not-permitted";

export type Decision = { ok: true; events: GameEvent[] } | { ok: false; reason: Rejection };

export type DecideInput = {
  history: readonly GameEvent[];
  command: Command;
  actor: Actor;
  now: Date;
};

export function deriveBoard(history: readonly GameEvent[]): Board {
  let board: Board = { created: false, name: null, version: 0 };
  for (const event of history) {
    switch (event.type) {
      case "GameCreated":
        board = { created: true, name: event.name, version: board.version };
        break;
    }
    board = { ...board, version: board.version + 1 };
  }
  return board;
}

export function decide({ history, command, actor, now }: DecideInput): Decision {
  switch (command.type) {
    case "CreateGame": {
      if (actor.role !== "host") return { ok: false, reason: "not-permitted" };
      if (deriveBoard(history).created) return { ok: false, reason: "already-created" };
      const name = command.name.trim();
      if (name === "") return { ok: false, reason: "name-required" };
      return { ok: true, events: [{ type: "GameCreated", name, at: now.toISOString() }] };
    }
  }
}
