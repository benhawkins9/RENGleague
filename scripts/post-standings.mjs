// Post the current-season Victory Points standings to the Sleeper league chat
// as ONE message: a rendered table image (PNG) with a one-line caption (notes optional).
//
//   node scripts/post-standings.mjs            # dry run: writes PNG + prints caption, posts nothing
//   node scripts/post-standings.mjs --post     # DEFAULT: table image + one-line caption ("Standings after Week N")
//   node scripts/post-standings.mjs --post --notes       # also append the emoji weekly notes
//   node scripts/post-standings.mjs --post --no-caption  # bare image, no text at all
//   node scripts/post-standings.mjs --post --no-image    # text-only table (fallback if Chrome is missing)
//
// Run `npm run data` first so src/data/league.json has the latest week.
// Auth: gitignored .sleeper-token (JWT). Sleeper reissues an expired token in the
// `authorization` response header; this script saves it automatically.
// Pipeline: POST https://sleeper.com/upload (multipart) -> create_file -> create_message.
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const args = new Set(process.argv.slice(2));
const POST = args.has("--post"), IMAGE = !args.has("--no-image"), NOTES = args.has("--notes"), CAPTION = !args.has("--no-caption");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const OUT_DIR = join(ROOT, "data", "chat-posts");
mkdirSync(OUT_DIR, { recursive: true });

// ---------- data ----------
const L = JSON.parse(readFileSync(join(ROOT, "src/data/league.json"), "utf8"));
const season = L.meta.upcomingSeason || L.meta.currentSeason;
const S = L.seasons[season];
const LEAGUE_ID = S.leagueId;
const wk = S.weeksPlayed;
if (!wk) { console.error(`${season}: no weeks played yet — nothing to post.`); process.exit(1); }
const st = S.standings; // already sorted by seed
const name = (r) => r.teamName.trim();
const f2 = (n) => n.toFixed(2);
const thisWeek = (r) => r.weekly.find((w) => w.week === wk);

// ---------- text summary ----------
function buildText() {
  if (!CAPTION && IMAGE && !NOTES) return "";
  const lines = [`Standings after Week ${wk}.`];
  if (!IMAGE) {
    st.forEach((r) => lines.push(`${r.seed}. ${name(r)} — ${r.vp} VP · ${r.w}-${r.l} · ${f2(r.pf)}`));
    lines.splice(7, 0, "——— playoff line ———");
  }
  if (NOTES) {
    const rows = st.map((r) => ({ r, w: thisWeek(r) })).filter((x) => x.w);
    const byPts = [...rows].sort((a, b) => b.w.points - a.w.points);
    const high = byPts[0], low = byPts[byPts.length - 1];
    const perfect = rows.filter((x) => x.w.vp === 4).map((x) => name(x.r));
    const robbed = byPts.slice(0, 4).filter((x) => x.w.result === "L").map((x) => name(x.r));
    const games = [];
    const seen = new Set();
    rows.forEach((x) => {
      const opp = rows.find((y) => y.w.points === x.w.oppPoints && y.r.managerId !== x.r.managerId);
      if (!opp) return;
      const key = [x.r.managerId, opp.r.managerId].sort().join("|");
      if (seen.has(key)) return; seen.add(key);
      const [win, lose] = x.w.points >= opp.w.points ? [x, opp] : [opp, x];
      games.push({ win, lose, margin: win.w.points - lose.w.points });
    });
    games.sort((a, b) => b.margin - a.margin);
    const blow = games[0], close = games[games.length - 1];
    const bench = [...rows].sort((a, b) => (b.r.weekly.find((w) => w.week === wk)?.optimal - b.w.points) - (a.r.weekly.find((w) => w.week === wk)?.optimal - a.w.points))[0];
    const benchPts = bench ? bench.w.optimal - bench.w.points : 0;
    lines.push("");
    lines.push(`🔥 High score: ${name(high.r)} ${f2(high.w.points)}`);
    if (perfect.length) lines.push(`💯 Perfect week (4 VP): ${perfect.join(", ")}`);
    if (robbed.length) lines.push(`🤕 Top-4 score but lost: ${robbed.join(", ")}`);
    if (blow) lines.push(`🧨 Blowout: ${name(blow.win.r)} over ${name(blow.lose.r)} by ${f2(blow.margin)}`);
    if (close && close !== blow) lines.push(`😬 Closest: ${name(close.win.r)} over ${name(close.lose.r)} by ${f2(close.margin)}`);
    if (benchPts >= 20) lines.push(`🪑 Left on bench: ${name(bench.r)} ${f2(benchPts)}`);
    lines.push(`🧊 Low score: ${name(low.r)} ${f2(low.w.points)}`);
  }
  if (NOTES || !IMAGE) lines.push("", "Full table, all-play & luck: rengleague.com/live");
  return lines.join("\n");
}

// ---------- image ----------
function buildHtml() {
  const rows = st.map((r) => {
    const w = thisWeek(r);
    return `<tr class="${r.seed <= 6 ? "in" : "out"} ${r.seed === 6 ? "cut" : ""}"><td class="n">${r.seed}</td><td class="t">${name(r)}</td><td class="vp">${r.vp}</td><td class="c">${r.w}-${r.l}${r.t ? "-" + r.t : ""}</td><td class="c">${f2(r.pf)}</td><td class="c dim">${w ? f2(w.points) : "—"}</td><td class="c wvp">${w ? "+" + w.vp : "—"}</td></tr>`;
  }).join("");
  return `<html><head><meta charset="utf-8"><style>
body{margin:0;background:#0f1115;font-family:"Segoe UI",Arial,sans-serif;color:#e8eaf0;width:660px}
.card{padding:22px 24px 18px}
h1{margin:0;font-size:22px;letter-spacing:.5px}h1 span{color:#ffb84d}
.sub{color:#8a90a2;font-size:13px;margin:4px 0 14px}
table{border-collapse:collapse;width:100%;font-size:16px}
th{color:#8a90a2;font-weight:600;font-size:12px;text-transform:uppercase;letter-spacing:.8px;text-align:right;padding:6px 8px;border-bottom:1px solid #2a2f3d}
th.l{text-align:left}
td{padding:8px 8px;border-bottom:1px solid #1c2030;font-variant-numeric:tabular-nums}
td.n{width:28px;color:#8a90a2}
td.t{font-weight:600}
td.vp{font-weight:800;color:#5ee0a0;font-size:18px;text-align:right}
td.c{text-align:right}
td.wvp{color:#ffb84d;font-weight:700}
.dim{color:#8a90a2}
tr.in td.n{color:#ffb84d;font-weight:700}
tr.cut td{border-bottom:2px dashed #ffb84d}
.foot{color:#8a90a2;font-size:12px;margin-top:12px;display:flex;justify-content:space-between}
</style></head><body><div class="card">
<h1>RENG <span>Victory Points</span> · Through Week ${wk}</h1>
<div class="sub">+2 for the H2H win · scoring bonus top-4 +2, mid-4 +1 · max 4/week · dashed line = playoff cut</div>
<table><thead><tr><th class="l">#</th><th class="l">Team</th><th>VP</th><th>Rec</th><th>PF</th><th>Wk ${wk}</th><th>Wk VP</th></tr></thead><tbody>${rows}</tbody></table>
<div class="foot"><span>rengleague.com/live</span><span>updated ${new Date().toISOString().slice(0, 10)}</span></div>
</div></body></html>`;
}

function renderPng() {
  const html = join(OUT_DIR, `standings-wk${wk}.html`);
  const png = join(OUT_DIR, `standings-wk${wk}.png`);
  writeFileSync(html, buildHtml());
  const height = 150 + st.length * 41 + 60;
  execFileSync(CHROME, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--force-device-scale-factor=2",
    `--window-size=660,${height}`, `--screenshot=${png}`, `file:///${html.replace(/\\/g, "/")}`], { stdio: "ignore" });
  return png;
}

// ---------- sleeper api ----------
const tokenPath = join(ROOT, ".sleeper-token");
let token = readFileSync(tokenPath, "utf8").trim();
const H = () => ({ Authorization: token, Origin: "https://sleeper.com", Referer: `https://sleeper.com/leagues/${LEAGUE_ID}`, "User-Agent": "Mozilla/5.0" });

async function refreshTokenIfNeeded() {
  const res = await fetch("https://sleeper.com/graphql", { method: "POST", headers: { ...H(), "Content-Type": "application/json" }, body: JSON.stringify({ query: "{ __typename }" }) });
  const fresh = res.headers.get("authorization");
  if (fresh && fresh !== token) { copyFileSync(tokenPath, tokenPath + ".bak"); writeFileSync(tokenPath, fresh); token = fresh; console.log("Sleeper token refreshed."); }
}

async function gql(op, query, variables = {}) {
  const res = await fetch("https://sleeper.com/graphql", { method: "POST", headers: { ...H(), "Content-Type": "application/json", "X-Sleeper-GraphQL-Op": op }, body: JSON.stringify({ operationName: op, variables, query }) });
  const j = await res.json();
  if (j.errors) throw new Error(`${op}: ${JSON.stringify(j.errors)}`);
  return j.data[op];
}

async function uploadPng(path) {
  const fd = new FormData();
  fd.append("file", new Blob([readFileSync(path)], { type: "image/png" }), `Week ${wk}.png`);
  const res = await fetch("https://sleeper.com/upload", { method: "POST", headers: H(), body: fd });
  if (!res.ok) throw new Error(`upload HTTP ${res.status}: ${await res.text()}`);
  const u = await res.json(); // {filename,filesize,height,width,mimetype,url,url_original}
  const file = await gql("create_file", `mutation create_file { create_file(filename: "${u.filename}", filesize: ${u.filesize}, height: ${u.height}, width: ${u.width}, mimetype: "${u.mimetype}", url: "${u.url}", url_original: "${u.url_original}", parent_type: "league", parent_id: "${LEAGUE_ID}") { file_id url } }`);
  return file;
}

async function postMessage(text, file) {
  const attach = file ? `, attachment_type: "file", attachment_id: "${file.file_id}"` : "";
  return gql("create_message", `mutation create_message($text: String) { create_message(text: $text, parent_type: "league", parent_id: "${LEAGUE_ID}"${attach}) { message_id created author_display_name } }`, { text });
}

// ---------- main ----------
const text = buildText();
const png = IMAGE ? renderPng() : null;
console.log(`--- ${season} Week ${wk} post ${POST ? "(POSTING)" : "(dry run)"} ---\n${text}\n---`);
if (png) console.log(`image: ${png}`);
if (!POST) { console.log("Dry run. Re-run with --post to send."); process.exit(0); }

await refreshTokenIfNeeded();
const file = png ? await uploadPng(png) : null;
if (file) console.log(`uploaded file_id ${file.file_id} -> ${file.url}`);
const m = await postMessage(text, file);
console.log(`POSTED message ${m.message_id} as ${m.author_display_name} at ${new Date(+m.created).toISOString()}`);
