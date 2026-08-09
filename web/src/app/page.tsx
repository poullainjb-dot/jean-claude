import Link from "next/link";
import { ensureSchema, getPool } from "@/lib/db";
import { computePositions, totalsByCurrency } from "@/lib/valuation";

// Never cache financial data — always compute fresh from the DB.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function formatNum(n: number, digits = 2): string {
  return n.toLocaleString(undefined, { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export default async function Home() {
  const pool = getPool();
  const client = await pool.connect();
  let positions;
  let totals;
  try {
    await ensureSchema(client);
    positions = await computePositions(client);
    totals = totalsByCurrency(positions);
  } finally {
    client.release();
  }

  if (positions.length === 0) {
    return (
      <main className="max-w-3xl mx-auto p-8 flex flex-col gap-4">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <p className="text-sm opacity-70">
          No holdings yet.{" "}
          <Link href="/import" className="underline">
            Import a transactions CSV
          </Link>{" "}
          to get started.
        </p>
      </main>
    );
  }

  return (
    // min-w-0 throughout: `body` is a flex container (layout.tsx), and this
    // page is itself flex-col — without it, flex children default to
    // min-width:auto and let the wide positions table stretch the whole
    // page horizontally instead of scrolling inside its own container.
    <main className="max-w-4xl mx-auto p-8 flex flex-col gap-8 min-w-0 w-full">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Portfolio</h1>
        <Link href="/import" className="text-sm underline opacity-70">
          Import data
        </Link>
      </div>

      <section className="min-w-0">
        <h2 className="text-lg font-semibold mb-1">Totals by currency</h2>
        <p className="text-xs opacity-60 mb-3">
          No FX conversion yet — totals are shown per currency rather than combined into one number.
        </p>
        <div className="flex flex-wrap gap-4">
          {Object.entries(totals).map(([ccy, t]) => (
            <div key={ccy} className="border rounded p-4 min-w-[180px]">
              <div className="text-xs opacity-60">{ccy} value</div>
              <div className="text-2xl font-semibold">{formatNum(t.value)}</div>
              <div className={t.profit >= 0 ? "text-sm text-green-600" : "text-sm text-red-600"}>
                {t.profit >= 0 ? "+" : ""}
                {formatNum(t.profit)} profit
              </div>
              {t.missingPrice.length > 0 && (
                <div className="text-xs opacity-60 mt-1">⚠️ no price yet for: {t.missingPrice.join(", ")}</div>
              )}
            </div>
          ))}
        </div>
      </section>

      <section className="min-w-0">
        <h2 className="text-lg font-semibold mb-3">Positions</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm border-collapse whitespace-nowrap">
            <thead>
              <tr className="text-left border-b border-black/10 dark:border-white/20">
                <th className="py-2 pr-4">Symbol</th>
                <th className="py-2 pr-4">Name</th>
                <th className="py-2 pr-4">Class</th>
                <th className="py-2 pr-4">Currency</th>
                <th className="py-2 pr-4 text-right">Quantity</th>
                <th className="py-2 pr-4 text-right">Price</th>
                <th className="py-2 pr-4 text-right">Value</th>
                <th className="py-2 pr-4 text-right">Net contributions</th>
                <th className="py-2 pr-4 text-right">Profit</th>
                <th className="py-2 pr-4 text-right">Profit %</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.assetId} className="border-b border-black/5 dark:border-white/10">
                  <td className="py-2 pr-4 font-medium">{p.symbol}</td>
                  <td className="py-2 pr-4">{p.name}</td>
                  <td className="py-2 pr-4">{p.assetClass}</td>
                  <td className="py-2 pr-4">{p.currency}</td>
                  <td className="py-2 pr-4 text-right">{p.quantity}</td>
                  <td className="py-2 pr-4 text-right">{p.price !== null ? formatNum(p.price, 4) : "N/A"}</td>
                  <td className="py-2 pr-4 text-right">{p.value !== null ? formatNum(p.value) : "N/A"}</td>
                  <td className="py-2 pr-4 text-right">{formatNum(p.netContributions)}</td>
                  <td className="py-2 pr-4 text-right">{p.profit !== null ? formatNum(p.profit) : "N/A"}</td>
                  <td className="py-2 pr-4 text-right">
                    {p.profitPct !== null ? `${formatNum(p.profitPct, 1)}%` : "N/A"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </main>
  );
}
