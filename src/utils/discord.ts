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

// Maps normalized aliases to canonical restaurant names.
// Keys must be lowercase for case-insensitive matching.
const RESTAURANT_ALIASES: Record<string, string> = {
  // T Kebob
  tk: 'T Kebob',
  tkebab: 'T Kebob',
  't kebab': 'T Kebob',
  't kebob': 'T Kebob',
  // SunNongDan
  snd: 'SunNongDan',
  // BCD
  bcd: 'BCD',
  // Chubby Cattle
  chubby: 'Chubby Cattle',
  'chubby cattle': 'Chubby Cattle',
};

export function extractRestaurantName(content: string, botId: string): string {
  // Remove user, role, and channel mentions and trim
  const name = content.replace(/<[@#][!&]?\d+>/g, '').trim();

  if (!name) return 'Receipt';

  const canonical = RESTAURANT_ALIASES[name.toLowerCase()];
  return canonical ?? name;
}

import { Attachment, Guild } from 'discord.js';
import { fileTypeFromBuffer } from 'file-type';

export type DisplayNameResolver = (userId: string) => string;

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
  attachment: Attachment,
): Promise<'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' | null> {
  if (!attachment) return null;

  if (!attachment) return null;

  const response = await fetch(attachment.url);

  if (!response.ok) {
    throw new Error(`Failed to fetch attachment: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const type = (await fileTypeFromBuffer(buffer))?.mime;

  if (!type) return null;

  console.log(type);

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
