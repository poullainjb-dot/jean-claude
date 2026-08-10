import Link from "next/link";
import { ensureSchema, getPool } from "@/lib/db";
import { LogoutButton } from "../LogoutButton";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface AssetRow {
  symbol: string;
  name: string | null;
  asset_class: string;
  currency: string;
  price_symbol: string | null;
}

export default async function AssetsPage() {
  const pool = getPool();
  const client = await pool.connect();
  let assets: AssetRow[];
  try {
    await ensureSchema(client);
    const res = await client.query<AssetRow>(
      "SELECT symbol, name, asset_class, currency, price_symbol FROM assets ORDER BY symbol",
    );
    assets = res.rows;
  } finally {
    client.release();
  }

  return (
    <main className="max-w-3xl mx-auto p-8 flex flex-col gap-6 min-w-0 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Assets</h1>
        <div className="flex items-center gap-4">
          <Link href="/import" className="text-sm underline opacity-70">
            Import data
          </Link>
          <Link href="/" className="text-sm underline opacity-70">
            Dashboard
          </Link>
          <LogoutButton />
        </div>
      </div>

      <p className="text-sm opacity-70">
        <code>price_symbol</code> is what the live price refresh actually looks up, when set — see{" "}
        <Link href="/import" className="underline">
          Import data
        </Link>{" "}
        to bulk-set these from a CSV.
      </p>

      {assets.length === 0 ? (
        <p className="text-sm opacity-70">No assets yet.</p>
      ) : (
        <div className="overflow-x-auto min-w-0">
          <table className="w-full text-sm border-collapse whitespace-nowrap">
            <thead>
              <tr className="text-left border-b border-black/10 dark:border-white/20">
                <th className="py-2 pr-4">Symbol</th>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Class</th>
                <th className="py-2 pr-4">Currency</th>
                <th className="py-2 pr-4">price_symbol</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.symbol} className="border-b border-black/5 dark:border-white/10">
                  <td className="py-2 pr-4 font-medium">{a.symbol}</td>
                  <td className="py-2 pr-4">{a.name}</td>
                  <td className="py-2 pr-4">{a.asset_class}</td>
                  <td className="py-2 pr-4">{a.currency}</td>
                  <td className="py-2 pr-4">
                    {a.price_symbol ? (
                      a.price_symbol
                    ) : (
                      <span className="opacity-50">— (uses {a.symbol})</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </main>
  );
}
