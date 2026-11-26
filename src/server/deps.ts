import type { Db } from "@/db/client";
import type { EmailSender } from "@/ports/email";
import type { PhotoStorage } from "@/ports/photo-storage";

/** Everything a request handler needs from the outside world. Tests pass fakes for email and photos. */
export type Deps = {
  db: Db;
  email: EmailSender;
  photos: PhotoStorage;
  now: () => Date;
  /** Public origin of the app, used to build links in emails. No trailing slash. */
  baseUrl: string;
};
