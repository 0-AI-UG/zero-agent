import { db } from "@/db/index.ts";
import { corsHeaders } from "@/lib/http/cors.ts";

export async function handleHealth(): Promise<Response> {
  try {
    // Probe SQLite to ensure it's working
    db.prepare("SELECT 1").get();
    return Response.json(
      { status: "ok" },
      { headers: corsHeaders },
    );
  } catch {
    return Response.json(
      { status: "error", error: "Database unavailable" },
      { status: 503, headers: corsHeaders },
    );
  }
}
