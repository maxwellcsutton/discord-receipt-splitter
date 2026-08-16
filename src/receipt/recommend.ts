import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });
const YELP_SEARCH_URL = "https://api.yelp.com/v3/businesses/search";

// Lightweight text model for the classification step (cuisines + timezone).
const CLASSIFY_MODEL = "claude-haiku-4-5";
const COST_PER_INPUT_TOKEN = 1.0 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 5.0 / 1_000_000;

export interface FavoriteRestaurant {
  name: string;
  receiptCount: number;
}

export interface SimilarRestaurant {
  name: string;
  cuisine: string;
  reason: string;
  priceRange: string;
  url?: string;
}

interface YelpCategory {
  alias: string;
  title: string;
}

interface YelpBusiness {
  name: string;
  categories: YelpCategory[];
  rating: number;
  review_count: number;
  price?: string;
  url: string;
  location?: { display_address?: string[] };
}

interface ClassificationResult {
  categories: string[];
  timezone: string | null;
  estimatedCostUsd: number;
}

const CLASSIFY_SCHEMA = {
  type: "object" as const,
  properties: {
    yelpCategories: {
      type: "array" as const,
      items: { type: "string" as const },
    },
    timezone: { type: "string" as const },
  },
  required: ["yelpCategories", "timezone"] as const,
  additionalProperties: false,
};

function buildClassifyPrompt(
  favorites: FavoriteRestaurant[],
  location: string
): string {
  const favoriteList = favorites
    .map((f) => `- ${f.name} (${f.receiptCount} visit${f.receiptCount !== 1 ? "s" : ""})`)
    .join("\n");

  return [
    "This Discord group has eaten at the following restaurants most frequently:",
    favoriteList,
    "",
    `We want Yelp restaurant recommendations near "${location}" that are similar to these favorites.`,
    "Return two things:",
    "1. yelpCategories: up to 4 Yelp category aliases (e.g., \"sushi\", \"burgers\", \"italian\", \"newamerican\") that best capture the group's tastes. Prefer specific cuisine aliases over generic ones like \"restaurants\".",
    `2. timezone: the IANA timezone for "${location}" (e.g., \"America/Chicago\").`,
    "",
    `Return ONLY valid JSON matching this schema, with no commentary:\n${JSON.stringify(CLASSIFY_SCHEMA)}`,
  ].join("\n");
}

async function classifyForYelp(
  favorites: FavoriteRestaurant[],
  location: string
): Promise<ClassificationResult> {
  let estimatedCostUsd = 0;
  try {
    const response = await anthropic.messages.create({
      model: CLASSIFY_MODEL,
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: buildClassifyPrompt(favorites, location),
        },
      ],
    });

    estimatedCostUsd =
      response.usage.input_tokens * COST_PER_INPUT_TOKEN +
      response.usage.output_tokens * COST_PER_OUTPUT_TOKEN;

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("No text response from Claude");
    }

    let jsonStr = textBlock.text.trim();
    const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1].trim();
    }

    const parsed = JSON.parse(jsonStr) as {
      yelpCategories: string[];
      timezone: string;
    };

    return {
      categories: Array.isArray(parsed.yelpCategories)
        ? parsed.yelpCategories.filter((c) => typeof c === "string" && c.length > 0)
        : [],
      timezone: typeof parsed.timezone === "string" ? parsed.timezone : null,
      estimatedCostUsd,
    };
  } catch (err) {
    const wrapped = new Error(err instanceof Error ? err.message : String(err));
    (wrapped as any).estimatedCostUsd = estimatedCostUsd;
    throw wrapped;
  }
}

function parseGmtOffset(offsetStr: string): number {
  const match = offsetStr.match(/GMT([+-])(\d{1,2}):(\d{2})/);
  if (!match) return 0;
  const sign = match[1] === "+" ? 1 : -1;
  const hours = parseInt(match[2], 10);
  const minutes = parseInt(match[3], 10);
  return sign * (hours * 3600 + minutes * 60);
}

function computeOpenAt(timezone: string | null): number | null {
  if (!timezone) return null;
  try {
    const fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      timeZoneName: "longOffset",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const parts = fmt.formatToParts(twoHoursFromNow);
    const get = (type: string) => parts.find((p) => p.type === type)?.value;

    const offsetStr = get("timeZoneName");
    if (!offsetStr) return null;
    const offsetSeconds = parseGmtOffset(offsetStr);

    const year = Number(get("year"));
    const month = Number(get("month"));
    const day = Number(get("day"));
    const hour = Number(get("hour"));
    const minute = Number(get("minute"));
    const second = Number(get("second"));
    if ([year, month, day, hour, minute, second].some(isNaN)) return null;

    const utcMs = Date.UTC(year, month - 1, day, hour, minute, second);
    return Math.floor((utcMs - offsetSeconds * 1000) / 1000);
  } catch {
    return null;
  }
}

async function yelpSearch(
  location: string,
  categories: string[],
  openAt: number | null,
  limit = 20
): Promise<YelpBusiness[]> {
  if (!config.yelpApiKey) {
    throw new Error("YELP_API_KEY is not configured.");
  }

  const params = new URLSearchParams();
  params.set("location", location);
  params.set("limit", String(limit));
  params.set("sort_by", "best_match");
  if (categories.length > 0) {
    params.set("categories", categories.slice(0, 4).join(","));
  }
  if (openAt !== null) {
    params.set("open_at", String(openAt));
  }

  const response = await fetch(`${YELP_SEARCH_URL}?${params.toString()}`, {
    headers: {
      Authorization: `Bearer ${config.yelpApiKey}`,
      Accept: "application/json",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`Yelp API error (${response.status}): ${body}`);
  }

  const data = (await response.json()) as { businesses?: YelpBusiness[] };
  return data.businesses ?? [];
}

function isNameSimilar(a: string, b: string): boolean {
  const left = a.toLowerCase().replace(/[^a-z0-9]/g, "");
  const right = b.toLowerCase().replace(/[^a-z0-9]/g, "");
  return left === right || left.includes(right) || right.includes(left);
}

export interface RecommendResult {
  restaurants: SimilarRestaurant[];
  estimatedCostUsd: number;
}

export async function findSimilarRestaurants(
  favorites: FavoriteRestaurant[],
  location: string,
  limit = 5
): Promise<RecommendResult> {
  let estimatedCostUsd = 0;
  try {
    const classification = await classifyForYelp(favorites, location);
    estimatedCostUsd = classification.estimatedCostUsd;
    const openAt = computeOpenAt(classification.timezone);

    let businesses = await yelpSearch(location, classification.categories, openAt, 20);

    // Fallback to a broader search if the cuisine filter returned nothing.
    if (businesses.length === 0 && classification.categories.length > 0) {
      businesses = await yelpSearch(location, [], openAt, 20);
    }

    const favoriteNames = favorites.map((f) => f.name);
    const filtered = businesses.filter(
      (b) => !favoriteNames.some((name) => isNameSimilar(b.name, name)),
    );

    const restaurants: SimilarRestaurant[] = filtered.slice(0, limit).map((b) => {
      const cuisine = b.categories.map((c) => c.title).join(", ") || "Restaurant";
      const price = b.price ?? "$$";
      const address = b.location?.display_address?.join(", ") ?? "";
      const reasonParts = [
        `Rated ${b.rating}⭐ (${b.review_count} reviews)`,
        address ? `at ${address}` : null,
        b.url ? `\n${b.url}` : null,
      ].filter(Boolean);
      return {
        name: b.name,
        cuisine,
        reason: reasonParts.join(" "),
        priceRange: price,
        url: b.url,
      };
    });

    return { restaurants, estimatedCostUsd };
  } catch (err) {
    const wrapped = new Error(err instanceof Error ? err.message : String(err));
    (wrapped as any).estimatedCostUsd = estimatedCostUsd;
    throw wrapped;
  }
}
