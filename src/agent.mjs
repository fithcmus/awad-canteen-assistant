// The agent loop, as the backend runs it. The model is reached through the `claude` CLI
// (Claude Haiku by default); the CLI runs the model's turns, our MCP server runs the tools.
// The limits are ours, in this file and in mcp-server.mjs: 12 tool calls, 90 seconds, 2 repair rounds.
// After the model, the backend parses and validates — the model's own "valid" never counts.
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { parseOrder, ORDER_SCHEMA } from './schema.mjs';
import { validateOrder } from './validate.mjs';
import { TOOLS } from './tools.mjs';
import { redact } from './redact.mjs';
import { spawnCli } from './model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const LIMITS = { maxCalls: 12, deadlineMs: 90_000, maxRepairs: 2 };
// CANTEEN_TOOLS=get_member,search_items,… offers the model only some tools (a demo of what the checking tools buy).
const offered = () => (process.env.CANTEEN_TOOLS ? TOOLS.filter((t) => process.env.CANTEEN_TOOLS.split(',').includes(t.name)) : TOOLS);

/** What the model is told about the request. Member ids only; the free-text note goes through redact(). */
export function userMessage(request) {
  const { id, date, pickup, members, total, note } = request;
  return 'Order request:\n' + JSON.stringify({ id, date, pickup, members: members.map((m) => m.id), groupTotal: total ?? null, note: redact(note).text });
}

function runModel({ cmd, model, system, message, mcpConfig, deadline, onEvent, structured }) {
  return new Promise((resolve) => {
    const args = ['-p', '--model', model, '--tools', '', '--strict-mcp-config', '--mcp-config', mcpConfig,
      '--allowedTools', offered().map((t) => `mcp__canteen__${t.name}`).join(','), '--setting-sources', '',
      '--no-session-persistence', ...(process.env.CANTEEN_EFFORT ? ['--effort', process.env.CANTEEN_EFFORT] : []),
      ...(structured ? ['--json-schema', JSON.stringify(ORDER_SCHEMA)] : []), '--system-prompt', system, '--output-format', 'stream-json', '--verbose', message];
    const child = spawnCli(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
    const out = { text: '', toolUses: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, timedOut: false, modelName: model };
    let buf = '';
    const timer = setTimeout(() => { out.timedOut = true; child.kill('SIGKILL'); }, Math.max(0, deadline - Date.now()));
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let e; try { e = JSON.parse(line); } catch { continue; }
        if (e.type === 'assistant') for (const c of e.message.content) {
          if (c.type === 'tool_use') { out.toolUses++; onEvent?.({ kind: 'tool_use', name: c.name.replace('mcp__canteen__', ''), input: c.input }); }
          if (c.type === 'text') out.text = c.text;
        }
        if (e.type === 'result') {
          out.costUsd = e.total_cost_usd || 0;
          for (const [name, u] of Object.entries(e.modelUsage || {})) { out.modelName = name; out.tokensIn += u.inputTokens + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0); out.tokensOut += u.outputTokens; }
          if (e.result) out.text = e.result;
          if (e.structured_output) out.text = JSON.stringify(e.structured_output);
          out.rawResult = e;
        }
      }
    });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}

/** Runs one request end to end. Returns the plan line (what the API would send back as a draft). */
export async function runAgent(request, opts = {}) {
  const o = { ...LIMITS, model: process.env.CANTEEN_MODEL || 'haiku', cmd: process.env.CANTEEN_MODEL_CMD || 'claude',
    prompt: 'order-v1', workDir: path.join(process.cwd(), 'runs', `${request.id}-${Date.now()}`), ...opts };
  mkdirSync(o.workDir, { recursive: true });
  const session = path.join(o.workDir, 'session.json');
  const calls = path.join(o.workDir, 'calls');
  const toolLog = o.toolLog || path.join(o.workDir, 'tool-log.jsonl');
  writeFileSync(session, JSON.stringify({ request }));
  writeFileSync(calls, '0');
  const mcpConfig = path.join(o.workDir, 'mcp.json');
  writeFileSync(mcpConfig, JSON.stringify({ mcpServers: { canteen: { command: process.execPath, args: [path.join(HERE, 'mcp-server.mjs')],
    env: { SESSION_FILE: session, TOOL_LOG: toolLog, CALLS_FILE: calls, MAX_CALLS: String(o.maxCalls), CANTEEN_DATA: process.env.CANTEEN_DATA || '', CANTEEN_TOOLS: process.env.CANTEEN_TOOLS || '' } } } }));
  const system = readFileSync(o.promptFile || path.join(HERE, 'prompts', `${o.prompt}.md`), 'utf8');

  const t0 = Date.now(); const deadline = t0 + o.deadlineMs;
  const plan = { requestId: request.id, status: 'warning', items: [], perPerson: {}, total: 0, violations: [], firstDraft: null,
    repairs: 0, toolCalls: 0, seconds: 0, costUsd: 0, tokensIn: 0, tokensOut: 0, model: o.model };
  let message = userMessage(request);
  let best = null;
  for (let round = 0; round <= o.maxRepairs; round++) {
    const r = await runModel({ cmd: o.cmd, model: o.model, system, message, mcpConfig, deadline, onEvent: o.onEvent, structured: o.structured ?? process.env.CANTEEN_STRUCTURED === '1' });
    plan.costUsd += r.costUsd; plan.tokensIn += r.tokensIn; plan.tokensOut += r.tokensOut; plan.model = r.modelName;
    writeFileSync(path.join(o.workDir, `round-${round}.txt`), r.text);
    const parsed = parseOrder(r.text);
    const problems = parsed.problems ? parsed.problems.map((p) => ({ rule: 'SCHEMA', msg: p })) : validateOrder(request, parsed.order).violations;
    if (round === 0) plan.firstDraft = { rules: problems.map((p) => p.rule) };
    if (parsed.order && (!best || problems.length < best.problems.length)) best = { order: parsed.order, problems };
    o.onEvent?.({ kind: 'round', round, problems });
    plan.repairs = round;
    if (!problems.length) { best = { order: parsed.order, problems }; plan.status = 'ok'; break; }
    if (r.timedOut || Date.now() >= deadline) { plan.warning = 'time limit (90 s): best draft returned'; break; }
    if (Number(readFileSync(calls, 'utf8')) >= o.maxCalls) { plan.warning = `tool-call limit (${o.maxCalls}): best draft returned`; break; }
    if (round === o.maxRepairs) { plan.warning = `still invalid after ${o.maxRepairs} repair rounds: best draft returned`; break; }
    message = `${userMessage(request)}\n\nYour previous answer was refused by the backend:\n${problems.map((p) => `- ${p.rule}: ${p.msg}`).join('\n')}\n\nPrevious answer:\n${r.text.slice(0, 1500)}\n\nFix it. Reply with the JSON object only.`;
  }
  plan.toolCalls = Number(readFileSync(calls, 'utf8'));
  plan.seconds = Math.round((Date.now() - t0) / 100) / 10;
  if (best) {
    const v = validateOrder(request, { items: best.order.items });   // the backend's own figures, not the model's
    Object.assign(plan, { items: best.order.items, perPerson: v.perPerson, total: v.total, note: best.order.note,
      violations: best.problems.map((p) => `${p.rule}: ${p.msg}`) });
  } else if (plan.status !== 'ok') plan.violations = ['SCHEMA: no order in any answer'];
  plan.costUsd = Math.round(plan.costUsd * 1e5) / 1e5;
  return plan;
}

// CLI: node src/agent.mjs <requests.jsonl> <id> [--verbose]
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [file, id] = process.argv.slice(2);
  const req = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((r) => r.id === id);
  const verbose = process.argv.includes('--verbose');
  const t0 = Date.now(); const ts = () => `[${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s]`;
  const plan = await runAgent(req, { onEvent: (e) => {
    if (!verbose) return;
    if (e.kind === 'tool_use') console.log(`${ts()} model → ${e.name} ${JSON.stringify(e.input)}`);
    if (e.kind === 'round') console.log(`${ts()} backend: round ${e.round} ${e.problems.length ? 'refused: ' + e.problems.map((p) => p.rule).join(', ') : 'valid'}`);
  } });
  if (!process.argv.includes('--summary')) console.log(JSON.stringify(plan));
  else {
    const who = Object.entries(plan.perPerson).map(([m, c]) => `${m} ${c}`).join(', ');
    console.log(`plan ${plan.status}${plan.warning ? ' (' + plan.warning + ')' : ''}: ${plan.items.map((i) => `${i.member}:${i.item}`).join(' ')}`);
    console.log(`  per person ${who} · total ${plan.total} (worked out by the backend)`);
    console.log(`  ${plan.toolCalls} tool calls · ${plan.repairs} repair round(s) · ${plan.seconds} s · ${plan.tokensIn} tokens in, ${plan.tokensOut} out · $${plan.costUsd.toFixed(4)}`);
    if (plan.violations.length) console.log(`  still wrong: ${plan.violations.join('; ')}`);
  }
}
