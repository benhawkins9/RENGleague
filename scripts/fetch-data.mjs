// Fetches every season of the league by walking the `previous_league_id` chain,
// then dumps all raw Sleeper data to data/raw/<season>/. Re-runnable; overwrites.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const BASE = "https://api.sleeper.app/v1";
const CURRENT_LEAGUE_ID = "1345899214218997760";
const MAX_WEEK = 18;

async function getJSON(url, tries = 4) {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url);
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      if (i === tries - 1) {
        console.warn(`  ! failed ${url}: ${err.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function save(season, name, data) {
  const dir = join(RAW, season);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, name), JSON.stringify(data));
}

// Slim the 11k-player global map down to the fields the site actually uses.
function slimPlayers(players) {
  const out = {};
  for (const [id, p] of Object.entries(players)) {
    if (!p) continue;
    out[id] = {
      id,
      name:
        p.full_name ||
        [p.first_name, p.last_name].filter(Boolean).join(" ") ||
        p.last_name ||
        id,
      pos: p.position || (p.fantasy_positions && p.fantasy_positions[0]) || null,
      team: p.team || null,
      exp: p.years_exp ?? null,
      age: p.age ?? null,
      college: p.college || null,
    };
  }
  return out;
}

async function fetchLeagueSeason(league) {
  const id = league.league_id;
  const season = league.season;
  console.log(`\n== ${season} :: ${league.name} (${id}) ==`);
  await save(season, "league.json", league);

  const [users, rosters, winners, losers, tradedPicks, drafts] =
    await Promise.all([
      getJSON(`${BASE}/league/${id}/users`),
      getJSON(`${BASE}/league/${id}/rosters`),
      getJSON(`${BASE}/league/${id}/winners_bracket`),
      getJSON(`${BASE}/league/${id}/losers_bracket`),
      getJSON(`${BASE}/league/${id}/traded_picks`),
      getJSON(`${BASE}/league/${id}/drafts`),
    ]);
  await save(season, "users.json", users || []);
  await save(season, "rosters.json", rosters || []);
  await save(season, "winners_bracket.json", winners || []);
  await save(season, "losers_bracket.json", losers || []);
  await save(season, "traded_picks.json", tradedPicks || []);
  await save(season, "drafts.json", drafts || []);
  console.log(`  users:${users?.length ?? 0} rosters:${rosters?.length ?? 0} drafts:${drafts?.length ?? 0}`);

  // Draft picks per draft
  const draftPicks = {};
  for (const d of drafts || []) {
    draftPicks[d.draft_id] = (await getJSON(`${BASE}/draft/${d.draft_id}/picks`)) || [];
  }
  await save(season, "draft_picks.json", draftPicks);

  // Weekly matchups + transactions
  const matchups = {};
  const transactions = {};
  for (let w = 1; w <= MAX_WEEK; w++) {
    const [m, t] = await Promise.all([
      getJSON(`${BASE}/league/${id}/matchups/${w}`),
      getJSON(`${BASE}/league/${id}/transactions/${w}`),
    ]);
    if (Array.isArray(m) && m.length) matchups[w] = m;
    if (Array.isArray(t) && t.length) transactions[w] = t;
  }
  await save(season, "matchups.json", matchups);
  await save(season, "transactions.json", transactions);
  const playedWeeks = Object.keys(matchups).length;
  console.log(`  matchup weeks:${playedWeeks} txn weeks:${Object.keys(transactions).length}`);
  return playedWeeks;
}

async function main() {
  console.log("Walking league history chain...");
  const leagues = [];
  let id = CURRENT_LEAGUE_ID;
  const seen = new Set();
  while (id && !seen.has(id)) {
    seen.add(id);
    const lg = await getJSON(`${BASE}/league/${id}`);
    if (!lg) break;
    leagues.push(lg);
    id = lg.previous_league_id;
  }
  console.log(
    `Found ${leagues.length} seasons: ${leagues.map((l) => l.season).join(", ")}`
  );

  for (const lg of leagues) await fetchLeagueSeason(lg);

  // Global state + player map (fetched once, shared across seasons)
  const state = await getJSON(`${BASE}/state/nfl`);
  await mkdir(RAW, { recursive: true });
  await writeFile(join(RAW, "state.json"), JSON.stringify(state));

  console.log("\nFetching player map (~5MB, slimming)...");
  const players = await getJSON(`${BASE}/players/nfl`);
  await writeFile(
    join(RAW, "players.json"),
    JSON.stringify(slimPlayers(players || {}))
  );
  console.log(`Players saved: ${Object.keys(players || {}).length} entries`);

  await writeFile(
    join(RAW, "_manifest.json"),
    JSON.stringify(
      {
        fetchedSeasons: leagues.map((l) => ({
          season: l.season,
          league_id: l.league_id,
          name: l.name,
          status: l.status,
        })),
        currentLeagueId: CURRENT_LEAGUE_ID,
      },
      null,
      2
    )
  );
  console.log("\nDone. Raw data in data/raw/");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
