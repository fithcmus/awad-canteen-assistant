// A FAKE model provider, for load and fault demos only. It does not call any model.
// It answers like a tool-calling model would, turn by turn, with a latency we choose, and counts tokens.
// The real agent (Claude Haiku through the CLI) is sessions 9 and 10; you cannot send it 3,000 requests in a lecture.
//   env: PORT (4103), BASE_MIN_MS/BASE_MAX_MS (turn latency, default 250–650), SLOW_ONE_IN + SLOW_MS (every Nth call is slow),
//        RATE_LIMIT (calls per second, then 429), FAULT_AFTER_S + FAULT_FOR_S + FAULT_RATE (503s for a while), LOOP_ON=v2 (requests from that prompt version never finish: the model keeps searching)
import http from 'node:http';
import { createServer, logger, readTraceparent, span, newSpanId, readBody, sleep, send } from './common.mjs';
import { items, stallById, isOpen } from '../src/data.mjs';

const E = process.env; const num = (k, d) => (E[k] != null ? Number(E[k]) : d);
const PORT = num('PORT', 4103), MIN = num('BASE_MIN_MS', 250), MAX = num('BASE_MAX_MS', 650);
const SLOW_N = num('SLOW_ONE_IN', 0), SLOW_MS = num('SLOW_MS', 20000), RATE = num('RATE_LIMIT', 0);
const F_AFTER = num('FAULT_AFTER_S', -1), F_FOR = num('FAULT_FOR_S', 0), F_RATE = num('FAULT_RATE', 0);
const log = logger('provider');
const t0 = Date.now();
let calls = 0, bucket = RATE, last = Date.now();

function take() { // token bucket: RATE per second
  if (!RATE) return true;
  const now = Date.now(); bucket = Math.min(RATE, bucket + ((now - last) / 1000) * RATE); last = now;
  if (bucket >= 1) { bucket -= 1; return true; } return false;
}
// What the fake model "decides": a fixed sequence of tool calls, then the cheapest valid dish per member.
function answer(request, turn, loop) {
  const ids = request.members.map((m) => m.id);
  if (turn === 0) return { type: 'tool', calls: ids.map((member) => ({ tool: 'get_member', args: { member } })) };
  if (turn === 1 || (loop && turn < 40)) return { type: 'tool', calls: [{ tool: 'search_items', args: { openAt: request.pickup } }] };
  const lines = request.members.map((m) => {
    const ok = items.filter((it) => isOpen(stallById.get(it.stall), request.date, request.pickup) && (!m.vegetarian || it.vegetarian)
      && !(m.allergies || []).some((a) => it.allergens.includes(a)) && !it.id.startsWith('s5')).sort((a, b) => a.price - b.price);
    return { item: ok[0]?.id, member: m.id };
  });
  if (turn === 2) return { type: 'tool', calls: [{ tool: 'compute_total', args: { items: lines } }, { tool: 'validate_order', args: { items: lines } }] };
  return { type: 'final', order: { items: lines } };
}

createServer(async (req, res) => {
  const start = Date.now(); const ctx = readTraceparent(req.headers.traceparent); const sid = newSpanId();
  const body = await readBody(req);
  const n = ++calls; const el = (Date.now() - t0) / 1000;
  let status = 200, out, delay = MIN + Math.random() * (MAX - MIN);
  if (!take()) { status = 429; delay = 5; }
  else if (F_AFTER >= 0 && el >= F_AFTER && el < F_AFTER + F_FOR && Math.random() < F_RATE) { status = 503; delay = 50; }
  else if (SLOW_N && n % SLOW_N === 0) delay = SLOW_MS;
  await sleep(delay);
  const turn = body.turn || 0;
  const tokensIn = 1500 + 700 * turn, tokensOut = status === 200 ? 120 : 0;
  if (status === 200) out = { ...answer(body.request, turn, E.LOOP_ON && body.prompt === E.LOOP_ON), usage: { tokensIn, tokensOut } };
  else out = { error: status === 429 ? 'rate limited' : 'overloaded' };
  if (status === 429) send(res, 429, out, { 'retry-after': '1' }); else send(res, status, out);
  log({ route: '/v1/turn', status, ms: Date.now() - start, turn, call: n, ...(ctx ? { trace: ctx.traceId } : {}) });
  span('provider (fake)', ctx, 'POST /v1/turn', sid, start, { status, turn });
}).listen(PORT, () => console.log(`provider (fake model) :${PORT}`));
