// Load generator: what the users see. Sends plan requests at a steady rate and records each one from the client side.
//   node ops/load.mjs --n 600 --rate 10 --users 20 [--timeout 10000] [--hammer u-script:8] [--poll] [--out dir] [--gateway url]
import http from 'node:http';
import { appendFileSync, readFileSync } from 'node:fs';
import { pct, sleep } from './common.mjs';

const argv = process.argv.slice(2);
const a = {};
for (let i = 0; i < argv.length; i++) if (argv[i].startsWith('--')) a[argv[i].slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
const N = Number(a.n || 300), RATE = Number(a.rate || 10), USERS = Number(a.users || 20), TIMEOUT = Number(a.timeout || 60000);
const GW = a.gateway || 'http://127.0.0.1:4100', OUT = a.out || process.env.OPS_OUT || './out';
const [hUser, hRate] = a.hammer ? String(a.hammer).split(':') : [null, 0];
const base = readFileSync(new URL('./requests.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const agent = new http.Agent({ keepAlive: true, maxSockets: 1024 });
const res = [];

function getJob(id) {
  return new Promise((ok) => http.get(`${GW}/api/jobs/${id}`, { agent }, (x) => { let s = ''; x.on('data', (d) => (s += d)); x.on('end', () => ok(JSON.parse(s))); }).on('error', () => ok({ status: 'error' })));
}

function one(i, user) {
  const request = { ...base[i % base.length], id: `q${i}` };
  const data = JSON.stringify({ request });
  const t = Date.now();
  return new Promise((resolve) => {
    const req = http.request(`${GW}/api/plan`, { method: 'POST', agent, headers: { 'content-type': 'application/json', 'x-user': user, 'content-length': Buffer.byteLength(data) } }, (r) => {
      let b = ''; r.on('data', (d) => (b += d));
      r.on('end', async () => {
        let body = null; try { body = JSON.parse(b); } catch {}
        let status = r.statusCode;
        if (status === 202 && a.poll) { // queued: poll the job until it is done
          for (;;) {
            await sleep(250);
            const j = await getJob(body.job);
            if (j.status === 'done' || j.status === 'failed') { status = j.status === 'done' ? 200 : 502; body = j.result; break; }
            if (Date.now() - t > TIMEOUT) { status = 'gave up'; break; }
          }
        }
        resolve({ i, user, status, ms: Date.now() - t, version: r.headers['x-version'] || body?.version, trace: r.headers['x-trace-id'], retryAfter: r.headers['retry-after'] });
      });
    });
    req.setTimeout(TIMEOUT, () => { req.destroy(); resolve({ i, user, status: 'gave up', ms: Date.now() - t }); });
    req.on('error', () => resolve({ i, user, status: 'gave up', ms: Date.now() - t }));
    req.end(data);
  });
}

const t0 = Date.now(); const pending = [];
let hammerSent = 0;
const hammer = hUser ? setInterval(() => { pending.push(one(100000 + hammerSent++, hUser).then((r) => res.push(r))); }, 1000 / Number(hRate)) : null;
for (let i = 0; i < N; i++) {
  const due = t0 + (i * 1000) / RATE; const w = due - Date.now(); if (w > 0) await sleep(w);
  pending.push(one(i, `u${(i % USERS) + 1}`).then((r) => res.push(r)));
}
if (hammer) clearInterval(hammer);
await Promise.all(pending);
for (const r of res) appendFileSync(`${OUT}/client.jsonl`, JSON.stringify(r) + '\n');
const groups = hUser ? [['everyone else', res.filter((r) => r.user !== hUser)], [hUser, res.filter((r) => r.user === hUser)]] : [['all users', res]];
const s = (v) => (v / 1000).toFixed(1) + ' s';
for (const [name, rs] of groups) {
  const ok = rs.filter((r) => r.status === 200), by = {};
  for (const r of rs) by[r.status] = (by[r.status] || 0) + 1;
  const ms = ok.map((r) => r.ms).sort((x, y) => x - y);
  console.log(`CLIENT ${name}: sent=${rs.length} ` + Object.entries(by).map(([k, v]) => `${k}=${v}`).join(' ') +
    (ms.length ? ` | answered p50=${s(pct(ms, 50))} p95=${s(pct(ms, 95))} p99=${s(pct(ms, 99))} max=${s(ms.at(-1))}` : ''));
}
process.exit(0);
