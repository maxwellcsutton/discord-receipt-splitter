import Database from "better-sqlite3";
import { config } from "../config.js";
import { normalizeRestaurantName } from "../utils/restaurantName.js";
import path from "path";
import fs from "fs";

let db: Database.Database;

export function getDb(): Database.Database {
  if (!db) {
    const dir = path.dirname(config.databasePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    db = new Database(config.databasePath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  }
  return db;
}

export function initDatabase(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS receipt_sessions (
      id TEXT PRIMARY KEY,
      thread_id TEXT UNIQUE NOT NULL,
      original_message_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      primary_user_id TEXT NOT NULL,
      restaurant_name TEXT NOT NULL,
      subtotal REAL NOT NULL,
      discount_amount REAL NOT NULL DEFAULT 0,
      tax_amount REAL NOT NULL,
      tip_amount REAL,
      total REAL NOT NULL,
      currency_code TEXT NOT NULL DEFAULT 'USD',
      rate_to_usd REAL NOT NULL DEFAULT 1,
      rate_date TEXT,
      original_subtotal REAL NOT NULL DEFAULT 0,
      original_discount REAL NOT NULL DEFAULT 0,
      original_tax REAL NOT NULL DEFAULT 0,
      original_tip REAL,
      original_total REAL NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      category TEXT NOT NULL DEFAULT 'food',
      summary_message_id TEXT,
      tagged_user_ids TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS line_items (
      session_id TEXT NOT NULL,
      item_index INTEGER NOT NULL,
      name TEXT NOT NULL,
      unit_price REAL NOT NULL,
      original_quantity INTEGER NOT NULL,
      claimed_by_user_id TEXT,
      PRIMARY KEY (session_id, item_index),
      FOREIGN KEY (session_id) REFERENCES receipt_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS split_items (
      session_id TEXT NOT NULL,
      line_item_index INTEGER NOT NULL,
      user_id TEXT NOT NULL,
      share_count INTEGER NOT NULL,
      share_pct REAL,
      PRIMARY KEY (session_id, line_item_index, user_id),
      FOREIGN KEY (session_id) REFERENCES receipt_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS user_payments (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      paid INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (session_id, user_id),
      FOREIGN KEY (session_id) REFERENCES receipt_sessions(id)
    );

    CREATE TABLE IF NOT EXISTS roulette_opt_ins (
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      PRIMARY KEY (session_id, user_id),
      FOREIGN KEY (session_id) REFERENCES receipt_sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS restaurant_stats (
      guild_id TEXT NOT NULL,
      restaurant_name TEXT NOT NULL,
      total_spend REAL NOT NULL DEFAULT 0,
      receipt_count INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, restaurant_name)
    );

    CREATE TABLE IF NOT EXISTS user_stats (
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      total_spend REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (guild_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS api_cost_log (
      date TEXT NOT NULL PRIMARY KEY,
      estimated_cost_usd REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS settlement_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      settlement_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      restaurant_name TEXT NOT NULL,
      amount REAL NOT NULL,
      tip_share REAL NOT NULL DEFAULT 0,
      session_id TEXT,
      settled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_settlement_user
      ON settlement_entries (guild_id, user_id);

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS user_venmo_handles (
      user_id TEXT PRIMARY KEY,
      handle TEXT NOT NULL
    );
  `);

  // Migration: add discount_amount to existing databases that pre-date this column
  const cols = db
    .prepare("PRAGMA table_info(receipt_sessions)")
    .all() as { name: string }[];
  if (!cols.some((c) => c.name === "discount_amount")) {
    db.exec(
      "ALTER TABLE receipt_sessions ADD COLUMN discount_amount REAL NOT NULL DEFAULT 0"
    );
  }

  // Migration: add share_pct to split_items for uneven splits (NULL = even split)
  const splitCols = db
    .prepare("PRAGMA table_info(split_items)")
    .all() as { name: string }[];
  if (!splitCols.some((c) => c.name === "share_pct")) {
    db.exec("ALTER TABLE split_items ADD COLUMN share_pct REAL");
  }

  // Migration: add category to receipt_sessions (food vs non-food leaderboard eligibility)
  const sessionCols = db
    .prepare("PRAGMA table_info(receipt_sessions)")
    .all() as { name: string }[];
  if (!sessionCols.some((c) => c.name === "category")) {
    db.exec("ALTER TABLE receipt_sessions ADD COLUMN category TEXT NOT NULL DEFAULT 'food'");
  }

  // Backfill: classify earlier movie/spellground receipts as non-food and remove their
  // leaderboard impact. This is a one-time fix for receipts that were settled before
  // category support existed. We match exact names only to avoid collateral damage to
  // legitimate restaurants whose names happen to contain these substrings.
  const nonFoodBackfillDone = db
    .prepare("SELECT value FROM meta WHERE key = 'non_food_backfill_v1'")
    .get() as any;
  if (!nonFoodBackfillDone) {
    const tx = db.transaction(() => {
      const nonFoodSessions = db
        .prepare(
          `SELECT id, restaurant_name FROM receipt_sessions
           WHERE LOWER(restaurant_name) IN ('movie', 'spellground')`
        )
        .all() as { id: string; restaurant_name: string }[];

      const sessionIds = nonFoodSessions.map((s) => s.id);
      if (sessionIds.length === 0) {
        db.prepare(
          "INSERT INTO meta (key, value) VALUES ('non_food_backfill_v1', ?)"
        ).run(new Date().toISOString());
        return;
      }

      const placeholders = sessionIds.map(() => '?').join(',');

      // Pull the leaderboard entries that were generated from these sessions.
      const entriesToRemove = db
        .prepare(
          `SELECT settlement_id, guild_id, user_id, restaurant_name, amount
           FROM settlement_entries
           WHERE session_id IN (${placeholders})`
        )
        .all(...sessionIds) as {
          settlement_id: string;
          guild_id: string;
          user_id: string;
          restaurant_name: string;
          amount: number;
        }[];

      // Aggregate per-user and per-restaurant adjustments before deleting entries.
      const userAdjustments = new Map<string, number>();
      const restaurantSpendAdjustments = new Map<string, number>();
      const restaurantSettlementIds = new Map<string, Set<string>>();

      for (const entry of entriesToRemove) {
        const userKey = `${entry.guild_id}|${entry.user_id}`;
        userAdjustments.set(userKey, (userAdjustments.get(userKey) || 0) + entry.amount);

        const restaurantKey = `${entry.guild_id}|${entry.restaurant_name}`;
        restaurantSpendAdjustments.set(
          restaurantKey,
          (restaurantSpendAdjustments.get(restaurantKey) || 0) + entry.amount
        );
        const ids = restaurantSettlementIds.get(restaurantKey) || new Set<string>();
        ids.add(entry.settlement_id);
        restaurantSettlementIds.set(restaurantKey, ids);
      }

      // Subtract from aggregated user stats.
      for (const [key, amount] of userAdjustments) {
        const [guildId, userId] = key.split('|');
        db.prepare(
          'UPDATE user_stats SET total_spend = total_spend - ? WHERE guild_id = ? AND user_id = ?'
        ).run(amount, guildId, userId);
        db.prepare(
          'DELETE FROM user_stats WHERE guild_id = ? AND user_id = ? AND total_spend <= 0.005'
        ).run(guildId, userId);
      }

      // Subtract from aggregated restaurant stats (one receipt count per settlement_id).
      for (const [key, amount] of restaurantSpendAdjustments) {
        const [guildId, restaurantName] = key.split('|');
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

      // Delete the leaderboard history for these sessions so they no longer count
      // in any leaderboard view.
      db.prepare(
        `DELETE FROM settlement_entries WHERE session_id IN (${placeholders})`
      ).run(...sessionIds);

      // Mark the sessions themselves as non-food.
      db.prepare(
        `UPDATE receipt_sessions SET category = 'non_food' WHERE id IN (${placeholders})`
      ).run(...sessionIds);

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('non_food_backfill_v1', ?)"
      ).run(new Date().toISOString());
    });
    tx();
  }

  // Migration: add currency columns to receipt_sessions for foreign-currency support.
  const currencyCols = db
    .prepare("PRAGMA table_info(receipt_sessions)")
    .all() as { name: string }[];
  const addCurrencyCol = (name: string, def: string) => {
    if (!currencyCols.some((c) => c.name === name)) {
      db.exec(`ALTER TABLE receipt_sessions ADD COLUMN ${name} ${def}`);
    }
  };
  addCurrencyCol("currency_code", "TEXT NOT NULL DEFAULT 'USD'");
  addCurrencyCol("rate_to_usd", "REAL NOT NULL DEFAULT 1");
  addCurrencyCol("rate_date", "TEXT");
  addCurrencyCol("original_subtotal", "REAL NOT NULL DEFAULT 0");
  addCurrencyCol("original_discount", "REAL NOT NULL DEFAULT 0");
  addCurrencyCol("original_tax", "REAL NOT NULL DEFAULT 0");
  addCurrencyCol("original_tip", "REAL");
  addCurrencyCol("original_total", "REAL NOT NULL DEFAULT 0");

  // Migration: canonicalize stored restaurant names to lowercase (with aliases
  // resolved) so differently-cased spellings of the same place — "Chubby Mart"
  // and "chubby mart" — merge into one restaurant everywhere. Display casing is
  // applied when names are read back out; see utils/restaurantName.ts.
  const nameCaseBackfillDone = db
    .prepare("SELECT value FROM meta WHERE key = 'restaurant_name_lowercase_v1'")
    .get() as any;
  if (!nameCaseBackfillDone) {
    const tx = db.transaction(() => {
      // receipt_sessions and settlement_entries have no uniqueness constraint on
      // the name, so a plain rewrite per distinct name is enough.
      for (const table of ["receipt_sessions", "settlement_entries"]) {
        const names = db
          .prepare(`SELECT DISTINCT restaurant_name FROM ${table}`)
          .all() as { restaurant_name: string }[];
        const update = db.prepare(
          `UPDATE ${table} SET restaurant_name = ? WHERE restaurant_name = ?`
        );
        for (const { restaurant_name } of names) {
          const canonical = normalizeRestaurantName(restaurant_name);
          if (canonical !== restaurant_name) update.run(canonical, restaurant_name);
        }
      }

      // restaurant_stats is keyed on (guild_id, restaurant_name), so rows that
      // collapse onto the same canonical name must be summed rather than
      // overwritten. Rebuild the table from the merged totals.
      const stats = db
        .prepare(
          "SELECT guild_id, restaurant_name, total_spend, receipt_count FROM restaurant_stats"
        )
        .all() as {
          guild_id: string;
          restaurant_name: string;
          total_spend: number;
          receipt_count: number;
        }[];

      const merged = new Map<
        string,
        { guildId: string; name: string; totalSpend: number; receiptCount: number }
      >();
      for (const row of stats) {
        const canonical = normalizeRestaurantName(row.restaurant_name);
        const key = `${row.guild_id} ${canonical}`;
        const existing = merged.get(key);
        if (existing) {
          existing.totalSpend += row.total_spend;
          existing.receiptCount += row.receipt_count;
        } else {
          merged.set(key, {
            guildId: row.guild_id,
            name: canonical,
            totalSpend: row.total_spend,
            receiptCount: row.receipt_count,
          });
        }
      }

      db.prepare("DELETE FROM restaurant_stats").run();
      const insertStat = db.prepare(
        `INSERT INTO restaurant_stats (guild_id, restaurant_name, total_spend, receipt_count)
         VALUES (?, ?, ?, ?)`
      );
      for (const row of merged.values()) {
        insertStat.run(row.guildId, row.name, row.totalSpend, row.receiptCount);
      }

      db.prepare(
        "INSERT INTO meta (key, value) VALUES ('restaurant_name_lowercase_v1', ?)"
      ).run(new Date().toISOString());
    });
    tx();
  }
}
