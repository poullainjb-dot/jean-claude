import Link from "next/link";
import { ImportForm } from "../ImportForm";
import { LogoutButton } from "../LogoutButton";
import { PriceImportForm } from "../PriceImportForm";
import { RefreshLivePricesForm } from "../RefreshLivePricesForm";

export default function ImportPage() {
  return (
    <main className="max-w-3xl mx-auto p-8 flex flex-col gap-8">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Import data</h1>
        <div className="flex items-center gap-4">
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
          Fetches recent daily closes from Yahoo Finance for every stock/ETF asset. Looks up each
          asset&apos;s <code>symbol</code> directly unless a <code>price_symbol</code> override is set
          on it (needed if your symbol is an ISIN, or a non-US listing needs an exchange suffix like{" "}
          <code>.AS</code>) — a failed lookup is reported per-asset below, not silently skipped.
          Doesn&apos;t touch cash, gold, or crypto; those get their own connectors later.
        </p>
        <RefreshLivePricesForm />
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
