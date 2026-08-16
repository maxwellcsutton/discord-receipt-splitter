import { config } from "../config.js";

const rateCache = new Map<string, { rate: number; fetchedAt: number }>();
const CACHE_TTL_MS = 1000 * 60 * 60; // 1 hour

export interface ConvertedAmounts {
  currencyCode: string;
  rateToUsd: number;
  rateDate: string | null;
  originalSubtotal: number;
  originalDiscount: number;
  originalTax: number;
  originalTip: number | null;
  originalTotal: number;
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
}

interface RateResponse {
  base?: string;
  date?: string;
  rates?: Record<string, number>;
  conversion_rates?: Record<string, number>;
  rate?: number;
  result?: number;
}

function cacheKey(fromCurrency: string): string {
  return `${fromCurrency.toUpperCase()}:USD`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * Fetches the USD exchange rate for a currency. Caches results for one hour.
 * Uses frankfurter.app by default; set EXCHANGE_RATE_API_URL to override.
 * Supported override formats:
 *   - https://api.exchangerate-api.com/v4/latest/{from}
 *   - https://api.example.com/rates?base={from}&symbols=USD
 */
export async function getUsdExchangeRate(fromCurrency: string): Promise<{
  rate: number;
  date: string | null;
}> {
  const code = fromCurrency.trim().toUpperCase();
  if (code === "USD") {
    return { rate: 1, date: null };
  }

  const key = cacheKey(code);
  const cached = rateCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return { rate: cached.rate, date: null };
  }

  const baseUrl =
    config.exchangeRateApiUrl || "https://api.frankfurter.app/latest";
  const url = baseUrl
    .replace(/\{from\}/gi, code)
    .replace(/\{to\}/gi, "USD")
    .replace(/\{apikey\}/gi, config.exchangeRateApiKey || "");

  const finalUrl = new URL(url);
  if (!finalUrl.searchParams.has("from") && !baseUrl.includes("{from}")) {
    finalUrl.searchParams.set("from", code);
  }
  if (!finalUrl.searchParams.has("to") && !baseUrl.includes("{to}")) {
    finalUrl.searchParams.set("to", "USD");
  }

  const res = await fetch(finalUrl.toString());
  if (!res.ok) {
    throw new Error(
      `Exchange rate lookup failed for ${code}: ${res.status} ${res.statusText}`
    );
  }

  const data = (await res.json()) as RateResponse;
  const rates = data.rates ?? data.conversion_rates ?? {};
  const rate =
    data.result ??
    data.rate ??
    rates.USD ??
    rates.usd ??
    rates["USD"] ??
    rates["usd"];
  if (rate === undefined || rate <= 0 || !Number.isFinite(rate)) {
    throw new Error(
      `Could not find a USD exchange rate for ${code}. Response: ${JSON.stringify(data)}`
    );
  }

  rateCache.set(key, { rate, fetchedAt: Date.now() });
  return { rate, date: data.date ?? null };
}

export async function convertToUsd(input: {
  currencyCode: string;
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
}): Promise<ConvertedAmounts> {
  const code = (input.currencyCode || "USD").trim().toUpperCase();
  const { rate, date } = await getUsdExchangeRate(code);

  return {
    currencyCode: code,
    rateToUsd: rate,
    rateDate: date,
    originalSubtotal: round2(input.subtotal),
    originalDiscount: round2(input.discount),
    originalTax: round2(input.tax),
    originalTip: input.tip === null ? null : round2(input.tip),
    originalTotal: round2(input.total),
    subtotal: round2(input.subtotal * rate),
    discount: round2(input.discount * rate),
    tax: round2(input.tax * rate),
    tip: input.tip === null ? null : round2(input.tip * rate),
    total: round2(input.total * rate),
  };
}

export function formatOriginalCurrency(
  amounts: Pick<ConvertedAmounts, "currencyCode" | "originalTotal" | "rateToUsd">
): string {
  if (amounts.currencyCode === "USD") return "";
  return `${amounts.currencyCode} ${amounts.originalTotal.toFixed(2)} @ ${amounts.rateToUsd.toFixed(4)}`;
}
