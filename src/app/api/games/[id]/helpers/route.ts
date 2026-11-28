import { appointHelper } from "@/server/members";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const POST = hostRoute<{ id: string }>("games/[id]/helpers", (deps, hostId, request, { id }) =>
  appointHelper(deps, hostId, id, request),
);
