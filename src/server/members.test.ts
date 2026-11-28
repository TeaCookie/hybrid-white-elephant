import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { gameEvents, games, hosts, members } from "@/db/schema";
import { createTestDeps, jsonRequest } from "../../tests/support";
import { createGame } from "./handlers";
import {
  appointHelper,
  claimInvite,
  getMe,
  inviteMembers,
  listMembers,
  MEMBER_COOKIE,
  optOut,
  previewInvite,
  setDisplayName,
} from "./members";

const { deps, email, close } = createTestDeps();
let hostId: string;
let gameId: string;

beforeEach(async () => {
  await deps.db.execute(sql`TRUNCATE hosts CASCADE`);
  email.reset();
  const [host] = await deps.db
    .insert(hosts)
    .values({ email: "host@example.com", passwordHash: "unused", emailVerifiedAt: new Date() })
    .returning({ id: hosts.id });
  hostId = host!.id;
  const created = await createGame(deps, hostId, jsonRequest("/api/games", "POST", { name: "Office exchange" }));
  gameId = (await created.json()).id;
});

afterAll(() => close());

async function invite(body: unknown, host = hostId, game = gameId) {
  return inviteMembers(deps, host, game, jsonRequest(`/api/games/${game}/invites`, "POST", body));
}

describe("inviting players by email", () => {
  it("sends each address an invite whose link needs a Continue step and carries both opt-out links and the privacy notice", async () => {
    const response = await invite({ permissionToInvite: true, emails: ["Ada@Example.com", "bob@example.com"] });

    expect(response.status).toBe(200);
    expect((await response.json()).results).toEqual([
      { email: "ada@example.com", status: "invited" },
      { email: "bob@example.com", status: "invited" },
    ]);
    expect(email.sent.map((m) => m.to)).toEqual(["ada@example.com", "bob@example.com"]);
    const text = email.sent[0]!.text;
    expect(text).toMatch(/http:\/\/localhost:3000\/invite\?token=[\w-]{20,}/);
    expect(text).toMatch(/http:\/\/localhost:3000\/optout\?member=[\w-]+&kind=stop-emails&token=[\w-]+/);
    expect(text).toMatch(/http:\/\/localhost:3000\/optout\?member=[\w-]+&kind=remove-me&token=[\w-]+/);
    expect(text).toContain("stop all emails for this game");
    expect(text).toContain("remove me and delete my email now");
    expect(text).toContain("http://localhost:3000/privacy");
  });

  it("requires the host to confirm permission to invite", async () => {
    for (const body of [{ emails: ["a@example.com"] }, { permissionToInvite: false, emails: ["a@example.com"] }]) {
      const response = await invite(body);
      expect(response.status).toBe(422);
      expect((await response.json()).error).toBe("permission-required");
    }
    expect(email.sent).toEqual([]);
  });

  it("rejects bad input", async () => {
    expect((await invite({ permissionToInvite: true, emails: [] })).status).toBe(422);
    expect((await invite({ permissionToInvite: true, emails: "a@example.com" })).status).toBe(422);
    expect((await invite({ permissionToInvite: true, emails: Array(51).fill("a@example.com") })).status).toBe(422);
    const response = await invite({ permissionToInvite: true, emails: ["not-an-email", "ok@example.com"] });
    expect((await response.json()).results).toEqual([
      { email: "not-an-email", status: "invalid" },
      { email: "ok@example.com", status: "invited" },
    ]);
    expect(email.sent).toHaveLength(1);
  });

  it("stores each address encrypted with a keyed hash, and nowhere in plaintext", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });

    const rows = await deps.db.select().from(members);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.emailCiphertext).toBeTruthy();
    expect(rows[0]!.emailHash).toMatch(/^[0-9a-f]{64}$/);
    for (const table of ["members", "member_invites", "member_sessions", "game_events", "games"]) {
      const dump = await deps.db.execute(sql.raw(`SELECT t::text AS row FROM ${table} t`));
      expect(JSON.stringify(dump)).not.toContain("ada@example.com");
    }
    expect(JSON.stringify(await deps.db.select().from(gameEvents))).not.toContain("ada");
  });

  it("never writes an address to the logs", async () => {
    const spies = (["log", "info", "warn", "error"] as const).map((level) => vi.spyOn(console, level));
    await invite({ permissionToInvite: true, emails: ["ada@example.com", "bad address@"] });
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    spies.forEach((s) => s.mockRestore());

    expect(logged).not.toContain("ada@example.com");
  });

  it("sends a fresh link instead of a second seat when an unclaimed address is invited again", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const again = await invite({ permissionToInvite: true, emails: ["ADA@example.com"] });

    expect((await again.json()).results).toEqual([{ email: "ada@example.com", status: "resent" }]);
    expect(await deps.db.select().from(members)).toHaveLength(1);
    expect(email.sent).toHaveLength(2);
    const token = (m: { text: string }) => /invite\?token=([\w-]+)/.exec(m.text)![1];
    expect(token(email.sent[0]!)).not.toBe(token(email.sent[1]!));
  });

  it("can invite a non-playing member", async () => {
    await invite({ permissionToInvite: true, emails: ["helper@example.com"], plays: false });

    expect((await deps.db.select().from(members))[0]!.plays).toBe(false);
  });

  it("is only for the host of an existing game", async () => {
    const [other] = await deps.db
      .insert(hosts)
      .values({ email: "other@example.com", passwordHash: "unused", emailVerifiedAt: new Date() })
      .returning({ id: hosts.id });

    expect((await invite({ permissionToInvite: true, emails: ["a@example.com"] }, other!.id)).status).toBe(404);
    expect((await invite({ permissionToInvite: true, emails: ["a@example.com"] }, hostId, "nope")).status).toBe(404);
    const [ended] = await deps.db.insert(games).values({ hostId, endedAt: new Date() }).returning({ id: games.id });
    expect((await invite({ permissionToInvite: true, emails: ["a@example.com"] }, hostId, ended!.id)).status).toBe(404);
    expect(email.sent).toEqual([]);
  });
});

function inviteToken(message: { text: string }): string {
  return /invite\?token=([\w-]+)/.exec(message.text)![1]!;
}

function claim(token: string, d = deps) {
  return claimInvite(d, jsonRequest("/api/invites/claim", "POST", { token }));
}

function cookieOf(response: Response): string {
  return (response.headers.get("set-cookie") ?? "").split(";")[0]!;
}

function asMember(cookie: string, url: string, method: string, body?: unknown): Request {
  const request = jsonRequest(url, method, body);
  request.headers.set("cookie", cookie);
  return request;
}

/** Invites an address, follows the emailed link through Continue, and returns the member's session cookie. */
async function join(address: string, displayName?: string): Promise<string> {
  await invite({ permissionToInvite: true, emails: [address] });
  const response = await claim(inviteToken(email.sent.at(-1)!));
  expect(response.status).toBe(200);
  const cookie = cookieOf(response);
  if (displayName) {
    const named = await setDisplayName(deps, asMember(cookie, "/api/me/display-name", "POST", { displayName }));
    expect(named.status).toBe(200);
  }
  return cookie;
}

describe("claiming a seat from the invite link", () => {
  it("only previews the invite until Continue is chosen, so a scanner opening the link burns nothing", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const token = inviteToken(email.sent[0]!);
    const url = `/api/invites/preview?token=${token}`;

    for (let i = 0; i < 3; i++) {
      const preview = await previewInvite(deps, new Request(`http://localhost${url}`));
      expect(preview.status).toBe(200);
      expect(await preview.json()).toEqual({ gameName: "Office exchange" });
    }
    expect(await deps.db.select().from(members)).toMatchObject([{ claimedAt: null }]);

    const claimed = await claim(token);
    expect(claimed.status).toBe(200);
    expect(await claimed.json()).toMatchObject({ needsDisplayName: true });
  });

  it("starts a long-lived secure session and works only once", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const token = inviteToken(email.sent[0]!);

    const response = await claim(token);
    const setCookie = response.headers.get("set-cookie")!;
    expect(setCookie).toContain(`${MEMBER_COOKIE}=`);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Lax");
    expect(setCookie).toContain(`Max-Age=${90 * 24 * 60 * 60}`);

    const again = await claim(token);
    expect(again.status).toBe(400);
    expect((await again.json()).error).toBe("invalid-token");
    expect((await previewInvite(deps, new Request(`http://localhost/api/invites/preview?token=${token}`))).status).toBe(404);
  });

  it("rejects unknown, empty and expired links", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const token = inviteToken(email.sent[0]!);

    expect((await claim("nonsense")).status).toBe(400);
    expect((await claim("")).status).toBe(400);
    const later = { ...deps, now: () => new Date("2026-12-30T00:00:00Z") };
    expect((await claim(token, later)).status).toBe(400);
  });

  it("an older link stops working once a new one is sent", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });

    expect((await claim(inviteToken(email.sent[0]!))).status).toBe(400);
    expect((await claim(inviteToken(email.sent[1]!))).status).toBe(200);
  });
});

describe("display names", () => {
  it("are chosen after claiming and shown back to the member", async () => {
    const cookie = await join("ada@example.com");
    expect((await (await getMe(deps, asMember(cookie, "/api/me", "GET"))).json()).displayName).toBeNull();

    const named = await setDisplayName(deps, asMember(cookie, "/api/me/display-name", "POST", { displayName: "  Ada   L  " }));

    expect(named.status).toBe(200);
    expect((await (await getMe(deps, asMember(cookie, "/api/me", "GET"))).json()).displayName).toBe("Ada L");
  });

  it("are unique within the game, ignoring case, but may be reused in another game", async () => {
    await join("ada@example.com", "Ada");
    const bob = await join("bob@example.com");

    const clash = await setDisplayName(deps, asMember(bob, "/api/me/display-name", "POST", { displayName: "ADA" }));
    expect(clash.status).toBe(409);
    expect((await clash.json()).error).toBe("display-name-taken");

    const second = await createGame(deps, hostId, jsonRequest("/api/games", "POST", { name: "Second" }));
    const secondId = (await second.json()).id;
    await invite({ permissionToInvite: true, emails: ["cy@example.com"] }, hostId, secondId);
    const cy = cookieOf(await claim(inviteToken(email.sent.at(-1)!)));
    expect((await setDisplayName(deps, asMember(cy, "/api/me/display-name", "POST", { displayName: "ada" }))).status).toBe(200);
  });

  it("lets a member keep or change their own name", async () => {
    const cookie = await join("ada@example.com", "Ada");

    expect((await setDisplayName(deps, asMember(cookie, "/api/me/display-name", "POST", { displayName: "ada" }))).status).toBe(200);
    expect((await setDisplayName(deps, asMember(cookie, "/api/me/display-name", "POST", { displayName: "Ada Lovelace" }))).status).toBe(200);
  });

  it("must be 1 to 40 visible characters", async () => {
    const cookie = await join("ada@example.com");

    for (const displayName of ["", "   ", "x".repeat(41), "bad\nname", 5]) {
      const response = await setDisplayName(deps, asMember(cookie, "/api/me/display-name", "POST", { displayName }));
      expect(response.status).toBe(422);
    }
  });

  it("need a signed-in member", async () => {
    expect((await setDisplayName(deps, jsonRequest("/api/me/display-name", "POST", { displayName: "Ada" }))).status).toBe(401);
    expect((await getMe(deps, jsonRequest("/api/me", "GET"))).status).toBe(401);
    expect((await getMe(deps, asMember(`${MEMBER_COOKIE}=forged`, "/api/me", "GET"))).status).toBe(401);
  });
});

describe("what a member sees", () => {
  it("is the board and the names of the others, never an email address", async () => {
    const ada = await join("ada@example.com", "Ada");
    await join("bob@example.com", "Bob");
    await join("cy@example.com");

    const me = await (await getMe(deps, asMember(ada, "/api/me", "GET"))).json();

    expect(me).toMatchObject({ displayName: "Ada", plays: true, helper: false, game: { id: gameId, board: { name: "Office exchange" } } });
    expect(me.members).toEqual([
      { id: expect.any(String), displayName: "Ada", plays: true, helper: false },
      { id: expect.any(String), displayName: "Bob", plays: true, helper: false },
    ]);
    expect(JSON.stringify(me)).not.toMatch(/@example\.com/);
  });
});

function linkParams(message: { text: string }, kind: "stop-emails" | "remove-me") {
  const match = new RegExp(`optout\\?member=([\\w-]+)&kind=${kind}&token=([\\w-]+)`).exec(message.text)!;
  return { member: match[1]!, kind, token: match[2]! };
}

function optOutRequest(body: unknown) {
  return optOut(deps, jsonRequest("/api/optout", "POST", body));
}

describe("opting out from an email", () => {
  it("'stop all emails for this game' ends all further mail to that member, from any email", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    // The link from the first, already superseded, email still works.
    const response = await optOutRequest(linkParams(email.sent[0]!, "stop-emails"));
    expect(response.status).toBe(200);

    email.reset();
    const again = await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    expect((await again.json()).results).toEqual([{ email: "ada@example.com", status: "emails-stopped" }]);
    expect(email.sent).toEqual([]);
    expect((await deps.db.select().from(members))[0]!.emailsStoppedAt).not.toBeNull();
  });

  it("'remove me and delete my email now' erases the address, ends the session and frees the name", async () => {
    const cookie = await join("ada@example.com", "Ada");
    const params = linkParams(email.sent[0]!, "remove-me");

    const response = await optOutRequest(params);

    expect(response.status).toBe(200);
    const [row] = await deps.db.select().from(members);
    expect(row).toMatchObject({ emailCiphertext: null, emailHash: null, displayName: null, displayNameKey: null });
    expect(row!.removedAt).not.toBeNull();
    expect((await getMe(deps, asMember(cookie, "/api/me", "GET"))).status).toBe(401);
    expect(await optOutRequest(params).then((r) => r.status)).toBe(200);

    const bob = await join("bob@example.com");
    expect((await setDisplayName(deps, asMember(bob, "/api/me/display-name", "POST", { displayName: "Ada" }))).status).toBe(200);
  });

  it("a removed member's old invite link no longer works", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    await optOutRequest(linkParams(email.sent[0]!, "remove-me"));

    expect((await claim(inviteToken(email.sent[0]!))).status).toBe(400);
  });

  it("refuses forged links: wrong token, wrong kind, unknown member", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const stop = linkParams(email.sent[0]!, "stop-emails");

    for (const body of [
      { ...stop, token: "forged" },
      { ...stop, kind: "remove-me" },
      { ...stop, member: "6f0c3c53-2f5f-4c7e-9a38-0b1f4f7f5a11" },
      { ...stop, kind: "other" },
      { ...stop, member: "not-a-uuid" },
    ]) {
      expect((await optOutRequest(body)).status).toBe(400);
    }
    expect((await deps.db.select().from(members))[0]).toMatchObject({ emailsStoppedAt: null, removedAt: null });
  });
});

describe("the host's view of members", () => {
  it("shows addresses to the host and to nobody else", async () => {
    const cookie = await join("ada@example.com", "Ada");
    await invite({ permissionToInvite: true, emails: ["bob@example.com"], plays: false });

    const response = await listMembers(deps, hostId, gameId);

    expect(response.status).toBe(200);
    expect((await response.json()).members).toEqual([
      { id: expect.any(String), email: "ada@example.com", displayName: "Ada", plays: true, helper: false, claimed: true, emailsStopped: false },
      { id: expect.any(String), email: "bob@example.com", displayName: null, plays: false, helper: false, claimed: false, emailsStopped: false },
    ]);
    const [other] = await deps.db
      .insert(hosts)
      .values({ email: "other@example.com", passwordHash: "unused", emailVerifiedAt: new Date() })
      .returning({ id: hosts.id });
    expect((await listMembers(deps, other!.id, gameId)).status).toBe(404);
    // A player's own view carries no addresses at all.
    expect(JSON.stringify(await (await getMe(deps, asMember(cookie, "/api/me", "GET"))).json())).not.toContain("@");
  });

  it("leaves out members who removed themselves", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    await optOutRequest(linkParams(email.sent[0]!, "remove-me"));

    expect((await (await listMembers(deps, hostId, gameId)).json()).members).toEqual([]);
  });
});

describe("appointing helpers", () => {
  async function memberIds() {
    return (await (await listMembers(deps, hostId, gameId)).json()).members.map((m: { id: string }) => m.id) as string[];
  }
  function appoint(memberId: string, version: number, host = hostId) {
    return appointHelper(deps, host, gameId, jsonRequest(`/api/games/${gameId}/helpers`, "POST", { memberId, version }));
  }

  it("lets the host appoint any member, playing or not, even one who has not joined yet", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    await invite({ permissionToInvite: true, emails: ["bob@example.com"], plays: false });
    const [ada, bob] = await memberIds();

    const first = await appoint(ada!, 1);
    expect(first.status).toBe(200);
    expect((await first.json()).board.helpers).toEqual([ada]);
    const second = await appoint(bob!, 2);
    expect((await second.json()).board).toMatchObject({ helpers: [ada, bob], version: 3 });
  });

  it("works on the fly, in the middle of the game", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com", "bob@example.com"] });
    const [ada, bob] = await memberIds();
    await deps.db.insert(gameEvents).values({
      gameId,
      seq: 2,
      type: "TurnStarted",
      payload: { type: "TurnStarted", memberId: ada, at: new Date().toISOString() },
    });

    expect((await appoint(bob!, 2)).status).toBe(200);
  });

  it("shows up as helper in the member's own view, and still hides addresses", async () => {
    const cookie = await join("ada@example.com", "Ada");
    const [ada] = await memberIds();
    await appoint(ada!, 1);

    const me = await (await getMe(deps, asMember(cookie, "/api/me", "GET"))).json();

    expect(me.helper).toBe(true);
    expect(me.members[0].helper).toBe(true);
    expect(JSON.stringify(me)).not.toContain("@");
  });

  it("rejects strangers, repeats and stale versions", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const [ada] = await memberIds();
    const [other] = await deps.db
      .insert(hosts)
      .values({ email: "other@example.com", passwordHash: "unused", emailVerifiedAt: new Date() })
      .returning({ id: hosts.id });

    expect((await appoint(ada!, 1, other!.id)).status).toBe(404);
    expect((await appoint("6f0c3c53-2f5f-4c7e-9a38-0b1f4f7f5a11", 1)).status).toBe(422);
    expect((await appoint("nonsense", 1)).status).toBe(422);
    const stale = await appoint(ada!, 0);
    expect(stale.status).toBe(409);
    expect((await stale.json()).board.version).toBe(1);
    await appoint(ada!, 1);
    const repeat = await appoint(ada!, 2);
    expect(repeat.status).toBe(422);
    expect((await repeat.json()).error).toBe("already-helper");
  });

  it("will not appoint someone who has removed themselves", async () => {
    await invite({ permissionToInvite: true, emails: ["ada@example.com"] });
    const [ada] = await memberIds();
    await optOutRequest(linkParams(email.sent[0]!, "remove-me"));

    expect((await appoint(ada!, 1)).status).toBe(422);
  });
});
