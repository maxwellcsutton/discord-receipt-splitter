import * as store from "./store.js";
import { ReceiptSession, LineItem, SplitEntry, UserTotal } from "../receipt/types.js";
import { calculateUserTotals } from "../receipt/calculator.js";

export function createReceiptSession(
  session: ReceiptSession,
  items: LineItem[]
): void {
  store.createSession(session, items);
}

export function getSession(threadId: string): ReceiptSession | null {
  return store.getSessionByThreadId(threadId);
}

export function getItems(sessionId: string): LineItem[] {
  return store.getLineItems(sessionId);
}

export function getSplits(sessionId: string): SplitEntry[] {
  return store.getSplitItems(sessionId);
}

export function claimItems(
  sessionId: string,
  itemIndices: number[],
  userId: string
): void {
  store.claimItems(sessionId, itemIndices, userId);
}

export function unclaimItems(
  sessionId: string,
  itemIndices: number[],
  userId: string
): void {
  store.unclaimItems(sessionId, itemIndices, userId);
}

export function editItemPrice(
  sessionId: string,
  itemIndex: number,
  newPrice: number,
): void {
  store.editItemPrice(sessionId, itemIndex, newPrice);
}

export function addItem(
  sessionId: string,
  name: string,
  unitPrice: number,
  quantity: number,
): number[] {
  return store.addItem(sessionId, name, unitPrice, quantity);
}

export function removeItem(sessionId: string, itemIndex: number): void {
  store.removeItem(sessionId, itemIndex);
}

export function splitItem(
  sessionId: string,
  itemIndex: number,
  userIds: string[],
  sharePcts?: number[] | null,
): void {
  store.splitItem(sessionId, itemIndex, userIds, sharePcts);
}

export function setRestaurantName(sessionId: string, name: string): void {
  store.updateRestaurantName(sessionId, name);
}

export function setTip(sessionId: string, tipAmount: number): void {
  store.updateTip(sessionId, tipAmount);
}

export function setDiscount(sessionId: string, discountAmount: number): void {
  store.updateDiscount(sessionId, discountAmount);
}

export function voidSession(sessionId: string): void {
  store.updateSessionStatus(sessionId, "voided");
}

export function replaceSessionItems(
  sessionId: string,
  items: LineItem[],
  totals: {
    subtotal: number;
    discountAmount: number;
    taxAmount: number;
    tipAmount: number | null;
    total: number;
  },
): void {
  store.replaceSessionItems(sessionId, items, totals);
}

export function markUserPaid(sessionId: string, userId: string): void {
  store.markPaid(sessionId, userId);
}

export function markUserUnpaid(sessionId: string, userId: string): void {
  store.markUnpaid(sessionId, userId);
}

export function addUserToSession(sessionId: string, userId: string): void {
  store.addTaggedUser(sessionId, userId);
}

export function setSummaryMessageId(
  sessionId: string,
  messageId: string
): void {
  store.updateSummaryMessageId(sessionId, messageId);
}

export function getUserTotals(session: ReceiptSession): UserTotal[] {
  const items = store.getLineItems(session.id);
  const splits = store.getSplitItems(session.id);
  return calculateUserTotals(session, items, splits);
}

export function getPaymentStatuses(
  sessionId: string
): { userId: string; paid: boolean }[] {
  return store.getUserPayments(sessionId);
}

export function recordSettlement(
  guildId: string,
  restaurantName: string,
  userTotals: { userId: string; grandTotal: number; tipShare?: number }[],
  sessionId?: string | null
): void {
  store.recordSettlement(guildId, restaurantName, userTotals, sessionId);
}

export function getLeaderboard(guildId: string): {
  restaurants: { restaurantName: string; totalSpend: number; receiptCount: number }[];
  users: { userId: string; totalSpend: number }[];
} {
  return {
    restaurants: store.getTopRestaurants(guildId),
    users: store.getTopUsers(guildId),
  };
}

export function getFilteredLeaderboard(
  guildId: string,
  range?: store.DateRange
): {
  restaurants: { restaurantName: string; totalSpend: number; receiptCount: number }[];
  users: { userId: string; totalSpend: number }[];
} {
  return store.getFilteredLeaderboard(guildId, range);
}

export function getRestaurantLeaderboard(
  guildId: string,
  restaurantName: string,
  range?: store.DateRange
): {
  totalSpend: number;
  receiptCount: number;
  topSpenders: { userId: string; totalSpend: number; visits: number }[];
} | null {
  return store.getRestaurantLeaderboard(guildId, restaurantName, range);
}

export function getPersonalStats(
  guildId: string,
  userId: string
): store.PersonalStats {
  return store.getPersonalStats(guildId, userId);
}

export function checkDailyLimit(): void {
  store.checkDailyLimit();
}

export function logApiCost(costUsd: number): void {
  const today = new Date().toISOString().slice(0, 10);
  store.addApiCost(today, costUsd);
}

export function getUnpaidSessionsForUser(
  guildId: string,
  userId: string
): ReceiptSession[] {
  return store.getUnpaidSessionsForUser(guildId, userId);
}

export function checkAllClaimedAndPaid(session: ReceiptSession): {
  allClaimed: boolean;
  allPaid: boolean;
} {
  const items = store.getLineItems(session.id);
  const payments = store.getUserPayments(session.id);

  const allClaimed = items.every((item) => item.claimedByUserId !== null);
  const allPaid =
    allClaimed && payments.length > 0 && payments.every((p) => p.paid);

  if (allClaimed && session.status === "active") {
    store.updateSessionStatus(session.id, "all_claimed");
  }
  if (allPaid && session.status !== "settled") {
    store.updateSessionStatus(session.id, "settled");
  }

  return { allClaimed, allPaid };
}
