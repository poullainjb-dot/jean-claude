import { NextResponse } from "next/server";
import { importBoleroPositionsXlsx } from "@/lib/boleroPositionsImporter";
import { CsvValidationError } from "@/lib/csv";
import { ensureSchema, getPool } from "@/lib/db";

// Needs the Node.js runtime, not Edge — the `pg` driver uses raw TCP sockets.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  const buffer = Buffer.from(await file.arrayBuffer());
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const stats = await importBoleroPositionsXlsx(buffer, client);
    return NextResponse.json({ stats });
  } catch (err) {
    if (err instanceof CsvValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("Bolero positions import failed", err);
    return NextResponse.json({ error: "Internal error during import" }, { status: 500 });
  } finally {
    client.release();
  }
}
