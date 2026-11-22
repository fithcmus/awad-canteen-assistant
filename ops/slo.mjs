// The SLO, read from the gateway log, and a burn-rate alert.
// SLO for the demo: 99% of plan requests get a 2xx in under 10 s. The error budget is the other 1%.
// Burn rate = (share of bad requests in a window) / 1%. A burn rate of 1 spends the budget exactly on time.
// Alert: burn rate >= 10 over the last 60 s AND over the last 10 s (a long window so one blip does not page,
// a short one so it stops paging soon after recovery). In production the windows are 1 h and 5 min; here one
// second of the run stands for one minute.
//   node ops/slo.mjs <dir> [--step 10]
import { readFileSync } from 'node:fs';

const [dir, , stepArg] = process.argv.slice(2);
const STEP = Number(stepArg || 10) * 1000, LONG = 60_000, SHORT = 10_000, TARGET = 0.99, LIMIT_MS = 10_000, FIRE = 10;
const g = readFileSync(`${dir}/gateway.log.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((x) => x.route === 'POST /api/plan' && x.status !== 429).map((x) => ({ t: Date.parse(x.t), bad: !(x.status < 300 && x.ms < LIMIT_MS) }));
const t0 = g[0].t, tEnd = g.at(-1).t;
const burn = (from, to) => { const w = g.filter((x) => x.t > from && x.t <= to); return w.length ? w.filter((x) => x.bad).length / w.length / (1 - TARGET) : 0; };
let firing = false;
console.log('time    requests  bad   burn 60s  burn 10s  alert');
for (let t = t0 + STEP; t <= tEnd + STEP; t += STEP) {
  const w = g.filter((x) => x.t > t - STEP && x.t <= t);
  const bl = burn(t - LONG, t), bs = burn(t - SHORT, t);
  const now = bl >= FIRE && bs >= FIRE;
  const mark = now && !firing ? 'FIRING' : !now && firing ? 'resolved' : now ? 'firing' : '';
  firing = now;
  console.log(`T+${String(Math.round((t - t0) / 1000)).padStart(3)}s  ${String(w.length).padStart(6)}  ${String(w.filter((x) => x.bad).length).padStart(4)}  ${bl.toFixed(1).padStart(8)}  ${bs.toFixed(1).padStart(8)}  ${mark}`);
}
const bad = g.filter((x) => x.bad).length;
console.log(`budget for this run: 1% of ${g.length} = ${Math.floor(g.length * (1 - TARGET))} bad requests; spent ${bad}`);
