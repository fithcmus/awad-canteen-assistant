// Reads the services' logs and prints what a dashboard would.
//   node ops/report.mjs <dir>                      per service and route: count, errors, avg, p50, p95, p99, max
//   node ops/report.mjs <dir> --avg                only what the first dashboard shows: average and error rate
//   node ops/report.mjs <dir> --by version         the same, split by version
//   node ops/report.mjs <dir> --slowest 3          the slowest requests at the gateway, with their trace ids
//   node ops/report.mjs <dir> --trace <id>         one request through every service, as a tree of spans
//   node ops/report.mjs <dir> --around <iso time>  every service's log lines within ±1 s of a moment
//   node ops/report.mjs <dir> --cost               model cost per plan and per user
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { pct } from './common.mjs';

const [dir, ...rest] = process.argv.slice(2);
const opt = (k) => { const i = rest.indexOf(`--${k}`); return i < 0 ? null : rest[i + 1] ?? true; };
const read = (f) => (existsSync(`${dir}/${f}`) ? readFileSync(`${dir}/${f}`, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const logs = readdirSync(dir).filter((f) => f.endsWith('.log.jsonl')).flatMap((f) => read(f));
const s = (ms) => (ms >= 1000 ? (ms / 1000).toFixed(1) + ' s' : Math.round(ms) + ' ms');
const order = ['gateway', 'planner', 'catalog', 'provider'];

if (opt('trace')) {
  const id = opt('trace');
  const spans = read('spans.jsonl').filter((x) => x.traceId === id).sort((a, b) => a.start - b.start);
  const t0 = spans[0]?.start ?? 0;
  const kids = (p) => spans.filter((x) => x.parentId === p);
  const root = spans.filter((x) => !spans.some((y) => y.spanId === x.parentId));
  console.log(`trace ${id}`);
  const walk = (x, d) => {
    const st = x.status && x.status !== 200 ? ` → ${x.status}` : '';
    console.log(`${'  '.repeat(d)}${`+${s(x.start - t0)}`.padEnd(8)} ${s(x.ms).padStart(7)}  ${x.service} · ${x.name}${x.turn != null ? ` (turn ${x.turn})` : ''}${st}`);
    kids(x.spanId).forEach((k) => walk(k, d + 1));
  };
  root.forEach((r) => walk(r, 0));
} else if (opt('around')) {
  const t = Date.parse(opt('around'));
  const near = logs.filter((x) => Math.abs(Date.parse(x.t) - t) <= Number(opt('window') || 1000)).sort((a, b) => a.t.localeCompare(b.t));
  for (const l of near) console.log(`${l.t.slice(11, 23)} ${l.service.padEnd(8)} ${l.route.padEnd(19)} ${l.status} ${s(l.ms)}`);
  console.log(`${near.length} lines from ${new Set(near.map((l) => l.service)).size} services`);
} else if (opt('slowest')) {
  const g = logs.filter((x) => x.service === 'gateway' && x.route === 'POST /api/plan').sort((a, b) => b.ms - a.ms).slice(0, Number(opt('slowest')));
  for (const l of g) console.log(`${s(l.ms).padStart(7)} ${l.status} ${l.user} ${l.t.slice(11, 19)} trace=${l.trace ?? '(none)'}`);
} else if (opt('cost')) {
  const p = logs.filter((x) => x.service === 'planner');
  const by = {};
  for (const x of p) (by[x.version] ||= []).push(x);
  for (const [v, xs] of Object.entries(by)) {
    const cs = xs.map((x) => x.costUsd).sort((a, b) => a - b); const tc = xs.map((x) => x.toolCalls).sort((a, b) => a - b);
    console.log(`planner ${v}: plans=${xs.length} cost/plan p50=$${pct(cs, 50).toFixed(4)} p99=$${pct(cs, 99).toFixed(4)} total=$${cs.reduce((a, b) => a + b, 0).toFixed(2)} | tool calls p50=${pct(tc, 50)} max=${tc.at(-1)}`);
  }
  const u = {};
  for (const x of p) u[x.user] = (u[x.user] || 0) + x.costUsd;
  const top = Object.entries(u).sort((a, b) => b[1] - a[1]).slice(0, 3);
  console.log('top users: ' + top.map(([k, v]) => `${k} $${v.toFixed(3)}`).join(', '));
  const g = logs.filter((x) => x.service === 'gateway' && x.status === 429);
  if (g.length) console.log(`gateway: ${g.length} requests refused with 429, users: ${[...new Set(g.map((x) => x.user))].join(', ')}`);
} else {
  const avgOnly = opt('avg'); const by = opt('by');
  const groups = {};
  for (const l of logs) {
    if (l.route === 'job') continue;
    const route = l.route.startsWith('/tools/') ? '/tools/*' : l.route;
    const k = `${l.service} ${route}${by && l[by] ? ` ${l[by]}` : ''}`;
    (groups[k] ||= []).push(l);
  }
  const keys = Object.keys(groups).sort((a, b) => order.indexOf(a.split(' ')[0]) - order.indexOf(b.split(' ')[0]) || a.localeCompare(b));
  for (const k of keys) {
    if (opt('only') && !k.startsWith(opt('only'))) continue;
    const xs = groups[k]; const ms = xs.map((x) => x.ms).sort((a, b) => a - b);
    const err = xs.filter((x) => x.status >= 500 || x.status === 499 || (x.status === 429 && !x.route.startsWith('POST'))).length;
    const avg = ms.reduce((a, b) => a + b, 0) / ms.length;
    console.log(`${k.padEnd(by ? 26 : 22)} n=${String(xs.length).padEnd(5)} err=${((100 * err) / xs.length).toFixed(1)}%  avg=${s(avg)}` +
      (avgOnly ? '' : `  p50=${s(pct(ms, 50))}  p95=${s(pct(ms, 95))}  p99=${s(pct(ms, 99))}`));
  }
}
