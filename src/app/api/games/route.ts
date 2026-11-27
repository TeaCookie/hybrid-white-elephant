import { createGame, listGames } from "@/server/handlers";
import { hostRoute } from "@/server/route";

export const dynamic = "force-dynamic";

export const GET = hostRoute("games", (deps, hostId) => listGames(deps, hostId));

export const POST = hostRoute("games", (deps, hostId, request) => createGame(deps, hostId, request));
