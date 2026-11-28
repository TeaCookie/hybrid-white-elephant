"use client";

import { useState } from "react";

type State = "ask" | "done" | "failed";

/** The emailed link only opens this page; the change is made when the button is pressed, never by a link scanner. */
export function OptOutConfirm({ member, kind, token }: { member: string; kind: string; token: string }) {
  const [state, setState] = useState<State>("ask");
  const removing = kind === "remove-me";

  async function confirm() {
    const response = await fetch("/api/optout", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ member, kind, token }),
    });
    setState(response.ok ? "done" : "failed");
  }

  if (state === "done") {
    return removing ? (
      <>
        <h1>You have been removed</h1>
        <p>Your email address has been deleted and your seat is gone.</p>
      </>
    ) : (
      <>
        <h1>No more emails</h1>
        <p>We will not email you again about this game. Your seat is unchanged.</p>
      </>
    );
  }
  if (state === "failed") {
    return (
      <>
        <h1>This link does not work</h1>
        <p>It may be incomplete. Try the link from the email again.</p>
      </>
    );
  }
  return (
    <>
      <h1>{removing ? "Remove me and delete my email" : "Stop all emails for this game"}</h1>
      <p>
        {removing
          ? "This deletes your email address and takes you out of the game now."
          : "You will stay in the game but we will send you nothing more about it."}
      </p>
      <button onClick={confirm}>{removing ? "Remove me and delete my email" : "Stop all emails"}</button>
    </>
  );
}
