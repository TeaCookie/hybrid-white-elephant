import { logIn } from "@/server/accounts";
import { route } from "@/server/route";

export const dynamic = "force-dynamic";

export const POST = route("auth/login", logIn);
