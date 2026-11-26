import { describe, expect, it } from "vitest";
import { ResendEmailSender } from "./resend-email";

describe("ResendEmailSender", () => {
  it("posts the message to Resend with the API key and sender address", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await new ResendEmailSender("re_key", "Elephant <hi@example.com>", fetchImpl).send({
      to: "host@example.com",
      subject: "Hello",
      text: "Body",
    });

    expect(calls[0]?.url).toBe("https://api.resend.com/emails");
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe("Bearer re_key");
    expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
      from: "Elephant <hi@example.com>",
      to: ["host@example.com"],
      subject: "Hello",
      text: "Body",
    });
  });

  it("fails without echoing the response body when Resend refuses", async () => {
    const fetchImpl = (async () => new Response("bad address host@example.com", { status: 422 })) as unknown as typeof fetch;
    const sender = new ResendEmailSender("re_key", "hi@example.com", fetchImpl);

    const failure = await sender.send({ to: "host@example.com", subject: "s", text: "t" }).catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain("422");
    expect((failure as Error).message).not.toContain("host@example.com");
  });
});
