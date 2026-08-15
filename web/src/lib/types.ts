export type AssetClass = "stock" | "etf" | "cash" | "gold" | "crypto";

export type TransactionType =
  | "buy"
  | "sell"
  | "deposit"
  | "withdrawal"
  | "interest"
  | "dividend";

export interface ImportStats {
  rowsRead: number;
  assetsCreated: number;
  inserted: number;
  skippedDuplicates: number;
}

export interface ImportPricesStats {
  rowsRead: number;
  inserted: number;
  updated: number;
  unchanged: number;
}

export type RefreshAssetStatus = "ok" | "failed";

export interface RefreshAssetResult {
  symbol: string; // the asset's own symbol (assets.symbol)
  lookupSymbol: string; // what was actually queried (price_symbol ?? symbol)
  status: RefreshAssetStatus;
  provider?: string; // which provider succeeded, when status is "ok"
  inserted: number;
  updated: number;
  unchanged: number;
  // One message per provider tried, e.g. "twelvedata: ...; yahoo: ...",
  // present when status is "failed" — every provider gets a say, since a
  // Twelve Data-only message would hide that Yahoo was tried too.
  error?: string;
}

export interface RefreshStats {
  assetsChecked: number;
  succeeded: number;
  failed: number;
  inserted: number;
  updated: number;
  unchanged: number;
  results: RefreshAssetResult[];
}

export interface PriceSymbolStats {
  rowsRead: number;
  updated: number;
  unchanged: number;
  cleared: number; // rows that explicitly blanked out an existing override
}

export interface BoleroPositionsStats {
  rowsRead: number;
  assetsCreated: number;
  inserted: number; // new synthetic snapshot transactions
  updated: number; // existing snapshot transactions whose quantity/cost changed
  removed: number; // snapshot transactions dropped because the position is no longer in this export
}
