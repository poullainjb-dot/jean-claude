import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { refreshLivePrices } from "@/lib/priceRefresh";

// Needs the Node.js runtime, not Edge — both `pg` and yahoo-finance2's
// underlying HTTP client expect a full Node environment.
export const runtime = "nodejs";
// This does real work (network calls out to Yahoo Finance, DB writes) —
// never something to statically cache.
export const dynamic = "force-dynamic";

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
