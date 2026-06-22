// Fetches current dynasty player values from FantasyCalc (Superflex, 0.5 PPR, 12-team),
// keyed to Sleeper IDs. Writes src/data/values-current.json AND a dated snapshot to
// src/data/value-history/<date>.json so the weekly cron builds a historical archive
// (lets future trades be valued at the time they happened).
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "src", "data");
const HIST = join(OUT, "value-history");
const API = "https://api.fantasycalc.com/values/current?isDynasty=true&numQbs=2&numTeams=12&ppr=0.5";

const res = await fetch(API);
if (!res.ok) { console.error(`FantasyCalc fetch failed: HTTP ${res.status}`); process.exit(1); }
const data = await res.json();

const values = {};
const snapshot = {};
for (const e of data) {
  const sid = e.player?.sleeperId;
  if (!sid) continue; // skip picks / unmapped entries
  values[sid] = {
    value: e.value,
    overallRank: e.overallRank,
    positionRank: e.positionRank,
    age: e.player.maybeAge ?? null,
    yoe: e.player.maybeYoe ?? null,
    position: e.player.position,
    name: e.player.name,
    team: e.player.maybeTeam ?? null,
    trend30: e.trend30Day ?? 0,
  };
  snapshot[sid] = e.value;
}

const date = new Date().toISOString().slice(0, 10);
mkdirSync(HIST, { recursive: true });
writeFileSync(join(OUT, "values-current.json"), JSON.stringify({ date, source: "FantasyCalc · Dynasty Superflex 0.5PPR 12-team", values }));
writeFileSync(join(HIST, `${date}.json`), JSON.stringify(snapshot));
console.log(`Wrote ${Object.keys(values).length} player values (snapshot ${date})`);
