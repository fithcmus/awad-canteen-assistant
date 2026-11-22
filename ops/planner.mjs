// The planner: the agent loop of sessions 9–10, with the fake model service in place of the real model.
// Same limits (12 tool calls, 90 s), same backend validator (src/validate.mjs), plus a retry policy towards the model.
//   env: PORT, VERSION (v1 | v2: v2 adds a self-check model turn and EXTRA_MS of work), RETRY (none | naive | backoff),
//        ATTEMPT_TIMEOUT_MS (backoff only, default 5000), PROVIDER, CATALOG, PRICE_IN / PRICE_OUT (USD per million tokens)
import http from 'node:http';
import { createServer, logger, readTraceparent, traceparent, span, newSpanId, readBody, postJson, sleep, send } from './common.mjs';
import { validateOrder } from '../src/validate.mjs';

const E = process.env;
const PORT = Number(E.PORT || 4101), VERSION = E.VERSION || 'v1', RETRY = E.RETRY || 'none';
const PROVIDER = E.PROVIDER || 'http://127.0.0.1:4103', CATALOG = E.CATALOG || 'http://127.0.0.1:4102';
const ATTEMPT_TIMEOUT = Number(E.ATTEMPT_TIMEOUT_MS || 5000), EXTRA_MS = Number(E.EXTRA_MS || (VERSION === 'v2' ? 900 : 0));
const PRICE_IN = Number(E.PRICE_IN || 1), PRICE_OUT = Number(E.PRICE_OUT || 5);
const MAX_CALLS = 12, DEADLINE_MS = 90_000;
const log = logger('planner');
let retryTokens = 10; // retry budget: each first attempt earns 0.1 retry, at most 10 saved

async function modelTurn(st, turn) {
  for (let attempt = 1; ; attempt++) {
    st.modelCalls++;
    if (attempt === 1) retryTokens = Math.min(10, retryTokens + 0.1);
    let r, err;
    try {
      r = await postJson(`${PROVIDER}/v1/turn`, { request: st.request, turn, prompt: VERSION },
        { headers: st.ctx ? { traceparent: traceparent(st.ctx.traceId, st.spanId) } : {}, timeoutMs: RETRY === 'backoff' ? ATTEMPT_TIMEOUT : undefined });
    } catch (e) { err = e.code === 'TIMEOUT' ? 'timeout' : 'network'; }
    if (r && r.status === 200) { st.tokensIn += r.body.usage.tokensIn; st.tokensOut += r.body.usage.tokensOut; return r.body; }
    const why = err || `HTTP ${r.status}`;
    const retryable = err || r.status === 429 || r.status >= 500;
    if (RETRY === 'none' || !retryable) throw new Error(`model: ${why}`);
    if (RETRY === 'naive') { if (attempt > 3) throw new Error(`model: ${why} after 3 retries`); st.retries++; continue; }
    // backoff: at most 2 retries, only while the shared retry budget lasts, with exponential delay and jitter
    if (attempt > 2) throw new Error(`model: ${why} after 2 retries`);
    if (retryTokens < 1) throw new Error(`model: ${why}, retry budget spent`);
    retryTokens -= 1; st.retries++;
    const ra = r && r.headers['retry-after'] ? Number(r.headers['retry-after']) * 1000 : 0;
    await sleep(Math.max(ra, 200 * 2 ** attempt) * (0.5 + Math.random()));
    if (Date.now() > st.deadline) throw new Error('time limit');
  }
}

createServer(async (req, res) => {
  const start = Date.now(); const ctx = readTraceparent(req.headers.traceparent); const spanId = req.headers['x-span-id'] || newSpanId();
  const { request, user } = await readBody(req);
  const st = { request, ctx, spanId, deadline: start + DEADLINE_MS, modelCalls: 0, retries: 0, toolCalls: 0, tokensIn: 0, tokensOut: 0 };
  let status = 200, body;
  try {
    let order = null, warning = null;
    for (let turn = 0; !order && !warning; turn++) {
      const a = await modelTurn(st, turn);
      if (a.type === 'final') {
        if (VERSION === 'v2') { await sleep(EXTRA_MS); await modelTurn(st, turn + 1); } // v2: a self-check turn
        order = a.order; break;
      }
      for (const c of a.calls) {
        if (st.toolCalls >= MAX_CALLS) { warning = `tool-call limit (${MAX_CALLS}): best draft returned`; break; }
        st.toolCalls++;
        await postJson(`${CATALOG}/tools/${c.tool}`, { request, args: c.args }, { headers: ctx ? { traceparent: traceparent(ctx.traceId, spanId) } : {} });
      }
      if (Date.now() > st.deadline) warning = 'time limit (90 s): best draft returned';
    }
    const v = order ? validateOrder(request, order) : { violations: [{ rule: 'NO_ORDER' }], total: 0 };
    body = { status: !warning && !v.violations.length ? 'ok' : 'warning', warning, total: v.total, violations: v.violations.map((x) => x.rule) };
  } catch (e) { status = 502; body = { error: e.message }; }
  const costUsd = (st.tokensIn * PRICE_IN + st.tokensOut * PRICE_OUT) / 1e6;
  send(res, status, { ...body, version: VERSION, costUsd }, { 'x-cost-usd': costUsd.toFixed(6), 'x-version': VERSION });
  log({ route: '/plan', status, ms: Date.now() - start, version: VERSION, user, requestId: request.id, modelCalls: st.modelCalls,
    retries: st.retries, toolCalls: st.toolCalls, tokensIn: st.tokensIn, tokensOut: st.tokensOut, costUsd: Number(costUsd.toFixed(6)),
    ...(body.error ? { error: body.error } : {}), ...(ctx ? { trace: ctx.traceId } : {}) });
  span(`planner ${VERSION}`, ctx, 'POST /plan', spanId, start, { status, modelCalls: st.modelCalls, retries: st.retries, toolCalls: st.toolCalls });
}).listen(PORT, () => console.log(`planner ${VERSION} :${PORT} retry=${RETRY}`));
