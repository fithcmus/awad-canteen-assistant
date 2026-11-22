// The backend's tool server, spoken over MCP (stdio, JSON-RPC, one message per line).
// The model asks; this code decides. It counts calls, enforces the limit, and logs every call
// as the model made it, before anything is fixed.
//   env: SESSION_FILE (the request, chosen by the backend), TOOL_LOG (jsonl), CALLS_FILE (shared counter), MAX_CALLS
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { TOOLS, callTool } from './tools.mjs';

const session = JSON.parse(readFileSync(process.env.SESSION_FILE, 'utf8'));
const MAX = Number(process.env.MAX_CALLS || 12);
const CALLS = process.env.CALLS_FILE;
const LOG = process.env.TOOL_LOG;
const used = () => (CALLS && existsSync(CALLS) ? Number(readFileSync(CALLS, 'utf8')) : 0);
const send = (m) => process.stdout.write(JSON.stringify(m) + '\n');
const OFFERED = process.env.CANTEEN_TOOLS ? TOOLS.filter((t) => process.env.CANTEEN_TOOLS.split(',').includes(t.name)) : TOOLS;

createInterface({ input: process.stdin }).on('line', (line) => {
  let m; try { m = JSON.parse(line); } catch { return; }
  if (m.method === 'initialize')
    return send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'canteen', version: '1.0.0' } } });
  if (m.method === 'tools/list') return send({ jsonrpc: '2.0', id: m.id, result: { tools: OFFERED } });
  if (m.method === 'tools/call') {
    const n = used() + 1;
    if (CALLS) writeFileSync(CALLS, String(n));
    const { name, arguments: args } = m.params;
    const t0 = Date.now();
    const r = n > MAX ? { ok: false, error: `tool-call limit reached (${MAX}). Stop calling tools and return your best order now.`, limit: true }
      : !OFFERED.some((t) => t.name === name) ? { ok: false, error: `unknown tool ${name}` } : callTool(session, name, args);
    if (LOG) appendFileSync(LOG, JSON.stringify({ requestId: session.request.id, seq: n, tool: name, args, ok: r.ok, error: r.error, ms: Date.now() - t0 }) + '\n');
    return send({ jsonrpc: '2.0', id: m.id, result: { content: [{ type: 'text', text: JSON.stringify(r.ok ? r.result : { error: r.error }) }], isError: !r.ok } });
  }
  if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, result: {} });
});
