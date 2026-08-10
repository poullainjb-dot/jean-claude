import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const res = await client.query(
      "SELECT symbol, name, asset_class, currency, price_symbol FROM assets ORDER BY symbol",
    );
    return NextResponse.json({ assets: res.rows });
  } finally {
    client.release();
  }
}
