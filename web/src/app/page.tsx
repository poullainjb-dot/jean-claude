import { ImportForm } from "./ImportForm";

export default function Home() {
  return (
    <main className="max-w-3xl mx-auto p-8 flex flex-col gap-6">
      <h1 className="text-2xl font-bold">Portfolio</h1>
      <p className="text-sm opacity-70">
        Import a transactions CSV to get started — see{" "}
        <code>sample_data/transactions_template.csv</code> in the repo for the format.
      </p>
      <ImportForm />
    </main>
  );
}
