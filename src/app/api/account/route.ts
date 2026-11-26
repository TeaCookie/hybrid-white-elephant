import { currentHost, deleteAccount } from "@/server/accounts";
import { route } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = route("account", async (deps, request) => {
  const host = await currentHost(deps, request);
  return host ? Response.json(host) : Response.json({ error: "not-signed-in" }, { status: 401 });
});

export const DELETE = route("account", deleteAccount);
