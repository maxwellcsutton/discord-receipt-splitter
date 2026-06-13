import Database from "better-sqlite3";
import { config } from "../config.js";
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
      status TEXT NOT NULL DEFAULT 'active',
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
}
