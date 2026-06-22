// Pulls full league-chat history from Sleeper's private GraphQL API.
// Reads the auth token from gitignored .sleeper-token (+ optional .sleeper-cookie).
// Writes raw messages to data/chat/messages.json (gitignored — private; only
// aggregates ever reach the public site via compute.mjs).
//
// Pagination note: messages(parent_id, before) returns up to ~50 messages in a
// FIXED ID-WIDTH window just below the cursor (≈11 days), not "newest 50 older
// than cursor" — so it returns nothing in gaps. We advance to the oldest id in a
// dense batch, and step the cursor down by a fixed amount across gaps. Each season
// is its own league_id, so we sweep every league in the dynasty chain.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const tokenPath = join(ROOT, ".sleeper-token");
if (!existsSync(tokenPath)) { console.error("Missing .sleeper-token"); process.exit(1); }
const token = readFileSync(tokenPath, "utf8").trim();
const cookie = existsSync(join(ROOT, ".sleeper-cookie")) ? readFileSync(join(ROOT, ".sleeper-cookie"), "utf8").trim() : null;

const FIELDS = "attachment author_avatar author_display_name author_real_name author_id author_is_bot author_role_id created edited message_id parent_id parent_type pinned reactions user_reactions text text_map";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STEP = 2000000000000000n;   // 2e15 — < window width, safe across gaps
const RANGE = 220000000000000000n; // 2.2e17 ≈ ~20 months back per league

async function fetchBatch(leagueId, before) {
  const query = `query messages { messages(parent_id: "${leagueId}", before: "${before}") { ${FIELDS} } }`;
  try {
    const res = await fetch("https://sleeper.com/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: token, "X-Sleeper-GraphQL-Op": "messages", Origin: "https://sleeper.com", Referer: `https://sleeper.com/leagues/${leagueId}/matchup`, "User-Agent": "Mozilla/5.0", ...(cookie ? { Cookie: cookie } : {}) },
      body: JSON.stringify({ operationName: "messages", variables: {}, query }),
    });
    if (!res.ok) { console.error(`  HTTP ${res.status}`); return []; }
    const j = await res.json();
    return j.data?.messages || [];
  } catch (e) { console.error("  fetch error:", e.message); return []; }
}

const manifest = JSON.parse(readFileSync(join(ROOT, "data", "raw", "_manifest.json"), "utf8"));
const leagues = manifest.fetchedSeasons.map((s) => {
  const lg = JSON.parse(readFileSync(join(ROOT, "data", "raw", s.season, "league.json"), "utf8"));
  return { season: s.season, league_id: lg.league_id, last_message_id: lg.last_message_id };
});

const all = [];
const seen = new Set();
for (const lg of leagues) {
  if (!lg.last_message_id) { console.log(`${lg.season}: no chat on record`); continue; }
  let before = BigInt(lg.last_message_id) + 1n;
  const floor = before - RANGE;
  let added = 0, reqs = 0;
  while (before > floor) {
    const batch = await fetchBatch(lg.league_id, before.toString());
    reqs++;
    let advanced = false;
    if (batch.length) {
      let minId = before;
      for (const m of batch) {
        if (!seen.has(m.message_id)) { seen.add(m.message_id); all.push({ season: lg.season, ...m }); added++; }
        const id = BigInt(m.message_id); if (id < minId) minId = id;
      }
      if (minId < before) { before = minId; advanced = true; }
    }
    if (!advanced) before -= STEP;
    await sleep(150);
  }
  console.log(`${lg.season}: +${added} messages (${reqs} requests)`);
}

mkdirSync(join(ROOT, "data", "chat"), { recursive: true });
writeFileSync(join(ROOT, "data", "chat", "messages.json"), JSON.stringify(all));
console.log(`\n✅ Total: ${all.length} messages saved to data/chat/messages.json`);
