export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

/** Sends transactional email. The real adapter (Resend) arrives with the first feature that sends mail. */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}
