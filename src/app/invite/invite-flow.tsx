"use client";

import { useEffect, useState, type FormEvent } from "react";

type Step = "loading" | "invalid" | "continue" | "name" | "done";

/** Opening the link only previews the invite. Nothing is claimed until Continue is pressed, so mail scanners cannot burn it. */
export function InviteFlow({ token }: { token: string }) {
  const [step, setStep] = useState<Step>("loading");
  const [gameName, setGameName] = useState<string | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      const response = await fetch(`/api/invites/preview?token=${encodeURIComponent(token)}`);
      if (!response.ok) return setStep("invalid");
      setGameName((await response.json()).gameName);
      setStep("continue");
    })();
  }, [token]);

  async function onContinue() {
    setError("");
    const response = await fetch("/api/invites/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (!response.ok) return setStep("invalid");
    setStep((await response.json()).needsDisplayName ? "name" : "done");
  }

  async function onName(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    const displayName = String(new FormData(event.currentTarget).get("displayName") ?? "");
    const response = await fetch("/api/me/display-name", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ displayName }),
    });
    if (response.ok) return setStep("done");
    const { error: code } = await response.json();
    setError(code === "display-name-taken" ? "Someone in this game already has that name. Try another." : "Use 1 to 40 characters.");
  }

  if (step === "loading") return <p>Checking your invite…</p>;
  if (step === "invalid") {
    return (
      <>
        <h1>This invite link does not work</h1>
        <p>It may have been used already, or replaced by a newer one. Ask the host to send you a fresh invite.</p>
      </>
    );
  }
  if (step === "continue") {
    return (
      <>
        <h1>You are invited{gameName ? ` to ${gameName}` : ""}</h1>
        <p>Choose Continue to take your seat. This device will stay signed in.</p>
        <button onClick={onContinue}>Continue</button>
      </>
    );
  }
  if (step === "name") {
    return (
      <>
        <h1>Pick a display name</h1>
        <p>This is how the others in the game will see you. It must be different from everyone else&apos;s.</p>
        <form onSubmit={onName}>
          <input name="displayName" required maxLength={40} autoComplete="nickname" aria-label="Display name" />{" "}
          <button type="submit">Save</button>
        </form>
        {error && <p role="alert">{error}</p>}
      </>
    );
  }
  return (
    <>
      <h1>You are in</h1>
      <p>Your seat is saved on this device. We will email you when it is nearly your turn.</p>
    </>
  );
}
