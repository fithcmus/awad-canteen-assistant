#!/usr/bin/env node
// A fake `claude` CLI for tests of src/model.mjs and src/rag.mjs: no model, no key, no cost.
// It prints the stream-json lines the real CLI prints, with the answer you give it.
//   FAKE_ANSWER  = the JSON the "model" returns, e.g. {"answer":"…","citations":[…]}
//   FAKE_SLEEP_MS = wait this long first (to test the time limit)
//   FAKE_FAIL    = an error message: print a failed result instead
const sleep = Number(process.env.FAKE_SLEEP_MS || 0);
if (sleep) await new Promise((r) => setTimeout(r, sleep));
const emit = (e) => process.stdout.write(JSON.stringify(e) + '\n');
if (process.env.FAKE_FAIL) {
  emit({ type: 'result', is_error: true, result: process.env.FAKE_FAIL, total_cost_usd: 0, modelUsage: {} });
  process.exit(1);
}
const text = process.env.FAKE_ANSWER || '{"answer":"The rules do not say.","citations":[]}';
let structured; try { structured = JSON.parse(text); } catch { /* the real CLI would also return plain text */ }
emit({ type: 'result', result: text, ...(structured ? { structured_output: structured } : {}), total_cost_usd: 0,
  modelUsage: { 'fake-model': { inputTokens: 0, outputTokens: 0 } } });
