import { updateRules } from "@/server/handlers";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const POST = hostRoute<{ id: string }>("games/[id]/rules", (deps, hostId, request, { id }) =>
  updateRules(deps, hostId, id, request),
);
