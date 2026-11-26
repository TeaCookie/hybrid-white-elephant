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
