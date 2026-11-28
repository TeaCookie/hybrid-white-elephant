import { OptOutConfirm } from "./optout-confirm";

export const metadata = { title: "Email choices · Hybrid White Elephant" };

export default async function OptOutPage({
  searchParams,
}: {
  searchParams: Promise<{ member?: string; kind?: string; token?: string }>;
}) {
  const { member, kind, token } = await searchParams;
  return (
    <main style={{ maxWidth: "32rem", margin: "0 auto", lineHeight: 1.5 }}>
      <OptOutConfirm member={member ?? ""} kind={kind ?? ""} token={token ?? ""} />
    </main>
  );
}
