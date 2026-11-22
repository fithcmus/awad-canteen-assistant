// The tools the model may call. All read-only: none of them places an order or moves money.
// The session (whose request, which members) comes from the backend, never from the model's arguments.
import { items, stallById, isOpen, hoursOn } from './data.mjs';
import { computeCost, validateOrder } from './validate.mjs';
import { check } from './schema.mjs';

const LINE = { type: 'object', required: ['item', 'member'], additionalProperties: false,
  properties: { item: { type: 'string' }, member: { type: 'string' } } };

export const TOOLS = [
  { name: 'get_member', description: 'Diet and allergies of one member of this order, and their spending cap in VND.',
    inputSchema: { type: 'object', required: ['member'], additionalProperties: false, properties: { member: { type: 'string' } } } },
  { name: 'search_items', description: 'Menu items with prices in VND. Filters are optional. openAt (HH:MM) keeps only stalls open at that time on the order date.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {
      stall: { type: 'string' }, vegetarian: { type: 'boolean' }, maxPrice: { type: 'integer', minimum: 0 },
      without: { type: 'array', items: { type: 'string' } }, openAt: { type: 'string', pattern: '^[0-2][0-9]:[0-5][0-9]$' } } } },
  { name: 'get_stall', description: 'A stall: its opening hours on the order date and its description.',
    inputSchema: { type: 'object', required: ['stall'], additionalProperties: false, properties: { stall: { type: 'string' } } } },
  { name: 'compute_total', description: 'Cost per member and in total for a list of order lines. Plain code, no model.',
    inputSchema: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: LINE } } } },
  { name: 'validate_order', description: 'Checks an order against every rule of the backend validator. Plain code, no model.',
    inputSchema: { type: 'object', required: ['items'], additionalProperties: false, properties: { items: { type: 'array', items: LINE } } } },
];
const byName = new Map(TOOLS.map((t) => [t.name, t]));

/** Runs one tool call for this session. Returns { ok, result } or { ok:false, error }. */
export function callTool(session, name, args) {
  const def = byName.get(name);
  if (!def) return { ok: false, error: `unknown tool ${name}` };
  const problems = typeof args === 'object' && args !== null ? check(def.inputSchema, args) : ['arguments are not a JSON object'];
  if (problems.length) return { ok: false, error: `invalid arguments: ${problems.join('; ')}` };
  const req = session.request;
  switch (name) {
    case 'get_member': {
      const m = req.members.find((x) => x.id === args.member);
      if (!m) return { ok: false, error: `${args.member} is not a member of this order` };
      return { ok: true, result: { id: m.id, vegetarian: !!m.vegetarian, allergies: m.allergies || [], cap: m.cap ?? null } };
    }
    case 'search_items': {
      const r = items.filter((it) =>
        (!args.stall || it.stall === args.stall) &&
        (args.vegetarian == null || it.vegetarian === args.vegetarian) &&
        (args.maxPrice == null || it.price <= args.maxPrice) &&
        (!args.without || !it.allergens.some((a) => args.without.includes(a))) &&
        (!args.openAt || isOpen(stallById.get(it.stall), req.date, args.openAt)));
      return { ok: true, result: r.map(({ id, stall, name, price, vegetarian, allergens }) => ({ id, stall, name, price, vegetarian, allergens })) };
    }
    case 'get_stall': {
      const s = stallById.get(args.stall);
      if (!s) return { ok: false, error: `no stall ${args.stall}` };
      return { ok: true, result: { id: s.id, name: s.name, date: req.date, hours: hoursOn(s, req.date), description: s.description } };
    }
    case 'compute_total': return { ok: true, result: computeCost(req, args.items) };
    case 'validate_order': {
      const { violations } = validateOrder(req, { items: args.items });
      return { ok: true, result: { valid: violations.length === 0, violations: violations.map((x) => `${x.rule}: ${x.msg}`) } };
    }
  }
}
