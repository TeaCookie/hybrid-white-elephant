import { previewInvite } from "@/server/members";
import { route } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = route("invites/preview", previewInvite);
