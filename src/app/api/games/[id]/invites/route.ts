import { inviteMembers } from "@/server/members";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const POST = hostRoute<{ id: string }>("games/[id]/invites", (deps, hostId, request, { id }) =>
  inviteMembers(deps, hostId, id, request),
);
