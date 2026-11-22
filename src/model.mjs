// One call to a model, from the backend. The parts are the same with every provider: a system
// prompt, the message, a model name, and back come text, tokens and a cost.
//
// Two ways to reach a model, chosen by CANTEEN_PROVIDER:
//   claude (default)  the `claude` CLI, logged in with a Claude subscription or an API key.
//                     CANTEEN_MODEL defaults to haiku. The CLI reports the cost of each call.
//   openai            any server that speaks the OpenAI chat-completions API: Google AI Studio
//                     (Gemini), Groq, OpenRouter, a local Ollama… Set CANTEEN_BASE_URL,
//                     CANTEEN_MODEL and, except for a local server, CANTEEN_API_KEY.
//                     CANTEEN_PRICE="<in>,<out>" (USD per million tokens) turns tokens into a cost;
//                     without it the cost is recorded as 0 and the tokens are still counted.
//                     CANTEEN_JSON=schema (default) | object | off: how the JSON shape is asked for.
// Put these in a file .env at the root (never committed); the npm scripts read it.
import { spawn } from 'node:child_process';

export const provider = () => process.env.CANTEEN_PROVIDER || 'claude';
export const modelName = () => process.env.CANTEEN_MODEL || (provider() === 'claude' ? 'haiku' : '');

/** Returns { child, done }: child.kill() stops the call; done resolves to the result. */
export function callModel(opts) {
  return provider() === 'openai' ? callOpenAI(opts) : callClaude(opts);
}

function callClaude({ system = 'You are a helpful assistant.', prompt, model = modelName(), jsonSchema, stream = false, onDelta,
  cmd = process.env.CANTEEN_MODEL_CMD || 'claude' }) {
  const args = ['-p', '--model', model, '--tools', '', '--setting-sources', '', '--no-session-persistence',
    '--system-prompt', system, '--output-format', 'stream-json', '--verbose',
    ...(stream ? ['--include-partial-messages'] : []), ...(jsonSchema ? ['--json-schema', JSON.stringify(jsonSchema)] : []), prompt];
  const t0 = Date.now();
  const out = { text: '', structured: null, costUsd: 0, tokensIn: 0, tokensOut: 0, ttftMs: null, ms: 0, deltas: 0, model, error: null };
  let child;
  try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) {
    out.error = `cannot start ${cmd}: ${e.message}`; return { child: { kill() {} }, done: Promise.resolve(out) };
  }
  let buf = ''; let err = '';
  child.stderr.on('data', (d) => { err += d; });
  child.stdout.on('data', (d) => {
    buf += d; let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i); buf = buf.slice(i + 1);
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e.type === 'stream_event' && e.event?.delta?.type === 'text_delta') {
        if (out.ttftMs == null) out.ttftMs = Date.now() - t0;
        out.deltas++; out.text += e.event.delta.text; onDelta?.(e.event.delta.text);
      }
      if (e.type === 'result') {
        out.costUsd = e.total_cost_usd || 0;
        for (const [name, u] of Object.entries(e.modelUsage || {})) {
          out.model = name;
          out.tokensIn += u.inputTokens + (u.cacheReadInputTokens || 0) + (u.cacheCreationInputTokens || 0);
          out.tokensOut += u.outputTokens;
        }
        if (e.is_error) out.error = String(e.result || e.subtype || 'error').slice(0, 300);
        if (e.result && !stream) out.text = e.result;
        if (e.structured_output) out.structured = e.structured_output;
      }
    }
  });
  const done = new Promise((resolve) => {
    child.on('error', (e) => { out.error = `cannot start ${cmd}: ${e.message}`; });
    child.on('close', (code, signal) => {
      out.ms = Date.now() - t0; out.killed = !!signal;
      if (!out.error && code && !out.text) out.error = `${cmd} exited with ${code}: ${err.trim().slice(0, 300)}`;
      resolve(out);
    });
  });
  return { child, done };
}

const price = () => (process.env.CANTEEN_PRICE || '0,0').split(',').map(Number);

function callOpenAI({ system = 'You are a helpful assistant.', prompt, model = modelName(), jsonSchema, stream = false, onDelta }) {
  const base = (process.env.CANTEEN_BASE_URL || '').replace(/\/+$/, '');
  const key = process.env.CANTEEN_API_KEY || '';
  const t0 = Date.now();
  const out = { text: '', structured: null, costUsd: 0, tokensIn: 0, tokensOut: 0, ttftMs: null, ms: 0, deltas: 0, model, error: null, status: null };
  const ac = new AbortController();
  const child = { kill: () => ac.abort() };
  if (!base || !model) {
    out.error = 'CANTEEN_PROVIDER=openai needs CANTEEN_BASE_URL and CANTEEN_MODEL';
    return { child, done: Promise.resolve(out) };
  }
  const mode = process.env.CANTEEN_JSON || 'schema';
  const body = { model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }], temperature: 1 };
  if (jsonSchema && mode === 'schema') body.response_format = { type: 'json_schema', json_schema: { name: 'answer', schema: jsonSchema } };
  if (jsonSchema && mode === 'object') body.response_format = { type: 'json_object' };
  if (stream) { body.stream = true; body.stream_options = { include_usage: true }; }
  const done = (async () => {
    try {
      const res = await fetch(`${base}/chat/completions`, { method: 'POST', signal: ac.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) }, body: JSON.stringify(body) });
      out.status = res.status;
      out.retryAfter = Number(res.headers.get('retry-after')) || null;
      if (!res.ok) { out.error = `HTTP ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 300)}`; return out; }
      let usage = null;
      if (!stream) {
        const j = await res.json();
        out.text = j.choices?.[0]?.message?.content ?? '';
        usage = j.usage; if (j.model) out.model = j.model;
      } else {
        const dec = new TextDecoder(); let buf = '';
        for await (const part of res.body) {
          buf += dec.decode(part, { stream: true }); let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
            if (!line.startsWith('data:') || line === 'data: [DONE]') continue;
            let e; try { e = JSON.parse(line.slice(5)); } catch { continue; }
            const d = e.choices?.[0]?.delta?.content;
            if (d) { if (out.ttftMs == null) out.ttftMs = Date.now() - t0; out.deltas++; out.text += d; onDelta?.(d); }
            if (e.usage) usage = e.usage;
          }
        }
      }
      out.tokensIn = usage?.prompt_tokens || 0; out.tokensOut = usage?.completion_tokens || 0;
      const [pin, pout] = price();
      out.costUsd = (out.tokensIn * pin + out.tokensOut * pout) / 1e6;
      if (jsonSchema) { try { out.structured = JSON.parse(out.text.trim().replace(/^```(json)?\s*|\s*```$/g, '')); } catch { /* left to the caller */ } }
    } catch (e) {
      out.error = e.name === 'AbortError' ? 'stopped' : `request failed: ${e.message}`;
      out.killed = e.name === 'AbortError';
    } finally { out.ms = Date.now() - t0; }
    return out;
  })();
  return { child, done };
}
