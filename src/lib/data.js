// Central data access for the site. All pages import from here.
// Data is computed at build time by scripts/compute.mjs.
//
// league.json shape (high level):
//   meta:        { name, currentSeason, seasonOrder[], completedSeasons[], upcomingSeason, nflState, note }
//   managers[]:  { id, name, displayName, avatar, seasonsPlayed[], teamNamesBySeason{},
//                  allTime:{ seasons,w,l,t,winPct,pf,pa,vp,allPlayPct,efficiency,titles,runnerUps,finalsApps,
//                            playoffApps,pointsTitles,lastPlace,bestSeed,bestFinish,finishes{season:seed},
//                            playoffResults{season:'champion'|'runner-up'|'finalist'},luck } }
//   seasons{}:   season -> { season, name, status, isComplete, weeksPlayed, regSeasonWeeks,
//                  standings[]:{ seed,rosterId,managerId,teamName, vp,vpH2H,vpScore, w,l,t,pf,pa,ppg,optimal,efficiency,
//                                pointsLeftOnBench,allPlayW,allPlayL,allPlayT,allPlayPct,expectedWins,luck,consistency,
//                                ceiling,floor,highWeek,lowWeek,bestWinStreak,worstLossStreak,currentStreak,
//                                weekly[]:{week,points,optimal,scoreVP,oppPoints,result,h2hVP,vp} },  // weekly = reg season (wks 1-14)
//                  power[], playoffs:{byes[],playin[],finals[],playInWeek,finalsWeeks}, champion, runnerUp, pointsKing, draftBoard[], transactions }
//   champion/runnerUp: { seed, managerId, teamName, vp, pf, wk{16,17}, total, place }
//   allTime:     { standings[] (managers sorted) }
//   headToHead[]: { a,b,aWins,bWins,ties,aPf,bPf,games }   (a,b are managerIds, a<b)
//   records:     { topWeeks[],worstWeeks[],biggestBlowouts[],closestGames[],highestScoringLoss[],lowestScoringWin[] }
//   draft:       { steals[],busts[],bestByYear{} }
//   topPlayerSeasons[]: { season, playerId, points }

import league from "../data/league.json";
import players from "../data/players.json";
import chatStatsData from "../data/chat-stats.json";

export const chatStats = chatStatsData;

export const meta = league.meta;
export const managers = league.managers;
export const seasons = league.seasons;
export const seasonOrder = league.meta.seasonOrder;
export const completedSeasons = league.meta.completedSeasons;
export const allTimeStandings = league.allTime.standings;
export const headToHead = league.headToHead;
export const records = league.records;
export const vpRecords = league.vpRecords;
export const faabRecords = league.faabRecords;
export const auctionRecords = league.auctionRecords;
export const trades = league.trades;
export const tradeAnalytics = league.tradeAnalytics;
export const acquisition = league.acquisition;
export const dynasty = league.dynasty;
export const awards = league.awards;
export const draft = league.draft;
export const topPlayerSeasons = league.topPlayerSeasons;

const byId = Object.fromEntries(managers.map((m) => [m.id, m]));
export const getManager = (id) => byId[id] || null;
export const managerName = (id) => byId[id]?.name || "Unknown";
export const managerAvatar = (id) => byId[id]?.avatar || null;

// ---- league commissioners (single source of truth) ----
// Big Monkey (@alleniverson) + OceanGate Titans (@OldManHawk)
export const commissionerIds = ["470083698897711104", "470070299694460928"];
export const isCommissioner = (id) => commissionerIds.includes(id);

export const player = (id) => players[id] || { id, name: id, pos: null, team: null };

// ---- stable per-manager color (for charts / bump lines / accents) ----
const PALETTE = [
  "#2ee6a6", "#54a6ff", "#ffcf4a", "#ff5d6c", "#a98bff", "#ff9f45",
  "#4dd9c0", "#f777b0", "#7ee081", "#5fb0ff", "#ffd479", "#c0a0ff",
];
const colorIndex = {};
managers
  .slice()
  .sort((a, b) => a.id.localeCompare(b.id))
  .forEach((m, i) => (colorIndex[m.id] = PALETTE[i % PALETTE.length]));
export const managerColor = (id) => colorIndex[id] || "#8c99b8";

// ---- avatars (Sleeper CDN) ----
export const avatarUrl = (avatar, thumb = true) =>
  avatar
    ? `https://sleepercdn.com/avatars/${thumb ? "thumbs/" : ""}${avatar}`
    : null;

// ---- formatting ----
export const fmt = (n, d = 0) =>
  n == null ? "—" : Number(n).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });
export const pct = (n, d = 1) => (n == null ? "—" : (n * 100).toFixed(d) + "%");
export const signed = (n, d = 1) => (n == null ? "—" : (n > 0 ? "+" : "") + Number(n).toFixed(d));
export const ordinal = (n) => {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
};
export const record = (w, l, t) => `${w}-${l}${t ? "-" + t : ""}`;

// convenience
export const latestCompleted = completedSeasons[completedSeasons.length - 1];
export const isUpcoming = (s) => !seasons[s]?.isComplete;
