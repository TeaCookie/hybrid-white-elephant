import Link from "next/link";
import { InviteFlow } from "./invite-flow";

export const metadata = { title: "Join the exchange · Hybrid White Elephant", referrer: "no-referrer" as const };

export default async function InvitePage({ searchParams }: { searchParams: Promise<{ token?: string }> }) {
  const { token } = await searchParams;
  return (
    <main style={{ maxWidth: "32rem", margin: "0 auto", lineHeight: 1.5 }}>
      <InviteFlow token={token ?? ""} />
      <p style={{ marginTop: "2rem", fontSize: "0.9rem" }}>
        <Link href="/privacy">How we handle your email</Link>
      </p>
    </main>
  );
}
