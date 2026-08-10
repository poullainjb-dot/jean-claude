import Link from "next/link";
import { ImportForm } from "../ImportForm";
import { LogoutButton } from "../LogoutButton";
import { PriceImportForm } from "../PriceImportForm";
import { PriceSymbolForm } from "../PriceSymbolForm";
import { RefreshLivePricesForm } from "../RefreshLivePricesForm";

export default function ImportPage() {
  return (
    <main className="max-w-3xl mx-auto p-8 flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Import data</h1>
        <div className="flex items-center gap-4">
          <Link href="/assets" className="text-sm underline opacity-70">
            Assets
          </Link>
          <Link href="/" className="text-sm underline opacity-70">
            ← Dashboard
          </Link>
          <LogoutButton />
        </div>
      </div>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Transactions</h2>
        <p className="text-sm opacity-70">
          See <code>sample_data/transactions_template.csv</code> in the repo for the format.
        </p>
        <ImportForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Prices — live (stocks &amp; ETFs)</h2>
        <p className="text-sm opacity-70">
          Fetches recent daily closes for every stock/ETF asset — Yahoo Finance first (broad
          exchange coverage, including non-US), Twelve Data as a fallback (official, reliable for US
          tickers, backstop if Yahoo has an outage). Looks up each asset&apos;s <code>symbol</code>{" "}
          directly unless a{" "}
          <code>price_symbol</code> override is set (see &quot;Price symbols&quot; below) — a failed
          lookup is reported per-asset, showing what each provider said, not silently skipped.
          Doesn&apos;t touch cash, gold, or crypto; those get their own connectors later. Can take a
          few minutes for many assets — the page will wait for it.
        </p>
        <RefreshLivePricesForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Price symbols</h2>
        <p className="text-sm opacity-70">
          Set <code>price_symbol</code> in bulk for assets whose <code>symbol</code> isn&apos;t
          something a price provider recognizes directly — an ISIN, or a non-US listing needing an
          exchange suffix (e.g. <code>IWDA</code> → <code>IWDA.AS</code>). Columns:{" "}
          <code>asset_symbol,price_symbol</code>; leave <code>price_symbol</code> blank to clear an
          existing override. See{" "}
          <Link href="/assets" className="underline">
            Assets
          </Link>{" "}
          for current values, and <code>sample_data/price_symbols_template.csv</code> for the format.
        </p>
        <PriceSymbolForm />
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-lg font-semibold">Prices — manual CSV</h2>
        <p className="text-sm opacity-70">
          Fallback for any asset the live refresh above can&apos;t reach. The asset must already
          exist — import its transactions first. See <code>sample_data/prices_template.csv</code>.
          Cash assets never need a price.
        </p>
        <PriceImportForm />
      </section>
    </main>
  );
}
