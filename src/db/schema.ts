import { bigserial, boolean, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** A host's account. Only the argon2id hash of the password is ever stored. */
export const hosts = pgTable("hosts", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Always stored lower-cased and trimmed. */
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  failedLoginCount: integer("failed_login_count").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** One-time emailed tokens (verify email, reset password). Only the SHA-256 of the token is stored. */
export const hostTokens = pgTable("host_tokens", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  kind: text("kind", { enum: ["verify-email", "reset-password"] }).notNull(),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Login sessions. The cookie carries the raw token; only its SHA-256 is stored. */
export const hostSessions = pgTable("host_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const games = pgTable("games", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** Deleting the host's account deletes their games (and, through the cascade, each game's events). */
  hostId: uuid("host_id")
    .notNull()
    .references(() => hosts.id, { onDelete: "cascade" }),
  /** Set when the game ends. A game with no end date is active and counts toward the host's limit of three. */
  endedAt: timestamp("ended_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Append-only event log. Board state is always derived from these rows. */
export const gameEvents = pgTable(
  "game_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [unique("game_events_game_seq").on(t.gameId, t.seq)],
);

/**
 * A seat in one game. The address is stored only encrypted (`emailCiphertext`) plus a keyed hash
 * for lookups; both are cleared when the person removes themselves. Whether a member is a helper
 * lives in the event log, not here.
 */
export const members = pgTable(
  "members",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    emailCiphertext: text("email_ciphertext"),
    emailHash: text("email_hash"),
    /** Whether this member takes turns. A non-playing member can still be a helper. */
    plays: boolean("plays").notNull().default(true),
    /** Chosen when the seat is claimed. */
    displayName: text("display_name"),
    /** The display name, lower-cased, so names are unique within a game regardless of case. */
    displayNameKey: text("display_name_key"),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    /** Set by "stop all emails for this game": nothing more is sent to this member. */
    emailsStoppedAt: timestamp("emails_stopped_at", { withTimezone: true }),
    /** Set by "remove me and delete my email now". */
    removedAt: timestamp("removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    unique("members_game_email_hash").on(t.gameId, t.emailHash),
    uniqueIndex("members_game_display_name").on(t.gameId, t.displayNameKey).where(sql`${t.displayNameKey} is not null`),
  ],
);

/** Invite links. Only the SHA-256 of the token is stored; a link works once, and only after Continue. */
export const memberInvites = pgTable("member_invites", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** A player's long-lived session. The cookie carries the raw token; only its SHA-256 is stored. */
export const memberSessions = pgTable("member_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  memberId: uuid("member_id")
    .notNull()
    .references(() => members.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
