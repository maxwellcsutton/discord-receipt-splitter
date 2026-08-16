import dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

// Parses a positive number from an env var, falling back to a default when the
// var is unset, empty, or not a valid positive number.
function positiveFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

// Parses a boolean env var, falling back to a default when unset or empty.
function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  return /^(1|true|yes|y)$/i.test(raw);
}

const DEFAULT_MODIFIER_PREFIXES = "add ,extra ,w/ ,with ";
const DEFAULT_DAILY_SPEND_LIMIT_USD = 0.1;

export const config = {
  discordToken: required("DISCORD_TOKEN"),
  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  databasePath: process.env.DATABASE_PATH || "./data/receipts.db",
  modifierPrefixes: (process.env.MODIFIER_PREFIXES ?? DEFAULT_MODIFIER_PREFIXES)
    .split(",")
    .map((p) => p.toLowerCase())
    .filter((p) => p.length > 0),
  // Max estimated Anthropic spend per UTC day before scans are blocked.
  dailySpendLimitUsd: positiveFloat("DAILY_SPEND_LIMIT_USD", DEFAULT_DAILY_SPEND_LIMIT_USD),
  // When true, receipt summaries can show "Pay with Venmo" buttons for users
  // who have set a Venmo handle.
  venmoEnabled: boolean("VENMO_ENABLED", false),
  // Exchange-rate API URL. Defaults to frankfurter.app (free, no key).
  // Templates: {from} = source currency, {to} = USD, {apikey} = EXCHANGE_RATE_API_KEY.
  exchangeRateApiUrl: process.env.EXCHANGE_RATE_API_URL || "",
  // Optional API key for the exchange-rate service.
  exchangeRateApiKey: process.env.EXCHANGE_RATE_API_KEY || "",
};
