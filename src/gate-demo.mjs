// node src/gate-demo.mjs [base]  — walks one group order through the human gate, one line per request.
const base = process.argv[2] || 'http://localhost:3009';
async function call(user, method, path, body) {
  const res = await fetch(base + path, { method, headers: { 'content-type': 'application/json', ...(user ? { authorization: `Bearer ${user}` } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json() };
}
const short = (b) => b.violations?.length && Array.isArray(b.violations) && typeof b.violations[0] === 'string' && b.violations[0].includes(':')
  ? b.violations.join('; ')
  : b.state ? `${b.state}${b.waitingFor?.length && b.state !== 'placed' ? `, waiting for ${b.waitingFor.join(', ')}` : ''}${b.charged ? `, charged ${Object.entries(b.charged).map(([m, c]) => `${m} ${c}`).join(', ')}` : ''}`
  : b.type + (b.detail ? `: ${b.detail}` : '');
const line = (who, what, r) => console.log(`${who.padEnd(3)} ${what.padEnd(26)} → ${r.status} ${short(r.body)}`);

const t0 = Date.now();
const d = await call('u1', 'POST', '/api/drafts', { requestId: 'd01' });
line('u1', 'POST /api/drafts d01', d);
console.log(`    the agent made a draft in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${d.body.items.map((i) => `${i.member}:${i.item}`).join(' ')}`);
const id = d.body.id; const P = `/api/drafts/${id}`;
line('u2', `GET ${P.replace(id, ':id')}`, await call('u2', 'GET', P));
const k = d.body.items.findIndex((i) => i.member === 'u2');            // the creator puts u2 on the 55,000 set
const edited = d.body.items.map((i, n) => (n === k ? { ...i, item: 's3-4' } : i));
line('u1', 'PATCH :id  u2 → s3-4', await call('u1', 'PATCH', P, { items: edited }));
line('u1', 'POST :id/confirm', await call('u1', 'POST', P + '/confirm'));
line('u1', 'PATCH :id  back', await call('u1', 'PATCH', P, { items: d.body.items }));
line('u1', 'POST :id/confirm', await call('u1', 'POST', P + '/confirm'));
line('u7', 'POST :id/accept', await call('u7', 'POST', P + '/accept'));
line('u2', 'POST :id/accept', await call('u2', 'POST', P + '/accept'));
line('u3', 'POST :id/accept', await call('u3', 'POST', P + '/accept'));
line('u3', 'POST :id/accept (again)', await call('u3', 'POST', P + '/accept'));
const w = await call('u3', 'GET', '/api/wallet');
console.log(`u3  GET /api/wallet             → ${w.status} ${w.body.wallet}`);
