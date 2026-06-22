// Transforms raw Sleeper dumps into the derived metrics that power the site.
// This league uses a custom VICTORY POINTS system (computed manually off-platform),
// so we reconstruct it here: VP standings over a 14-week regular season, then a
// play-in week + 2-week cumulative-score finals to crown the real champion.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const RAW = join(ROOT, "data", "raw");
const OUT = join(ROOT, "src", "data");
mkdirSync(OUT, { recursive: true });

// ---- league format constants ----
const REG_WEEKS = 14;          // weeks 1-14 are the VP regular season
const PLAYIN_WEEK = 15;        // seeds 3-6 play; top 2 SCORES advance
const FINALS_WEEKS = [16, 17]; // 4 finalists; highest 2-week cumulative score wins

const read = (...p) => JSON.parse(readFileSync(join(RAW, ...p), "utf8"));
const manifest = read("_manifest.json");
const state = read("state.json");
const players = read("players.json");
// FantasyCalc dynasty values (optional — only present after `fetch-values`)
let valueData = null;
const valuesPath = join(OUT, "values-current.json");
if (existsSync(valuesPath)) valueData = JSON.parse(readFileSync(valuesPath, "utf8"));
const PV = valueData?.values || {}; // sleeperId -> { value, age, position, name, trend30, ... }
const SEASONS = manifest.fetchedSeasons.map((s) => s.season).sort();
const referencedPlayers = new Set();

const round = (n, d = 2) => { const f = 10 ** d; return Math.round((n + Number.EPSILON) * f) / f; };
const sum = (a) => a.reduce((x, y) => x + y, 0);
const avg = (a) => (a.length ? sum(a) / a.length : 0);
const stdev = (a) => { if (a.length < 2) return 0; const m = avg(a); return Math.sqrt(avg(a.map((x) => (x - m) ** 2))); };

// ---- Manager identity (stable across seasons via owner user_id) ----
const managers = {};
function touchManager(userId, user, season) {
  if (!userId) return;
  const m = (managers[userId] ||= { id: userId, name: null, displayName: null, avatar: null, seasonsPlayed: new Set(), teamNamesBySeason: {} });
  m.seasonsPlayed.add(season);
  const team = (user?.metadata?.team_name || user?.display_name || "").trim();
  m.teamNamesBySeason[season] = team || m.teamNamesBySeason[season] || `Team ${userId.slice(-4)}`;
  m.name = m.teamNamesBySeason[SEASONS[SEASONS.length - 1]] || team || m.name;
  m.displayName = user?.display_name || m.displayName;
  m.avatar = user?.avatar || m.avatar;
}

// ---- Optimal lineup solver (QB/RB/WR/TE + FLEX + SF) ----
const ELIG = {
  QB: ["QB"], RB: ["RB"], WR: ["WR"], TE: ["TE"], K: ["K"], DEF: ["DEF"],
  FLEX: ["RB", "WR", "TE"], WRRB_FLEX: ["RB", "WR"], REC_FLEX: ["WR", "TE"],
  SUPER_FLEX: ["QB", "RB", "WR", "TE"], IDP_FLEX: ["DL", "LB", "DB"],
};
const startingSlots = (positions) => positions.filter((p) => !["BN", "IR", "TAXI"].includes(p));
function optimalPoints(slots, playerIds, pointsMap) {
  const pool = playerIds.map((id) => ({ id, pos: players[id]?.pos, pts: pointsMap[id] ?? 0 })).filter((p) => p.pos);
  const order = [...slots].sort((a, b) => (ELIG[a]?.length || 99) - (ELIG[b]?.length || 99));
  const used = new Set();
  let total = 0;
  for (const slot of order) {
    const elig = ELIG[slot] || [];
    let best = null;
    for (const p of pool) { if (used.has(p.id) || !elig.includes(p.pos)) continue; if (!best || p.pts > best.pts) best = p; }
    if (best) { used.add(best.id); total += best.pts; }
  }
  return round(total);
}

// ---- Per-season computation ----
const seasonsOut = {};
const allTimeWeekly = [];   // regular-season weeks only, for raw scoring records
const h2h = {};
const playerSeasonPoints = {};
const allWaiverAdds = [];   // {season, managerId, playerId, faab, week} for FAAB records
const txByManager = {};     // managerId -> {faabSpent, waiverClaims, faAdds, biggestBid, trades}
const allTrades = [];       // {season, week, created, sides:[{managerId, players, picks, faab, ...Out}]}
const faEvents = [];        // {managerId, playerId, season, week} free-agent adds, for acquisition source
const currentRosters = {};  // managerId -> [playerId] for the latest season

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

for (const season of SEASONS) {
  const league = read(season, "league.json");
  const users = read(season, "users.json");
  const rosters = read(season, "rosters.json");
  const matchups = read(season, "matchups.json");
  const drafts = read(season, "drafts.json");
  const draftPicks = read(season, "draft_picks.json");
  const transactions = read(season, "transactions.json");

  const userById = Object.fromEntries(users.map((u) => [u.user_id, u]));
  const rosterToManager = {};
  for (const r of rosters) {
    rosterToManager[r.roster_id] = r.owner_id;
    touchManager(r.owner_id, userById[r.owner_id], season);
    (r.players || []).forEach((p) => referencedPlayers.add(p));
  }
  if (season === SEASONS[SEASONS.length - 1]) for (const r of rosters) if (r.owner_id) currentRosters[r.owner_id] = r.players || [];

  const slots = startingSlots(league.roster_positions || []);
  const allWeeks = Object.keys(matchups).map(Number).sort((a, b) => a - b)
    .filter((w) => matchups[w].some((t) => (t.points || 0) > 0));
  const regWeeks = allWeeks.filter((w) => w <= REG_WEEKS);
  const isComplete = league.status === "complete";

  // team accumulators
  const T = {};
  for (const r of rosters) {
    T[r.roster_id] = {
      rosterId: r.roster_id, managerId: r.owner_id,
      teamName: userById[r.owner_id]?.metadata?.team_name || userById[r.owner_id]?.display_name || `Team ${r.roster_id}`,
      w: 0, l: 0, t: 0, pf: 0, pa: 0, optimal: 0,
      vp: 0, vpH2H: 0, vpScore: 0,
      weekly: [], allWeekPoints: {},
      allPlayW: 0, allPlayL: 0, allPlayT: 0,
      highWeek: { pts: -Infinity, week: null }, lowWeek: { pts: Infinity, week: null },
    };
  }

  // record every team's points for EVERY played week (needed for playoff reconstruction)
  for (const week of allWeeks) {
    for (const tm of matchups[week]) {
      if (!(tm.roster_id in T)) continue;
      T[tm.roster_id].allWeekPoints[week] = tm.points || 0;
      const pp = tm.players_points || {};
      playerSeasonPoints[season] ||= {};
      for (const [pid, pts] of Object.entries(pp)) playerSeasonPoints[season][pid] = round((playerSeasonPoints[season][pid] || 0) + pts);
    }
  }

  // regular-season pass: standings stats + Victory Points
  for (const week of regWeeks) {
    const teams = matchups[week].filter((t) => t.roster_id in T);
    const scores = teams.map((t) => t.points || 0).sort((a, b) => a - b);
    const byMatch = {};
    for (const t of teams) (byMatch[t.matchup_id] ||= []).push(t);

    // VP scoring tier: rank desc, top4=+2, mid4=+1, bottom4=0
    const rankedDesc = [...teams].sort((a, b) => (b.points || 0) - (a.points || 0));
    const scoreVP = {};
    rankedDesc.forEach((t, i) => (scoreVP[t.roster_id] = i < 4 ? 2 : i < 8 ? 1 : 0));

    for (const t of teams) {
      const me = T[t.roster_id];
      const pts = t.points || 0;
      me.pf += pts;
      const beat = scores.filter((s) => s < pts).length;
      const tied = Math.max(0, scores.filter((s) => s === pts).length - 1);
      me.allPlayW += beat; me.allPlayT += tied; me.allPlayL += teams.length - 1 - beat - tied;
      const opt = optimalPoints(slots, t.players || [], t.players_points || {});
      me.optimal += opt;
      if (pts > me.highWeek.pts) me.highWeek = { pts: round(pts), week };
      if (pts < me.lowWeek.pts) me.lowWeek = { pts: round(pts), week };
      allTimeWeekly.push({ season, week, managerId: me.managerId, teamName: me.teamName, points: round(pts) });
      me.vpScore += scoreVP[t.roster_id];
      me.weekly.push({ week, points: round(pts), optimal: opt, scoreVP: scoreVP[t.roster_id] });
    }

    for (const pair of Object.values(byMatch)) {
      if (pair.length !== 2) continue;
      const [a, b] = pair;
      const A = T[a.roster_id], B = T[b.roster_id];
      const ap = a.points || 0, bp = b.points || 0;
      A.pa += bp; B.pa += ap;
      const wkA = A.weekly[A.weekly.length - 1], wkB = B.weekly[B.weekly.length - 1];
      wkA.oppPoints = round(bp); wkB.oppPoints = round(ap);
      let hvA = 0, hvB = 0;
      if (ap > bp) { A.w++; B.l++; wkA.result = "W"; wkB.result = "L"; hvA = 2; }
      else if (bp > ap) { B.w++; A.l++; wkA.result = "L"; wkB.result = "W"; hvB = 2; }
      else { A.t++; B.t++; wkA.result = "T"; wkB.result = "T"; hvA = hvB = 1; }
      A.vpH2H += hvA; B.vpH2H += hvB;
      wkA.h2hVP = hvA; wkB.h2hVP = hvB;
      wkA.vp = hvA + wkA.scoreVP; wkB.vp = hvB + wkB.scoreVP;

      // head-to-head (regular season, by manager)
      const ma = A.managerId, mb = B.managerId;
      if (ma && mb) {
        const key = pairKey(ma, mb), aLow = ma < mb;
        const rec = (h2h[key] ||= { a: aLow ? ma : mb, b: aLow ? mb : ma, aw: 0, bw: 0, t: 0, apf: 0, bpf: 0 });
        rec.apf += aLow ? ap : bp; rec.bpf += aLow ? bp : ap;
        if (ap === bp) rec.t++; else if ((ap > bp) === aLow) rec.aw++; else rec.bw++;
      }
    }
  }

  // finalize team rows
  const teamRows = Object.values(T).filter((x) => x.weekly.length).map((x) => {
    x.vp = x.vpH2H + x.vpScore;
    const g = x.w + x.l + x.t;
    const apg = x.allPlayW + x.allPlayL + x.allPlayT;
    const weeklyPts = x.weekly.map((w) => w.points);
    let bestW = 0, worstL = 0, run = 0;
    for (const w of x.weekly) {
      if (w.result === "W") { run = run >= 0 ? run + 1 : 1; bestW = Math.max(bestW, run); }
      else if (w.result === "L") { run = run <= 0 ? run - 1 : -1; worstL = Math.min(worstL, run); }
    }
    let curStreak = 0, runType = null;
    for (let i = x.weekly.length - 1; i >= 0; i--) {
      const r = x.weekly[i].result;
      if (i === x.weekly.length - 1) { curStreak = r === "W" ? 1 : r === "L" ? -1 : 0; runType = r; }
      else if (r === runType && runType !== "T") curStreak += runType === "W" ? 1 : -1; else break;
    }
    const expectedWins = round((x.allPlayW + 0.5 * x.allPlayT) / ((apg / (g || 1)) || 1), 2);
    return {
      rosterId: x.rosterId, managerId: x.managerId, teamName: x.teamName,
      vp: x.vp, vpH2H: x.vpH2H, vpScore: x.vpScore,
      perfectWeeks: x.weekly.filter((w) => w.vp === 4).length,
      w: x.w, l: x.l, t: x.t, pf: round(x.pf), pa: round(x.pa),
      ppg: round(x.pf / x.weekly.length),
      optimal: round(x.optimal), efficiency: round((x.pf / x.optimal) * 100, 1),
      pointsLeftOnBench: round(x.optimal - x.pf),
      allPlayW: x.allPlayW, allPlayL: x.allPlayL, allPlayT: x.allPlayT,
      allPlayPct: round((x.allPlayW + 0.5 * x.allPlayT) / (apg || 1), 4),
      expectedWins, luck: round(x.w + 0.5 * x.t - expectedWins, 2),
      consistency: round(stdev(weeklyPts), 1),
      ceiling: round(Math.max(...weeklyPts)), floor: round(Math.min(...weeklyPts)),
      highWeek: x.highWeek, lowWeek: x.lowWeek, bestWinStreak: bestW, worstLossStreak: -worstL, currentStreak: curStreak,
      weekly: x.weekly,
      allWeekPoints: x.allWeekPoints,
    };
  });

  // standings sorted by VP, then PF (matches the league's manual sheet)
  const standings = [...teamRows].sort((a, b) => b.vp - a.vp || b.pf - a.pf);
  standings.forEach((r, i) => (r.seed = i + 1));

  // power ranking
  const pfVals = teamRows.map((r) => r.pf);
  const last4 = (r) => avg(r.weekly.slice(-4).map((w) => w.points));
  const last4Vals = teamRows.map(last4);
  const pct = (v, arr) => (arr.filter((x) => x <= v).length - 1) / Math.max(1, arr.length - 1);
  const power = [...teamRows].map((r) => ({
    rosterId: r.rosterId, managerId: r.managerId, teamName: r.teamName, allPlayPct: r.allPlayPct, pf: r.pf,
    powerScore: round(100 * (0.6 * r.allPlayPct + 0.25 * pct(r.pf, pfVals) + 0.15 * pct(last4(r), last4Vals)), 1),
  })).sort((a, b) => b.powerScore - a.powerScore).map((r, i) => ({ ...r, rank: i + 1 }));

  // ---- playoff reconstruction ----
  const ptsAt = (row, wk) => row.allWeekPoints[wk] ?? 0;
  let playoffs = null, champion = null, runnerUp = null;
  const hasPlayoffData = isComplete && standings.length >= 6 &&
    standings.every((r) => true) && [PLAYIN_WEEK, ...FINALS_WEEKS].every((wk) => standings.some((r) => r.allWeekPoints[wk] != null));

  if (hasPlayoffData) {
    const slim = (r) => ({ seed: r.seed, managerId: r.managerId, teamName: r.teamName, vp: r.vp, pf: r.pf });
    const byes = [standings[0], standings[1]];
    const playin = standings.slice(2, 6)
      .map((r) => ({ ...slim(r), points: round(ptsAt(r, PLAYIN_WEEK)) }))
      .sort((a, b) => b.points - a.points)
      .map((p, i) => ({ ...p, advanced: i < 2 }));
    const advancerIds = playin.filter((p) => p.advanced).map((p) => p.managerId);
    const finalistRows = standings.filter((r) => r === byes[0] || r === byes[1] || advancerIds.includes(r.managerId));
    const finals = finalistRows.map((r) => {
      const wk = Object.fromEntries(FINALS_WEEKS.map((w) => [w, round(ptsAt(r, w))]));
      return { ...slim(r), wk, total: round(FINALS_WEEKS.reduce((a, w) => a + ptsAt(r, w), 0)) };
    }).sort((a, b) => b.total - a.total).map((f, i) => ({ ...f, place: i + 1 }));

    playoffs = {
      byes: byes.map(slim),
      playin,
      finals,
      playInWeek: PLAYIN_WEEK, finalsWeeks: FINALS_WEEKS,
    };
    champion = finals[0]; runnerUp = finals[1];
  }

  const pointsKing = [...teamRows].sort((a, b) => b.pf - a.pf)[0];

  // draft board
  const draftId = drafts[0]?.draft_id;
  const picks = (draftId && draftPicks[draftId]) || [];
  const draftBoard = picks.map((p) => {
    referencedPlayers.add(p.player_id);
    const meta = p.metadata || {};
    return {
      round: p.round, pickNo: p.pick_no, rosterId: p.roster_id, managerId: rosterToManager[p.roster_id],
      playerId: p.player_id, name: [meta.first_name, meta.last_name].filter(Boolean).join(" ") || players[p.player_id]?.name || p.player_id,
      pos: meta.position || players[p.player_id]?.pos, team: meta.team,
      amount: meta.amount ? +meta.amount : null,
    };
  });

  const txAll = Object.values(transactions).flat();
  let tradeCount = 0;
  const initTx = (mid) => (txByManager[mid] ||= { faabSpent: 0, waiverClaims: 0, faAdds: 0, biggestBid: 0, trades: 0 });
  for (const tx of txAll) {
    if (tx.type === "trade") {
      if (tx.status && tx.status !== "complete") continue;
      tradeCount++;
      const sides = (tx.roster_ids || []).map((rid) => {
        const mid = rosterToManager[rid];
        if (mid) initTx(mid).trades++;
        const playersIn = [];
        for (const [pid, toR] of Object.entries(tx.adds || {})) if (toR === rid) { referencedPlayers.add(pid); playersIn.push(pid); }
        const picksIn = (tx.draft_picks || [])
          .filter((dp) => dp.owner_id === rid && dp.previous_owner_id !== rid)
          .map((dp) => ({ season: dp.season, round: dp.round, fromManager: rosterToManager[dp.roster_id] || null }));
        let faabIn = 0, faabOut = 0;
        for (const wb of tx.waiver_budget || []) { if (wb.receiver === rid) faabIn += wb.amount || 0; if (wb.sender === rid) faabOut += wb.amount || 0; }
        const playersOut = [];
        for (const [pid, fromR] of Object.entries(tx.drops || {})) if (fromR === rid) playersOut.push(pid);
        const picksOut = (tx.draft_picks || []).filter((dp) => dp.previous_owner_id === rid && dp.owner_id !== rid).map((dp) => ({ season: dp.season, round: dp.round }));
        return { rosterId: rid, managerId: mid, players: playersIn, picks: picksIn, faab: faabIn, playersOut, picksOut, faabOut };
      });
      allTrades.push({ season, week: tx.leg, created: tx.created || tx.status_updated || 0, sides });
      continue;
    }
    const mid = rosterToManager[(tx.roster_ids || [])[0]];
    if (!mid) continue;
    const e = initTx(mid);
    if (tx.type === "waiver" && tx.status === "complete") {
      const bid = tx.settings?.waiver_bid ?? 0;
      e.faabSpent += bid; e.waiverClaims++; e.biggestBid = Math.max(e.biggestBid, bid);
      for (const pid of Object.keys(tx.adds || {})) {
        referencedPlayers.add(pid);
        allWaiverAdds.push({ season, managerId: mid, playerId: pid, faab: bid, week: tx.leg });
      }
    } else if (tx.type === "free_agent") {
      e.faAdds++;
      for (const pid of Object.keys(tx.adds || {})) { referencedPlayers.add(pid); faEvents.push({ managerId: mid, playerId: pid, season, week: tx.leg }); }
    }
  }

  // strip heavy allWeekPoints from standings before output (only needed during compute)
  const standingsOut = standings.map(({ allWeekPoints, ...r }) => r);

  seasonsOut[season] = {
    season, leagueId: league.league_id, name: league.name, status: league.status,
    weeksPlayed: regWeeks.length, isComplete,
    regSeasonWeeks: REG_WEEKS,
    standings: standingsOut, power, playoffs, champion, runnerUp,
    pointsKing: pointsKing ? { managerId: pointsKing.managerId, teamName: pointsKing.teamName, pf: pointsKing.pf } : null,
    draftType: drafts[0]?.type || null, auctionBudget: drafts[0]?.settings?.budget || null,
    draftBoard, transactions: { total: txAll.length, trades: tradeCount },
    rosterPositions: league.roster_positions,
  };
}

// ---- All-time aggregates ----
const allTime = {};
for (const season of SEASONS) {
  const so = seasonsOut[season];
  for (const row of so.standings) {
    const m = (allTime[row.managerId] ||= {
      managerId: row.managerId, seasons: 0, w: 0, l: 0, t: 0, pf: 0, pa: 0,
      allPlayW: 0, allPlayL: 0, allPlayT: 0, optimal: 0, optimalDenomPf: 0, vp: 0,
      titles: 0, runnerUps: 0, finalsApps: 0, playoffApps: 0, pointsTitles: 0, lastPlace: 0,
      perfectWeeks: 0, bestSeasonVP: 0,
      bestSeed: 99, finishes: {}, playoffResults: {}, luck: 0,
    });
    if (!so.isComplete) continue;
    m.seasons++;
    m.w += row.w; m.l += row.l; m.t += row.t; m.pf += row.pf; m.pa += row.pa; m.vp += row.vp;
    m.perfectWeeks += row.perfectWeeks; m.bestSeasonVP = Math.max(m.bestSeasonVP, row.vp);
    m.allPlayW += row.allPlayW; m.allPlayL += row.allPlayL; m.allPlayT += row.allPlayT;
    m.optimal += row.optimal; m.optimalDenomPf += row.pf; m.luck += row.luck;
    m.bestSeed = Math.min(m.bestSeed, row.seed);
    m.finishes[season] = row.seed;
    if (row.seed <= 6) m.playoffApps++;
    if (row.seed === so.standings.length) m.lastPlace++;
  }
  if (so.isComplete && so.playoffs) {
    for (const f of so.playoffs.finals) { if (allTime[f.managerId]) allTime[f.managerId].finalsApps++; }
    if (so.champion && allTime[so.champion.managerId]) { allTime[so.champion.managerId].titles++; allTime[so.champion.managerId].playoffResults[season] = "champion"; }
    if (so.runnerUp && allTime[so.runnerUp.managerId]) { allTime[so.runnerUp.managerId].runnerUps++; allTime[so.runnerUp.managerId].playoffResults[season] = "runner-up"; }
    for (const f of so.playoffs.finals) { const e = allTime[f.managerId]?.playoffResults; if (e && !e[season]) e[season] = "finalist"; }
  }
  const pk = so.pointsKing;
  if (so.isComplete && pk && allTime[pk.managerId]) allTime[pk.managerId].pointsTitles++;
}

const managerList = Object.values(managers).map((m) => {
  const at = allTime[m.id] || {};
  const g = (at.w || 0) + (at.l || 0) + (at.t || 0);
  const apg = (at.allPlayW || 0) + (at.allPlayL || 0) + (at.allPlayT || 0);
  const tx = txByManager[m.id] || {};
  return {
    id: m.id, name: m.name, displayName: m.displayName, avatar: m.avatar,
    seasonsPlayed: [...m.seasonsPlayed].sort(), teamNamesBySeason: m.teamNamesBySeason,
    allTime: {
      seasons: at.seasons || 0, w: at.w || 0, l: at.l || 0, t: at.t || 0,
      winPct: round((at.w + 0.5 * (at.t || 0)) / (g || 1), 4),
      pf: round(at.pf || 0), pa: round(at.pa || 0), vp: at.vp || 0,
      allPlayPct: round((at.allPlayW + 0.5 * at.allPlayT) / (apg || 1), 4),
      efficiency: at.optimal ? round((at.optimalDenomPf / at.optimal) * 100, 1) : null,
      titles: at.titles || 0, runnerUps: at.runnerUps || 0, finalsApps: at.finalsApps || 0,
      playoffApps: at.playoffApps || 0, pointsTitles: at.pointsTitles || 0, lastPlace: at.lastPlace || 0,
      perfectWeeks: at.perfectWeeks || 0, bestSeasonVP: at.bestSeasonVP || 0,
      vpPerSeason: at.seasons ? round(at.vp / at.seasons, 1) : 0,
      bestSeed: at.bestSeed === 99 ? null : at.bestSeed,
      bestFinish: at.bestSeed === 99 ? null : at.bestSeed,
      finishes: at.finishes || {}, playoffResults: at.playoffResults || {}, luck: round(at.luck || 0, 2),
      faabSpent: tx.faabSpent || 0, waiverClaims: tx.waiverClaims || 0, faAdds: tx.faAdds || 0, biggestBid: tx.biggestBid || 0, trades: tx.trades || 0,
    },
  };
});

// ---- Record book (regular season) ----
const sortedWeekly = [...allTimeWeekly].sort((a, b) => b.points - a.points);
const games = [];
for (const season of SEASONS)
  for (const row of seasonsOut[season].standings)
    for (const w of row.weekly)
      if (w.oppPoints != null) games.push({ season, week: w.week, managerId: row.managerId, teamName: row.teamName, points: w.points, oppPoints: w.oppPoints, margin: round(w.points - w.oppPoints), result: w.result });
const decisive = games.filter((g) => g.result === "W");
const records = {
  topWeeks: sortedWeekly.slice(0, 15),
  worstWeeks: [...allTimeWeekly].sort((a, b) => a.points - b.points).slice(0, 10),
  biggestBlowouts: [...decisive].sort((a, b) => b.margin - a.margin).slice(0, 10),
  closestGames: [...decisive].sort((a, b) => a.margin - b.margin).slice(0, 10),
  highestScoringLoss: [...games].filter((g) => g.result === "L").sort((a, b) => b.points - a.points).slice(0, 8),
  lowestScoringWin: [...games].filter((g) => g.result === "W").sort((a, b) => a.points - b.points).slice(0, 8),
};

// ---- Victory Points records ----
const completedForVP = SEASONS.filter((s) => seasonsOut[s].isComplete);
const teamSeasons = [];
for (const s of completedForVP)
  for (const row of seasonsOut[s].standings)
    teamSeasons.push({ season: s, managerId: row.managerId, teamName: row.teamName, vp: row.vp, vpH2H: row.vpH2H, vpScore: row.vpScore, perfectWeeks: row.perfectWeeks, seed: row.seed, w: row.w, l: row.l });
const vpRecords = {
  topSeasonVP: [...teamSeasons].sort((a, b) => b.vp - a.vp).slice(0, 8),
  worstSeasonVP: [...teamSeasons].sort((a, b) => a.vp - b.vp).slice(0, 5),
  mostPerfectWeeks: [...teamSeasons].sort((a, b) => b.perfectWeeks - a.perfectWeeks).slice(0, 8),
  mostScoringVP: [...teamSeasons].sort((a, b) => b.vpScore - a.vpScore).slice(0, 5),
};

// ---- Head-to-head ----
const h2hList = Object.values(h2h).map((r) => ({ a: r.a, b: r.b, aWins: r.aw, bWins: r.bw, ties: r.t, aPf: round(r.apf), bPf: round(r.bpf), games: r.aw + r.bw + r.t }));

// ---- Draft value ----
const playerTotalPoints = {};
for (const season of SEASONS) for (const [pid, pts] of Object.entries(playerSeasonPoints[season] || {})) playerTotalPoints[pid] = round((playerTotalPoints[pid] || 0) + pts);
const playedSeasons = SEASONS.filter((s) => seasonsOut[s].isComplete);
// Rookie-draft steals/busts only (snake/linear). The auction is analyzed separately by $.
const rookieSeasons = playedSeasons.filter((s) => seasonsOut[s].draftType !== "auction");
const draftSteals = [];
for (const season of rookieSeasons)
  for (const p of seasonsOut[season].draftBoard)
    draftSteals.push({ season, ...p, careerPoints: round(playerTotalPoints[p.playerId] || 0), firstYearPoints: round(playerSeasonPoints[season]?.[p.playerId] || 0) });
const draftAnalysis = {
  steals: [...draftSteals].filter((d) => d.pickNo > 12).sort((a, b) => b.careerPoints - a.careerPoints).slice(0, 9),
  busts: [...draftSteals].filter((d) => d.pickNo <= 18 && d.careerPoints < 60).sort((a, b) => a.pickNo - b.pickNo).slice(0, 9),
  bestByYear: rookieSeasons.reduce((acc, s) => { acc[s] = draftSteals.filter((d) => d.season === s).sort((a, b) => b.careerPoints - a.careerPoints).slice(0, 3); return acc; }, {}),
};

// ---- FAAB / waiver records ----
for (const wa of allWaiverAdds) {
  wa.name = players[wa.playerId]?.name || wa.playerId;
  wa.pos = players[wa.playerId]?.pos || null;
  wa.seasonPoints = round(playerSeasonPoints[wa.season]?.[wa.playerId] || 0);
}
const faabRecords = {
  bestPickups: [...allWaiverAdds].sort((a, b) => b.seasonPoints - a.seasonPoints).slice(0, 12),
  biggestBids: [...allWaiverAdds].filter((w) => w.faab > 0).sort((a, b) => b.faab - a.faab).slice(0, 10),
  bestValues: [...allWaiverAdds].filter((w) => w.faab >= 1 && w.seasonPoints >= 60).map((w) => ({ ...w, perDollar: round(w.seasonPoints / w.faab, 1) })).sort((a, b) => b.perDollar - a.perDollar).slice(0, 10),
  totalFaab: allWaiverAdds.reduce((a, w) => a + w.faab, 0),
  totalClaims: allWaiverAdds.length,
};

// ---- Trades ----
for (const t of allTrades) {
  t.date = t.created ? new Date(t.created).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : null;
  for (const s of t.sides) {
    s.playerNames = s.players.map((pid) => ({ id: pid, name: players[pid]?.name || pid, pos: players[pid]?.pos || null, value: PV[pid]?.value || 0 }));
    s.valueToday = s.players.reduce((a, pid) => a + (PV[pid]?.value || 0), 0);
  }
}
const trades = [...allTrades].sort((a, b) => (b.created || 0) - (a.created || 0));

// ---- Trade analytics (partners, journeys, blockbusters, buyers/sellers, timing) ----
const tIdx = (s) => SEASONS.indexOf(s);
const tradePartnerCount = {};
const playerTradeCount = {};
const mgrTradeAgg = {};
const tradesByWeek = {};
allTrades.forEach((t, idx) => {
  tradesByWeek[t.week] = (tradesByWeek[t.week] || 0) + 1;
  const mids = t.sides.map((s) => s.managerId).filter(Boolean);
  for (let i = 0; i < mids.length; i++)
    for (let j = i + 1; j < mids.length; j++) {
      const k = pairKey(mids[i], mids[j]);
      tradePartnerCount[k] = (tradePartnerCount[k] || 0) + 1;
    }
  for (const s of t.sides) {
    if (!s.managerId) continue;
    const m = (mgrTradeAgg[s.managerId] ||= { trades: 0, playersIn: 0, playersOut: 0, picksIn: 0, picksOut: 0, faabIn: 0, faabOut: 0, deadline: 0 });
    m.trades++;
    m.playersIn += s.players.length; m.playersOut += s.playersOut.length;
    m.picksIn += s.picks.length; m.picksOut += s.picksOut.length;
    m.faabIn += s.faab; m.faabOut += s.faabOut;
    if (t.week >= 11) m.deadline++;
    for (const pid of s.players) { const e = (playerTradeCount[pid] ||= { count: 0, idxs: [] }); e.count++; e.idxs.push(idx); }
  }
});
const sortKey = (x) => `${x.season}-${String(x.week).padStart(2, "0")}`;
const mostTraded = Object.entries(playerTradeCount)
  .filter(([, e]) => e.count >= 2)
  .map(([pid, e]) => ({
    playerId: pid, name: players[pid]?.name || pid, pos: players[pid]?.pos || null, count: e.count,
    journey: e.idxs.map((i) => {
      const t = allTrades[i];
      return { season: t.season, week: t.week, date: t.date, from: t.sides.find((s) => s.playersOut.includes(pid))?.managerId || null, to: t.sides.find((s) => s.players.includes(pid))?.managerId || null };
    }).sort((a, b) => sortKey(a).localeCompare(sortKey(b))),
  }))
  .sort((a, b) => b.count - a.count)
  .slice(0, 10);
const blockbusters = [...allTrades]
  .map((t) => ({ trade: t, assets: t.sides.reduce((a, s) => a + s.players.length + s.picks.length, 0) + (t.sides.some((s) => s.faab > 0) ? 1 : 0) }))
  .sort((a, b) => b.assets - a.assets)
  .slice(0, 6);
const tradeAnalytics = {
  partners: Object.entries(tradePartnerCount).map(([k, c]) => { const [a, b] = k.split("|"); return { a, b, count: c }; }).sort((x, y) => y.count - x.count),
  mostTraded, blockbusters, byWeek: tradesByWeek, byManager: mgrTradeAgg,
};

// ---- Roster acquisition source (current rosters) ----
const acqEvents = [];
for (const s of SEASONS) for (const p of seasonsOut[s].draftBoard) if (p.managerId) acqEvents.push({ mid: p.managerId, pid: p.playerId, source: seasonsOut[s].draftType === "auction" ? "auction" : "draft", t: tIdx(s) * 100 });
for (const w of allWaiverAdds) if (w.managerId) acqEvents.push({ mid: w.managerId, pid: w.playerId, source: "waiver", t: tIdx(w.season) * 100 + (w.week || 0) });
for (const f of faEvents) if (f.managerId) acqEvents.push({ mid: f.managerId, pid: f.playerId, source: "free agent", t: tIdx(f.season) * 100 + (f.week || 0) });
for (const t of allTrades) for (const sd of t.sides) if (sd.managerId) for (const pid of sd.players) acqEvents.push({ mid: sd.managerId, pid, source: "trade", t: tIdx(t.season) * 100 + (t.week || 0) });
const acqMap = {};
for (const e of acqEvents) { const k = e.mid + "|" + e.pid; if (!acqMap[k] || e.t >= acqMap[k].t) acqMap[k] = e; }
const acquisition = {};
for (const [mid, pids] of Object.entries(currentRosters)) {
  const breakdown = {}, list = [];
  for (const pid of pids) {
    const src = acqMap[mid + "|" + pid]?.source || "kept";
    breakdown[src] = (breakdown[src] || 0) + 1;
    list.push({ id: pid, name: players[pid]?.name || pid, pos: players[pid]?.pos || null, source: src });
  }
  acquisition[mid] = { breakdown, players: list };
}

// ---- Dynasty roster values (FantasyCalc, today) ----
let dynasty = null;
if (valueData && Object.keys(currentRosters).length) {
  const teams = Object.entries(currentRosters).map(([mid, pids]) => {
    const valued = pids.map((pid) => ({ id: pid, name: PV[pid]?.name || players[pid]?.name || pid, pos: PV[pid]?.position || players[pid]?.pos || null, value: PV[pid]?.value || 0, age: PV[pid]?.age ?? null, trend30: PV[pid]?.trend30 || 0 })).sort((a, b) => b.value - a.value);
    const total = valued.reduce((a, p) => a + p.value, 0);
    const vSum = total || 1;
    const wAge = valued.reduce((a, p) => a + (p.age || 0) * (p.value || 0), 0) / vSum;
    return { managerId: mid, totalValue: total, avgAge: round(wAge, 1), qbValue: valued.filter((p) => p.pos === "QB").reduce((a, p) => a + p.value, 0), topPlayers: valued.slice(0, 6), players: valued };
  }).sort((a, b) => b.totalValue - a.totalValue).map((t, i) => ({ ...t, rank: i + 1 }));
  const allValued = [];
  for (const t of teams) for (const p of t.players) if (p.value) allValued.push({ ...p, managerId: t.managerId });
  dynasty = {
    date: valueData.date, source: valueData.source, teams,
    risers: [...allValued].sort((a, b) => b.trend30 - a.trend30).slice(0, 8),
    fallers: [...allValued].sort((a, b) => a.trend30 - b.trend30).slice(0, 8),
    topAssets: [...allValued].sort((a, b) => b.value - a.value).slice(0, 12),
  };
}

// ---- Auction (startup) records ----
let auctionRecords = null;
const auctionSeason = SEASONS.find((s) => seasonsOut[s].draftType === "auction");
if (auctionSeason) {
  const board = seasonsOut[auctionSeason].draftBoard.map((p) => ({ season: auctionSeason, managerId: p.managerId, playerId: p.playerId, name: p.name, pos: p.pos, team: p.team, amount: p.amount || 0, careerPoints: round(playerTotalPoints[p.playerId] || 0) }));
  auctionRecords = {
    season: auctionSeason,
    budget: seasonsOut[auctionSeason].auctionBudget,
    biggestBuys: [...board].sort((a, b) => b.amount - a.amount).slice(0, 12),
    bestValues: [...board].filter((p) => p.amount >= 1).map((p) => ({ ...p, perDollar: round(p.careerPoints / p.amount, 1) })).sort((a, b) => b.perDollar - a.perDollar).slice(0, 10),
    biggestBusts: [...board].filter((p) => p.amount >= 15).sort((a, b) => a.careerPoints - b.careerPoints).slice(0, 8),
  };
}

// ---- Best individual player seasons ----
const playerSeasonsFlat = [];
for (const season of SEASONS) for (const [pid, pts] of Object.entries(playerSeasonPoints[season] || {})) if (pts > 150) { referencedPlayers.add(pid); playerSeasonsFlat.push({ season, playerId: pid, points: round(pts) }); }
const topPlayerSeasons = playerSeasonsFlat.sort((a, b) => b.points - a.points).slice(0, 20);

const playersOut = {};
for (const id of referencedPlayers) if (players[id]) playersOut[id] = players[id];

// ---- The Awards Show (per-season superlatives) ----
const awards = {};
for (const s of SEASONS.filter((x) => seasonsOut[x].isComplete)) {
  const so = seasonsOut[s];
  const st = so.standings;
  const byLuck = [...st].sort((a, b) => b.luck - a.luck);
  const byEffLow = [...st].sort((a, b) => a.efficiency - b.efficiency);
  const highWeek = st.map((r) => ({ managerId: r.managerId, teamName: r.teamName, pts: r.highWeek?.pts || 0, week: r.highWeek?.week })).sort((a, b) => b.pts - a.pts)[0];
  const splurge = allWaiverAdds.filter((w) => w.season === s).sort((a, b) => b.faab - a.faab)[0];
  const seasonTrades = allTrades.filter((t) => t.season === s).map((t) => ({ t, assets: t.sides.reduce((a, sd) => a + sd.players.length + sd.picks.length, 0) })).sort((a, b) => b.assets - a.assets);
  const tradeCounts = {};
  allTrades.filter((t) => t.season === s).forEach((t) => t.sides.forEach((sd) => { if (sd.managerId) tradeCounts[sd.managerId] = (tradeCounts[sd.managerId] || 0) + 1; }));
  const wheeler = Object.entries(tradeCounts).sort((a, b) => b[1] - a[1])[0];
  const heist = so.draftType === "auction" ? auctionRecords?.bestValues?.[0] : draftAnalysis.bestByYear?.[s]?.[0];
  awards[s] = {
    champion: so.champion, runnerUp: so.runnerUp, pointsKing: so.pointsKing,
    choker: st.find((r) => r.managerId !== so.champion?.managerId) || null,
    luckiest: byLuck[0], snakebit: byLuck[byLuck.length - 1],
    benchWarmer: byEffLow[0], lvp: st[st.length - 1], highWeek,
    faabSplurge: splurge ? { managerId: splurge.managerId, name: splurge.name, pos: splurge.pos, faab: splurge.faab } : null,
    tradeOfYear: seasonTrades[0] ? { ...seasonTrades[0].t, assets: seasonTrades[0].assets } : null,
    wheeler: wheeler ? { managerId: wheeler[0], trades: wheeler[1] } : null,
    heist: heist ? { name: heist.name, pos: heist.pos, managerId: heist.managerId, value: heist.amount ? `$${heist.amount}` : null, careerPoints: heist.careerPoints } : null,
  };
}

const league = {
  meta: {
    name: manifest.fetchedSeasons[0].name,
    currentSeason: state.season,
    seasonOrder: SEASONS,
    completedSeasons: SEASONS.filter((s) => seasonsOut[s].isComplete),
    upcomingSeason: SEASONS.find((s) => !seasonsOut[s].isComplete) || null,
    nflState: { season: state.season, week: state.week, type: state.season_type },
    teamCount: 12,
    format: {
      regWeeks: REG_WEEKS, playInWeek: PLAYIN_WEEK, finalsWeeks: FINALS_WEEKS,
      vp: "Each week: +2 for the head-to-head win, plus a scoring bonus (top-4 = +2, middle-4 = +1, bottom-4 = 0). Max 4 VP/week.",
    },
    note: "Standings & seeding use Victory Points over a 14-week regular season. Playoffs: top-2 seeds bye, seeds 3-6 play a Week-15 score shootout (top 2 advance), then a 2-week cumulative-score final crowns the champion.",
  },
  managers: managerList,
  seasons: seasonsOut,
  allTime: { standings: managerList.filter((m) => m.allTime.seasons > 0).sort((a, b) => b.allTime.titles - a.allTime.titles || b.allTime.winPct - a.allTime.winPct || b.allTime.pf - a.allTime.pf) },
  headToHead: h2hList, records, vpRecords, faabRecords, auctionRecords, trades, tradeAnalytics, acquisition, dynasty, awards, draft: draftAnalysis, topPlayerSeasons,
};

writeFileSync(join(OUT, "league.json"), JSON.stringify(league));
writeFileSync(join(OUT, "players.json"), JSON.stringify(playersOut));

console.log(`Wrote src/data/league.json (VP + playoffs model)`);
for (const s of SEASONS) {
  const o = seasonsOut[s];
  if (o.champion) console.log(`  ${s}: 🏆 ${o.champion.teamName} (finals ${o.champion.total}, was #${o.champion.seed} seed) | reg-season VP leader: ${o.standings[0].teamName} (${o.standings[0].vp} VP)`);
  else console.log(`  ${s}: ${o.status} — upcoming`);
}
