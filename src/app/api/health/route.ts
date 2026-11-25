import { describeError, health } from "@/server/handlers";
import { productionDeps } from "@/server/production";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return await health(productionDeps());
  } catch (error) {
    console.error("health: could not build dependencies", describeError(error));
    return Response.json({ status: "error" }, { status: 503 });
  }
}
