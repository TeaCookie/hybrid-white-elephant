import { setDisplayName } from "@/server/members";
import { route } from "@/server/route";

export const dynamic = "force-dynamic";

export const POST = route("me/display-name", setDisplayName);
