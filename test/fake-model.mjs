#!/usr/bin/env node
// A fake model for tests: it takes the place of the `claude` CLI, talks to the real tool server
// over MCP, and follows a script instead of thinking. Deterministic, free, and fast.
//   FAKE_SCRIPT = JSON file: { "rounds": [ [step, …], … ] }, one list per call of the CLI
//   step = { "tool": name, "args": {…} } | { "repeat": n, "tool": name, "args": {…} } | { "sleep": ms } | { "text": "…" }
//   FAKE_STATE = file that counts the rounds already played
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';

const argv = process.argv.slice(2);
const cfg = JSON.parse(readFileSync(argv[argv.indexOf('--mcp-config') + 1], 'utf8')).mcpServers.canteen;
const script = JSON.parse(readFileSync(process.env.FAKE_SCRIPT, 'utf8'));
const state = process.env.FAKE_STATE;
const round = existsSync(state) ? Number(readFileSync(state, 'utf8')) : 0;
writeFileSync(state, String(round + 1));
const steps = script.rounds[Math.min(round, script.rounds.length - 1)];

const server = spawn(cfg.command, cfg.args, { env: { ...process.env, ...cfg.env }, stdio: ['pipe', 'pipe', 'inherit'] });
const pending = new Map(); let id = 0;
createInterface({ input: server.stdout }).on('line', (l) => { const m = JSON.parse(l); pending.get(m.id)?.(m); pending.delete(m.id); });
const rpc = (method, params) => new Promise((r) => { const n = ++id; pending.set(n, r); server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: n, method, params }) + '\n'); });
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');

await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'fake-model' } });
let text = '';
for (const s of steps) {
  if (s.sleep) await new Promise((r) => setTimeout(r, s.sleep));
  if (s.text != null) text = s.text;
  for (let k = 0; k < (s.tool ? s.repeat || 1 : 0); k++) {
    emit({ type: 'assistant', message: { content: [{ type: 'tool_use', name: `mcp__canteen__${s.tool}`, input: s.args || {} }] } });
    const r = await rpc('tools/call', { name: s.tool, arguments: s.args || {} });
    emit({ type: 'user', message: { content: [{ type: 'tool_result', content: r.result.content }] } });
    if (r.result.isError && /limit reached/.test(r.result.content[0].text)) break;   // a well-behaved fake stops when told
  }
}
emit({ type: 'result', result: text, total_cost_usd: 0, modelUsage: {} });
server.kill();
