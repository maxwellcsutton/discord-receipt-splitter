import * as store from "./store.js";
import { ReceiptSession, LineItem, SplitEntry, UserTotal, ReceiptCategory } from "../receipt/types.js";
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

export function setSessionCategory(sessionId: string, category: ReceiptCategory): void {
  store.updateSessionCategory(sessionId, category);
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
    currencyCode?: string;
    rateToUsd?: number;
    rateDate?: string | null;
    originalSubtotal?: number;
    originalDiscount?: number;
    originalTax?: number;
    originalTip?: number | null;
    originalTotal?: number;
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

export function getUserVenmoHandle(userId: string): string | null {
  return store.getUserVenmoHandle(userId);
}

export function setUserVenmoHandle(userId: string, handle: string | null): void {
  store.setUserVenmoHandle(userId, handle);
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

export function getMostFrequentRestaurants(
  guildId: string,
  limit = 10
): { restaurantName: string; totalSpend: number; receiptCount: number }[] {
  return store.getMostFrequentRestaurants(guildId, limit);
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

export function getRecommendations(
  guildId: string,
  limit: number
): { restaurantName: string; visits: number; lastVisit: string; totalSpend: number }[] {
  return store.getRestaurantRecommendations(guildId, limit);
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

export function getRecentSessionsForUser(
  guildId: string,
  userId: string,
  limit: number
): ReceiptSession[] {
  return store.getRecentSessionsForUser(guildId, userId, limit);
}

export function getOpenSessionsForUser(
  guildId: string,
  userId: string
): ReceiptSession[] {
  return store.getOpenSessionsForUser(guildId, userId);
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

// --- Roulette ---

export function optIntoRoulette(sessionId: string, userId: string): void {
  store.optIntoRoulette(sessionId, userId);
}

export function optOutOfRoulette(sessionId: string, userId: string): void {
  store.optOutOfRoulette(sessionId, userId);
}

export function getRouletteOptIns(sessionId: string): string[] {
  return store.getRouletteOptIns(sessionId);
}

export function clearRouletteOptIns(sessionId: string): void {
  store.clearRouletteOptIns(sessionId);
}

export interface RouletteParticipant {
  userId: string;
  grandTotal: number;
  weight: number;
}

export interface RouletteResult {
  winnerUserId: string;
  poolTotal: number;
  participants: RouletteParticipant[];
  affectedItemCount: number;
}

export function runRoulette(session: ReceiptSession): RouletteResult {
  const optIns = getRouletteOptIns(session.id);
  if (optIns.length < 2) {
    throw new Error("At least 2 users must opt in to spin the roulette.");
  }

  const items = store.getLineItems(session.id);
  const splits = store.getSplitItems(session.id);

  const splitMap = new Map<number, SplitEntry[]>();
  for (const s of splits) {
    if (!splitMap.has(s.lineItemIndex)) {
      splitMap.set(s.lineItemIndex, []);
    }
    splitMap.get(s.lineItemIndex)!.push(s);
  }

  // Reject mixed opt-in/opt-out splits — we can't cleanly move only a portion
  // of an item to the winner without re-splitting.
  for (const [idx, itemSplits] of splitMap) {
    const hasOptedIn = itemSplits.some((s) => optIns.includes(s.userId));
    const hasNonOptedIn = itemSplits.some((s) => !optIns.includes(s.userId));
    if (hasOptedIn && hasNonOptedIn) {
      throw new Error(
        `Item ${idx} is split between opted-in and opted-out users. Unsplit it or have all participants opt in.`
      );
    }
  }

  // Items claimed by opted-in users (including fully opted-in splits).
  const affectedItems = items.filter((item) => {
    if (item.claimedByUserId && optIns.includes(item.claimedByUserId)) {
      return true;
    }
    const itemSplits = splitMap.get(item.index);
    return itemSplits?.some((s) => optIns.includes(s.userId)) ?? false;
  });

  if (affectedItems.length === 0) {
    throw new Error("Opted-in users have no claimed items to put in the pool.");
  }

  const userTotals = calculateUserTotals(session, items, splits);
  const participants = userTotals
    .filter((u) => optIns.includes(u.userId))
    .map((u) => ({
      userId: u.userId,
      grandTotal: u.grandTotal,
      weight: 0,
    }));

  if (participants.length < 2) {
    throw new Error("At least 2 opted-in users must have claimed items to spin.");
  }

  const poolTotal = participants.reduce((sum, p) => sum + p.grandTotal, 0);
  for (const p of participants) {
    p.weight = poolTotal > 0 ? p.grandTotal / poolTotal : 1 / participants.length;
  }

  // Weighted random selection.
  const rand = Math.random();
  let cumulative = 0;
  let winnerUserId = participants[0].userId;
  for (const p of participants) {
    cumulative += p.weight;
    if (rand <= cumulative) {
      winnerUserId = p.userId;
      break;
    }
  }

  // Move all affected items to the winner as sole owner.
  store.reassignItemsToUser(
    session.id,
    affectedItems.map((i) => i.index),
    winnerUserId
  );

  // Remove payment entries for opted-in users who didn't win.
  const nonWinners = optIns.filter((id) => id !== winnerUserId);
  store.removeUserPayments(session.id, nonWinners);

  // Ensure winner is tracked as unpaid for the new total.
  store.ensureUserPayment(session.id, winnerUserId);

  clearRouletteOptIns(session.id);

  return {
    winnerUserId,
    poolTotal,
    participants,
    affectedItemCount: affectedItems.length,
  };
}
