// The limits and the backend checks, tested with a fake model. No key, no cost, the same result every run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runAgent } from '../src/agent.mjs';
import { callTool } from '../src/tools.mjs';

const FAKE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fake-model.mjs');
const REQ = { id: 't01', date: '2026-12-04', pickup: '11:30', total: 130000, members: [
  { id: 'u1', cap: 50000 }, { id: 'u2', cap: 40000, vegetarian: true }, { id: 'u3', cap: 50000, allergies: ['peanut'] }] };
const GOOD = { items: [{ item: 's1-1', member: 'u1' }, { item: 's3-2', member: 'u2' }, { item: 's2-2', member: 'u3' }], perPerson: { u1: 35000, u2: 28000, u3: 35000 }, total: 98000 };

function withFake(rounds, opts = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'canteen-test-'));
  writeFileSync(path.join(dir, 'script.json'), JSON.stringify({ rounds }));
  process.env.FAKE_SCRIPT = path.join(dir, 'script.json');
  process.env.FAKE_STATE = path.join(dir, 'state');
  return runAgent(REQ, { cmd: FAKE, workDir: dir, ...opts }).then((plan) => ({ plan, dir }));
}
const toolLog = (dir) => readFileSync(path.join(dir, 'tool-log.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('a valid order is accepted in one round', async () => {
  const { plan } = await withFake([[{ tool: 'get_member', args: { member: 'u1' } }, { text: JSON.stringify(GOOD) }]]);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.repairs, 0);
});

test('a model that never stops calling tools gets 12 calls, then a refusal', async () => {
  const { plan, dir } = await withFake([[{ repeat: 30, tool: 'search_items', args: {} }, { text: JSON.stringify(GOOD) }]]);
  const log = toolLog(dir);
  assert.equal(log.filter((c) => c.ok).length, 12);
  assert.match(log.at(-1).error, /limit reached/);
});

test('a model that hangs is stopped at the deadline, and no order is accepted', async () => {
  const { plan } = await withFake([[{ sleep: 5000 }, { text: JSON.stringify(GOOD) }]], { deadlineMs: 1500 });
  assert.equal(plan.status, 'warning');
  assert.match(plan.warning, /time limit/);
  assert.ok(plan.seconds < 3, `took ${plan.seconds} s`);
});

test('prose around the JSON is refused, at most 2 repair rounds', async () => {
  const prose = `Perfect! Here is your order:\n\`\`\`json\n${JSON.stringify(GOOD)}\n\`\`\``;
  const { plan } = await withFake([[{ text: prose }], [{ text: prose }], [{ text: prose }], [{ text: JSON.stringify(GOOD) }]]);
  assert.equal(plan.status, 'warning');
  assert.equal(plan.repairs, 2);
  assert.match(plan.violations[0], /^SCHEMA/);
});

test('an order over a cap is refused, whatever the model says about it', async () => {
  const over = { ...GOOD, items: [{ item: 's1-2', member: 'u1' }, { item: 's3-4', member: 'u2' }, { item: 's2-2', member: 'u3' }],
    perPerson: { u1: 45000, u2: 40000, u3: 35000 }, total: 120000, note: 'validated, all within caps' };
  const { plan } = await withFake([[{ text: JSON.stringify(over) }]], { maxRepairs: 0 });
  assert.equal(plan.status, 'warning');
  assert.ok(plan.violations.some((v) => v.startsWith('OVER_CAP')), plan.violations.join('; '));
});

test("the model's arithmetic is checked, and the backend's figure is the one returned", async () => {
  const wrong = { ...GOOD, total: 90000 };
  const { plan } = await withFake([[{ text: JSON.stringify(wrong) }], [{ text: JSON.stringify(GOOD) }]]);
  assert.equal(plan.status, 'ok');
  assert.equal(plan.repairs, 1);
  assert.equal(plan.total, 98000);
});

test('a tool asked about someone outside this order answers nothing about them', () => {
  const r = callTool({ request: REQ }, 'get_member', { member: 'u7' });
  assert.equal(r.ok, false);
  assert.match(r.error, /not a member of this order/);
});

test('a tool call with the wrong argument types is refused and logged as the model made it', async () => {
  const { dir } = await withFake([[{ tool: 'search_items', args: { maxPrice: '40k' } }, { text: JSON.stringify(GOOD) }]]);
  const [call] = toolLog(dir);
  assert.equal(call.ok, false);
  assert.deepEqual(call.args, { maxPrice: '40k' });
});
