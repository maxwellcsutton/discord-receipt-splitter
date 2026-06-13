# Receipt Bot

A Discord bot that splits restaurant receipts among users. Post a receipt photo, and the bot uses Claude's vision models to extract line items. Users claim their items, and the bot calculates each person's share including proportional tax and tip.

## Features

- **AI-powered receipt reading** — Claude Vision extracts line items, per-unit prices, tax, tip, and totals from receipt photos
- **Skew-aware parsing** — handles photos taken at an angle, with automatic self-correction when line items don't reconcile to the subtotal (see [Prompting & Accuracy](#prompting--accuracy))
- **Configurable model** — choose `haiku`, `sonnet`, or `opus` per your accuracy/cost needs
- **Item claiming** — claim items by number with ranges (`claim 1-3 5`)
- **Item splitting** — split shared items between users, evenly or by percentage (`split 3 @alice @bob`)
- **Proportional tax/tip** — each user's tax and tip is based on their share of the subtotal
- **Discounts** — apply a flat or percentage discount that flows through to every item
- **Proxy users** — add placeholders for people who aren't in Discord
- **Payment tracking** — users mark themselves paid; the bot notifies when all payments are in
- **Leaderboard** — track top restaurants and spenders across receipts, plus per-user personal stats
- **Concurrent receipts** — each receipt gets its own Discord thread
- **Persistent storage** — SQLite database survives restarts
- **Daily spend cap** — a built-in API-cost limit guards against runaway spend

## Quick Start

```bash
# 1. Clone and install
git clone <your-repo-url>
cd receipt-bot
npm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your tokens (see Setup below)

# 3. Run in development mode
bash dev.sh
```

## Setup

### 1. Create a Discord Bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications)
2. Click **New Application**, give it a name, and create it
3. Go to the **Bot** tab and click **Add Bot**
4. Enable **Message Content Intent** under Privileged Gateway Intents — required for the bot to read message text
5. Copy the **Bot Token** for your `.env` file

### 2. Invite the Bot to Your Server

1. In the Developer Portal, go to **OAuth2 > URL Generator**
2. Under **Scopes**, select `bot`
3. Under **Bot Permissions**, select:
   - Send Messages
   - Send Messages in Threads
   - Create Public Threads
   - Read Message History
   - Add Reactions
   - Manage Messages
   - Embed Links
4. Open the generated URL, select your server, and authorize

### 3. Get an Anthropic API Key

1. Go to [console.anthropic.com](https://console.anthropic.com/)
2. Create an account or sign in, and generate an API key
3. See [Model Selection](#model-selection) for per-receipt cost by model

### 4. Configure Environment Variables

Copy `.env.example` to `.env` and fill in:

```env
DISCORD_TOKEN=your_discord_bot_token
ANTHROPIC_API_KEY=your_anthropic_api_key
CLAUDE_MODEL=sonnet
DATABASE_PATH=./data/receipts.db
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_TOKEN` | **Yes** | — | Discord bot token |
| `ANTHROPIC_API_KEY` | **Yes** | — | Anthropic API key |
| `CLAUDE_MODEL` | No | `sonnet` | Model alias (`haiku` \| `sonnet` \| `opus`) or a full model id — see [Model Selection](#model-selection) |
| `DATABASE_PATH` | No | `./data/receipts.db` | SQLite database file path |
| `MODIFIER_PREFIXES` | No | `add ,extra ,w/ ,with ` | Comma-separated prefixes that mark a line as a modifier/add-on to roll into its parent item |
| `DAILY_SPEND_LIMIT_USD` | No | `0.10` | Max estimated Anthropic spend per UTC day before scans are blocked |
| `PORT` | No | `3000` | Port for the health-check HTTP server (used by hosting platforms) |

> **Daily spend cap:** the bot blocks new scans once estimated Anthropic spend reaches `DAILY_SPEND_LIMIT_USD` for the current UTC day (resets at midnight UTC) as a safety guard. The `0.10` default is only a handful of receipts per day on `sonnet`/`opus` — raise it to match your expected volume.

## Model Selection

`CLAUDE_MODEL` accepts a short alias or a full model id. Aliases also set the correct pricing so the daily-spend cap is tracked accurately.

| Alias | Model | Approx. cost / receipt¹ | Notes |
|-------|-------|-------------------------|-------|
| `haiku` | `claude-haiku-4-5` | ~$0.005–0.01 | Cheapest, fastest. Weakest at angled/skewed receipts. No adaptive thinking. |
| `sonnet` *(default)* | `claude-sonnet-4-6` | ~$0.02–0.04 | Best balance. Strong vision + adaptive thinking. **Recommended.** |
| `opus` | `claude-opus-4-8` | ~$0.05–0.08 | Strongest reasoning for difficult layouts. Highest cost. |

¹ Rough estimate including the occasional automatic reconciliation retry; varies with receipt size.

Notes:
- On `sonnet`/`opus`, the bot uses **adaptive thinking** to reason about price-to-item alignment before answering. `haiku` doesn't support it, so the request automatically falls back to a plain call — it still works, just with less alignment reasoning.
- A full model id (e.g. `claude-opus-4-8`) is also accepted; pricing is inferred from the family name for cost tracking.
- If you're seeing persistent mis-reads on angled receipts, the single biggest lever is moving from `haiku` to `sonnet` or `opus`.

## Usage

### Starting a Receipt

In a channel where the bot can post, send a message with:
- A receipt photo (JPEG, PNG, GIF, or WebP)
- An `@mention` of the bot
- `@mentions` of everyone splitting the receipt
- The restaurant name as text (optional)

**Example:**
```
@ReceiptBot @alice @bob Sakura Sushi
[attached receipt photo]
```

The bot will create a thread, parse the receipt, and post numbered line items with a command reference.

### Claiming Items

Reply in the receipt thread with item numbers (the `claim`/`c` keyword is optional for bare numbers):

```
claim 1 3 5       # claim specific items
c 1-3             # claim a range
c 1-3 7           # mix ranges and specific numbers
```

The bot replies with your calculated total (items + proportional tax + tip).

### Splitting Items

```
split 3 @alice @bob              # split item 3 evenly (you are NOT auto-included)
split 3 5 @alice @bob            # split multiple items
split 3 @alice 30% @bob 70%      # uneven split (percentages must sum to 100%)
split 3 @alice bob               # mix Discord users and proxy names
```

### Setting Tip & Discount (primary user only)

```
tip 20%           # percentage of subtotal
tip 15.00         # flat dollar amount
tip 0             # no tip

discount 5.00     # flat discount
discount 15%      # percentage discount
discount remove   # clear the discount
```

If no tip is detected on the receipt, the bot prompts for one.

### Payment

```
paid              # mark yourself as paid
unpaid            # undo
sum               # your unpaid totals across all receipts
sum paid          # mark all your unpaid items as paid
```

When all items are claimed and everyone is marked paid, the bot notifies the primary user that all payments are in.

## Commands Reference

Aliases are shown after the `/`. In a thread, the bot reads every reply; in a channel, mention the bot.

### Thread commands (anyone)

| Command | Description |
|---------|-------------|
| `claim 1 3 5` / `c 1 3 5` | Claim items by number (ranges like `1-3` work; bare numbers also work) |
| `unclaim 1 3` / `uc 1 3` | Release claimed items |
| `split 3 5 @user1 @user2` / `s ...` | Split item(s) between mentioned users (even, or `@user 30%` for uneven; proxy names allowed) |
| `paid` / `p` | Mark yourself as paid |
| `unpaid` / `up` | Mark yourself as unpaid |
| `status` / `st` | Show current claim status |
| `sum` / `sm` | Show your unpaid totals across all receipts |
| `sum paid` / `sp` | Mark all your unpaid items as paid |
| `help` / `h` | Show the thread command list |

### Thread commands — primary user only

The primary user is whoever posted the receipt. These manage the receipt itself.

| Command | Description |
|---------|-------------|
| `tip 20%` / `t 20%` | Set tip (percentage or flat amount; `tip 0` to skip) |
| `discount 5.00` / `disc 15%` / `discount remove` | Add, edit, or remove a discount |
| `rename TK` / `rn TK` | Rename the restaurant |
| `edit 5 12.50` / `e 5 12.50` | Fix an item's price |
| `add Diet Coke 1.75 2` / `a Diet Coke 1.75` | Add an item (trailing number = optional quantity) |
| `remove 5` / `rm 3 5 7` | Remove items |
| `adduser @user` / `au @user` | Add a user to the receipt |
| `addproxy Alice` / `ap Alice` | Add a placeholder for someone not in Discord |
| `rescan <optional hint>` | Re-parse the receipt image (resets all claims/splits/payments) — see [Prompting & Accuracy](#prompting--accuracy) |
| `void` | Void the receipt and lock the thread |

> **Acting on behalf of others:** the primary user can append `@user` to most commands (e.g. `claim 3 @alice`) or `as <proxyname>` to act for a proxy user.

### Channel commands (mention the bot)

| Command | Description |
|---------|-------------|
| `@bot <image> @user1 @user2 [restaurant]` | Start a new receipt split |
| `@bot sum` / `@bot sum paid` | Show/settle your unpaid totals across all receipts |
| `@bot leaderboard` | Show top restaurants and spenders |
| `@bot personal leaderboard` | Show your own spending stats (top restaurants, priciest receipts, lifetime spend, rank) |
| `@bot addtotal [restaurant] @user1 amount1 @user2 amount2` | Manually log a receipt to the leaderboard |
| `@bot help` | Show the channel command list |

## Prompting & Accuracy

The bot sends the receipt image to Claude with a structured prompt and validates the result before showing it.

**How extraction works:**
- Each line item is extracted with a name, quantity, line total, and — when the receipt prints one — a per-unit price (e.g. the `18.99` in `5 @18.99`).
- The bot self-checks two ways: line totals must sum to the **subtotal**, and any printed per-unit price must satisfy `quantity × unit = line total`. The per-unit check is what catches an angled photo whose price column has shifted by a row (a shift still sums to the same subtotal, so the subtotal alone can't catch it).
- If a scan fails either check, the bot **automatically retries once** with a targeted hint, then keeps whichever attempt reconciles best.

**Writing a good `rescan` hint.** When a scan is wrong, a specific hint helps far more than a vague one. Name the item and state the correction:

```
rescan item 3 should be $18.99
rescan the strawberry is a $3.69 add-on to the hotcake, not its own item
rescan the prices are shifted up one row
rescan Country Steak & Eggs is 5 @ 18.99 = 94.95
```

**`rescan` vs. manual edits.** `rescan` re-parses the *entire* receipt and **resets all claims, splits, and payments** — use it when the overall mapping is off. For a single known error, prefer the targeted commands, which don't reset anything:

```
edit 5 12.50          # fix one price
add Side Salad 4.50   # add a missed item
remove 7              # delete a phantom item
```

**Improving accuracy:**
- Take the photo as flat and square-on as possible; even lighting helps.
- Use `sonnet` or `opus` rather than `haiku` for receipts with skew, dense layouts, or per-unit pricing (see [Model Selection](#model-selection)).

## Deployment

### Local Development

```bash
bash dev.sh
```

Runs with hot reload via `tsx watch`. The script checks for `.env` and required variables before starting.

### Production (Railway)

1. Install the [Railway CLI](https://docs.railway.com/guides/cli):
   ```bash
   npm install -g @railway/cli
   railway login
   ```
2. Create a project:
   ```bash
   railway init
   ```
3. In the Railway dashboard:
   - Add environment variables (`DISCORD_TOKEN`, `ANTHROPIC_API_KEY`, and optionally `CLAUDE_MODEL`)
   - Add a persistent volume mounted at `/app/data` (for the SQLite database)
4. Deploy:
   ```bash
   bash deploy.sh
   ```

### Production (Docker)

```bash
# Build
npm run build
docker build -t receipt-bot .

# Run
docker run -d \
  --env-file .env \
  -v receipt-data:/app/data \
  receipt-bot
```

## Project Structure

```
src/
  index.ts              — Entry point + health-check HTTP server
  config.ts             — Environment variable loading
  bot/
    client.ts           — Discord client setup
    events/
      messageCreate.ts  — Main message handler (receipts, claims, payments, admin)
      ready.ts          — Bot ready event
  receipt/
    parser.ts           — Claude Vision extraction, model selection, reconciliation
    formatter.ts        — Discord embed/message formatting + help text
    calculator.ts       — Proportional tax/tip math
    types.ts            — TypeScript interfaces
  session/
    manager.ts          — Session business logic + daily spend tracking
    store.ts            — SQLite CRUD operations + daily spend cap
    migrations.ts       — Database schema
  utils/
    discord.ts          — Mention parsing, display name resolution
```

## How Tax and Tip Are Calculated

Each user's share is proportional to their claimed items relative to the receipt subtotal:

```
userShare    = userItemsTotal / receiptSubtotal
userTax      = taxAmount  × userShare
userTip      = tipAmount  × userShare
userTotal    = userItemsTotal + userTax + userTip   (rounded to nearest cent)
```

For split items, each user's portion is `itemPrice / numberOfUsers` (or the percentage given). Any discount is applied at the item level before shares are computed, so it flows through to every user.

Rounding may cause the sum of all user totals to differ from the receipt total by 1–2 cents.
```
