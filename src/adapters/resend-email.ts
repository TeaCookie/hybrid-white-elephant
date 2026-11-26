import type { EmailMessage, EmailSender } from "@/ports/email";

/** Sends mail through Resend's HTTP API. */
export class ResendEmailSender implements EmailSender {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async send(message: EmailMessage): Promise<void> {
    const response = await this.fetchImpl("https://api.resend.com/emails", {
      method: "POST",
      headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
      body: JSON.stringify({ from: this.from, to: [message.to], subject: message.subject, text: message.text }),
    });
    // The response body is left out of the error: it can echo the recipient address.
    if (!response.ok) throw new Error(`Resend rejected the message with status ${response.status}`);
  }
}
