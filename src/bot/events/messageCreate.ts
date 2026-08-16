import {
  Client,
  Message,
  TextChannel,
  ThreadChannel,
  ChannelType,
  EmbedBuilder,
  APIEmbed,
  ActionRowBuilder,
  ButtonBuilder,
  OmitPartialGroupDMChannel,
  MessagePayload,
  MessageReplyOptions,
  MessageCreateOptions,
} from 'discord.js';
import { randomUUID } from 'crypto';
import { config } from '../../config.js';
import {
  parseReceiptWithReconciliation,
} from '../../receipt/parser.js';
import { findSimilarRestaurants } from '../../receipt/recommend.js';
import {
  buildSummaryEmbeds,
  buildUserEmbed,
  buildUserVenmoButton,
  formatItemList,
  formatThreadHelp,
  formatChannelHelp,
} from '../../receipt/formatter.js';
import * as manager from '../../session/manager.js';
import type { DateRange } from '../../session/store.js';
import {
  parseItemNumbers,
  extractRestaurantName,
  getImageMediaType,
  buildDisplayNameResolver,
  DisplayNameResolver,
  isProxyUserId,
  makeProxyUserId,
  proxyDisplayName,
} from '../../utils/discord.js';
import { ReceiptSession, UserTotal } from '../../receipt/types.js';

export function hasEmbeds(
  value: unknown,
): value is { embeds: EmbedBuilder[]; components?: ActionRowBuilder<ButtonBuilder>[] } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'embeds' in value &&
    Array.isArray(value.embeds) &&
    value.embeds.every((embed) => embed instanceof EmbedBuilder)
  );
}

export async function messageReplyHandler(
  message: Message,
  input: string | MessagePayload | MessageReplyOptions,
): Promise<void> {
  try {
    await message.reply(input);
  } catch (err: any) {
    if (err?.code == 50035 && hasEmbeds(input)) {
      const components = input.components;
      for (let i = 0; i < input.embeds.length; i++) {
        // Attach components only to the last message so they appear at the bottom.
        await message.reply({
          embeds: [input.embeds[i].data],
          components: i === input.embeds.length - 1 ? components : undefined,
        });
      }
    } else {
      console.error('Error handling message:', err);
      try {
        await message.reply(
          `OOPSIE WOOPSIE!! Uwu We make a fucky wucky!! A wittle fucko boingo! The code monkeys at our headquarters are working VEWY HAWD to fix this!`,
        );
      } catch {
        // ignore reply failure
      }
    }
  }
}

export async function threadSendHandler(
  thread: ThreadChannel,
  input: string | MessagePayload | MessageCreateOptions,
): Promise<Message> {
  try {
    return await thread.send(input);
  } catch (err: any) {
    if (err?.code == 50035 && hasEmbeds(input)) {
      let lastMsg;
      const components = input.components;
      for (let i = 0; i < input.embeds.length; i++) {
        const msg = await thread.send({
          embeds: [input.embeds[i].data],
          components: i === input.embeds.length - 1 ? components : undefined,
        });
        lastMsg = msg;
      }
      return lastMsg as Message<true>;
    } else {
      console.error('Error handling message:', err);
      return await thread.send(
        `OOPSIE WOOPSIE!! Uwu We make a fucky wucky!! A wittle fucko boingo! The code monkeys at our headquarters are working VEWY HAWD to fix this!`,
      );
    }
  }
}

export function registerMessageCreateEvent(client: Client): void {
  client.on('messageCreate', async (message: Message) => {
    if (message.author.bot) return;

    try {
      // Messages in receipt threads
      if (
        message.channel.type === ChannelType.PublicThread ||
        message.channel.type === ChannelType.PrivateThread
      ) {
        await handleThreadMessage(message, client);
        return;
      }

      // Bot must be mentioned for any non-thread command
      if (!message.mentions.has(client.user!)) return;

      const content = message.content.toLowerCase();
      const hasImage = message.attachments.some((a) => a.contentType?.startsWith('image/'));

      // Help command
      if (content.includes('help')) {
        await message.reply(formatChannelHelp());
        return;
      }

      // New restaurant suggestions (must come before the bare-new-receipt handler)
      const noMentions = message.content.replace(/<@!?\d+>/g, '').trim();
      if (!hasImage && /^new(\s+|$)/i.test(noMentions)) {
        await handleNewRestaurantSuggestions(message);
        return;
      }

      // Personal leaderboard (check before the global leaderboard)
      if (
        content.includes('leaderboard') &&
        (content.includes('personal') || content.includes(' me ') || content.includes(' my '))
      ) {
        await handlePersonalLeaderboard(message);
        return;
      }

      // Leaderboard command
      if (content.includes('leaderboard')) {
        await handleLeaderboard(message);
        return;
      }

      // Add total command (manual leaderboard entry)
      if (content.includes('addtotal')) {
        await handleAddTotal(message);
        return;
      }

      // Recommend command
      if (content.includes('recommend')) {
        await handleRecommend(message);
        return;
      }

      // Recent / open receipts uploaded by the requester.
      // Guard on no image so a new-receipt submission whose caption is a bare
      // number (e.g. a restaurant named "10") isn't swallowed here.
      const cleaned = content.replace(/<@!?\d+>/g, '').trim();
      if (!hasImage && (cleaned === 'open' || cleaned === 'open receipts')) {
        await handleOpenReceipts(message);
        return;
      }
      if (!hasImage && (/^recent\b/.test(cleaned) || /^\d+$/.test(cleaned))) {
        await handleRecentReceipts(message, cleaned);
        return;
      }

      // Sum command (check "sum paid" before "sum")
      if (content.includes('sum paid')) {
        await handleSum(message, client, true);
        return;
      }
      if (content.includes('sum')) {
        await handleSum(message, client, false);
        return;
      }

      // New receipt submission (bot mention + image attachment)
      if (message.attachments.some((a) => a.contentType?.startsWith('image/'))) {
        await handleNewReceipt(message, client);
      }
    } catch (err) {
      console.error('Error handling message:', err);
      try {
        await message.reply(
          `OOPSIE WOOPSIE!! Uwu We make a fucky wucky!! A wittle fucko boingo! The code monkeys at our headquarters are working VEWY HAWD to fix this!`,
        );
      } catch {
        // ignore reply failure
      }
    }
  });
}

// Returns a single proxy target for commands that act on behalf of one user
// (claim, unclaim, split). Returns null if not applicable.
function getProxyTarget(message: Message, session: ReceiptSession): string | null {
  if (message.author.id !== session.primaryUserId) return null;
  const mentioned = message.mentions.users
    .filter((u) => !u.bot && u.id !== message.author.id)
    .map((u) => u.id);
  if (mentioned.length !== 1) return null;
  const targetId = mentioned[0];
  if (!session.taggedUserIds.includes(targetId)) return null;
  return targetId;
}

// Resolves a trailing `as <name>` proxy suffix. Only the primary user may use it.
// Returns the matched proxy user ID and the command text with the suffix stripped, or null if no suffix.
function resolveProxySuffix(
  content: string,
  message: Message,
  session: ReceiptSession,
): { proxyId: string; stripped: string } | null {
  const match = content.match(/^(.*?)\s+as\s+(\S+)\s*$/i);
  if (!match) return null;
  if (message.author.id !== session.primaryUserId) return null;

  const name = match[2].trim();
  const proxyId = session.taggedUserIds.find(
    (id) => isProxyUserId(id) && id.slice(6).toLowerCase() === name.toLowerCase(),
  );
  if (!proxyId) return null;

  return { proxyId, stripped: match[1].trim() };
}

// Returns all proxy targets for paid/unpaid, which can act on multiple users at once.
function getProxyTargets(message: Message, session: ReceiptSession): string[] | null {
  if (message.author.id !== session.primaryUserId) return null;
  const mentioned = message.mentions.users
    .filter((u) => !u.bot && u.id !== message.author.id)
    .map((u) => u.id)
    .filter((id) => session.taggedUserIds.includes(id));
  if (mentioned.length === 0) return null;
  return mentioned;
}

async function getDisplayNameResolver(
  message: Message,
  session: ReceiptSession,
): Promise<DisplayNameResolver> {
  const guild = message.guild;
  if (!guild) return (id: string) => `<@${id}>`;

  const allUserIds = new Set(session.taggedUserIds);
  const items = manager.getItems(session.id);
  for (const item of items) {
    if (item.claimedByUserId) allUserIds.add(item.claimedByUserId);
  }
  const splits = manager.getSplits(session.id);
  for (const s of splits) allUserIds.add(s.userId);

  return buildDisplayNameResolver(guild, [...allUserIds]);
}

// Parses the text after `leaderboard` into an optional restaurant filter and an
// optional date window. Timeframe tokens (today/week/month/year, from/since/to
// <date>, or bare YYYY-MM-DD) are consumed; whatever remains is the restaurant name.
function parseLeaderboardArgs(message: Message): {
  range?: DateRange;
  label: string | null;
  restaurant: string | null;
} {
  const stripped = message.content.replace(/<@!?\d+>/g, ' ');
  const m = stripped.match(/leaderboard\b(.*)/is);
  const rest = (m?.[1] ?? '').trim();
  if (!rest) return { label: null, restaurant: null };

  const tokens = rest.split(/\s+/).filter(Boolean);
  const leftover: string[] = [];
  let range: DateRange | undefined;
  let label: string | null = null;

  const now = new Date();
  const toISODate = (d: Date) => d.toISOString().slice(0, 10);
  const daysAgo = (n: number) => {
    const d = new Date(now);
    d.setUTCDate(d.getUTCDate() - n);
    return toISODate(d);
  };
  const isDate = (s: string | undefined) => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i].toLowerCase();
    if (t === 'today') {
      range = { ...(range ?? {}), from: toISODate(now) };
      label = 'Today';
    } else if (t === 'week') {
      range = { ...(range ?? {}), from: daysAgo(6) };
      label = 'Last 7 days';
    } else if (t === 'month') {
      range = { ...(range ?? {}), from: daysAgo(29) };
      label = 'Last 30 days';
    } else if (t === 'year') {
      range = { ...(range ?? {}), from: daysAgo(364) };
      label = 'Last 365 days';
    } else if ((t === 'from' || t === 'since') && isDate(tokens[i + 1])) {
      range = { ...(range ?? {}), from: tokens[++i] };
    } else if (t === 'to' && isDate(tokens[i + 1])) {
      range = { ...(range ?? {}), to: tokens[++i] };
    } else if (isDate(tokens[i])) {
      if (!range?.from) range = { ...(range ?? {}), from: tokens[i] };
      else range = { ...range, to: tokens[i] };
    } else {
      leftover.push(tokens[i]);
    }
  }

  // Build a human label for explicit ranges that didn't come from a keyword.
  if (range && !label) {
    if (range.from && range.to) label = `${range.from} to ${range.to}`;
    else if (range.from) label = `Since ${range.from}`;
    else if (range.to) label = `Through ${range.to}`;
  }

  const restaurantRaw = leftover.join(' ').trim();
  const restaurant = restaurantRaw ? extractRestaurantName(restaurantRaw, '') : null;

  return { range, label, restaurant };
}

async function handleLeaderboard(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('Leaderboard is only available in servers.');
    return;
  }

  const guild = message.guild;
  const { range, label, restaurant } = parseLeaderboardArgs(message);

  // Per-restaurant leaderboard
  if (restaurant) {
    const data = manager.getRestaurantLeaderboard(message.guildId, restaurant, range);
    if (!data) {
      await message.reply(
        `No settled receipts for **${restaurant}**${label ? ` in ${label.toLowerCase()}` : ''} yet — nothing to show.`,
      );
      return;
    }

    const displayName =
      data.topSpenders.length > 0
        ? await buildDisplayNameResolver(
            guild,
            data.topSpenders.map((s) => s.userId),
          )
        : (_id: string) => 'Unknown';

    const embed = new EmbedBuilder()
      .setTitle(`🏆 ${restaurant} Leaderboard`)
      .setColor(0xe67e22)
      .setDescription(
        [
          label ? `_${label}_` : null,
          `**Total spend:** $${data.totalSpend.toFixed(2)} across ${data.receiptCount} receipt${data.receiptCount !== 1 ? 's' : ''}`,
        ]
          .filter(Boolean)
          .join('\n'),
      );

    const lines = data.topSpenders.map(
      (s, i) =>
        `${i + 1}. **${displayName(s.userId)}** — $${s.totalSpend.toFixed(2)} (${s.visits} visit${s.visits !== 1 ? 's' : ''})`,
    );
    embed.addFields({ name: 'Top Spenders', value: lines.join('\n'), inline: false });

    await message.reply({ embeds: [embed] });
    return;
  }

  // Global leaderboard — date-filtered reads from settlement_entries; all-time
  // uses the pre-aggregated stats (which also include legacy addtotal totals).
  const { restaurants, users } = range
    ? manager.getFilteredLeaderboard(message.guildId, range)
    : manager.getLeaderboard(message.guildId);

  if (restaurants.length === 0 && users.length === 0) {
    await message.reply(
      `No settled receipts${label ? ` in ${label.toLowerCase()}` : ''} yet — nothing to show.`,
    );
    return;
  }

  const userIds = users.map((u) => u.userId);
  const displayName =
    userIds.length > 0 ? await buildDisplayNameResolver(guild, userIds) : (_id: string) => 'Unknown';

  const embed = new EmbedBuilder().setTitle('🏆 Receipt Leaderboard').setColor(0x3498db);
  if (label) embed.setDescription(`_${label}_`);

  if (restaurants.length > 0) {
    const lines = restaurants.map(
      (r, i) =>
        `${i + 1}. **${r.restaurantName}** — $${r.totalSpend.toFixed(2)} (${r.receiptCount} receipt${r.receiptCount !== 1 ? 's' : ''})`,
    );
    embed.addFields({
      name: 'Top Restaurants by Spend',
      value: lines.join('\n'),
      inline: false,
    });
  }

  if (users.length > 0) {
    const lines = users.map((u, i) => `${i + 1}. **${displayName(u.userId)}** — $${u.totalSpend.toFixed(2)}`);
    embed.addFields({
      name: 'Top Spenders',
      value: lines.join('\n'),
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function handleNewRestaurantSuggestions(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('Restaurant suggestions are only available in servers.');
    return;
  }

  const location = message.content
    .replace(/<@!?\d+>/g, '')
    .trim()
    .replace(/^new\s*/i, '')
    .trim();

  if (!location) {
    await message.reply('Usage: `@bot new <location>` — e.g. `@bot new Austin, TX`');
    return;
  }

  const favorites = manager.getMostFrequentRestaurants(message.guildId, 10);
  if (favorites.length === 0) {
    await message.reply(
      "I don't have any restaurant history for this server yet. Upload a few receipts first!",
    );
    return;
  }

  manager.checkDailyLimit();

  const result = await findSimilarRestaurants(
    favorites.map((f) => ({ name: f.restaurantName, receiptCount: f.receiptCount })),
    location,
    5,
  );
  manager.logApiCost(result.estimatedCostUsd);

  const basis = favorites
    .slice(0, 5)
    .map((f) => `${f.restaurantName} (${f.receiptCount} visit${f.receiptCount !== 1 ? 's' : ''})`)
    .join(', ');

  const embed = new EmbedBuilder()
    .setTitle(`🍽️ New restaurant ideas near ${location}`)
    .setColor(0x2ecc71)
    .setDescription(`Based on your group's favorites: ${basis}`);

  for (const r of result.restaurants) {
    embed.addFields({
      name: `${r.name} · ${r.cuisine} · ${r.priceRange}`,
      value: r.reason,
      inline: false,
    });
  }

  await message.reply({ embeds: [embed] });
}

async function handlePersonalLeaderboard(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('Personal stats are only available in servers.');
    return;
  }

  const userId = message.author.id;
  const stats = manager.getPersonalStats(message.guildId, userId);

  if (stats.receiptCount === 0) {
    await message.reply("You have no settled receipts yet — nothing to show.");
    return;
  }

  const displayName = (await buildDisplayNameResolver(message.guild, [userId]))(userId);

  const embed = new EmbedBuilder()
    .setTitle(`📊 ${displayName}'s Receipt Stats`)
    .setColor(0x9b59b6);

  // Headline: lifetime spend, receipts, average, rank
  const headline = [
    `**Lifetime spend:** $${stats.lifetimeSpend.toFixed(2)} across ${stats.receiptCount} receipt${stats.receiptCount !== 1 ? 's' : ''}`,
    `**Average per receipt:** $${stats.averagePortion.toFixed(2)}`,
    `**Total tip paid:** $${stats.totalTip.toFixed(2)}`,
  ];
  if (stats.rank !== null) {
    headline.push(`**Server rank:** #${stats.rank} of ${stats.rankOutOf} spender${stats.rankOutOf !== 1 ? 's' : ''}`);
  }
  if (stats.mostVisited) {
    headline.push(
      `**Most visited:** ${stats.mostVisited.restaurantName} (${stats.mostVisited.visits} visit${stats.mostVisited.visits !== 1 ? 's' : ''})`,
    );
  }
  embed.setDescription(headline.join('\n'));

  if (stats.topRestaurants.length > 0) {
    const lines = stats.topRestaurants.map(
      (r, i) =>
        `${i + 1}. **${r.restaurantName}** — $${r.totalSpend.toFixed(2)} (${r.visits} visit${r.visits !== 1 ? 's' : ''})`,
    );
    embed.addFields({ name: 'Top Restaurants by Spend', value: lines.join('\n'), inline: false });
  }

  if (stats.topPortions.length > 0) {
    const lines = stats.topPortions.map((p, i) => {
      const date = p.settledAt.slice(0, 10);
      return `${i + 1}. **$${p.amount.toFixed(2)}** — ${p.restaurantName} (${date})`;
    });
    embed.addFields({ name: 'Most Expensive Receipts', value: lines.join('\n'), inline: false });
  }

  await message.reply({ embeds: [embed] });
}

async function handleAddTotal(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('This command is only available in servers.');
    return;
  }

  // Take everything after the "addtotal" keyword — the bot mention always precedes it
  const addtotalMatch = message.content.match(/addtotal\s*(.*)/is);
  if (!addtotalMatch) {
    await message.reply('Usage: `@bot addtotal [restaurant] @user1 amount1 @user2 amount2`');
    return;
  }
  const afterKeyword = addtotalMatch[1].trim();

  // Extract restaurant name: text before the first user mention
  const firstMentionPos = afterKeyword.search(/<@!?\d+>/);
  if (firstMentionPos === -1) {
    await message.reply('Usage: `@bot addtotal [restaurant] @user1 amount1 @user2 amount2`');
    return;
  }

  const restaurantRaw = afterKeyword.slice(0, firstMentionPos).trim();
  if (!restaurantRaw) {
    await message.reply('Please specify a restaurant name before the mentions.');
    return;
  }
  const restaurantName = extractRestaurantName(restaurantRaw, '');

  // Parse mention+amount pairs from the remainder
  const remainder = afterKeyword.slice(firstMentionPos);
  const tokens = remainder.trim().split(/\s+/);
  const userAmounts: { userId: string; grandTotal: number }[] = [];

  for (let i = 0; i < tokens.length; i++) {
    const mentionMatch = tokens[i].match(/^<@!?(\d+)>$/);
    if (!mentionMatch) continue;
    const userId = mentionMatch[1];
    const next = tokens[i + 1];
    if (!next) {
      await message.reply(`Missing amount after <@${userId}>.`);
      return;
    }
    const amount = parseFloat(next.replace('$', ''));
    if (isNaN(amount) || amount < 0) {
      await message.reply(`Invalid amount "${next}" after <@${userId}>.`);
      return;
    }
    userAmounts.push({ userId, grandTotal: amount });
    i++; // skip the amount token
  }

  if (userAmounts.length === 0) {
    await message.reply('Please mention at least one user with an amount.');
    return;
  }

  manager.recordSettlement(message.guildId, restaurantName, userAmounts);

  const displayName = await buildDisplayNameResolver(
    message.guild,
    userAmounts.map((u) => u.userId),
  );
  const total = userAmounts.reduce((sum, u) => sum + u.grandTotal, 0);
  const lines = userAmounts.map((u) => `  ${displayName(u.userId)}: $${u.grandTotal.toFixed(2)}`);

  await message.reply(
    `Added to leaderboard:\n**${restaurantName}** — $${total.toFixed(2)}\n${lines.join('\n')}`,
  );
}

async function handleRecommend(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('This command is only available in servers.');
    return;
  }

  const stripped = message.content.replace(/<@!?\d+>/g, ' ');
  const match = stripped.match(/recommend\b(.*)/is);
  const rest = (match?.[1] ?? '').trim();

  let limit = 5;
  if (rest) {
    const parsed = parseInt(rest, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, 25);
    }
  }

  const recommendations = manager.getRecommendations(message.guildId, limit);
  if (recommendations.length === 0) {
    await message.reply('No settled receipts yet — I have no history to recommend from.');
    return;
  }

  const lines = recommendations.map((r, i) => {
    const date = r.lastVisit.slice(0, 10);
    return `${i + 1}. **${r.restaurantName}** — ${r.visits} visit${r.visits !== 1 ? 's' : ''} · $${r.totalSpend.toFixed(2)} · last ${date}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`🍽️ ${recommendations.length} Place${recommendations.length !== 1 ? 's' : ''} to Eat`)
    .setColor(0x2ecc71)
    .setDescription(lines.join('\n'));

  await message.reply({ embeds: [embed] });
}

// Human-readable status for a receipt, keyed off session.status.
// active/all_claimed both read as "Open" (still accepting commands); a receipt
// is "Closed" once fully paid (settled), and "Voided" if cancelled.
function receiptStatusLabel(status: string): string {
  switch (status) {
    case 'settled':
      return '✅ Closed';
    case 'voided':
      return '🚫 Voided';
    default:
      return '🟢 Open';
  }
}

async function handleRecentReceipts(message: Message, cleaned: string): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('This command is only available in servers.');
    return;
  }

  let limit = 10;
  const numMatch = cleaned.match(/\d+/);
  if (numMatch) {
    const parsed = parseInt(numMatch[0], 10);
    if (!isNaN(parsed) && parsed > 0) limit = Math.min(parsed, 25);
  }

  const sessions = manager.getRecentSessionsForUser(message.guildId, message.author.id, limit);
  if (sessions.length === 0) {
    await message.reply("You haven't uploaded any receipts in this server yet.");
    return;
  }

  const lines = sessions.map((s) => {
    const date = s.createdAt.slice(0, 10);
    return `${receiptStatusLabel(s.status)} — **${s.restaurantName}** (<#${s.threadId}>) · $${s.total.toFixed(2)} · ${date}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📋 Your Last ${sessions.length} Receipt${sessions.length !== 1 ? 's' : ''}`)
    .setColor(0x3498db)
    .setDescription(lines.join('\n'));

  await message.reply({ embeds: [embed] });
}

async function handleOpenReceipts(message: Message): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('This command is only available in servers.');
    return;
  }

  const sessions = manager.getOpenSessionsForUser(message.guildId, message.author.id);
  if (sessions.length === 0) {
    await message.reply('You have no open receipts — everything you uploaded is settled. 🎉');
    return;
  }

  const MAX = 25;
  const shown = sessions.slice(0, MAX);
  const lines = shown.map((s) => {
    const date = s.createdAt.slice(0, 10);
    return `🟢 **${s.restaurantName}** (<#${s.threadId}>) · $${s.total.toFixed(2)} · ${date}`;
  });
  if (sessions.length > MAX) {
    lines.push(`…and ${sessions.length - MAX} more.`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`🟢 Your Open Receipt${sessions.length !== 1 ? 's' : ''} (${sessions.length})`)
    .setColor(0x2ecc71)
    .setDescription(lines.join('\n'));

  await message.reply({ embeds: [embed] });
}

async function handleSum(message: Message, client: Client, markPaid: boolean): Promise<void> {
  if (!message.guildId || !message.guild) {
    await message.reply('The sum command is only available in servers.');
    return;
  }

  const sessions = manager.getUnpaidSessionsForUser(message.guildId, message.author.id);

  if (sessions.length === 0) {
    await message.reply('You have no unpaid items across any active receipts.');
    return;
  }

  const sessionData: { session: ReceiptSession; ut: UserTotal }[] = [];
  for (const session of sessions) {
    const userTotals = manager.getUserTotals(session);
    const ut = userTotals.find((u) => u.userId === message.author.id);
    if (ut) sessionData.push({ session, ut });
  }

  if (sessionData.length === 0) {
    await message.reply('You have no unpaid items across any active receipts.');
    return;
  }

  const grandTotal = sessionData.reduce((sum, d) => sum + d.ut.grandTotal, 0);

  const lines = sessionData.map((d) => `**${d.session.restaurantName}** — $${d.ut.grandTotal.toFixed(2)}`);
  lines.push(`\n**Grand Total: $${grandTotal.toFixed(2)}**`);

  if (markPaid) {
    for (const { session } of sessionData) {
      manager.markUserPaid(session.id, message.author.id);
    }

    // Update each thread's summary and check for settlement
    for (const { session } of sessionData) {
      try {
        const thread = await client.channels.fetch(session.threadId);
        if (!thread || !thread.isThread()) continue;

        const refreshedSession = manager.getSession(session.threadId);
        if (!refreshedSession) continue;

        const displayName = await buildDisplayNameResolver(thread.guild, refreshedSession.taggedUserIds);
        const items = manager.getItems(session.id);
        const userTotals = manager.getUserTotals(refreshedSession);
        const payments = manager.getPaymentStatuses(session.id);
        const splits = manager.getSplits(session.id);
        const primaryHandle = manager.getUserVenmoHandle(refreshedSession.primaryUserId);
        const { embeds, components } = buildSummaryEmbeds(
          refreshedSession,
          items,
          userTotals,
          payments,
          splits,
          displayName,
          primaryHandle,
        );

        if (session.summaryMessageId) {
          try {
            const summaryMsg = await thread.messages.fetch(session.summaryMessageId);
            await summaryMsg.edit({ embeds, components });
          } catch {
            const newMsg = await threadSendHandler(thread, { embeds, components });
            manager.setSummaryMessageId(session.id, newMsg.id);
          }
        }

        const { allPaid } = manager.checkAllClaimedAndPaid(refreshedSession);
        if (allPaid) {
          const primaryName = displayName(session.primaryUserId);
          manager.recordSettlement(session.guildId, session.restaurantName, userTotals, session.id);
          await thread.send(
            `🎉 **${primaryName}** — All payments for **${session.restaurantName}** have been received!`,
          );
          try {
            await thread.edit({ archived: true, locked: true });
          } catch {
            // ignore — bot may lack Manage Threads permission
          }
        }

        // Remove user from thread (self-initiated via sum paid, not primary user of this session)
        if (message.author.id !== session.primaryUserId) {
          try {
            await thread.members.remove(message.author.id);
          } catch {
            // ignore
          }
        }
      } catch (err) {
        console.error(`Failed to update thread for session ${session.id}:`, err);
      }
    }

    const embed = new EmbedBuilder()
      .setTitle('✅ Marked as Paid')
      .setColor(0x2ecc71)
      .setDescription(lines.join('\n'));
    await message.reply({ embeds: [embed] });
  } else {
    const embed = new EmbedBuilder()
      .setTitle('💰 Your Unpaid Totals')
      .setColor(0xe74c3c)
      .setDescription(lines.join('\n') + '\n\nReply `@bot sum paid` to mark all as paid.');
    await message.reply({ embeds: [embed] });
  }
}

async function handleNewReceipt(message: Message, client: Client): Promise<void> {
  const attachment = message.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (!attachment) {
    await message.reply('Please include a receipt image in your message.');
    return;
  }

  const mediaType = await getImageMediaType(attachment);
  if (!mediaType) {
    await message.reply('Unsupported image format. Please use JPEG, PNG, GIF, or WebP.');
    return;
  }

  const taggedUserIds = message.mentions.users.filter((u) => u.id !== client.user!.id).map((u) => u.id);

  if (taggedUserIds.length === 0) {
    await message.reply('Please tag at least one other user to split the receipt with.');
    return;
  }

  // Check daily API spend limit before calling Claude
  manager.checkDailyLimit();

  const restaurantName = extractRestaurantName(message.content, client.user!.id);

  await message.react('⏳');

  const response = await fetch(attachment.url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const imageBase64 = buffer.toString('base64');

  let result;
  try {
    result = await parseReceiptWithReconciliation(imageBase64, mediaType);
  } catch (err) {
    await message.reactions.removeAll().catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    await message.reply(
      `⚠️ Couldn't read this receipt: ${reason}`
    );
    return;
  }
  manager.logApiCost(result.estimatedCostUsd);

  const parsed = result.parsed;
  const allItems = result.items;
  const warning = result.warning;
  const wasRescanned = result.retried;

  const lineItems = allItems.filter((item) => item.unitPrice > 0);

  const thread = await (message.channel as TextChannel).threads.create({
    name: restaurantName,
    startMessage: message,
  });

  const tipFromReceipt = parsed.tip;
  const defaultTipApplied = tipFromReceipt === null || tipFromReceipt === 0;
  const effectiveTip = defaultTipApplied ? Math.round(parsed.subtotal * 0.2 * 100) / 100 : tipFromReceipt;

  const session: ReceiptSession = {
    id: randomUUID(),
    threadId: thread.id,
    originalMessageId: message.id,
    channelId: message.channelId,
    guildId: message.guildId!,
    primaryUserId: message.author.id,
    restaurantName,
    subtotal: parsed.subtotal,
    discountAmount: parsed.discount,
    taxAmount: parsed.tax,
    tipAmount: effectiveTip,
    total: parsed.total,
    currencyCode: parsed.currencyCode,
    rateToUsd: parsed.rateToUsd,
    rateDate: parsed.rateDate,
    originalSubtotal: parsed.originalSubtotal,
    originalDiscount: parsed.originalDiscount,
    originalTax: parsed.originalTax,
    originalTip: parsed.originalTip,
    originalTotal: parsed.originalTotal,
    status: 'active',
    category: 'food',
    summaryMessageId: null,
    taggedUserIds: [message.author.id, ...taggedUserIds],
    createdAt: new Date().toISOString(),
  };

  manager.createReceiptSession(session, lineItems);

  const itemListMsg = formatItemList(session.taggedUserIds);
  await thread.send(itemListMsg);

  const displayName = await getDisplayNameResolver(message, session);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const primaryHandle = manager.getUserVenmoHandle(session.primaryUserId);
  const { embeds, components } = buildSummaryEmbeds(
    session,
    lineItems,
    userTotals,
    payments,
    splits,
    displayName,
    primaryHandle,
  );
  const summaryMsg = await threadSendHandler(thread, { embeds, components });
  manager.setSummaryMessageId(session.id, summaryMsg.id);

  if (wasRescanned) {
    await thread.send(
      "🔄 The receipt was re-scanned because the first scan's item prices didn't match the subtotal. Please double-check the values below.",
    );
  }

  if (warning) {
    await thread.send(`⚠️ ${warning}`);
  }

  if (defaultTipApplied) {
    await thread.send(
      `No tip detected on the receipt — a default 20% tip ($${effectiveTip.toFixed(2)}) was applied. The primary user can reply \`tip 15%\`, \`tip 15.00\`, or \`tip 0\` to change it.`,
    );
  }

  await message.reactions.removeAll().catch(() => {});
  await message.react('✅');
}

async function handleThreadMessage(message: Message, client: Client): Promise<void> {
  const thread = message.channel as ThreadChannel;
  const session = manager.getSession(thread.id);
  if (!session) return;

  if (session.status === 'settled') {
    await message.reply('This receipt has already been settled.');
    return;
  }

  if (session.status === 'voided') {
    await message.reply('This receipt has been voided — no further commands are accepted.');
    return;
  }

  // Strip mentions from content so proxy commands parse cleanly
  let contentClean = message.content
    .replace(/<@!?\d+>/g, '')
    .trim()
    .toLowerCase();

  // Proxy-by-name via trailing `as <name>` — only primary user
  const proxyByName = resolveProxySuffix(contentClean, message, session);
  if (proxyByName) contentClean = proxyByName.stripped;

  // Proxy-by-mention: if primary user tags a secondary user, act on their behalf
  const proxyTarget = proxyByName?.proxyId ?? getProxyTarget(message, session);
  const effectiveUserId = proxyTarget ?? message.author.id;

  if (contentClean === 'sum paid' || contentClean === 'sp') {
    await handleSum(message, client, true);
    return;
  }

  if (contentClean === 'sum' || contentClean === 'sm') {
    await handleSum(message, client, false);
    return;
  }

  if (contentClean.startsWith('rename ') || contentClean.startsWith('rn ')) {
    await handleRename(message, session, contentClean);
    return;
  }

  if (contentClean.startsWith('tip ') || contentClean.startsWith('t ')) {
    await handleTipCommand(message, session, contentClean);
    return;
  }

  if (
    contentClean === 'discount' ||
    contentClean.startsWith('discount ') ||
    contentClean.startsWith('disc ') ||
    contentClean === 'disc'
  ) {
    await handleDiscountCommand(message, session, contentClean);
    return;
  }

  if (contentClean.startsWith('unclaim ') || contentClean.startsWith('uc ')) {
    await handleUnclaim(message, session, contentClean, effectiveUserId);
    return;
  }

  if (contentClean.startsWith('split ') || contentClean.startsWith('s ')) {
    // For split, mentions are participants — not proxy targets, and the
    // actor is never auto-included.
    await handleSplit(message, session);
    return;
  }

  if (contentClean === 'void') {
    await handleVoid(message, session);
    return;
  }

  if (contentClean === 'nonfood' || contentClean === 'nf') {
    await handleCategory(message, session, 'non_food');
    return;
  }

  if (contentClean === 'food') {
    await handleCategory(message, session, 'food');
    return;
  }

  if (contentClean === 'help' || contentClean === 'h') {
    await message.reply(formatThreadHelp());
    return;
  }

  if (
    contentClean.startsWith('venmo ') ||
    contentClean === 'venmo' ||
    contentClean.startsWith('v ') ||
    contentClean === 'v'
  ) {
    await handleVenmo(message, session, contentClean);
    return;
  }

  if (contentClean === 'rescan' || contentClean.startsWith('rescan ')) {
    const hint = contentClean === 'rescan' ? '' : contentClean.slice('rescan '.length).trim();
    await handleRescan(message, session, client, hint);
    return;
  }

  if (contentClean.startsWith('addproxy ') || contentClean.startsWith('ap ')) {
    await handleAddProxy(message, session);
    return;
  }

  if (contentClean === 'paid' || contentClean === 'done' || contentClean === 'p') {
    const targets = proxyByName
      ? [proxyByName.proxyId]
      : (getProxyTargets(message, session) ?? [message.author.id]);
    for (const t of targets) await handlePaid(message, session, t);
    return;
  }

  if (contentClean === 'unpaid' || contentClean === 'up') {
    const targets = proxyByName
      ? [proxyByName.proxyId]
      : (getProxyTargets(message, session) ?? [message.author.id]);
    for (const t of targets) await handleUnpaid(message, session, t);
    return;
  }

  if (contentClean === 'status' || contentClean === 'st') {
    await handleStatus(message, session);
    return;
  }

  if (contentClean.startsWith('adduser ') || contentClean.startsWith('au ')) {
    await handleAddUser(message, session);
    return;
  }

  if (contentClean.startsWith('edit ') || contentClean.startsWith('e ')) {
    await handleEditPrice(message, session, contentClean);
    return;
  }

  if (contentClean.startsWith('add ') || contentClean.startsWith('a ')) {
    await handleAddItem(message, session, contentClean);
    return;
  }

  if (contentClean.startsWith('remove ') || contentClean.startsWith('rm ')) {
    await handleRemoveItem(message, session, contentClean);
    return;
  }

  if (
    contentClean.startsWith('claim ') ||
    contentClean === 'claim' ||
    contentClean.startsWith('c ') ||
    contentClean === 'c'
  ) {
    const prefix = contentClean.startsWith('claim') ? 'claim' : 'c';
    const numbers = parseItemNumbers(contentClean.slice(prefix.length));
    if (numbers.length === 0) {
      await message.reply('Please specify item numbers (e.g. `claim 1 3 5`).');
      return;
    }
    await handleClaim(message, session, numbers, effectiveUserId);
    return;
  }
}

async function handleClaim(
  message: Message,
  session: ReceiptSession,
  itemNumbers: number[],
  targetUserId: string,
): Promise<void> {
  try {
    manager.claimItems(session.id, itemNumbers, targetUserId);
  } catch (err) {
    await message.reply(err instanceof Error ? err.message : 'Failed to claim items.');
    return;
  }

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  const displayName = await getDisplayNameResolver(message, refreshedSession);
  const userTotals = manager.getUserTotals(refreshedSession);
  const ut = userTotals.find((u) => u.userId === targetUserId);

  if (ut) {
    const payments = manager.getPaymentStatuses(refreshedSession.id);
    const splits = manager.getSplits(refreshedSession.id);
    const paid = payments.find((p) => p.userId === targetUserId)?.paid ?? false;
    const embed = buildUserEmbed(ut, paid, splits, refreshedSession, displayName);
    embed.setDescription("Reply `paid` / `p` when you've paid.");
    const primaryHandle = manager.getUserVenmoHandle(refreshedSession.primaryUserId);
    const venmoButton = buildUserVenmoButton(refreshedSession, ut, paid, primaryHandle, displayName);
    const components = venmoButton ? [new ActionRowBuilder<ButtonBuilder>().addComponents(venmoButton)] : [];
    await message.reply({ embeds: [embed], components });
  }

  await updateSummaryMessage(message, refreshedSession);
  await checkAndNotify(message, refreshedSession);
}

async function handleUnclaim(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
  targetUserId: string,
): Promise<void> {
  const ucPrefix = contentClean.startsWith('unclaim ') ? 'unclaim ' : 'uc ';
  const numbers = parseItemNumbers(contentClean.slice(ucPrefix.length));
  if (numbers.length === 0) {
    await message.reply('Please specify item numbers to unclaim (e.g. `unclaim 1 3`).');
    return;
  }

  try {
    manager.unclaimItems(session.id, numbers, targetUserId);
  } catch (err) {
    await message.reply(err instanceof Error ? err.message : 'Failed to unclaim items.');
    return;
  }

  await message.reply(`Unclaimed items: ${numbers.join(', ')}`);

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleRename(message: Message, session: ReceiptSession, contentClean: string): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can rename the receipt.');
    return;
  }

  const prefix = contentClean.startsWith('rename ') ? 'rename ' : 'rn ';
  const rawName = contentClean.slice(prefix.length).trim();
  if (!rawName) {
    await message.reply('Usage: `rename <restaurant name>` (e.g. `rename TK`)');
    return;
  }

  const newName = extractRestaurantName(rawName, '');
  manager.setRestaurantName(session.id, newName);

  // Also rename the thread to match
  const thread = message.channel as ThreadChannel;
  try {
    await thread.setName(newName);
  } catch {
    // ignore — bot may lack permission
  }

  await message.reply(`Restaurant renamed to **${newName}**.`);
  const refreshedSession = manager.getSession(thread.id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleEditPrice(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can edit item prices.');
    return;
  }

  const prefix = contentClean.startsWith('edit ') ? 'edit ' : 'e ';
  const parts = contentClean.slice(prefix.length).trim().split(/\s+/);
  const itemIndex = parseInt(parts[0], 10);
  const newPrice = parseFloat(parts[1]?.replace('$', '') ?? '');

  if (isNaN(itemIndex) || isNaN(newPrice) || newPrice < 0) {
    await message.reply('Usage: `edit <item#> <price>` (e.g. `edit 5 12.50`)');
    return;
  }

  try {
    manager.editItemPrice(session.id, itemIndex, newPrice);
  } catch (err) {
    await message.reply(err instanceof Error ? err.message : 'Failed to edit item.');
    return;
  }

  await message.reply(`Item ${itemIndex} price updated to $${newPrice.toFixed(2)}.`);
  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleAddItem(message: Message, session: ReceiptSession, contentClean: string): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can add items.');
    return;
  }

  // Format: add <name> <price> [qty]
  // Parse from the end: last token is qty (if numeric), second-to-last is price, rest is name
  const prefix = contentClean.startsWith('add ') ? 'add ' : 'a ';
  const tokens = contentClean.slice(prefix.length).trim().split(/\s+/);

  if (tokens.length < 2) {
    await message.reply('Usage: `add <name> <price> [qty]` (e.g. `add Diet Coke 1.75 2`)');
    return;
  }

  let quantity = 1;
  let priceIndex = tokens.length - 1;

  // Check if last token is a quantity (integer) and second-to-last is a price
  if (tokens.length >= 3) {
    const maybeQty = parseInt(tokens[tokens.length - 1], 10);
    const maybePrice = parseFloat(tokens[tokens.length - 2]?.replace('$', '') ?? '');
    if (!isNaN(maybeQty) && maybeQty > 0 && !isNaN(maybePrice) && maybePrice >= 0) {
      quantity = maybeQty;
      priceIndex = tokens.length - 2;
    }
  }

  const price = parseFloat(tokens[priceIndex]?.replace('$', '') ?? '');
  if (isNaN(price) || price < 0) {
    await message.reply('Usage: `add <name> <price> [qty]` (e.g. `add Diet Coke 1.75 2`)');
    return;
  }

  const name = tokens.slice(0, priceIndex).join(' ');
  if (!name) {
    await message.reply('Please provide an item name.');
    return;
  }

  const indices = manager.addItem(session.id, name, price, quantity);
  const label = quantity > 1 ? `${quantity}x ${name}` : name;
  await message.reply(
    `Added **${label}** at $${price.toFixed(2)} each (item${indices.length > 1 ? 's' : ''} ${indices.join(', ')}).`,
  );

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleRemoveItem(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can remove items.');
    return;
  }

  const prefix = contentClean.startsWith('remove ') ? 'remove ' : 'rm ';
  const numbers = parseItemNumbers(contentClean.slice(prefix.length));
  if (numbers.length === 0) {
    await message.reply('Usage: `remove <item#>` (e.g. `remove 5` or `rm 3 5 7`)');
    return;
  }

  const errors: string[] = [];
  for (const idx of numbers) {
    try {
      manager.removeItem(session.id, idx);
    } catch (err) {
      errors.push(err instanceof Error ? err.message : `Failed to remove item ${idx}.`);
    }
  }

  if (errors.length > 0) {
    await message.reply(errors.join('\n'));
    if (errors.length === numbers.length) return;
  }

  const removed = numbers.filter((n) => !errors.some((e) => e.includes(`${n}`)));
  if (removed.length > 0) {
    await message.reply(`Removed item${removed.length > 1 ? 's' : ''}: ${removed.join(', ')}`);
  }

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

// `split all [- <item#>...] [- <user>...]` — split every currently-unclaimed item
// evenly among all users on the receipt. Already-claimed/split items are left
// untouched (this never errors on "already claimed"). Exclusions after a `-`
// remove item numbers and/or users (by @mention or proxy name) from the split.
async function handleSplitAll(
  message: Message,
  session: ReceiptSession,
  args: string[],
): Promise<void> {
  const proxyByLowerName = new Map<string, string>();
  for (const id of session.taggedUserIds) {
    if (isProxyUserId(id)) {
      proxyByLowerName.set(proxyDisplayName(id).toLowerCase(), id);
    }
  }

  const excludedItems = new Set<number>();
  const excludedUsers = new Set<string>();
  for (const token of args) {
    if (token === '-') continue; // list separator, ignorable
    const mention = token.match(/^<@!?(\d+)>$/);
    if (mention) {
      if (mention[1] !== message.client.user!.id) excludedUsers.add(mention[1]);
      continue;
    }
    if (/^\d+$/.test(token)) {
      excludedItems.add(parseInt(token, 10));
      continue;
    }
    const proxyId = proxyByLowerName.get(token.toLowerCase());
    if (proxyId) excludedUsers.add(proxyId);
    // anything else is ignored
  }

  const participants = session.taggedUserIds.filter((id) => !excludedUsers.has(id));
  if (participants.length < 2) {
    await message.reply(
      'Need at least two users to split between — check your exclusions. `split all` divides among everyone on the receipt.',
    );
    return;
  }

  // Only split items that are currently unclaimed; leave claimed/split items alone.
  const items = manager.getItems(session.id);
  const toSplit = items.filter(
    (item) => !item.claimedByUserId && !excludedItems.has(item.index),
  );
  if (toSplit.length === 0) {
    await message.reply(
      'No unclaimed items to split — everything is already claimed or excluded.',
    );
    return;
  }

  const succeeded: number[] = [];
  for (const item of toSplit) {
    try {
      manager.splitItem(session.id, item.index, participants);
      succeeded.push(item.index);
    } catch {
      // Skip any item that can't be split rather than failing the whole command.
    }
  }

  const displayName = await getDisplayNameResolver(message, session);
  const names = participants.map((id) => displayName(id)).join(', ');
  const skipped = items.length - succeeded.length;

  const lines = [
    `Split ${succeeded.length} unclaimed item${succeeded.length !== 1 ? 's' : ''} evenly between ${names}: ${succeeded.join(', ')}.`,
  ];
  if (skipped > 0) {
    lines.push(
      `_(${skipped} item${skipped !== 1 ? 's' : ''} left as-is — already claimed or excluded.)_`,
    );
  }
  await message.reply(lines.join('\n'));

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleSplit(message: Message, session: ReceiptSession): Promise<void> {
  // Tokenize the original content (with mentions intact) so we can pair
  // each `<@id>` with an optional following `NN%` percentage token.
  const raw = message.content.replace(/^.*?\b(split|s)\b\s*/i, '').trim();
  const tokens = raw.split(/\s+/).filter((t) => t.length > 0);

  // `split all` — split every currently-unclaimed item evenly among all users,
  // with optional exclusions after `-` (item numbers and/or users).
  if (tokens[0]?.toLowerCase() === 'all') {
    await handleSplitAll(message, session, tokens.slice(1));
    return;
  }

  // Map lowercased proxy names → stored proxy ID, so bare name tokens like
  // "alice" resolve to the `proxy:Alice` user already in the session.
  const proxyByLowerName = new Map<string, string>();
  for (const id of session.taggedUserIds) {
    if (isProxyUserId(id)) {
      proxyByLowerName.set(proxyDisplayName(id).toLowerCase(), id);
    }
  }
  const resolveParticipant = (token: string): string | null => {
    const m = token.match(/^<@!?(\d+)>$/);
    if (m) {
      if (m[1] === message.client.user!.id) return null;
      return m[1];
    }
    return proxyByLowerName.get(token.toLowerCase()) ?? null;
  };

  // Item numbers come before the first participant token; user/pct pairs come after.
  const itemIndices: number[] = [];
  let i = 0;
  for (; i < tokens.length; i++) {
    if (resolveParticipant(tokens[i]) !== null) break;
    if (/^\d+$/.test(tokens[i])) {
      const n = parseInt(tokens[i], 10);
      if (!itemIndices.includes(n)) itemIndices.push(n);
    }
  }
  itemIndices.sort((a, b) => a - b);

  if (itemIndices.length === 0) {
    await message.reply('Usage: `split <item#> [<item#>...] @user1 [pct%] @user2 [pct%]`');
    return;
  }

  const explicit: { userId: string; pct: number | null }[] = [];
  for (; i < tokens.length; i++) {
    const userId = resolveParticipant(tokens[i]);
    if (userId === null) continue;
    let pct: number | null = null;
    const next = tokens[i + 1];
    if (next) {
      const pctMatch = next.match(/^(\d+(?:\.\d+)?)%$/);
      if (pctMatch) {
        pct = parseFloat(pctMatch[1]);
        i++;
      }
    }
    explicit.push({ userId, pct });
  }

  if (explicit.length === 0) {
    await message.reply('Please mention at least one user to split with.');
    return;
  }

  const anyPct = explicit.some((p) => p.pct !== null);

  // Dedupe by userId (keep the first occurrence's pct).
  const seen = new Set<string>();
  const participants: { userId: string; pct: number | null }[] = [];
  for (const p of explicit) {
    if (seen.has(p.userId)) continue;
    seen.add(p.userId);
    participants.push({ userId: p.userId, pct: p.pct });
  }

  if (anyPct) {
    const missingPct = participants.filter((p) => p.pct === null);
    if (missingPct.length > 0) {
      const names = missingPct.map((p) => `<@${p.userId}>`).join(', ');
      await message.reply(`If you specify percentages, every user needs one. Missing for: ${names}.`);
      return;
    }
    const sum = participants.reduce((s, p) => s + p.pct!, 0);
    if (Math.abs(sum - 100) > 0.01) {
      await message.reply(`Percentages sum to ${sum.toFixed(2)}% but should sum to 100%.`);
      return;
    }
  }

  if (participants.length < 2) {
    await message.reply(
      'Please mention at least two users to split the item(s) between (the actor is no longer auto-included).',
    );
    return;
  }

  const userIds = participants.map((p) => p.userId);
  const sharePcts = anyPct ? participants.map((p) => p.pct!) : null;

  const succeeded: number[] = [];
  const failures: string[] = [];
  for (const itemIndex of itemIndices) {
    try {
      manager.splitItem(session.id, itemIndex, userIds, sharePcts);
      succeeded.push(itemIndex);
    } catch (err) {
      failures.push(`Item ${itemIndex}: ${err instanceof Error ? err.message : 'failed'}`);
    }
  }

  const displayName = await getDisplayNameResolver(message, session);
  const names = participants
    .map((p) => (anyPct ? `${displayName(p.userId)} (${p.pct!.toFixed(0)}%)` : displayName(p.userId)))
    .join(', ');

  if (succeeded.length > 0) {
    const items = manager.getItems(session.id);
    const lines = succeeded.map((idx) => {
      const item = items.find((i) => i.index === idx);
      if (!item) return `Item ${idx}: split applied`;
      if (anyPct) {
        const perUser = participants
          .map((p) => {
            const amt = (item.unitPrice * (p.pct! / 100)).toFixed(2);
            return `${displayName(p.userId)} $${amt}`;
          })
          .join(', ');
        return `Item ${idx}: ${perUser}`;
      }
      const perPerson = (item.unitPrice / participants.length).toFixed(2);
      return `Item ${idx}: $${perPerson} each`;
    });
    const header =
      succeeded.length === 1
        ? `Item ${succeeded[0]} split between ${names}:`
        : `Items ${succeeded.join(', ')} split between ${names}:`;
    await message.reply(`${header}\n${lines.join('\n')}`);
  }

  if (failures.length > 0) {
    await message.reply(failures.join('\n'));
  }

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleAddProxy(message: Message, session: ReceiptSession): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can add a proxy.');
    return;
  }

  const raw = message.content.replace(/<@!?\d+>/g, '').trim();
  const prefix = raw.match(/^(addproxy|ap)\s+/i);
  if (!prefix) {
    await message.reply('Usage: `addproxy <name>` — creates a placeholder user.');
    return;
  }
  const name = raw.slice(prefix[0].length).trim();

  if (!name) {
    await message.reply('Please provide a name for the proxy, e.g. `addproxy Alice`.');
    return;
  }
  if (/\s/.test(name)) {
    await message.reply("Proxy names can't contain spaces — use a single word.");
    return;
  }

  const proxyId = makeProxyUserId(name);
  const exists = session.taggedUserIds.some(
    (id) => isProxyUserId(id) && id.slice(6).toLowerCase() === name.toLowerCase(),
  );
  if (exists) {
    await message.reply(`A proxy named **${name}** already exists on this receipt.`);
    return;
  }

  manager.addUserToSession(session.id, proxyId);

  await message.reply(
    `Added proxy **${name}**. Use \`claim 1 3 as ${name}\`, \`paid as ${name}\`, etc. to act on their behalf.`,
  );

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleRescan(
  message: Message,
  session: ReceiptSession,
  client: Client,
  hint: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can re-scan the receipt.');
    return;
  }

  // Fetch the original channel + message to retrieve the receipt image
  const origChannel = await client.channels.fetch(session.channelId);
  if (!origChannel || !origChannel.isTextBased() || origChannel.isDMBased()) {
    await message.reply("Couldn't access the original channel to re-fetch the image.");
    return;
  }
  const origMessage = await (origChannel as TextChannel).messages
    .fetch(session.originalMessageId)
    .catch(() => null);
  if (!origMessage) {
    await message.reply("Couldn't find the original receipt message (it may have been deleted).");
    return;
  }
  const attachment = origMessage.attachments.find((a) => a.contentType?.startsWith('image/'));
  if (!attachment) {
    await message.reply('The original message no longer has a receipt image.');
    return;
  }
  const mediaType = await getImageMediaType(attachment);
  if (!mediaType) {
    await message.reply('Unsupported image format on the original message.');
    return;
  }

  manager.checkDailyLimit();
  await message.react('⏳');

  const response = await fetch(attachment.url);
  const buffer = Buffer.from(await response.arrayBuffer());
  const imageBase64 = buffer.toString('base64');

  let result;
  try {
    result = await parseReceiptWithReconciliation(imageBase64, mediaType, hint || undefined);
  } catch (err) {
    await message.reactions.removeAll().catch(() => {});
    const reason = err instanceof Error ? err.message : String(err);
    await message.reply(
      `⚠️ Couldn't re-scan this receipt: ${reason}`
    );
    return;
  }
  manager.logApiCost(result.estimatedCostUsd);

  const parsed = result.parsed;
  const allItems = result.items;
  const lineItems = allItems.filter((item) => item.unitPrice > 0);
  const warning = result.warning;

  // Preserve existing tip behavior: keep current tipAmount, don't default-apply again
  manager.replaceSessionItems(session.id, lineItems, {
    subtotal: parsed.subtotal,
    discountAmount: parsed.discount,
    taxAmount: parsed.tax,
    tipAmount: session.tipAmount,
    total: parsed.total,
    currencyCode: parsed.currencyCode,
    rateToUsd: parsed.rateToUsd,
    rateDate: parsed.rateDate,
    originalSubtotal: parsed.originalSubtotal,
    originalDiscount: parsed.originalDiscount,
    originalTax: parsed.originalTax,
    originalTip: parsed.originalTip,
    originalTotal: parsed.originalTotal,
  });

  await message.reactions.removeAll().catch(() => {});
  await message.reply(
    `🔄 Receipt re-scanned${hint ? ` with hint: _${hint}_` : ''}. All previous claims, splits, and payment statuses were reset. Please double-check the values below.`,
  );

  if (warning) {
    await (message.channel as ThreadChannel).send(`⚠️ ${warning}`);
  }

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleVoid(message: Message, session: ReceiptSession): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can void this receipt.');
    return;
  }

  manager.voidSession(session.id);

  await message.reply('🚫 Receipt voided. No further commands will be accepted on this thread.');

  const thread = message.channel as ThreadChannel;
  try {
    await thread.setLocked(true);
    await thread.setArchived(true);
  } catch {
    // ignore — bot may lack manage-threads permission
  }
}

async function handleCategory(
  message: Message,
  session: ReceiptSession,
  category: 'food' | 'non_food',
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can change the receipt category.');
    return;
  }

  if (session.status === 'settled') {
    await message.reply(
      "This receipt is already settled — its category can't be changed. Void and re-upload if needed.",
    );
    return;
  }

  manager.setSessionCategory(session.id, category);

  const label = category === 'non_food' ? 'non-food' : 'food';
  await message.reply(
    `This receipt is now marked as **${label}**. It ${category === 'non_food' ? 'will not' : 'will'} count toward leaderboards.`,
  );

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleUnpaid(message: Message, session: ReceiptSession, targetUserId: string): Promise<void> {
  const payments = manager.getPaymentStatuses(session.id);
  const userPayment = payments.find((p) => p.userId === targetUserId);

  if (!userPayment) {
    await message.reply("That user doesn't have any claimed items on this receipt.");
    return;
  }

  if (!userPayment.paid) {
    await message.reply('That user is already marked as unpaid.');
    return;
  }

  manager.markUserUnpaid(session.id, targetUserId);

  const displayName = await getDisplayNameResolver(message, session);
  await message.reply(`${displayName(targetUserId)} marked as unpaid.`);

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleAddUser(message: Message, session: ReceiptSession): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can add new users.');
    return;
  }

  const newUsers = message.mentions.users
    .filter((u) => !u.bot && !session.taggedUserIds.includes(u.id))
    .map((u) => u.id);

  if (newUsers.length === 0) {
    await message.reply('No new users to add. Make sure you @mention users not already in this receipt.');
    return;
  }

  for (const userId of newUsers) {
    manager.addUserToSession(session.id, userId);
  }

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  const displayName = await getDisplayNameResolver(message, refreshedSession);
  const names = newUsers.map((id) => displayName(id)).join(', ');
  await message.reply(`Added ${names} to the receipt. They can now claim items.`);

  await updateSummaryMessage(message, refreshedSession);
}

async function handleStatus(message: Message, session: ReceiptSession): Promise<void> {
  const displayName = await getDisplayNameResolver(message, session);
  const items = manager.getItems(session.id);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const primaryHandle = manager.getUserVenmoHandle(session.primaryUserId);
  const { embeds, components } = buildSummaryEmbeds(
    session,
    items,
    userTotals,
    payments,
    splits,
    displayName,
    primaryHandle,
  );
  await messageReplyHandler(message, { embeds, components });
}

async function handleVenmo(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (!config.venmoEnabled) {
    await message.reply('Venmo buttons are not enabled on this bot.');
    return;
  }

  const prefix = contentClean.startsWith('venmo') ? 'venmo' : 'v';
  const arg = contentClean.slice(prefix.length).trim();

  if (!arg) {
    const current = manager.getUserVenmoHandle(message.author.id);
    await message.reply(
      current
        ? `Your Venmo handle is set to **${current}**.`
        : "You haven't set a Venmo handle yet. Use `venmo <handle>` to set one.",
    );
    return;
  }

  if (arg === 'remove' || arg === 'clear') {
    manager.setUserVenmoHandle(message.author.id, null);
    await message.reply('Your Venmo handle has been cleared.');
    const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
    await updateSummaryMessage(message, refreshedSession);
    return;
  }

  const handle = arg.replace(/^@/, '').trim();
  if (!handle || !/^[a-zA-Z0-9_-]{1,30}$/.test(handle)) {
    await message.reply(
      'Please provide a valid Venmo handle (1–30 letters, numbers, underscores, or hyphens).',
    );
    return;
  }

  manager.setUserVenmoHandle(message.author.id, handle);
  await message.reply(`Your Venmo handle has been set to **${handle}**.`);

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handleDiscountCommand(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can change the discount.');
    return;
  }

  let arg = '';
  if (contentClean.startsWith('discount ')) arg = contentClean.slice('discount '.length).trim();
  else if (contentClean.startsWith('disc ')) arg = contentClean.slice('disc '.length).trim();

  if (!arg || arg === 'remove' || arg === 'rm' || arg === '0') {
    manager.setDiscount(session.id, 0);
    await message.reply('Discount removed.');
    const refreshed = manager.getSession((message.channel as ThreadChannel).id)!;
    await updateSummaryMessage(message, refreshed);
    return;
  }

  let amount: number;
  if (arg.endsWith('%')) {
    const pct = parseFloat(arg.slice(0, -1));
    if (isNaN(pct) || pct < 0) {
      await message.reply('Invalid discount percentage. Use e.g. `discount 15%`.');
      return;
    }
    amount = Math.round(session.subtotal * (pct / 100) * 100) / 100;
  } else {
    amount = parseFloat(arg.replace('$', ''));
    if (isNaN(amount) || amount < 0) {
      await message.reply(
        'Invalid discount. Use e.g. `discount 5.00`, `discount 15%`, or `discount remove`.',
      );
      return;
    }
  }

  if (amount > session.subtotal) {
    await message.reply(`Discount $${amount.toFixed(2)} exceeds subtotal $${session.subtotal.toFixed(2)}.`);
    return;
  }

  manager.setDiscount(session.id, amount);
  await message.reply(`Discount set to $${amount.toFixed(2)}.`);

  const refreshed = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshed);
}

async function handleTipCommand(
  message: Message,
  session: ReceiptSession,
  contentClean: string,
): Promise<void> {
  if (message.author.id !== session.primaryUserId) {
    await message.reply('Only the primary user can set the tip.');
    return;
  }

  const prefix = contentClean.startsWith('tip ') ? 'tip ' : 't ';
  const tipStr = contentClean.slice(prefix.length).trim();
  let tipAmount: number;

  if (tipStr.endsWith('%')) {
    const pct = parseFloat(tipStr.slice(0, -1));
    if (isNaN(pct)) {
      await message.reply('Invalid tip percentage. Use e.g. `tip 20%`.');
      return;
    }
    tipAmount = Math.round(session.subtotal * (pct / 100) * 100) / 100;
  } else {
    tipAmount = parseFloat(tipStr);
    if (isNaN(tipAmount)) {
      await message.reply('Invalid tip amount. Use e.g. `tip 15.00` or `tip 20%`.');
      return;
    }
  }

  manager.setTip(session.id, tipAmount);
  await message.reply(`Tip set to $${tipAmount.toFixed(2)}.`);

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
}

async function handlePaid(message: Message, session: ReceiptSession, targetUserId: string): Promise<void> {
  const payments = manager.getPaymentStatuses(session.id);
  const userPayment = payments.find((p) => p.userId === targetUserId);

  if (!userPayment) {
    await message.reply("That user doesn't have any claimed items on this receipt.");
    return;
  }

  if (userPayment.paid) {
    await message.reply('That user is already marked as paid.');
    return;
  }

  manager.markUserPaid(session.id, targetUserId);

  const displayName = await getDisplayNameResolver(message, session);
  await message.reply(`${displayName(targetUserId)} marked as paid! ✅`);

  const refreshedSession = manager.getSession((message.channel as ThreadChannel).id)!;
  await updateSummaryMessage(message, refreshedSession);
  await checkAndNotify(message, refreshedSession);

  // Remove user from thread if they marked themselves paid (not proxy) and aren't the primary user
  if (targetUserId === message.author.id && targetUserId !== session.primaryUserId) {
    const thread = message.channel as ThreadChannel;
    try {
      await thread.members.remove(targetUserId);
    } catch {
      // ignore — bot may lack permission or user already left
    }
  }
}

async function updateSummaryMessage(message: Message, session: ReceiptSession): Promise<void> {
  if (!session.summaryMessageId) return;

  const thread = message.channel as ThreadChannel;
  const displayName = await getDisplayNameResolver(message, session);
  const items = manager.getItems(session.id);
  const userTotals = manager.getUserTotals(session);
  const payments = manager.getPaymentStatuses(session.id);
  const splits = manager.getSplits(session.id);
  const primaryHandle = manager.getUserVenmoHandle(session.primaryUserId);
  const { embeds, components } = buildSummaryEmbeds(
    session,
    items,
    userTotals,
    payments,
    splits,
    displayName,
    primaryHandle,
  );

  try {
    const summaryMsg = await thread.messages.fetch(session.summaryMessageId);
    await summaryMsg.edit({ embeds, components });
  } catch {
    const newMsg = await threadSendHandler(thread, { embeds, components });
    manager.setSummaryMessageId(session.id, newMsg.id);
  }
}

async function checkAndNotify(message: Message, session: ReceiptSession): Promise<void> {
  const { allClaimed, allPaid } = manager.checkAllClaimedAndPaid(session);
  const thread = message.channel as ThreadChannel;

  if (allPaid) {
    const displayName = await getDisplayNameResolver(message, session);
    const primaryName = displayName(session.primaryUserId);

    const userTotals = manager.getUserTotals(session);
    manager.recordSettlement(session.guildId, session.restaurantName, userTotals, session.id);

    await thread.send(
      `🎉 **${primaryName}** — All payments for **${session.restaurantName}** have been received!`,
    );

    try {
      await thread.edit({ archived: true, locked: true });
    } catch {
      // ignore — bot may lack Manage Threads permission
    }
  } else if (!allClaimed) {
    const items = manager.getItems(session.id);
    const unclaimed = items.filter((i) => !i.claimedByUserId);
    if (unclaimed.length > 0) {
      const claimants = new Set(items.filter((i) => i.claimedByUserId).map((i) => i.claimedByUserId!));
      const allTaggedHaveClaimed = session.taggedUserIds
        .filter((id) => id !== session.primaryUserId)
        .every((id) => claimants.has(id));

      if (allTaggedHaveClaimed && !claimants.has(session.primaryUserId)) {
        const unclaimedNums = unclaimed.map((i) => i.index).join(', ');
        await thread.send(
          `Items ${unclaimedNums} are still unclaimed. <@${session.primaryUserId}>, who do these belong to?`,
        );
      }
    }
  }
}
