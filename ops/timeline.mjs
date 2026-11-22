// The timeline of a run, from the logs alone: for a post-mortem.
//   node ops/timeline.mjs <dir>   first 429, first failed plan, then every 10 s: plans, failed, model calls, 429s; errors; cost
import { readFileSync } from 'node:fs';

const dir = process.argv[2];
const r = (f) => readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const g = r('gateway.log.jsonl').filter((x) => x.route === 'POST /api/plan');
const p = r('provider.log.jsonl');
const pl = r('planner.log.jsonl');
const t0 = Math.min(...g.map((x) => Date.parse(x.t) - x.ms));
const at = (x) => ((Date.parse(x.t) - t0) / 1000).toFixed(1);
const pad = (v, n) => String(v).padStart(n);

console.log(`start of load ${new Date(t0).toISOString().slice(11, 19)} UTC`);
const f429 = p.find((x) => x.status === 429);
if (f429) console.log(`first 429 from the provider: T+${at(f429)} s`);
const ff = g.filter((x) => x.status >= 500).sort((a, b) => a.t.localeCompare(b.t))[0];
if (ff) console.log(`first failed plan: T+${at(ff)} s`);
for (let s = 0; ; s += 10) {
  const w = (x) => { const d = (Date.parse(x.t) - t0) / 1000; return d >= s && d < s + 10; };
  const gg = g.filter(w), pp = p.filter(w);
  if (!gg.length && !pp.length) break;
  console.log(`T+${pad(s, 2)}–${s + 10} s  plans ${pad(gg.length, 3)}  failed ${pad(gg.filter((x) => x.status >= 500).length, 3)}  model calls ${pad(pp.length, 3)}  429 ${pad(pp.filter((x) => x.status === 429).length, 3)}`);
}
const e = {};
for (const x of pl.filter((x) => x.error)) e[x.error] = (e[x.error] || 0) + 1;
for (const [k, v] of Object.entries(e)) console.log(`planner error × ${v}: ${k}`);
const cost = (xs) => xs.reduce((a, x) => a + x.costUsd, 0).toFixed(2);
console.log(`model cost: $${cost(pl)} in all, $${cost(pl.filter((x) => x.status !== 200))} on plans that failed`);
