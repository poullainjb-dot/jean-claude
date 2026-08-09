import Link from "next/link";
import { ImportForm } from "../ImportForm";
import { LogoutButton } from "../LogoutButton";
import { PriceImportForm } from "../PriceImportForm";

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
        <h2 className="text-lg font-semibold">Prices</h2>
        <p className="text-sm opacity-70">
          The asset must already exist — import its transactions first. See{" "}
          <code>sample_data/prices_template.csv</code>. Cash assets never need a price.
        </p>
        <PriceImportForm />
      </section>
    </main>
  );
}
