// Restaurant name canonicalization.
//
// Restaurant names are stored in the database in a canonical *lowercase* form so
// that differently-cased spellings of the same place ("Chubby Mart" and
// "chubby mart") merge into a single restaurant on every leaderboard, stat and
// recommendation. Display casing is applied at the database boundary
// (see session/store.ts), so everywhere else in the app a `restaurantName` is
// already the Title Case form that gets shown in Discord.
//
// Rule of thumb:
//   - writing to the DB      -> normalizeRestaurantName()
//   - reading out of the DB  -> displayRestaurantName()

// Maps normalized aliases to their canonical (lowercase) restaurant name.
// Keys and values must be lowercase; matching is on the whole name only, so
// `chubby` -> `chubby cattle` does not affect "chubby mart".
const RESTAURANT_ALIASES: Record<string, string> = {
  // T Kebob
  tk: 't kebob',
  tkebab: 't kebob',
  't kebab': 't kebob',
  // SunNongDan
  snd: 'sunnongdan',
  // Chubby Cattle
  chubby: 'chubby cattle',
};

// Display casing for whole names that Title Case would get wrong.
// Keys are the canonical lowercase name.
const NAME_DISPLAY_OVERRIDES: Record<string, string> = {
  sunnongdan: 'SunNongDan',
};

// Display casing for individual words (acronyms and the like).
const WORD_DISPLAY_OVERRIDES: Record<string, string> = {
  bcd: 'BCD',
  bbq: 'BBQ',
  kbbq: 'KBBQ',
  ihop: 'IHOP',
  kfc: 'KFC',
  cvs: 'CVS',
  ii: 'II',
  iii: 'III',
};

// Kept lowercase in Title Case unless they are the first or last word:
// "house of pies" -> "House of Pies".
const MINOR_WORDS = new Set([
  'a',
  'an',
  'and',
  'at',
  'by',
  'de',
  'del',
  'des',
  'du',
  'el',
  'for',
  'in',
  'la',
  'le',
  'of',
  'on',
  'or',
  'the',
  'to',
  'van',
  'von',
  'with',
]);

/**
 * The canonical storage form of a restaurant name: trimmed, whitespace-collapsed,
 * lowercased, with aliases resolved. This is the form every DB write and lookup uses.
 */
export function normalizeRestaurantName(raw: string): string {
  const collapsed = raw.trim().replace(/\s+/g, ' ').toLowerCase();
  return RESTAURANT_ALIASES[collapsed] ?? collapsed;
}

/**
 * The form shown in Discord: Title Case, with overrides for acronyms and names
 * whose real casing isn't Title Case. Safe to call on any form of the name —
 * it normalizes first, so it's idempotent.
 */
export function displayRestaurantName(name: string): string {
  const normalized = normalizeRestaurantName(name);
  if (!normalized) return normalized;

  const nameOverride = NAME_DISPLAY_OVERRIDES[normalized];
  if (nameOverride) return nameOverride;

  const words = normalized.split(' ');
  return words
    .map((word, i) => titleCaseWord(word, i === 0 || i === words.length - 1))
    .join(' ');
}

function titleCaseWord(word: string, isEdgeWord: boolean): string {
  const override = WORD_DISPLAY_OVERRIDES[word];
  if (override) return override;

  if (!isEdgeWord && MINOR_WORDS.has(word)) return word;

  // Capitalize each hyphen/slash-separated part so "chick-fil-a" -> "Chick-Fil-A".
  // Apostrophes are not split on, so "chubby's" -> "Chubby's".
  return word
    .split(/([-/])/)
    .map((part) => WORD_DISPLAY_OVERRIDES[part] ?? capitalizeFirstLetter(part))
    .join('');
}

// Uppercases the first letter in the segment, leaving any leading digits or
// symbols alone: "85c" -> "85C".
function capitalizeFirstLetter(segment: string): string {
  return segment.replace(/[a-z]/, (c) => c.toUpperCase());
}
