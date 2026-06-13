import Anthropic from "@anthropic-ai/sdk";
import { config } from "../config.js";
import { ParsedReceipt, LineItem } from "./types.js";

const anthropic = new Anthropic({ apiKey: config.anthropicApiKey });

// CLAUDE_MODEL accepts a short alias (`haiku` | `sonnet` | `opus`) or a full
// model id. Aliases also carry the right per-MTok pricing so daily-spend
// accounting stays correct when the model changes. Sonnet is the default —
// its vision reasoning handles skewed/angled receipts far better than Haiku.
interface ModelChoice {
  id: string;
  inputPerMTok: number;
  outputPerMTok: number;
}

const MODEL_ALIASES: Record<string, ModelChoice> = {
  haiku: { id: "claude-haiku-4-5", inputPerMTok: 1.0, outputPerMTok: 5.0 },
  sonnet: { id: "claude-sonnet-4-6", inputPerMTok: 3.0, outputPerMTok: 15.0 },
  opus: { id: "claude-opus-4-8", inputPerMTok: 5.0, outputPerMTok: 25.0 },
};

function resolveModel(): ModelChoice {
  const raw = (process.env.CLAUDE_MODEL || "sonnet").trim();
  const alias = MODEL_ALIASES[raw.toLowerCase()];
  if (alias) return alias;
  // A full model id was provided — keep it, but infer pricing from the family
  // name so cost tracking is still roughly right (defaults to Sonnet's rates).
  const family = Object.keys(MODEL_ALIASES).find((k) => raw.toLowerCase().includes(k));
  return { ...(family ? MODEL_ALIASES[family] : MODEL_ALIASES.sonnet), id: raw };
}

const MODEL_CHOICE = resolveModel();
const MODEL = MODEL_CHOICE.id;
const COST_PER_INPUT_TOKEN = MODEL_CHOICE.inputPerMTok / 1_000_000;
const COST_PER_OUTPUT_TOKEN = MODEL_CHOICE.outputPerMTok / 1_000_000;

// Claude returns one entry per receipt line — quantity, line_total, and the
// printed per-unit price when the line shows one (e.g. "5 @18.99"). We handle
// division and expansion in code.
const RAW_ITEM_SCHEMA = {
  type: "object" as const,
  properties: {
    name: { type: "string" as const },
    quantity: { type: "integer" as const },
    line_total: { type: "number" as const },
    // The per-unit price PRINTED on the line (the "18.99" in "5 @18.99"), or
    // null when no per-unit price is shown. This is an alignment anchor: it
    // sits next to its item, so it survives a skewed/shifted price column.
    printed_unit_price: { type: ["number", "null"] as const },
  },
  required: ["name", "quantity", "line_total", "printed_unit_price"] as const,
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
  printed_unit_price: number | null;
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

// Sends the vision request. Adaptive thinking + effort materially help the
// per-line/anchor cross-checks (e.g. "5 @18.99 must be 94.95; a $94.95
// strawberry is absurd") on capable models like Sonnet 4.6 — but not every
// model supports them. We attempt with them and transparently retry without if
// the model rejects them, so the bot works regardless of the configured model.
async function createReceiptMessage(
  messages: Anthropic.MessageParam[],
): Promise<Anthropic.Message> {
  const base = { model: MODEL, max_tokens: 8192, messages };
  try {
    return await anthropic.messages.create({
      ...base,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
    });
  } catch (err) {
    if (
      err instanceof Anthropic.APIError &&
      err.status === 400 &&
      /thinking|effort|output_config/i.test(String(err.message))
    ) {
      return anthropic.messages.create(base);
    }
    throw err;
  }
}

export async function parseReceiptImage(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  userHint?: string,
): Promise<ParseResult> {
  const response = await createReceiptMessage([
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
- printed_unit_price: if the line shows a per-unit price like "5 @18.99" or "2 @ 4.59", record that per-unit number (18.99, 4.59). Otherwise null. This is the price PRINTED on the line, not something you compute.

PER-UNIT PRICES ("N @ X.XX"): when a line shows a quantity and a per-unit price together — e.g. "Country Steak & Eggs (5 @18.99)" — it means 5 units at $18.99 each, so the line_total is 5 × 18.99 = 94.95. The printed per-unit price is AUTHORITATIVE: set quantity=5, printed_unit_price=18.99, line_total=94.95. NEVER infer a unit price by dividing a line_total by the quantity — if you find yourself computing "16.49 ÷ 5 = 3.30", you have grabbed the wrong line_total. The printed per-unit price sits right next to its item, so use it to anchor that row even if the price column looks shifted.

MODIFIERS / ADD-ONS: Many receipts show modifiers, add-ons, options, or customizations INDENTED beneath a parent item (e.g. "Arrachera $2.16", "Add Guacamole $1.08", "Chile Guero $0.00" under a "Burrito" line). These are NOT separate items — they are upcharges or options that belong to the parent item. For each parent item:
- Sum the parent's base price with the prices of all its indented modifier lines to produce line_total
- Do NOT emit separate JSON entries for modifier/add-on lines
- Modifiers with $0.00 are free options — include them in the name if useful (e.g. "Burrito (Arrachera, Add Guacamole)"), but do not create separate entries

A line is a MODIFIER if it is visually indented under another item, starts with words like "Add", "Extra", "Side", or describes a sub-choice (meat type, temperature, side). A line is a PARENT item if it has its own quantity in the leftmost column.

IMPORTANT: Do NOT output both a summed parent line_total AND a separate modifier entry. Each modifier's price should appear ONLY in the parent's line_total, never as its own item. For example, if "Burrito" has line_total 19.87 (already including $1.08 guacamole), do NOT also emit "Add Guacamole" as a separate item.

Output one JSON object per PARENT receipt line — do not expand or split quantities, that will be handled separately.

Also extract subtotal, discount (0 if none), tax, tip (null if not on receipt), and total. Discount is any coupon, promo, or discount line that reduces the subtotal.

PRICE ALIGNMENT (receipts are often photographed at an angle): item names run down the left, prices down the right. When the photo is skewed, a price can sit slightly higher or lower than the item it belongs to, so the two columns drift out of step. Read each row by following the item across to the price on its line — do NOT blindly pair the Nth item with the Nth price. If a price looks implausible for an item (a side or drink priced like an entrée, or vice versa), the alignment is probably off by a row.

SELF-CHECK AGAINST THE SUBTOTAL: after assigning every line_total, add them all up (including any rolled-up modifier prices). The sum must equal the printed subtotal. If it does not, the item↔price mapping is shifted — a skewed photo typically offsets the prices by a consistent number of rows. Re-trace the rows and re-assign prices.

WARNING — matching the subtotal is necessary but NOT sufficient: if you shift the whole price column by one row, the totals still add up to the same subtotal even though every item now has the wrong price. So do not just shuffle prices until the sum works. Verify each individual line: does this price belong to THIS item, on THIS row? Use the printed per-unit prices as fixed anchors (a "5 @18.99" line must total 94.95 no matter what), and sanity-check plausibility (a side/drink/modifier should not cost more than an entrée). Return the mapping where each line is individually correct.

Return ONLY valid JSON matching this schema, no commentary:
${JSON.stringify(RECEIPT_SCHEMA)}`,
        },
      ],
    },
  ]);

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
        printed_unit_price: item.printed_unit_price ?? null,
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

interface UnitPriceMismatch {
  name: string;
  quantity: number;
  printedUnitPrice: number;
  expectedTotal: number;
  actualTotal: number;
}

// Lines that print a per-unit price ("5 @18.99") must satisfy
// line_total ≈ quantity × printed_unit_price. Unlike the subtotal sum, this
// check is NOT invariant under a row-shift permutation — it's how we catch a
// skewed price column that still happens to add up to the subtotal.
function unitPriceMismatches(parsed: ParsedReceipt): UnitPriceMismatch[] {
  const mismatches: UnitPriceMismatch[] = [];
  for (const it of parsed.items) {
    const unit = it.printed_unit_price;
    if (unit === null || unit <= 0 || it.quantity < 1) continue;
    const expected = Math.round(it.quantity * unit * 100) / 100;
    if (Math.abs(it.total_price - expected) > 0.05) {
      mismatches.push({
        name: it.name,
        quantity: it.quantity,
        printedUnitPrice: unit,
        expectedTotal: expected,
        actualTotal: it.total_price,
      });
    }
  }
  return mismatches;
}

// A scan is "off" if its items don't sum to the subtotal OR any printed
// per-unit line doesn't reconcile. Lower score = better; mismatched anchor
// lines dominate (they're strong evidence of misalignment), with the subtotal
// gap as a tie-breaker.
function reconciliationScore(parsed: ParsedReceipt, items: LineItem[]): number {
  return unitPriceMismatches(parsed).length * 1000 + subtotalItemsDiff(parsed, items);
}

function reconciliationWarning(parsed: ParsedReceipt, items: LineItem[]): string | null {
  const mismatches = unitPriceMismatches(parsed);
  if (mismatches.length > 0) {
    const lines = mismatches
      .map(
        (m) =>
          `“${m.name}” is ${m.quantity} @ $${m.printedUnitPrice.toFixed(2)} = $${m.expectedTotal.toFixed(2)}, but got $${m.actualTotal.toFixed(2)}`,
      )
      .join("; ");
    return `Warning: per-unit prices don't reconcile (${lines}). The price column may be misaligned.`;
  }
  return validateReceipt(parsed, items);
}

// Builds a focused retry hint. Leads with the printed per-unit anchors (the
// strongest correction signal — they pin specific rows), then the subtotal gap,
// then hands back the failed mapping so the model re-aligns rather than
// re-deriving from scratch.
function buildAlignmentRetryHint(
  parsed: ParsedReceipt,
  items: LineItem[],
  userHint?: string,
): string {
  const itemsSum = items.reduce((s, i) => s + i.unitPrice, 0);
  const subtotalDiff = Math.abs(itemsSum - parsed.subtotal);
  const mismatches = unitPriceMismatches(parsed);
  const breakdown = parsed.items
    .map((it) => `  - ${it.name}: $${it.total_price.toFixed(2)}`)
    .join("\n");

  const anchorBlock =
    mismatches.length > 0
      ? [
          `Some lines print their own per-unit price, which fixes their total regardless of how the column lines up. These are WRONG and must be corrected:`,
          ...mismatches.map(
            (m) =>
              `  - “${m.name}” is printed as ${m.quantity} @ $${m.printedUnitPrice.toFixed(2)}, so its line total must be $${m.expectedTotal.toFixed(2)} — you reported $${m.actualTotal.toFixed(2)}.`,
          ),
          `Pin those lines to their correct totals, then re-align the rest of the price column around them (the whole column is likely shifted by a row).`,
        ].join("\n")
      : "";

  const subtotalBlock =
    subtotalDiff > 0.5
      ? `The line items sum to $${itemsSum.toFixed(2)} but the subtotal is $${parsed.subtotal.toFixed(2)}.`
      : `Note: the totals happen to sum to the subtotal, but that does NOT mean the mapping is right — a one-row shift of the whole column preserves the sum. Verify each line individually.`;

  return [
    userHint ? `${userHint}\n` : "",
    `The previous scan mapped prices to the wrong items. This receipt is likely photographed at an angle, which offsets the price column from the item column by a row or two.`,
    anchorBlock,
    subtotalBlock,
    `Previous (incorrect) mapping:`,
    breakdown,
    `Re-read the receipt, trace each item across to the price on its own row, use any printed per-unit prices as fixed anchors, and return a mapping where every individual line is correct.`,
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

// Parse the receipt and, if it doesn't reconcile (subtotal mismatch OR a
// printed per-unit line that doesn't add up), retry once with a targeted hint.
// Keeps whichever attempt reconciles best. Used by both the initial scan and
// the manual `rescan` command so both self-correct on angled receipts.
export async function parseReceiptWithReconciliation(
  imageBase64: string,
  mediaType: "image/jpeg" | "image/png" | "image/gif" | "image/webp",
  userHint?: string,
): Promise<ReconciledParseResult> {
  const first = await parseReceiptImage(imageBase64, mediaType, userHint);
  let parsed = first.parsed;
  let items = expandLineItems(parsed);
  let warning = reconciliationWarning(parsed, items);
  let estimatedCostUsd = first.estimatedCostUsd;

  if (!warning) {
    return { parsed, items, warning, estimatedCostUsd, retried: false };
  }

  const retryHint = buildAlignmentRetryHint(parsed, items, userHint);
  const retry = await parseReceiptImage(imageBase64, mediaType, retryHint);
  estimatedCostUsd += retry.estimatedCostUsd;
  const retryItems = expandLineItems(retry.parsed);

  if (
    reconciliationScore(retry.parsed, retryItems) <
    reconciliationScore(parsed, items)
  ) {
    parsed = retry.parsed;
    items = retryItems;
  }
  warning = reconciliationWarning(parsed, items);

  return { parsed, items, warning, estimatedCostUsd, retried: true };
}
