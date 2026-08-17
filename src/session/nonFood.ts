import type Database from "better-sqlite3";
import { normalizeRestaurantName } from "../utils/restaurantName.js";

// Removing a receipt from the leaderboards means undoing three things at once:
// the per-receipt history in settlement_entries, and the two aggregate tables
// (user_stats, restaurant_stats) that were incremented when it settled. Doing
// only the first leaves the restaurant on `leaderboard`; doing only the last
// leaves it in date-filtered views. This module owns that unwind so the
// migrations and the `nonfood` command can't drift apart.

export interface PurgeFilter {
  /** Purge every entry recorded for these sessions. */
  sessionIds?: string[];
  /** Purge every entry recorded under these restaurant names, session or not. */
  restaurantNames?: string[];
}

/**
 * Deletes the matching settlement history and subtracts it back out of the
 * aggregate stats tables. Returns the number of entries removed.
 *
 * Name-based purges also drop any leftover restaurant_stats row for those names,
 * so restaurants that predate settlement_entries (and therefore have aggregate
 * totals with no history to subtract) still disappear from the leaderboard.
 */
export function purgeLeaderboardEntries(
  db: Database.Database,
  filter: PurgeFilter
): number {
  const clauses: string[] = [];
  const params: string[] = [];

  const sessionIds = filter.sessionIds ?? [];
  if (sessionIds.length > 0) {
    clauses.push(`session_id IN (${sessionIds.map(() => "?").join(",")})`);
    params.push(...sessionIds);
  }

  // Entries are stored under the canonical (lowercase) name — see utils/restaurantName.ts.
  const names = (filter.restaurantNames ?? []).map(normalizeRestaurantName);
  if (names.length > 0) {
    clauses.push(`LOWER(restaurant_name) IN (${names.map(() => "?").join(",")})`);
    params.push(...names);
  }

  if (clauses.length === 0) return 0;
  const where = clauses.join(" OR ");

  const tx = db.transaction(() => {
    const entries = db
      .prepare(
        `SELECT settlement_id, guild_id, user_id, restaurant_name, amount
         FROM settlement_entries
         WHERE ${where}`
      )
      .all(...params) as {
        settlement_id: string;
        guild_id: string;
        user_id: string;
        restaurant_name: string;
        amount: number;
      }[];

    // Aggregate the adjustments before deleting anything.
    const userAdjustments = new Map<string, number>();
    const restaurantSpend = new Map<string, number>();
    const restaurantSettlementIds = new Map<string, Set<string>>();

    for (const entry of entries) {
      const userKey = `${entry.guild_id}|${entry.user_id}`;
      userAdjustments.set(userKey, (userAdjustments.get(userKey) || 0) + entry.amount);

      const restaurantKey = `${entry.guild_id}|${entry.restaurant_name}`;
      restaurantSpend.set(
        restaurantKey,
        (restaurantSpend.get(restaurantKey) || 0) + entry.amount
      );
      const ids = restaurantSettlementIds.get(restaurantKey) || new Set<string>();
      ids.add(entry.settlement_id);
      restaurantSettlementIds.set(restaurantKey, ids);
    }

    for (const [key, amount] of userAdjustments) {
      const [guildId, userId] = key.split("|");
      db.prepare(
        "UPDATE user_stats SET total_spend = total_spend - ? WHERE guild_id = ? AND user_id = ?"
      ).run(amount, guildId, userId);
      db.prepare(
        "DELETE FROM user_stats WHERE guild_id = ? AND user_id = ? AND total_spend <= 0.005"
      ).run(guildId, userId);
    }

    // One receipt_count per settlement_id, matching how recordSettlement counts them.
    for (const [key, amount] of restaurantSpend) {
      const [guildId, restaurantName] = key.split("|");
      const receiptCount = restaurantSettlementIds.get(key)?.size || 0;
      db.prepare(
        `UPDATE restaurant_stats
         SET total_spend = total_spend - ?, receipt_count = receipt_count - ?
         WHERE guild_id = ? AND restaurant_name = ?`
      ).run(amount, receiptCount, guildId, restaurantName);
      db.prepare(
        `DELETE FROM restaurant_stats
         WHERE guild_id = ? AND restaurant_name = ? AND (total_spend <= 0.005 OR receipt_count <= 0)`
      ).run(guildId, restaurantName);
    }

    db.prepare(`DELETE FROM settlement_entries WHERE ${where}`).run(...params);

    if (names.length > 0) {
      db.prepare(
        `DELETE FROM restaurant_stats
         WHERE LOWER(restaurant_name) IN (${names.map(() => "?").join(",")})`
      ).run(...names);
    }

    return entries.length;
  });

  return tx();
}
