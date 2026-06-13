import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ParsedReceipt, LineItem } from "./types.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

const MODEL = process.env.CLAUDE_MODEL || "claude-sonnet-4-6";

// Sonnet 4.6 pricing (per token). Sonnet's stronger vision reasoning is worth
// the higher per-token cost on skewed/angled receipts, where item↔price row
// alignment is the hard part.
const COST_PER_INPUT_TOKEN = 3.00 / 1_000_000;
const COST_PER_OUTPUT_TOKEN = 15.00 / 1_000_000;

// Claude returns one entry per receipt line — quantity and line_total only.
// We handle division and expansion in code.
const RAW_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    quantity: { type: "integer" as const },
    line_total: { type: "number" as const },
  },
  required: ["name", "quantity", "line_total"] as const,
  additionalProperties: false,
};

const RECEIPT_SCHEMA = {
  type: "object" as const,
  properties: {
    items: {
      type: "array" as const,
      items: RAW_ITEM_SCHEMA,
    },
    subtotal: { type: "number" as const },
    discount: { type: "number" as const },
    tax: { type: "number" as const },
    tip: { type: ["number", "null"] as const },
    total: { type: "number" as const },
  },
  required: ["items", "subtotal", "discount", "tax", "tip", "total"] as const,
  additionalProperties: false,
};

interface RawReceiptItem {
  name: string;
  quantity: number;
  line_total: number;
}

interface RawReceipt {
  items: RawReceiptItem[];
  subtotal: number;
  discount: number;
  tax: number;
  tip: number | null;
  total: number;
}

export interface ParseResult {
  parsed: ParsedReceipt;
  estimatedCostUsd: number;
}

// A line is a likely modifier if it matches configured prefix patterns, has
// quantity 1, and costs ≤$6. These guards prevent false positives like
// "Sub Sandwich" or "No. 5 Combo" from being absorbed.
function looksLikeModifier(item: RawReceiptItem): boolean {
  if (item.quantity > 1) return false;
  if (item.line_total > 6.0) return false;
  const n = item.name.trim().toLowerCase();
  return config.modifierPrefixes.some((p) => n.startsWith(p));
}

// Appends a modifier's name to the parent item for display.
function appendModifierName(parent: RawReceiptItem, modifier: RawReceiptItem): void {
  const suffix = modifier.name.trim();
  if (suffix && !parent.name.toLowerCase().includes(suffix.toLowerCase())) {
    parent.name = `${parent.name} + ${suffix}`;
  }
}

// Subtotal-guided modifier rollup. Uses the receipt subtotal to decide whether
// Claude already folded modifier prices into parents (drop duplicates) or
// leaked them as separate lines (roll up into parent).
function rollUpModifiers(items: RawReceiptItem[], subtotal: number): RawReceiptItem[] {
  // Identify candidate modifier lines (non-zero priced)
  const candidates: { index: number; item: RawReceiptItem }[] = [];
  for (let i = 0; i < items.length; i++) {
    if (items[i].line_total > 0 && looksLikeModifier(items[i])) {
      candidates.push({ index: i, item: items[i] });
    }
  }

  const rawSum = items.reduce((s, it) => s + it.line_total, 0);
  const modifierSum = candidates.reduce((s, c) => s + c.item.line_total, 0);
  const candidateIndices = new Set(candidates.map((c) => c.index));

  // diffWith: what the diff is if we keep modifiers as standalone items
  const diffWith = Math.abs(rawSum - subtotal);
  // diffWithout: what the diff is if we drop modifier lines entirely
  // (implying Claude already folded their prices into parents)
  const diffWithout = Math.abs(rawSum - modifierSum - subtotal);

  // Decide strategy:
  // - "drop":  Claude already folded prices → remove modifier lines (don't re-add)
  // - "merge": Claude leaked modifiers   → roll their prices into the parent
  // - "keep":  uncertain                  → leave items as-is (conservative)
  let strategy: "drop" | "merge" | "keep";
  if (candidates.length === 0) {
    strategy = "keep";
  } else if (diffWithout < diffWith) {
    strategy = "drop";
  } else if (diffWith < diffWithout) {
    strategy = "merge";
  } else {
    strategy = "keep"; // tie → conservative
  }

  const result: RawReceiptItem[] = [];
  for (let i = 0; i < items.length; i++) {
    const item = items[i];

    // $0 items always merge into preceding parent (no pricing impact, just declutter)
    if (item.line_total === 0 && result.length > 0) {
      appendModifierName(result[result.length - 1], item);
      continue;
    }

    if (candidateIndices.has(i)) {
      if (strategy === "drop" && result.length > 0) {
        // Claude already summed this into the parent → just append name, skip price
        appendModifierName(result[result.length - 1], item);
      } else if (strategy === "merge" && result.length > 0) {
        // Claude leaked this modifier → add price to parent
        const parent = result[result.length - 1];
        parent.line_total = Math.round((parent.line_total + item.line_total) * 100) / 100;
        appendModifierName(parent, item);
      } else {
        // "keep" or no parent → leave as standalone
        result.push({ ...item });
      }
    } else {
      result.push({ ...item });
    }
  }
  return result;
}

export async function parseReceiptImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  userHint?: string,
): Promise<ParseResult> {
  const response = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4096,
    messages: [
      {
        role: "user",
        content: [
          {
            type: "image",
            source: { type: "base64", media_type: mediaType, data: imageBase64 },
          },
          {
            type: "text",
            text: `${userHint ? `USER HINT (pay close attention): ${userHint}\n\n` : ""}Extract all line items from this receipt. For each line item output one entry with:
- name: the item name, stripped of any parenthetical numbers (e.g. "Mild Spicy Lamb Kebab(5)" → "Mild Spicy Lamb Kebab")
- quantity: the number in the LEFTMOST column of that line. This is the only source of truth for quantity. Numbers inside the item name (like the "(5)" or "(1)") are NOT the quantity — ignore them.
- line_total: the TOTAL price charged for this item (see MODIFIERS below)

MODIFIERS / ADD-ONS: Many receipts show modifiers, add-ons, options, or customizations INDENTED beneath a parent item (e.g. "Arrachera $2.16", "Add Guacamole $1.08", "Chile Guero $0.00" under a "Burrito" line). These are NOT separate items — they are upcharges or options that belong to the parent item. For each parent item:
- Sum the parent's base price with the prices of all its indented modifier lines to produce line_total
- Do NOT emit separate JSON entries for modifier/add-on lines
- Modifiers with $0.00 are free options — include them in the name if useful (e.g. "Burrito (Arrachera, Add Guacamole)"), but do not create separate entries

A line is a MODIFIER if it is visually indented under another item, starts with words like "Add", "Extra", "Side", or describes a sub-choice (meat type, temperature, side). A line is a PARENT item if it has its own quantity in the leftmost column.

IMPORTANT: Do NOT output both a summed parent line_total AND a separate modifier entry. Each modifier's price should appear ONLY in the parent's line_total, never as its own item. For example, if "Burrito" has line_total 19.87 (already including $1.08 guacamole), do NOT also emit "Add Guacamole" as a separate item.

Output one JSON object per PARENT receipt line — do not expand or split quantities, that will be handled separately.

Also extract subtotal, discount (0 if none), tax, tip (null if not on receipt), and total. Discount is any coupon, promo, or discount line that reduces the subtotal.

PRICE ALIGNMENT (receipts are often photographed at an angle): item names run down the left, prices down the right. When the photo is skewed, a price can sit slightly higher or lower than the item it belongs to, so the two columns drift out of step. Read each row by following the item across to the price on its line — do NOT blindly pair the Nth item with the Nth price. If a price looks implausible for an item (a side or drink priced like an entrée, or vice versa), the alignment is probably off by a row.

SELF-CHECK AGAINST THE SUBTOTAL: after assigning every line_total, add them all up (including any rolled-up modifier prices). The sum must equal the printed subtotal. If it does not, the item↔price mapping is almost certainly shifted — a skewed photo typically offsets the prices by a consistent number of rows. Re-trace the rows, re-assign prices until the line_totals sum to the subtotal, and return that corrected result.

Return ONLY valid JSON matching this schema, no commentary:
${JSON.stringify(RECEIPT_SCHEMA)}`,
          },
        ],
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

  const raw = JSON.parse(jsonStr) as RawReceipt;

  // Guardrail: detect modifier/add-on lines that Claude emitted as separate items
  // and roll their line_total into the preceding parent item.
  raw.items = rollUpModifiers(raw.items, raw.subtotal);

  // Items are stored at their RAW (pre-discount) prices. Any session-level
  // discount is applied at calc/display time so discount changes flow through
  // to every item — parsed or custom-added.
  const parsed: ParsedReceipt = {
    items: raw.items.map((item) => {
      const unitPrice = Math.round((item.line_total / item.quantity) * 100) / 100;
      return {
        name: item.name,
        quantity: item.quantity,
        unit_price: unitPrice,
        total_price: Math.round(item.line_total * 100) / 100,
      };
    }),
    subtotal: raw.subtotal,
    discount: raw.discount ?? 0,
    tax: raw.tax,
    tip: raw.tip,
    total: raw.total,
  };

  const estimatedCostUsd =
    response.usage.input_tokens * COST_PER_INPUT_TOKEN +
    response.usage.output_tokens * COST_PER_OUTPUT_TOKEN;

  return { parsed, estimatedCostUsd };
}

export function expandLineItems(parsed: ParsedReceipt): LineItem[] {
  if (!Array.isArray(parsed.items)) {
    throw new TypeError("parsed.items must be an array");
  }

  const items: LineItem[] = [];
  let index = 1;

  for (const item of parsed.items) {
    const qty = item.quantity ?? 1;
    if (qty > 1) {
      for (let i = 1; i <= qty; i++) {
        items.push({
          index: index++,
          name: `${item.name} (${i} of ${qty})`,
          unitPrice: item.unit_price,
          originalQuantity: qty,
          claimedByUserId: null,
        });
      }
    } else {
      items.push({
        index: index++,
        name: item.name,
        unitPrice: item.unit_price,
        originalQuantity: 1,
        claimedByUserId: null,
      });
    }
  }

  return items;
}

export function subtotalItemsDiff(
  parsed: ParsedReceipt,
  items: LineItem[],
): number {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  return Math.abs(itemsSum - parsed.subtotal);
}

export function validateReceipt(
  parsed: ParsedReceipt,
  items: LineItem[]
): string | null {
  const itemsSum = items.reduce((sum, item) => sum + item.unitPrice, 0);
  const diff = Math.abs(itemsSum - parsed.subtotal);
  if (diff > 0.5) {
    return `Warning: Item prices sum to $${itemsSum.toFixed(2)} but receipt subtotal is $${parsed.subtotal.toFixed(2)} (difference: $${diff.toFixed(2)}).`;
  }
  return null;
}

// Builds a focused retry hint for when line items don't sum to the subtotal.
// The dominant cause on real photos is skew shifting the price column relative
// to the items, so we name that explicitly and hand back the failed mapping so
// the model can re-align rather than re-deriving from scratch.
function buildAlignmentRetryHint(
  parsed: ParsedReceipt,
  items: LineItem[],
  userHint?: string,
): string {
  const itemsSum = items.reduce((s, i) => s + i.unitPrice, 0);
  const breakdown = parsed.items
    .map((it) => `  - ${it.name}: $${it.total_price.toFixed(2)}`)
    .join("\n");
  return [
    userHint ? `${userHint}\n` : "",
    `The previous scan's line items sum to $${itemsSum.toFixed(2)}, but the printed subtotal is $${parsed.subtotal.toFixed(2)} — they don't match, so prices are mapped to the wrong items.`,
    `This receipt is likely photographed at an angle, which offsets the price column from the item column by a row or two.`,
    `Previous (incorrect) mapping:`,
    breakdown,
    `Re-read the receipt, trace each item across to the price on its row, and re-assign prices so every line_total is correct and the sum of all line_totals equals the subtotal of $${parsed.subtotal.toFixed(2)}. Also confirm modifier/add-on prices are folded into their parent item rather than listed as separate lines.`,
  ]
    .filter(Boolean)
    .join("\n");
}

export interface ReconciledParseResult {
  parsed: ParsedReceipt;
  items: LineItem[];
  warning: string | null;
  estimatedCostUsd: number;
  retried: boolean;
}

// Parse the receipt and, if the line items don't reconcile to the subtotal,
// retry once with a skew-aware hint. Keeps whichever attempt lands closest to
// the subtotal. Used by both the initial scan and the manual `rescan` command
// so both self-correct on angled receipts.
export async function parseReceiptWithReconciliation(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  userHint?: string,
): Promise<ReconciledParseResult> {
  const first = await parseReceiptImage(imageBase64, mediaType, userHint);
  let parsed = first.parsed;
  let items = expandLineItems(parsed);
  let warning = validateReceipt(parsed, items);
  let estimatedCostUsd = first.estimatedCostUsd;

  if (!warning) {
    return { parsed, items, warning, estimatedCostUsd, retried: false };
  }

  const retryHint = buildAlignmentRetryHint(parsed, items, userHint);
  const retry = await parseReceiptImage(imageBase64, mediaType, retryHint);
  estimatedCostUsd += retry.estimatedCostUsd;
  const retryItems = expandLineItems(retry.parsed);

  if (
    subtotalItemsDiff(retry.parsed, retryItems) <
    subtotalItemsDiff(parsed, items)
  ) {
    parsed = retry.parsed;
    items = retryItems;
    warning = validateReceipt(parsed, items);
  }

  return { parsed, items, warning, estimatedCostUsd, retried: true };
}
