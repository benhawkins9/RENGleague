# Regular Everday Normal Guys — League Hub

A data-rich static website for the **Regular Everday Normal Guys** Sleeper dynasty league
(12-team Superflex, 0.5 PPR, est. 2023). Pulls four seasons of history straight from the
free Sleeper API and turns it into the stats your group chat actually argues about.

Built with **Astro** → ships as a static site → deploy anywhere (Vercel, Netlify, GitHub Pages).

## How it works

```
Sleeper API ──▶ scripts/fetch-data.mjs ──▶ data/raw/<season>/*.json   (raw dumps, gitignored)
                                  │
                                  ▼
                       scripts/compute.mjs ──▶ src/data/league.json    (all derived metrics)
                                                  src/data/players.json
                                  │
                                  ▼
                          Astro build ──▶ dist/   (static HTML/CSS/JS)
```

- **fetch-data.mjs** walks the league's `previous_league_id` chain back to the first season,
  pulling every league/roster/matchup/draft/transaction. No API key needed — Sleeper's read API is public.
- **compute.mjs** turns raw scores into standings, all-play records, the luck index (expected
  vs. actual wins), lineup efficiency (vs. optimal lineup), power rankings, head-to-head grids,
  the record book, draft steals/busts, champions, and more.

## Commands

```bash
npm install        # one-time
npm run data       # fetch from Sleeper + recompute all metrics
npm run dev        # local dev server (http://localhost:4321)
npm run build      # static production build → dist/
npm run preview    # preview the production build
```

`npm run data` is the only thing you re-run to refresh — do it weekly during the season,
then rebuild/redeploy.

## Pages

| Route | What's there |
|-------|--------------|
| `/` | Hero, champions, league lore, leaderboards |
| `/standings` | Per-season standings + all-play, luck, efficiency, weekly form, power ranking |
| `/records` | Highest/lowest weeks, blowouts, nailbiters, best player seasons ever |
| `/head-to-head` | All-time 12×12 rivalry matrix + fiercest/most-lopsided |
| `/draft` | Every board (incl. the 2026 rookie draft) + biggest steals & busts |
| `/managers` + `/managers/[id]` | Career profiles: stats, finishes, rivalries, draft legacy |
| `/hall` | Champions, dynasty-trajectory bump chart, all-time leaderboard |
| `/labs` | Schedule-swap what-if machine, bench hall of shame, coin-flip luck, boom/bust |

## The Victory Points format

This league doesn't use Sleeper's built-in playoffs — it runs a custom **Victory Points** system,
reconstructed in `scripts/compute.mjs`:

- **Regular season (weeks 1–14):** each week a team earns VP = `+2` for the head-to-head win,
  plus a scoring bonus (`top-4 = +2`, `middle-4 = +1`, `bottom-4 = 0`). Max 4 VP/week.
- **Seeding:** VP total (PF tiebreak) sets the top-6 playoff seeds.
- **Playoffs:** seeds 1–2 bye → seeds 3–6 play a **Week-15 score shootout** (top 2 advance) →
  **Weeks 16–17 are a 2-week final**; highest cumulative score is champion.
- The reconstruction is validated to the decimal against the league's own spreadsheets — run
  `node scripts/validate-vp.mjs` to re-check. Format constants live at the top of `compute.mjs`
  (`REG_WEEKS`, `PLAYIN_WEEK`, `FINALS_WEEKS`); adjust there if the format ever changes.

To point this at a different league, change `CURRENT_LEAGUE_ID` in `scripts/fetch-data.mjs`
and re-run `npm run data`.

## Deploy to Vercel

```bash
npm i -g vercel && vercel        # framework auto-detected as Astro
```
For automatic in-season refreshes, add a weekly Vercel Cron (or GitHub Action) that runs
`npm run data` and triggers a redeploy.
