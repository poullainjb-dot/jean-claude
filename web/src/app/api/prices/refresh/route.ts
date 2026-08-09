import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { refreshLivePrices } from "@/lib/priceRefresh";

// Needs the Node.js runtime, not Edge — both `pg` and the plain `fetch`
// call to Twelve Data expect a full Node environment.
export const runtime = "nodejs";
// This does real work (paced network calls out to Twelve Data, DB writes)
// — never something to statically cache.
export const dynamic = "force-dynamic";
// A refresh covering many assets is paced at ~8s/asset to respect Twelve
// Data's free-tier rate limit (see priceRefresh.ts) — 20 assets is ~2.5
// minutes. Vercel may cap this below 300s depending on plan; if a refresh
// times out before finishing, that's the next thing to fix (splitting into
// client-driven batches), not yet needed until real usage shows it's a
// problem.
export const maxDuration = 300;

export async function POST() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const stats = await refreshLivePrices(client);
    return NextResponse.json({ stats });
  } catch (err) {
    console.error("live price refresh failed", err);
    return NextResponse.json({ error: "Internal error during price refresh" }, { status: 500 });
  } finally {
    client.release();
  }
}
