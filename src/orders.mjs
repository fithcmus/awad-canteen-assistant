// The human gate, in the API. The agent only ever makes a draft. Money moves here, and only after
// the creator confirms and every member accepts (canteen rule P8). The validator runs again at the
// gate, on whatever the order is now, including a creator's hand edits. The model has no tool for any of this.
import { randomUUID } from 'node:crypto';
import { members } from './data.mjs';
import { validateOrder } from './validate.mjs';

const drafts = new Map();
const wallets = Object.fromEntries(Object.entries(members.users).map(([id, u]) => [id, u.wallet]));
export const walletOf = (id) => wallets[id];

const err = (status, type, detail, extra = {}) => ({ status, body: { type, detail, ...extra } });

export function createDraft(user, request, plan) {
  if (!request.members.some((m) => m.id === user)) return err(403, 'not-a-member', `${user} is not in request ${request.id}`);
  const d = { id: randomUUID().slice(0, 8), creator: user, request, items: plan.items, state: 'draft', accepted: [], charged: null };
  drafts.set(d.id, d);
  return { status: 201, body: view(d) };
}
function view(d) {
  const v = validateOrder(d.request, { items: d.items });
  return { id: d.id, state: d.state, items: d.items, perPerson: v.perPerson, total: v.total,
    violations: v.violations.map((x) => x.rule), waitingFor: d.request.members.map((m) => m.id).filter((m) => !d.accepted.includes(m)),
    ...(d.charged ? { charged: d.charged } : {}) };
}
function find(user, id) {
  const d = drafts.get(id);
  // A draft is seen only by its creator; once confirmed, by the members of the order. Others get 404, not 403.
  if (!d) return null;
  const isMember = d.request.members.some((m) => m.id === user);
  if (d.state === 'draft' ? d.creator !== user : !isMember) return null;
  return d;
}

export function getDraft(user, id) {
  const d = find(user, id);
  return d ? { status: 200, body: view(d) } : err(404, 'not-found', 'no such order');
}
export function editDraft(user, id, items) {
  const d = find(user, id);
  if (!d) return err(404, 'not-found', 'no such order');
  if (d.creator !== user || d.state !== 'draft') return err(409, 'not-editable', 'only the creator edits, and only a draft');
  d.items = items;
  return { status: 200, body: view(d) };
}
export function confirm(user, id) {
  const d = find(user, id);
  if (!d) return err(404, 'not-found', 'no such order');
  if (d.creator !== user) return err(403, 'not-creator', 'only the creator confirms');
  if (d.state !== 'draft') return { status: 200, body: view(d) };            // confirming twice changes nothing
  const v = validateOrder(d.request, { items: d.items });
  if (v.violations.length) return err(422, 'order-invalid', 'the validator refused this order', { violations: v.violations.map((x) => `${x.rule}: ${x.msg}`) });
  d.state = 'waiting'; d.accepted = [user];
  return settle(d);
}
export function accept(user, id) {
  const d = find(user, id);
  if (!d) return err(404, 'not-found', 'no such order');
  if (d.state === 'draft') return err(409, 'not-confirmed', 'the creator has not confirmed this order');
  if (d.state === 'placed' || d.accepted.includes(user)) return { status: 200, body: view(d) };   // no second charge
  d.accepted.push(user);
  return settle(d);
}
function settle(d) {
  if (d.request.members.some((m) => !d.accepted.includes(m.id))) return { status: 200, body: view(d) };
  const v = validateOrder(d.request, { items: d.items });
  const short = Object.entries(v.perPerson).filter(([m, c]) => (wallets[m] ?? 0) < c).map(([m]) => m);
  if (v.violations.length || short.length) return err(409, 'cannot-charge', short.length ? `not enough in the wallet of ${short.join(', ')}` : 'order invalid');
  for (const [m, c] of Object.entries(v.perPerson)) wallets[m] -= c;   // all wallets in one step, or none
  d.state = 'placed'; d.charged = v.perPerson;
  return { status: 201, body: view(d) };
}
