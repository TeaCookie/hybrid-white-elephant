import type { Deps } from "./deps";
import { decryptEmail, optOutToken, type OptOutKind } from "./member-crypto";

/** The part of a member row the mailer needs. */
export type Mailable = { id: string; emailCiphertext: string | null; emailsStoppedAt: Date | null };

export function optOutLink(deps: Deps, kind: OptOutKind, memberId: string): string {
  const token = optOutToken(deps.emailKeys, kind, memberId);
  return `${deps.baseUrl}/optout?member=${memberId}&kind=${kind}&token=${token}`;
}

/**
 * Sends one email to a member. Every email ends with both opt-out links and the privacy notice.
 * Nothing is sent once the member has stopped emails or removed themselves. Returns whether it was sent.
 */
export async function sendToMember(deps: Deps, member: Mailable, subject: string, body: string): Promise<boolean> {
  if (member.emailsStoppedAt || !member.emailCiphertext) return false;
  const footer = [
    "--",
    `To stop all emails for this game, open: ${optOutLink(deps, "stop-emails", member.id)}`,
    `To remove me and delete my email now, open: ${optOutLink(deps, "remove-me", member.id)}`,
    `How we handle your email: ${deps.baseUrl}/privacy`,
  ].join("\n");
  await deps.email.send({
    to: decryptEmail(deps.emailKeys, member.emailCiphertext),
    subject,
    text: `${body}\n\n${footer}`,
  });
  return true;
}
