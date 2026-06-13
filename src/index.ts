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

// Test Discord API connectivity before attempting login
console.log("Testing Discord API connectivity...");
fetch("https://discord.com/api/v10/gateway/bot", {
  headers: { Authorization: `Bot ${config.discordToken}` },
})
  .then((res) => res.json())
  .then((data) => console.log("Gateway API response:", JSON.stringify(data)))
  .catch((err) => console.error("Gateway API fetch failed:", err));

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
