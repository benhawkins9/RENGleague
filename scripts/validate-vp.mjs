// Validation: recompute Victory Points + reconstruct playoffs from Sleeper data,
// then compare to the manager's spreadsheet screenshots.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const L = JSON.parse(readFileSync(join(ROOT, "src/data/league.json"), "utf8"));
const nameById = Object.fromEntries(L.managers.map((m) => [m.id, m.name]));

const REG_WEEKS = 14, PLAYIN = 15, FINALS = [16, 17];

for (const season of L.meta.completedSeasons) {
  const st = L.seasons[season].standings;
  // index weekly points/results per team
  const teams = st.map((r) => ({
    id: r.managerId, name: r.teamName,
    wk: Object.fromEntries(r.weekly.map((w) => [w.week, w])),
  }));
  const vp = {}, pf14 = {};
  teams.forEach((t) => { vp[t.id] = 0; pf14[t.id] = 0; });

  for (let w = 1; w <= REG_WEEKS; w++) {
    const row = teams.map((t) => ({ id: t.id, pts: t.wk[w]?.points ?? null, res: t.wk[w]?.result }))
      .filter((x) => x.pts != null);
    if (!row.length) continue;
    const ranked = [...row].sort((a, b) => b.pts - a.pts);
    ranked.forEach((x, i) => {
      const tier = i < 4 ? 2 : i < 8 ? 1 : 0;        // top4 / mid4 / bottom4
      const h2h = x.res === "W" ? 2 : x.res === "T" ? 1 : 0;
      vp[x.id] += tier + h2h;
      pf14[x.id] += x.pts;
    });
  }

  // seed by VP desc, then PF14 desc
  const seeds = teams.map((t) => ({ id: t.id, name: t.name, vp: vp[t.id], pf: +pf14[t.id].toFixed(2) }))
    .sort((a, b) => b.vp - a.vp || b.pf - a.pf);

  console.log(`\n========== ${season} ==========`);
  console.log("Seed  Team                       VP   PF(1-14)");
  seeds.forEach((s, i) =>
    console.log(`${String(i + 1).padStart(2)}    ${s.name.slice(0, 24).padEnd(24)} ${String(s.vp).padStart(3)}  ${s.pf.toFixed(1)}`));

  // playoff reconstruction
  const byId = Object.fromEntries(teams.map((t) => [t.id, t]));
  const ptsAt = (id, wk) => byId[id].wk[wk]?.points ?? 0;
  const playin = seeds.slice(2, 6).map((s) => ({ ...s, w15: ptsAt(s.id, PLAYIN) }))
    .sort((a, b) => b.w15 - a.w15);
  const advancers = playin.slice(0, 2);
  console.log(`Week ${PLAYIN} play-in (seeds 3-6): ` +
    playin.map((p) => `${p.name} ${p.w15.toFixed(1)}${advancers.includes(p) ? " ✔" : " ✘"}`).join(" | "));

  const finalists = [seeds[0], seeds[1], ...advancers].map((s) => ({
    ...s, f: FINALS.reduce((a, wk) => a + ptsAt(s.id, wk), 0),
    breakdown: FINALS.map((wk) => ptsAt(s.id, wk).toFixed(2)).join(" + "),
  })).sort((a, b) => b.f - a.f);
  console.log("FINALS (wk16+17 cumulative):");
  finalists.forEach((f, i) =>
    console.log(`  ${["🏆 1st", "2nd", "3rd", "4th"][i]}: ${f.name.padEnd(24)} ${f.breakdown} = ${f.f.toFixed(2)}`));
}
