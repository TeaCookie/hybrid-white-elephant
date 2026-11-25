import { describe, expect, it } from "vitest";
import { FakeEmailSender } from "./fake-email";
import { FakePhotoStorage } from "./fake-photo-storage";

describe("FakeEmailSender", () => {
  it("records every message sent, in order", async () => {
    const email = new FakeEmailSender();

    await email.send({ to: "a@example.com", subject: "One", text: "first" });
    await email.send({ to: "b@example.com", subject: "Two", text: "second" });

    expect(email.sent.map((m) => m.to)).toEqual(["a@example.com", "b@example.com"]);
  });

  it("can be cleared between tests", async () => {
    const email = new FakeEmailSender();
    await email.send({ to: "a@example.com", subject: "One", text: "first" });

    email.reset();

    expect(email.sent).toEqual([]);
  });
});

describe("FakePhotoStorage", () => {
  it("returns the bytes that were stored under a key", async () => {
    const photos = new FakePhotoStorage();
    const bytes = new Uint8Array([1, 2, 3]);

    await photos.put("games/1/gift-1.jpg", bytes, "image/jpeg");

    expect(await photos.get("games/1/gift-1.jpg")).toEqual(bytes);
  });

  it("returns null for a key that was never stored", async () => {
    const photos = new FakePhotoStorage();

    expect(await photos.get("missing")).toBeNull();
  });

  it("forgets a deleted key", async () => {
    const photos = new FakePhotoStorage();
    await photos.put("k", new Uint8Array([9]), "image/jpeg");

    await photos.delete("k");

    expect(await photos.get("k")).toBeNull();
  });
});
