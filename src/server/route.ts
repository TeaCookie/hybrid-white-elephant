import { currentHost } from "./accounts";
import { describeError } from "./handlers";
import type { Deps } from "./deps";
import { productionDeps } from "./production";

/** Runs a handler with the deployed dependencies. Failures become a 500 and log only the error name and code. */
export function route(name: string, handler: (deps: Deps, request: Request) => Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    try {
      return await handler(productionDeps(), request);
    } catch (error) {
      console.error(`${name}: unhandled error`, describeError(error));
      return Response.json({ error: "server-error" }, { status: 500 });
    }
  };
}

/**
 * Like `route`, for endpoints only a signed-in host may use. Without a valid session the answer is 401;
 * otherwise the handler gets the host's id and the route's path parameters (such as the game's id).
 */
export function hostRoute<Params extends Record<string, string> = Record<string, never>>(
  name: string,
  handler: (deps: Deps, hostId: string, request: Request, params: Params) => Promise<Response>,
) {
  return async (request: Request, context: { params: Promise<Params> }): Promise<Response> => {
    try {
      const deps = productionDeps();
      const host = await currentHost(deps, request);
      if (!host) return Response.json({ error: "not-signed-in" }, { status: 401 });
      return await handler(deps, host.id, request, await context.params);
    } catch (error) {
      console.error(`${name}: unhandled error`, describeError(error));
      return Response.json({ error: "server-error" }, { status: 500 });
    }
  };
}
