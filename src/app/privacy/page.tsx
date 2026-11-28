export const metadata = { title: "Privacy notice · Hybrid White Elephant" };

export default function Privacy() {
  return (
    <main style={{ maxWidth: "36rem", margin: "0 auto", lineHeight: 1.5 }}>
      <h1>How we handle your email</h1>
      <p>
        The person running your gift exchange (the host) gave us your email address so we can invite you and send reminders about
        your turn. That is all we use it for.
      </p>
      <ul>
        <li>We store your address encrypted, with a separate scrambled copy used only to avoid inviting the same address twice.</li>
        <li>Only the host can see your address. Helpers and other players see just your display name.</li>
        <li>We never write your address to our logs, and we never sell or share it.</li>
        <li>
          Every email we send has two links: one to stop all emails for this game, and one to remove you from the game and delete
          your email straight away.
        </li>
        <li>You never need an account or password to play. Your invite link signs this device in.</li>
      </ul>
    </main>
  );
}
