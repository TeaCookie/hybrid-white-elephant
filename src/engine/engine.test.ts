import { describe, expect, it } from "vitest";
import { decide, deriveBoard, type GameEvent } from "./index";

const now = new Date("2026-12-08T09:00:00Z");

describe("engine: creating a game", () => {
  it("emits a GameCreated event for a named game", () => {
    const result = decide({
      history: [],
      command: { type: "CreateGame", name: "Office exchange" },
      actor: { role: "host" },
      now,
    });

    expect(result).toEqual({
      ok: true,
      events: [{ type: "GameCreated", name: "Office exchange", at: now.toISOString() }],
    });
  });

  it("rejects a blank name", () => {
    const result = decide({
      history: [],
      command: { type: "CreateGame", name: "   " },
      actor: { role: "host" },
      now,
    });

    expect(result).toEqual({ ok: false, reason: "name-required" });
  });

  it("rejects creating a game that already exists", () => {
    const history: GameEvent[] = [{ type: "GameCreated", name: "A", at: now.toISOString() }];

    const result = decide({
      history,
      command: { type: "CreateGame", name: "B" },
      actor: { role: "host" },
      now,
    });

    expect(result).toEqual({ ok: false, reason: "already-created" });
  });

  it("only lets a host create a game", () => {
    const result = decide({
      history: [],
      command: { type: "CreateGame", name: "A" },
      actor: { role: "player" },
      now,
    });

    expect(result).toEqual({ ok: false, reason: "not-permitted" });
  });
});

describe("engine: board derived from the event log", () => {
  it("is empty before anything has happened", () => {
    expect(deriveBoard([])).toEqual({ created: false, name: null, version: 0 });
  });

  it("reflects the game name and counts events as the version", () => {
    const history: GameEvent[] = [{ type: "GameCreated", name: "Office exchange", at: now.toISOString() }];

    expect(deriveBoard(history)).toEqual({ created: true, name: "Office exchange", version: 1 });
  });
});
