// The rules assistant, tested with a fake CLI (test/fake-cli.mjs). No key, no cost, the same result every run.
// These test the code around the model: retrieval, the citation check, errors and the time limit. Whether the
// model's answers are right is a question for an eval, with the real model, many questions and several runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-cli.mjs');
process.env.CANTEEN_PROVIDER = 'claude';
process.env.CANTEEN_MODEL_CMD = FAKE;
const { answerFromRules, retrieve, checkCitations } = await import('../src/rag.mjs');
const ask = (answer, q = 'Can I cancel a pre-order 30 minutes before pick-up?', opts) => {
  process.env.FAKE_ANSWER = typeof answer === 'string' ? answer : JSON.stringify(answer);
  return answerFromRules(q, opts);
};

test('retrieval is code: the same question gets the same chunks every time', () => {
  const q = 'Can I cancel a pre-order 30 minutes before pick-up?';
  assert.deepEqual(retrieve(q).map((c) => c.id), retrieve(q).map((c) => c.id));
  assert.ok(retrieve(q).some((c) => c.id === 'P5'));
});

test('a quote copied from the rule it cites is checked OK', async () => {
  const r = await ask({ answer: 'No.', citations: [{ id: 'P5', quote: 'A pre-order can be cancelled in the app until 60 minutes before pick-up' }] });
  assert.equal(r.error, null);
  assert.deepEqual(r.citations.map((c) => c.ok), [true]);
});

test('a quote that is not in its rule, or a rule that does not exist, is flagged', async () => {
  const r = await ask({ answer: 'Yes.', citations: [{ id: 'P5', quote: 'cancel any time' }, { id: 'P42', quote: 'anything' }] });
  assert.deepEqual(r.citations.map((c) => c.why), ['not in P5', 'P42 does not exist']);
});

test('a checked quote says nothing about the conclusion', async () => {
  const r = await ask({ answer: 'Yes, you can cancel 30 minutes before.', citations: [{ id: 'P5', quote: 'until 60 minutes before pick-up' }] });
  assert.ok(r.citations.every((c) => c.ok));          // the quote is real, the answer is wrong: only an eval sees that
});

test('an answer that is not the JSON shape is an error, not an answer', async () => {
  const r = await ask('Sure! You can cancel until 60 minutes before.');
  assert.match(r.error, /not the JSON shape/);
  assert.equal(r.answer, '');
});

test('a provider that fails gives an error, never an empty "answer"', async () => {
  process.env.FAKE_FAIL = 'rate limited';
  try { const r = await ask({ answer: 'x', citations: [] }); assert.match(r.error, /rate limited/); }
  finally { delete process.env.FAKE_FAIL; }
});

test('a model that hangs is stopped at the time limit', async () => {
  process.env.FAKE_SLEEP_MS = '5000';
  try {
    const t0 = Date.now(); const r = await ask({ answer: 'x', citations: [] }, undefined, { timeoutMs: 800 });
    assert.match(r.error, /no answer within/); assert.ok(Date.now() - t0 < 3000);
  } finally { delete process.env.FAKE_SLEEP_MS; }
});

test('checkCitations ignores case, quotes and spacing, nothing else', () => {
  const [a, b] = checkCitations([{ id: 'P9', quote: 'the SMALLEST  top-up is 20,000 VND' }, { id: 'P9', quote: 'the smallest top-up is 10,000 VND' }]);
  assert.equal(a.ok, true); assert.equal(b.ok, false);
});
