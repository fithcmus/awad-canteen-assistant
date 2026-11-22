// Shared by the four demo services (session 11): JSON log lines, trace context, spans, percentiles.
// Every service writes to $OPS_OUT: <service>.log.jsonl (one line per request) and spans.jsonl.
import { appendFileSync, mkdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import http from 'node:http';

export const OUT = process.env.OPS_OUT || './out';
mkdirSync(OUT, { recursive: true });
export const TRACE = process.env.TRACE !== '0';

export function logger(service) {
  const f = `${OUT}/${service}.log.jsonl`;
  return (o) => appendFileSync(f, JSON.stringify({ t: new Date().toISOString(), service, ...o }) + '\n');
}

// W3C trace context: traceparent = 00-<32 hex trace id>-<16 hex parent span id>-01
export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');
export function readTraceparent(h) {
  const m = /^00-([0-9a-f]{32})-([0-9a-f]{16})-0[01]$/.exec(h || '');
  return m ? { traceId: m[1], parentId: m[2] } : null;
}
export const traceparent = (traceId, spanId) => `00-${traceId}-${spanId}-01`;

/** Records one finished span. ctx = { traceId, parentId }. */
export function span(service, ctx, name, spanId, start, attrs = {}) {
  if (!TRACE || !ctx) return;
  appendFileSync(`${OUT}/spans.jsonl`, JSON.stringify({ traceId: ctx.traceId, spanId, parentId: ctx.parentId || null,
    service, name, start, ms: Date.now() - start, ...attrs }) + '\n');
}

/** Nearest-rank percentile. */
export function pct(sorted, p) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}

/** An HTTP server whose idle keep-alive sockets outlive the clients' (otherwise a reused socket is reset: a stray 502). */
export function createServer(handler) {
  const s = http.createServer(handler); s.keepAliveTimeout = 120_000; s.headersTimeout = 121_000; return s;
}
const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 1000, maxSockets: 512, timeout: 110000 });
/** POST JSON over http with an optional timeout. Resolves { status, body, headers } or rejects on timeout/network. */
export function postJson(url, body, { headers = {}, timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const req = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST', agent,
      headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data), ...headers } }, (res) => {
      let b = ''; res.on('data', (d) => (b += d));
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, body: j, headers: res.headers }); });
    });
    if (timeoutMs) req.setTimeout(timeoutMs, () => req.destroy(Object.assign(new Error('timeout'), { code: 'TIMEOUT' })));
    req.on('error', reject);
    req.end(data);
  });
}
export function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, { agent }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(b) }); } catch (e) { resolve({ status: res.statusCode, body: null }); } }); }).on('error', reject);
  });
}
export function readBody(req) {
  return new Promise((resolve) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve({}); } }); });
}
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const send = (res, status, body, headers = {}) => { res.writeHead(status, { 'content-type': 'application/json', ...headers }); res.end(JSON.stringify(body)); };
