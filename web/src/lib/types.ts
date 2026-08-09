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
