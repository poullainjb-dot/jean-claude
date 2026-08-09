import { NextResponse } from "next/server";
import { ensureSchema, getPool } from "@/lib/db";
import { CsvValidationError, importTransactionsCsv } from "@/lib/importer";

// Needs the Node.js runtime, not Edge — the `pg` driver uses raw TCP sockets.
export const runtime = "nodejs";

export async function POST(request: Request) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "Missing 'file' in form data" }, { status: 400 });
  }

  const csvText = await file.text();
  const pool = getPool();
  const client = await pool.connect();
  try {
    await ensureSchema(client);
    const stats = await importTransactionsCsv(csvText, client);
    return NextResponse.json({ stats });
  } catch (err) {
    if (err instanceof CsvValidationError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("transactions import failed", err);
    return NextResponse.json({ error: "Internal error during import" }, { status: 500 });
  } finally {
    client.release();
  }
}
