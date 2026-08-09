import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { computePositions, totalsByCurrency } from "@/lib/valuation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // never cache financial data

export async function GET() {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const positions = await computePositions(client);
    const totals = totalsByCurrency(positions);
    return NextResponse.json({ positions, totals });
  } finally {
    client.release();
  }
}
