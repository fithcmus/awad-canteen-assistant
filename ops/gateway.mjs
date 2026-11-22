// The gateway: the entry point the browser calls. Starts the trace, picks a planner version (canary weight),
// limits each user, caps each user's model spending, and can queue the work instead of holding the request.
//   env: PORT (4100), PLANNERS ("v1=url,v2=url"), CANARY_V2 (share of traffic to v2, 0–1), LOG_AT (finish | close),
//        TRACE (1 | 0), RATE_PER_USER_MIN + BURST (0 = off), COST_CAP_USD (per user, 0 = off), QUEUE (1 = 202 + job), WORKERS
import http from 'node:http';
import { appendFileSync } from 'node:fs';
import { createServer, OUT, TRACE, logger, newTraceId, newSpanId, traceparent, span, readBody, postJson, send } from './common.mjs';

const E = process.env;
const PORT = Number(E.PORT || 4100), CANARY = Number(E.CANARY_V2 || 0), LOG_AT = E.LOG_AT || 'close';
const PLANNERS = Object.fromEntries((E.PLANNERS || 'v1=http://127.0.0.1:4101').split(',').map((p) => p.split('=')));
const RPM = Number(E.RATE_PER_USER_MIN || 0), BURST = Number(E.BURST || 3), CAP = Number(E.COST_CAP_USD || 0);
const QUEUE = E.QUEUE === '1', WORKERS = Number(E.WORKERS || 6);
const log = logger('gateway');
const buckets = new Map(), spent = new Map(), jobs = new Map(), queue = [];
let inflight = 0, jobSeq = 0;

function allow(user) { // token bucket per user
  if (!RPM) return { ok: true };
  const now = Date.now(); const b = buckets.get(user) || { tokens: BURST, at: now };
  b.tokens = Math.min(BURST, b.tokens + ((now - b.at) / 60000) * RPM); b.at = now; buckets.set(user, b);
  if (b.tokens >= 1) { b.tokens -= 1; return { ok: true }; }
  return { ok: false, retryAfter: Math.ceil(((1 - b.tokens) / RPM) * 60) };
}
async function callPlanner(request, user, ctx) {
  const version = PLANNERS.v2 && Math.random() < CANARY ? 'v2' : 'v1';
  const sid = newSpanId();
  inflight++;
  try {
    const r = await postJson(`${PLANNERS[version]}/plan`, { request, user }, { headers: ctx ? { traceparent: traceparent(ctx.traceId, ctx.spanId), 'x-span-id': sid } : {} });
    const cost = Number(r.headers['x-cost-usd'] || 0); spent.set(user, (spent.get(user) || 0) + cost);
    return { ...r, version };
  } catch (e) { return { status: 502, body: { error: 'planner unreachable' }, version }; }
  finally { inflight--; }
}
async function worker() {
  for (;;) {
    const job = queue.shift();
    if (!job) { await new Promise((r) => setTimeout(r, 20)); continue; }
    job.startedAt = Date.now(); job.status = 'running';
    const r = await callPlanner(job.request, job.user, job.ctx);
    Object.assign(job, { status: r.status === 200 ? 'done' : 'failed', result: r.body, version: r.version });
    log({ route: 'job', status: r.status, ms: Date.now() - job.queuedAt, waitedMs: job.startedAt - job.queuedAt, user: job.user, version: r.version, requestId: job.request.id, ...(job.ctx ? { trace: job.ctx.traceId } : {}) });
  }
}
if (QUEUE) {
  for (let i = 0; i < WORKERS; i++) worker();
  setInterval(() => appendFileSync(`${OUT}/gateway.metrics.jsonl`, JSON.stringify({ t: new Date().toISOString(), queueDepth: queue.length, inflight }) + '\n'), 500);
}

createServer(async (req, res) => {
  const start = Date.now();
  if (req.method === 'GET' && req.url.startsWith('/api/jobs/')) {
    const j = jobs.get(req.url.split('/').pop());
    return j ? send(res, 200, { status: j.status, result: j.result, waitedMs: j.startedAt ? j.startedAt - j.queuedAt : null }) : send(res, 404, { error: 'no such job' });
  }
  if (req.method === 'GET' && req.url === '/metrics') return send(res, 200, { queueDepth: queue.length, inflight });
  const user = req.headers['x-user'] || 'anonymous';
  const ctx = TRACE ? { traceId: newTraceId(), spanId: newSpanId() } : null;
  const entry = { route: 'POST /api/plan', user };
  let logged = false;
  const write = (status) => { if (logged) return; logged = true;
    log({ ...entry, status, ms: Date.now() - start, ...(ctx ? { trace: ctx.traceId } : {}) });
    span('gateway', ctx && { traceId: ctx.traceId }, 'POST /api/plan', ctx?.spanId, start, { status, user }); };
  res.on('finish', () => write(res.statusCode));
  if (LOG_AT === 'close') res.on('close', () => { if (!res.writableFinished) write(499); }); // the client went away first
  const { request } = await readBody(req); entry.requestId = request?.id;
  const a = allow(user);
  if (!a.ok) return send(res, 429, { type: 'rate-limit', title: 'Too many plans, slow down' }, { 'retry-after': String(a.retryAfter) });
  if (CAP && (spent.get(user) || 0) >= CAP) return send(res, 429, { type: 'model-budget', title: `Model budget of ${CAP} USD for today is used` });
  if (QUEUE) {
    const id = `j${++jobSeq}`; jobs.set(id, { id, request, user, ctx, queuedAt: Date.now(), status: 'queued' }); queue.push(jobs.get(id));
    return send(res, 202, { job: id, position: queue.length }, { location: `/api/jobs/${id}` });
  }
  const r = await callPlanner(request, user, ctx);
  entry.version = r.version;
  send(res, r.status, r.body, ctx ? { 'x-trace-id': ctx.traceId } : {});
}).listen(PORT, () => console.log(`gateway :${PORT} log_at=${LOG_AT} trace=${TRACE} canary_v2=${CANARY} queue=${QUEUE}`));
