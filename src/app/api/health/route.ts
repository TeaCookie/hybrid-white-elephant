import { health } from "@/server/handlers";
import { productionDeps } from "@/server/production";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return await health(productionDeps());
  } catch {
    return Response.json({ status: "error" }, { status: 503 });
  }
}
