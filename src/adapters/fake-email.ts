import type { EmailMessage, EmailSender } from "@/ports/email";

/** In-memory EmailSender for tests: records messages instead of sending them. */
export class FakeEmailSender implements EmailSender {
  sent: EmailMessage[] = [];

  async send(message: EmailMessage): Promise<void> {
    this.sent.push(message);
  }

  reset(): void {
    this.sent = [];
  }
}
