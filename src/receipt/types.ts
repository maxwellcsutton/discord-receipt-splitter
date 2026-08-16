export interface ParsedReceiptItem {
  name: string;
  quantity: number;
  unit_price: number;
  total_price: number;
  // Per-unit price printed on the receipt line (e.g. "18.99" in "5 @18.99"),
  // or null. Used to anchor line totals against skew-induced price shifts.
  printed_unit_price: number | null;
}

export interface ParsedReceipt {
  items: ParsedReceiptItem[];
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
  // ISO 4217 currency code detected on the receipt. Defaults to USD.
  currencyCode: string;
  // USD exchange rate used (1 for USD receipts).
  rateToUsd: number;
  // Date of the exchange rate, if available from the rate provider.
  rateDate: string | null;
  // Original receipt amounts before conversion to USD.
  originalSubtotal: number;
  originalDiscount: number;
  originalTax: number;
  originalTip: number | null;
  originalTotal: number;
}

export interface LineItem {
  index: number;
  name: string;
  unitPrice: number;
  originalQuantity: number;
  claimedByUserId: string | null;
}

export interface SplitEntry {
  sessionId: string;
  lineItemIndex: number;
  userId: string;
  shareCount: number;
  sharePct: number | null;
}

export type SessionStatus = "active" | "all_claimed" | "settled" | "voided";
export type ReceiptCategory = "food" | "non_food";

export interface ReceiptSession {
  id: string;
  threadId: string;
  originalMessageId: string;
  channelId: string;
  guildId: string;
  primaryUserId: string;
  restaurantName: string;
  subtotal: number;
  discountAmount: number;
  taxAmount: number;
  tipAmount: number | null;
  total: number;
  // ISO 4217 currency code detected on the receipt. All stored amounts are USD.
  currencyCode: string;
  rateToUsd: number;
  rateDate: string | null;
  originalSubtotal: number;
  originalDiscount: number;
  originalTax: number;
  originalTip: number | null;
  originalTotal: number;
  status: SessionStatus;
  category: ReceiptCategory;
  summaryMessageId: string | null;
  taggedUserIds: string[];
  createdAt: string;
}

export interface UserTotal {
  userId: string;
  itemsTotal: number;
  taxShare: number;
  tipShare: number;
  grandTotal: number;
  items: { index: number; name: string; amount: number }[];
}
