import { getHostGame } from "@/server/handlers";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = hostRoute<{ id: string }>("games/[id]", (deps, hostId, _request, { id }) =>
  getHostGame(deps, hostId, id),
);
