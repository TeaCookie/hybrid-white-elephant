import { listMembers } from "@/server/members";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = hostRoute<{ id: string }>("games/[id]/members", (deps, hostId, _request, { id }) =>
  listMembers(deps, hostId, id),
);
