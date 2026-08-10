"use client";

import { useState } from "react";

interface PriceSymbolStats {
  rowsRead: number;
  updated: number;
  unchanged: number;
  cleared: number;
}

export function PriceSymbolForm() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [stats, setStats] = useState<PriceSymbolStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!file) return;

    setStatus("loading");
    setError(null);
    setStats(null);

    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/assets/price-symbols", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Import failed");
        setStatus("error");
        return;
      }
      setStats(data.stats);
      setStatus("done");
    } catch (err) {
      setError((err as Error).message);
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4 max-w-md">
      <label className="flex flex-col gap-1">
        <span className="text-sm font-medium">price_symbol overrides CSV</span>
        <input
          type="file"
          accept=".csv"
          onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          className="border rounded p-2 text-sm"
        />
      </label>

      <button
        type="submit"
        disabled={!file || status === "loading"}
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50 dark:bg-white dark:text-black w-fit"
      >
        {status === "loading" ? "Importing…" : "Set price symbols"}
      </button>

      {stats && (
        <div className="text-sm border rounded p-3 border-green-600/30 bg-green-600/10">
          <p>Read {stats.rowsRead} row(s)</p>
          <p>Set/changed {stats.updated} override(s)</p>
          <p>Cleared {stats.cleared} override(s)</p>
          <p>Unchanged {stats.unchanged}</p>
        </div>
      )}

      {error && (
        <pre className="text-sm border rounded p-3 border-red-600/30 bg-red-600/10 whitespace-pre-wrap">
          {error}
        </pre>
      )}
    </form>
  );
}
