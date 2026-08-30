import http from "http";
import { config } from "./config.js";
import { createClient } from "./bot/client.js";
import { registerReadyEvent } from "./bot/events/ready.js";
import { registerMessageCreateEvent } from "./bot/events/messageCreate.js";
import { initDatabase } from "./session/migrations.js";
import { backfillSettlementEntries } from "./session/store.js";

// Health check server for Railway
const port = process.env.PORT || 3000;
http
  .createServer((_req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(port, () => {
    console.log(`Health check listening on port ${port}`);
  });

// TEMPORARY DIAGNOSTIC — remove once the Railway→Discord egress block is
// understood. Since 2026-08-29 every container start gets a Cloudflare HTML
// page instead of Discord's API, while the same token works from a residential
// IP. This dumps enough to tell an IP ban from a WAF challenge from a real
// rate limit, and how long it claims to last.
//
// Never logs the token. Response headers only.
const DIAG_HEADERS = [
  "server",
  "cf-ray",
  "cf-mitigated",
  "cf-cache-status",
  "retry-after",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset-after",
  "x-ratelimit-global",
  "x-ratelimit-scope",
  "via",
  "content-type",
];

async function probe(label: string, url: string, init: RequestInit = {}) {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, init);
    const picked: Record<string, string> = {};
    for (const h of DIAG_HEADERS) {
      const v = res.headers.get(h);
      if (v !== null) picked[h] = v;
    }
    const body = (await res.text()).replace(/\s+/g, " ").trim();
    console.log(
      `[diag] ${label}: ${res.status} ${res.statusText} (${Date.now() - startedAt}ms) ` +
        `headers=${JSON.stringify(picked)} body="${body.slice(0, 300)}"`,
    );
  } catch (err) {
    console.log(
      `[diag] ${label}: threw after ${Date.now() - startedAt}ms: ` +
        (err instanceof Error ? `${err.name}: ${err.message}` : String(err)),
    );
  }
}

async function runDiagnostics(): Promise<void> {
  console.log("[diag] ===== Railway -> Discord egress diagnostic =====");
  // What IP does Discord actually see us as? Decides "our IP range is banned".
  await probe("egress-ip", "https://api.ipify.org?format=json");
  // Is general egress fine, and is *any* Cloudflare-fronted site fine?
  await probe("control-noncf", "https://api.frankfurter.app/latest?from=EUR&to=USD");
  await probe("control-cloudflare", "https://cloudflare.com/cdn-cgi/trace");
  // Unauthenticated Discord API. If this is blocked too, it is not about our
  // token or our bot — it is the IP.
  await probe("discord-unauth", "https://discord.com/api/v10/gateway");
  // Authenticated, with a browser-ish UA and with a proper bot UA, to see
  // whether the WAF is fingerprinting the client rather than the address.
  await probe("discord-auth-defaultua", "https://discord.com/api/v10/gateway/bot", {
    headers: { Authorization: `Bot ${config.discordToken}` },
  });
  await probe("discord-auth-botua", "https://discord.com/api/v10/gateway/bot", {
    headers: {
      Authorization: `Bot ${config.discordToken}`,
      "User-Agent": "DiscordBot (https://github.com/maxwellcsutton/discord-receipt-splitter, 1.0)",
    },
  });
  console.log("[diag] ===== end diagnostic =====");
}

void runDiagnostics();

const client = createClient();

initDatabase();
backfillSettlementEntries();
registerReadyEvent(client);
registerMessageCreateEvent(client);

client.on("error", (err) => console.error("Client error:", err));
client.on("warn", (msg) => console.warn("Client warn:", msg));
client.on("debug", (msg) => console.log("Client debug:", msg));
client.on("invalidated", () => console.error("Session invalidated"));
client.rest.on("rateLimited", (info) =>
  console.warn("Rate limited:", JSON.stringify(info)),
);
client.rest.on("response", (req, res) =>
  console.log(`REST response: ${req.method} ${req.path} -> ${res.status}`),
);

console.log("Calling client.login()...");
client
  .login(config.discordToken)
  .then(() => console.log("login() resolved"))
  .catch((err) => {
    console.error("Failed to login:", err);
    process.exit(1);
  });
