// The backend: the browser talks to this server, this server talks to the model. The key (here,
// the CLI's login) never leaves this process.
//   GET /api/answer?q=…           one answer, streamed as Server-Sent Events (text/event-stream)
//   GET /api/rag?q=…              an answer from the canteen rules, with checked quotes (JSON)
//   POST /api/drafts {requestId}   the agent makes a DRAFT (Authorization: Bearer <user id>, demo tokens)
//   GET|PATCH /api/drafts/:id, POST /api/drafts/:id/confirm, POST /api/drafts/:id/accept, GET /api/wallet
// env: PORT (3009), ABORT=0 to keep the model running after the client leaves (the bug, for the demo)
import http from 'node:http';
import { callModel } from './model.mjs';
import { answerFromRules, CHUNKS } from './rag.mjs';
import { readFileSync } from 'node:fs';
import { runAgent } from './agent.mjs';
import { createDraft, getDraft, editDraft, confirm, accept, walletOf } from './orders.mjs';

const REQUESTS = new Map(readFileSync(new URL('../data/requests.jsonl', import.meta.url), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).map((r) => [r.id, r]));
const body = (req) => new Promise((r) => { let s = ''; req.on('data', (d) => (s += d)).on('end', () => { try { r(JSON.parse(s || '{}')); } catch { r({}); } }); });
const send = (res, { status, body: b }) => { res.writeHead(status, { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json' }); res.end(JSON.stringify(b)); };

const PORT = Number(process.env.PORT || 3009);
const ABORT = process.env.ABORT !== '0';
const SYSTEM = 'You answer questions from students about Canteen B, using only these rules:\n' +
  CHUNKS.map((c) => `[${c.id}] ${c.title}: ${c.text}`).join('\n') + '\nAnswer in plain sentences, at most 300 words.';
const t = (t0) => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/answer') {
    const q = url.searchParams.get('q') || '';
    const t0 = Date.now();
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' });
    log(`[${t(t0)}] request: stream an answer`);
    let first = true; let gone = false;
    const { child, done } = callModel({ system: SYSTEM, prompt: q, stream: true, onDelta: (d) => {
      if (first) { log(`[${t(t0)}] first text from the model, sent on`); first = false; }
      if (!gone) res.write(`data: ${JSON.stringify(d)}\n\n`);
    } });
    res.on('close', () => {
      if (res.writableFinished) return;
      gone = true;
      if (ABORT) { child.kill('SIGTERM'); log(`[${t(t0)}] client left: model call stopped`); }
      else log(`[${t(t0)}] client left: model call keeps running`);
    });
    const r = await done;
    log(`[${t(t0)}] model call ended${r.killed ? ' (stopped by us)' : ''}: ${r.tokensOut} output tokens, $${r.costUsd.toFixed(4)}`);
    if (!gone) { res.write('event: done\ndata: {}\n\n'); res.end(); }
    return;
  }
  if (url.pathname === '/api/rag') {
    const r = await answerFromRules(url.searchParams.get('q') || '');
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(r));
  }
  const user = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (url.pathname.startsWith('/api/') && !user) return send(res, { status: 401, body: { type: 'no-session', detail: 'sign in first' } });
  if (url.pathname === '/api/wallet') return send(res, { status: 200, body: { user, wallet: walletOf(user) } });
  if (url.pathname === '/api/drafts' && req.method === 'POST') {
    const { requestId } = await body(req);
    const request = REQUESTS.get(requestId);
    if (!request) return send(res, { status: 404, body: { type: 'not-found', detail: 'no such request' } });
    if (!request.members.some((m) => m.id === user)) return send(res, { status: 403, body: { type: 'not-a-member' } });
    const plan = await runAgent(request, { structured: true });
    log(`draft for ${requestId} by ${user}: ${plan.status}, ${plan.toolCalls} tool calls, ${plan.seconds} s`);
    return send(res, createDraft(user, request, plan));
  }
  const m = url.pathname.match(/^\/api\/drafts\/([\w-]+)(\/(confirm|accept))?$/);
  if (m && req.method === 'GET' && !m[3]) return send(res, getDraft(user, m[1]));
  if (m && req.method === 'PATCH' && !m[3]) return send(res, editDraft(user, m[1], (await body(req)).items));
  if (m && req.method === 'POST' && m[3] === 'confirm') return send(res, confirm(user, m[1]));
  if (m && req.method === 'POST' && m[3] === 'accept') return send(res, accept(user, m[1]));
  res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
}).listen(PORT, () => log(`canteen backend on :${PORT} (abort on client close: ${ABORT ? 'yes' : 'no'})`));
