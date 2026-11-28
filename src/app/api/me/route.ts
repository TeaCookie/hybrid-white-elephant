import { getMe } from "@/server/members";
import { route } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = route("me", getMe);
