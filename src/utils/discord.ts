export function parseItemNumbers(text: string): number[] {
  // Only accept individual numbers separated by commas or whitespace — no ranges
  const tokens = text.split(/[\s,]+/);
  const numbers: number[] = [];
  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      const n = parseInt(token, 10);
      if (!numbers.includes(n)) numbers.push(n);
    }
  }
  return numbers.sort((a, b) => a - b);
}

import { displayRestaurantName } from './restaurantName.js';

// Returns the display (Title Case) form of the name, with aliases resolved.
// The store normalizes it back to lowercase on write — see utils/restaurantName.ts.
export function extractRestaurantName(content: string, botId: string): string {
  // Remove user, role, and channel mentions and trim
  const name = content.replace(/<[@#][!&]?\d+>/g, '').trim();

  if (!name) return 'Receipt';

  return displayRestaurantName(name);
}

import { Attachment, Guild, Message } from 'discord.js';
import { fetchWithTimeout } from './http.js';

export type DisplayNameResolver = (userId: string) => string;

// Progress reactions (⏳ / ✅) are cosmetic, but Discord's per-user reaction
// sublimit 429s on this route and a 429 there can stall the bucket in
// @discordjs/rest indefinitely. An awaited react() on that path wedged the
// whole receipt pipeline in production — silently, since a hung await never
// reaches a catch block. So: never block receipt work on a reaction. These run
// detached and swallow failures.
//
// Reaction ops for one message are chained so ⏳ → ✅ still lands in order:
// add and removeAll are different REST routes, so the rest handler's per-bucket
// queue alone doesn't guarantee ordering between them.
const reactionChains = new Map<string, Promise<void>>();

function queueReactionOp(message: Message, op: () => Promise<unknown>): void {
  const prev = reactionChains.get(message.id) ?? Promise.resolve();
  const next = prev.then(op).then(
    () => {},
    (err) => {
      console.warn(`Reaction update failed on message ${message.id}:`, err);
    },
  );
  reactionChains.set(message.id, next);
  void next.finally(() => {
    if (reactionChains.get(message.id) === next) reactionChains.delete(message.id);
  });
}

// Adds a reaction without blocking the caller.
export function addReaction(message: Message, emoji: string): void {
  queueReactionOp(message, () => message.react(emoji));
}

// Clears the bot's reactions and adds `emoji`, without blocking the caller.
export function replaceReaction(message: Message, emoji: string): void {
  queueReactionOp(message, async () => {
    await message.reactions.removeAll().catch(() => {});
    await message.react(emoji);
  });
}

// Clears all reactions without blocking the caller.
export function clearReactions(message: Message): void {
  queueReactionOp(message, () => message.reactions.removeAll());
}

export const PROXY_PREFIX = 'proxy:';

export function isProxyUserId(id: string): boolean {
  return id.startsWith(PROXY_PREFIX);
}

export function proxyDisplayName(id: string): string {
  return id.slice(PROXY_PREFIX.length);
}

export function makeProxyUserId(name: string): string {
  return `${PROXY_PREFIX}${name}`;
}

export async function buildDisplayNameResolver(
  guild: Guild,
  userIds: string[],
): Promise<DisplayNameResolver> {
  const nameMap = new Map<string, string>();
  for (const id of userIds) {
    if (isProxyUserId(id)) {
      nameMap.set(id, proxyDisplayName(id));
      continue;
    }
    try {
      const member = await guild.members.fetch(id);
      nameMap.set(id, member.displayName);
    } catch {
      nameMap.set(id, `<@${id}>`);
    }
  }
  return (userId: string) => {
    if (isProxyUserId(userId)) return proxyDisplayName(userId);
    return nameMap.get(userId) ?? `<@${userId}>`;
  };
}

export async function getImageMediaType(
  attachment: Attachment | null,
): Promise<'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null> {
  if (!attachment) return null;

  const { fileTypeFromBuffer } = await import('file-type');

  const response = await fetchWithTimeout(attachment.url);

  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const type = (await fileTypeFromBuffer(buffer))?.mime;

  if (!type) return null;

  switch (true) {
    default:
      return null;
    case type.includes('jpeg'):
    case type.includes('jpg'):
      return 'image/jpeg';

    case type.includes('png'):
      return 'image/png';

    case type.includes('gif'):
      return 'image/gif';

    case type.includes('webp'):
      return 'image/webp';
  }
}
