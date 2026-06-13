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
  status: SessionStatus;
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
