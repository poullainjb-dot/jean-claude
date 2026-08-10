"use client";

import { useState } from "react";

interface RefreshAssetResult {
  symbol: string;
  lookupSymbol: string;
  status: "ok" | "failed";
  provider?: string;
  inserted: number;
  updated: number;
  unchanged: number;
  error?: string;
}

interface RefreshStats {
  assetsChecked: number;
  succeeded: number;
  failed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  results: RefreshAssetResult[];
}

export function RefreshLivePricesForm() {
  const [status, setStatus] = useState<"idle" | "loading" | "done" | "error">("idle");
  const [stats, setStats] = useState<RefreshStats | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function handleRefresh() {
    setStatus("loading");
    setError(null);
    setStats(null);

    try {
      const res = await fetch("/api/prices/refresh", { method: "POST" });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Refresh failed");
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
    <div className="flex flex-col gap-4 max-w-md">
      <button
        type="button"
        onClick={handleRefresh}
        disabled={status === "loading"}
        className="rounded bg-black text-white px-4 py-2 disabled:opacity-50 dark:bg-white dark:text-black w-fit"
      >
        {status === "loading" ? "Fetching… (can take a few minutes)" : "Refresh live prices"}
      </button>

      {stats && (
        <div className="text-sm border rounded p-3 border-green-600/30 bg-green-600/10 flex flex-col gap-2">
          <p>
            Checked {stats.assetsChecked} asset(s) — {stats.succeeded} succeeded, {stats.failed} failed
          </p>
          <p>
            {stats.inserted} new price(s), {stats.updated} updated, {stats.unchanged} unchanged
          </p>
          {stats.results.some((r) => r.status === "ok") && (
            <div className="pt-1 border-t border-green-600/30">
              <p className="font-medium">Updated:</p>
              <ul className="list-disc list-inside">
                {stats.results
                  .filter((r) => r.status === "ok")
                  .map((r) => (
                    <li key={r.symbol}>
                      <span className="font-medium">{r.symbol}</span> via {r.provider}
                    </li>
                  ))}
              </ul>
            </div>
          )}
          {stats.results.some((r) => r.status !== "ok") && (
            <div className="pt-1 border-t border-green-600/30">
              <p className="font-medium">Not updated:</p>
              <ul className="list-disc list-inside">
                {stats.results
                  .filter((r) => r.status !== "ok")
                  .map((r) => (
                    <li key={r.symbol}>
                      <span className="font-medium">{r.symbol}</span>
                      {r.lookupSymbol !== r.symbol && <> (looked up as {r.lookupSymbol})</>} — {r.error}
                    </li>
                  ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <pre className="text-sm border rounded p-3 border-red-600/30 bg-red-600/10 whitespace-pre-wrap">
          {error}
        </pre>
      )}
    </div>
  );
}
