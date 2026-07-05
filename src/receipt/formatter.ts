import { EmbedBuilder } from "discord.js";
import { ReceiptSession, LineItem, UserTotal, SplitEntry } from "./types.js";
import { DisplayNameResolver } from "../utils/discord.js";

const INDENT = "\u2800"; // U+2800 braille blank — not stripped by Discord on first line
const FIELD_LIMIT = 1024;

// Splits lines across multiple fields on the same embed to stay within Discord's limit.
function addChunkedFields(embed: EmbedBuilder, name: string, lines: string[]): void {
  let chunk: string[] = [];
  let chunkLen = 0;
  let first = true;

  const flush = () => {
    if (chunk.length === 0) return;
    embed.addFields({
      name: first ? name : `${name} (cont.)`,
      value: chunk.join("\n"),
      inline: false,
    });
    first = false;
    chunk = [];
    chunkLen = 0;
  };

  for (const line of lines) {
    const lineLen = line.length + 1;
    if (chunkLen + lineLen > FIELD_LIMIT) flush();
    chunk.push(line);
    chunkLen += lineLen;
  }
  flush();
}

function buildSplitMap(splits: SplitEntry[]): Map<number, SplitEntry[]> {
  const splitMap = new Map<number, SplitEntry[]>();
  for (const s of splits) {
    if (!splitMap.has(s.lineItemIndex)) splitMap.set(s.lineItemIndex, []);
    splitMap.get(s.lineItemIndex)!.push(s);
  }
  return splitMap;
}

export function buildUserEmbed(
  ut: UserTotal,
  paid: boolean,
  splits: SplitEntry[],
  session: ReceiptSession,
  displayName: DisplayNameResolver,
): EmbedBuilder {
  const splitMap = buildSplitMap(splits);
  const name = displayName(ut.userId);
  const statusIcon = paid ? "✅ PAID" : "❌ UNPAID";

  const embed = new EmbedBuilder()
    .setColor(paid ? 0x2ecc71 : 0xe74c3c)
    .setTitle(`${name} — $${ut.grandTotal.toFixed(2)} ${statusIcon}`);

  const itemLines = ut.items.map((item) => {
    const itemSplits = splitMap.get(item.index);
    let splitNote = "";
    if (itemSplits && itemSplits.length > 1) {
      const allHavePct = itemSplits.every((s) => s.sharePct !== null);
      const others = itemSplits
        .filter((s) => s.userId !== ut.userId)
        .map((s) =>
          allHavePct
            ? `${displayName(s.userId)} ${s.sharePct!.toFixed(0)}%`
            : displayName(s.userId),
        )
        .join(", ");
      const mine = itemSplits.find((s) => s.userId === ut.userId);
      const suffix = allHavePct && mine?.sharePct != null
        ? `your ${mine.sharePct.toFixed(0)}% — $${item.amount.toFixed(2)}`
        : `$${item.amount.toFixed(2)} each`;
      splitNote = ` (split with ${others} — ${suffix})`;
    }
    return `${INDENT}**${item.index}.** ${item.name} — $${item.amount.toFixed(2)}${splitNote}`;
  });

  addChunkedFields(embed, "Items", itemLines);

  const tipAmount = session.tipAmount ?? 0;
  const tipStr = session.tipAmount !== null
    ? `Tip: $${ut.tipShare.toFixed(2)}`
    : "Tip: not set";
  const footerText = `Items: $${ut.itemsTotal.toFixed(2)} | Tax: $${ut.taxShare.toFixed(2)} | ${tipStr} | Total: $${ut.grandTotal.toFixed(2)}`;
  embed.setFooter({ text: footerText });

  return embed;
}

export function buildSummaryEmbeds(
  session: ReceiptSession,
  items: LineItem[],
  userTotals: UserTotal[],
  payments: { userId: string; paid: boolean }[],
  splits: SplitEntry[],
  displayName: DisplayNameResolver
): EmbedBuilder[] {
  const paymentMap = new Map(payments.map((p) => [p.userId, p.paid]));

  const unclaimed = items.filter((i) => !i.claimedByUserId);
  const allClaimed = unclaimed.length === 0;
  const allPaid = allClaimed && payments.length > 0 && payments.every((p) => p.paid);

  const tipAmount = session.tipAmount ?? 0;
  const tipStr = session.tipAmount !== null ? `$${tipAmount.toFixed(2)}` : "not set";
  const discountAmount = session.discountAmount ?? 0;
  const computedTotal = session.subtotal - discountAmount + session.taxAmount + tipAmount;
  const discountStr = discountAmount > 0 ? ` | Discount: -$${discountAmount.toFixed(2)}` : "";
  const footerText = `Subtotal: $${session.subtotal.toFixed(2)}${discountStr} | Tax: $${session.taxAmount.toFixed(2)} | Tip: ${tipStr} | Total: $${computedTotal.toFixed(2)}`;

  // Discount factor matches calculator.ts — items are stored raw and adjusted at display time.
  const discountFactor =
    session.subtotal > 0 && discountAmount > 0
      ? (session.subtotal - discountAmount) / session.subtotal
      : 1;

  const embeds: EmbedBuilder[] = [];

  // Embed 1: header + unclaimed items
  const headerEmbed = new EmbedBuilder()
    .setTitle(`🧾 ${session.restaurantName}`)
    .setColor(allPaid ? 0x2ecc71 : allClaimed ? 0xf1c40f : 0xe74c3c)
    .setFooter({ text: footerText });

  if (unclaimed.length > 0) {
    const lines = unclaimed.map((i) => {
      const adjusted = Math.round(i.unitPrice * discountFactor * 100) / 100;
      return `${INDENT}**${i.index}.** ${i.name} — $${adjusted.toFixed(2)}`;
    });
    addChunkedFields(headerEmbed, "UNCLAIMED", lines);
  } else {
    headerEmbed.setDescription("All items have been claimed.");
  }

  embeds.push(headerEmbed);

  // One embed per user in the claimed list
  for (const ut of userTotals) {
    const paid = paymentMap.get(ut.userId) ?? false;
    embeds.push(buildUserEmbed(ut, paid, splits, session, displayName));
  }

  return embeds;
}

export function formatItemList(taggedUserIds: string[]): string {
  const header = taggedUserIds.map((id) => `<@${id}>`).join(" ");
  const commands = [
    "**Commands:**",
    "`claim 1 3 5` / `c 1 3 5` — claim items by number",
    "`unclaim 1 3` / `uc 1 3` — release claimed items",
    "`split 3 @user1 @user2` / `s 3 @user1 @user2` — split item(s) between the mentioned users (add `30%` after a mention for uneven splits; you are not auto-included; bare proxy names work too, e.g. `split 3 @user1 alice`)",
    "`tip 20%` / `t 20%` — set tip (primary user only)",
    "`paid` / `p` — mark yourself as paid",
    "_Reply `help` for more commands._",
  ].join("\n");

  return `${header}\n\nReply with the item numbers you want to claim.\n\n${commands}`;
}

export function formatThreadHelp(): string {
  return [
    "**Receipt thread commands:**",
    "`claim 1 3 5` / `c 1 3 5` — claim items by number",
    "`unclaim 1 3` / `uc 1 3` — release claimed items",
    "`split 3 5 @user1 @user2` / `s 3 5 @user1 @user2` — split one or more items evenly between the mentioned users (you are NOT auto-included — @ yourself if you want a share)",
    "`split 3 @user1 30% @user2 70%` — split with uneven percentages (must sum to 100%)",
    "`split 3 @user alice 30%` — mix Discord users and `addproxy` names (proxy names are matched case-insensitively)",
    "`tip 20%` / `t 20%` — set tip (primary user only)",
    "`discount 5.00` / `discount 15%` / `discount remove` — add, edit, or remove a discount (primary user only)",
    "`paid` / `p` — mark yourself as paid",
    "`unpaid` / `up` — mark yourself as unpaid",
    "`status` / `st` — show current claim status",
    "`sum` / `sm` — show your unpaid totals across all receipts",
    "`sum paid` / `sp` — mark all your unpaid items as paid",
    "`rename TK` / `rn TK` — rename the restaurant (primary user only)",
    "`edit 5 12.50` / `e 5 12.50` — fix an item's price (primary user only)",
    "`add Diet Coke 1.75 2` / `a Diet Coke 1.75` — add item with optional qty (primary user only)",
    "`remove 5` / `rm 3 5 7` — remove items (primary user only)",
    "`adduser @user` / `au @user` — add a new user to the receipt (primary user only)",
    "`addproxy Alice` / `ap Alice` — add a placeholder for someone not in Discord (primary user only)",
    "`rescan <optional hint>` — re-parse the receipt image; include a hint like `rescan item 3 was missed` (primary user only, resets all claims)",
    "`void` — void this receipt and lock the thread (primary user only)",
    "_(Primary user: add `@user` to any command to act on their behalf, or `as <proxyname>` for a proxy user)_",
  ].join("\n");
}

export function formatChannelHelp(): string {
  return [
    "**Channel commands** (mention the bot):",
    "`@bot <receipt image> @user1 @user2` — start a new receipt split and tag participants",
    "`@bot <restaurant name> <image> @user1` — optionally include a restaurant name",
    "`@bot sum` — show your unpaid totals across all receipts",
    "`@bot sum paid` — mark all your unpaid items as paid",
    "`@bot leaderboard` — show the top restaurants and spenders",
    "`@bot leaderboard <restaurant>` — top spenders at one restaurant (e.g. `leaderboard TK`)",
    "`@bot leaderboard <today|week|month|year>` — limit to a recent window",
    "`@bot leaderboard from 2026-01-01 to 2026-03-31` — limit to a date range (`to` optional)",
    "`@bot personal leaderboard` — show your own spending stats",
    "`@bot addtotal <restaurant> <amount>` — manually log a receipt to the leaderboard",
    "`@bot help` — show this message",
  ].join("\n");
}

export function formatUserTotal(ut: UserTotal, tipSet: boolean, name: string): string {
  const itemLines = ut.items
    .map((i) => `${INDENT}**${i.index}.** ${i.name} — $${i.amount.toFixed(2)}`)
    .join("\n");

  let msg = `**${name}**, you claimed:\n${itemLines}\n\n`;
  msg += `Items: $${ut.itemsTotal.toFixed(2)} | Tax: $${ut.taxShare.toFixed(2)}`;
  if (tipSet) {
    msg += ` | Tip: $${ut.tipShare.toFixed(2)}`;
  }
  msg += `\n**Your total: $${ut.grandTotal.toFixed(2)}**`;
  if (!tipSet) {
    msg += `\n_(Tip not yet set — total may change)_`;
  }
  msg += `\n\nReply \`paid\` when you've paid.`;
  return msg;
}
