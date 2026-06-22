// Aggregates the (gitignored) raw chat into src/data/chat-stats.json — the only
// chat data that reaches the public site. Kept separate from compute.mjs so the
// weekly cron (which has no raw chat) never overwrites it.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = join(ROOT, "data", "chat", "messages.json");
if (!existsSync(raw)) { console.error("No data/chat/messages.json — run fetch-chat first."); process.exit(1); }
const msgs = JSON.parse(readFileSync(raw, "utf8"));

const real = msgs.filter((m) => m.text && m.author_display_name !== "sys" && !m.author_is_bot && m.author_id && m.author_id !== "0");

// ---- biggest yappers ----
const byAuthor = {};
for (const m of real) {
  const a = (byAuthor[m.author_id] ||= { managerId: m.author_id, name: m.author_display_name, count: 0, chars: 0 });
  a.count++; a.chars += m.text.length;
}
const yappers = Object.values(byAuthor).map((a) => ({ managerId: a.managerId, name: a.name, count: a.count, avgLen: Math.round(a.chars / a.count) })).sort((x, y) => y.count - x.count);

// ---- word cloud ----
const STOP = new Set(("a an the and or but if then so to of in on at for from by with about as into over after under is are was were be been being am im do does did doing have has had get got go going gonna will would can could should shall may might must this that these those it its it's he she they them his her their we our us you your yall my mine me i'm you're we're they're there here what when where who whom which why how not no yes yeah yep nope just like really very too also still even much many more most some any all out up down off back than then now want need know think thing things lol lmao haha hahaha bro dude man yo oh ok okay u ur n y idk tbh fr gonna wanna gotta let lets im dont don't cant can't didnt doesnt aint isnt wont").split(/\s+/));
const freq = {};
for (const m of real) {
  for (let w of m.text.toLowerCase().split(/[^a-z0-9']+/)) {
    w = w.replace(/^'+|'+$/g, "");
    if (w.length < 3 || STOP.has(w) || /^\d+$/.test(w)) continue;
    freq[w] = (freq[w] || 0) + 1;
  }
}
const words = Object.entries(freq).map(([w, n]) => ({ w, n })).sort((a, b) => b.n - a.n).slice(0, 80);

// ---- reactions → quote wall + emoji totals ----
const rscore = (m) => (m.reactions && typeof m.reactions === "object" ? Object.values(m.reactions).reduce((a, b) => a + (+b || 0), 0) : 0);
const quotes = real
  .map((m) => ({ managerId: m.author_id, name: m.author_display_name, text: m.text, reactions: rscore(m), season: m.season, breakdown: m.reactions || {} }))
  .filter((q) => q.reactions > 0 && q.text.length <= 280)
  .sort((a, b) => b.reactions - a.reactions)
  .slice(0, 18);
const reactTypes = {};
for (const m of real) if (m.reactions && typeof m.reactions === "object") for (const [k, v] of Object.entries(m.reactions)) reactTypes[k] = (reactTypes[k] || 0) + (+v || 0);

const bySeason = {};
for (const m of real) bySeason[m.season] = (bySeason[m.season] || 0) + 1;

const out = {
  updated: new Date().toISOString().slice(0, 10),
  totalMessages: real.length,
  totalAll: msgs.length,
  yappers, words, quotes, reactTypes, bySeason,
};
writeFileSync(join(ROOT, "src", "data", "chat-stats.json"), JSON.stringify(out));
console.log(`Wrote chat-stats.json: ${real.length} real msgs, ${yappers.length} chatters, ${words.length} words, ${quotes.length} quotes`);
