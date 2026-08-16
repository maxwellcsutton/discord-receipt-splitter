import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// Lightweight text model for recommendations. Pricing matches the haiku alias
// used by the receipt parser so daily-spend tracking stays in the same ballpark.
const MODEL = "claude-haiku-4-5";
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
}

const RESPONSE_SCHEMA = {
  type: "object" as const,
  properties: {
    restaurants: {
      type: "array" as const,
      items: {
        type: "object" as const,
        properties: {
          name: { type: "string" as const },
          cuisine: { type: "string" as const },
          reason: { type: "string" as const },
          priceRange: { type: "string" as const },
        },
        required: ["name", "cuisine", "reason", "priceRange"] as const,
        additionalProperties: false,
      },
    },
  },
  required: ["restaurants"] as const,
  additionalProperties: false,
};

function buildPrompt(
  favorites: FavoriteRestaurant[],
  location: string,
  limit: number
): string {
  const favoriteList = favorites
    .map((f) => `- ${f.name} (${f.receiptCount} visit${f.receiptCount !== 1 ? "s" : ""})`)
    .join("\n");

  return [
    "This Discord group has eaten at the following restaurants most frequently:",
    favoriteList,
    "",
    `Suggest ${limit} restaurants near "${location}" that are similar in cuisine, vibe, or price to the group's favorites.`,
    "Do not recommend any restaurant that is already in the list above.",
    "For each suggestion, provide:",
    "- name: the restaurant's name",
    "- cuisine: a short cuisine/style label",
    "- reason: one sentence explaining why it matches the group's tastes",
    "- priceRange: an approximate price range like $, $$, $$$, or $$$$",
    "",
    `Return ONLY valid JSON matching this schema, with no commentary:\n${JSON.stringify(RESPONSE_SCHEMA)}`,
  ].join("\n");
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
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 2048,
    messages: [
      {
        role: "user",
        content: buildPrompt(favorites, location, limit),
      },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text response from Claude");
  }

  let jsonStr = textBlock.text.trim();
  const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    jsonStr = jsonMatch[1].trim();
  }

  const parsed = JSON.parse(jsonStr) as { restaurants: SimilarRestaurant[] };
  if (!Array.isArray(parsed.restaurants)) {
    throw new Error("Invalid recommendation response: restaurants array missing");
  }

  const estimatedCostUsd =
    response.usage.input_tokens * COST_PER_INPUT_TOKEN +
    response.usage.output_tokens * COST_PER_OUTPUT_TOKEN;

  return { restaurants: parsed.restaurants.slice(0, limit), estimatedCostUsd };
}
