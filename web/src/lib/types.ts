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

export type RefreshAssetStatus = "ok" | "no_data" | "error";

export interface RefreshAssetResult {
  symbol: string; // the asset's own symbol (assets.symbol)
  lookupSymbol: string; // what was actually queried (price_symbol ?? symbol)
  status: RefreshAssetStatus;
  inserted: number;
  updated: number;
  unchanged: number;
  error?: string;
}

export interface RefreshStats {
  assetsChecked: number;
  succeeded: number;
  failed: number; // no_data + error
  inserted: number;
  updated: number;
  unchanged: number;
  results: RefreshAssetResult[];
}
