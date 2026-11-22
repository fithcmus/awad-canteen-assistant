// The validator: plain code, run in the backend, last, on every order —
// also on an order the user edited by hand. It trusts nothing the model says about itself.
import { itemById, stallById, isOpen } from './data.mjs';

/** Cost per member and in total, worked out from the data. Money is integer VND. */
export function computeCost(request, lines) {
  const perPerson = Object.fromEntries(request.members.map((m) => [m.id, 0]));
  for (const { item, member } of lines) {
    const it = itemById.get(item);
    if (it && member in perPerson) perPerson[member] += it.price;
  }
  const total = Object.values(perPerson).reduce((a, b) => a + b, 0);
  return { perPerson, total };
}

/**
 * Checks an order against the request. Returns { violations, perPerson, total }.
 * order = { items: [{ item, member }], perPerson?, total? }
 */
export function validateOrder(request, order) {
  const v = [];
  const add = (rule, msg, extra = {}) => v.push({ rule, msg, ...extra });
  const byId = new Map(request.members.map((m) => [m.id, m]));
  const lines = Array.isArray(order.items) ? order.items : [];

  for (const [i, { item, member }] of lines.entries()) {
    const it = itemById.get(item);
    const m = byId.get(member);
    if (!it) { add('ITEM_NOT_FOUND', `line ${i + 1}: no item ${item}`, { item }); continue; }
    if (!m) { add('NOT_IN_REQUEST', `line ${i + 1}: ${member} is not in this order`, { member }); continue; }
    if (!isOpen(stallById.get(it.stall), request.date, request.pickup))
      add('STALL_CLOSED', `${it.id} (${stallById.get(it.stall).name}) is closed at ${request.pickup}`, { item });
    if (m.vegetarian && !it.vegetarian)
      add('NOT_VEGETARIAN', `${member} is vegetarian, ${it.id} "${it.name}" is not`, { item, member });
    for (const a of m.allergies || [])
      if (it.allergens.includes(a)) add('ALLERGEN', `${member} is allergic to ${a}, ${it.id} contains it`, { item, member });
  }
  const { perPerson, total } = computeCost(request, lines);
  for (const m of request.members) {
    if (!lines.some((l) => l.member === m.id)) add('NO_ITEM', `${m.id} has nothing`, { member: m.id });
    if (m.cap != null && perPerson[m.id] > m.cap)
      add('OVER_CAP', `${m.id} spends ${perPerson[m.id]}, cap ${m.cap}`, { member: m.id });
  }
  if (request.total != null && total > request.total)
    add('OVER_TOTAL', `the group spends ${total}, total ${request.total}`);
  if (order.total != null && order.total !== total)
    add('COST_MISMATCH', `the order says ${order.total}, the items cost ${total}`);
  if (order.perPerson) for (const [id, c] of Object.entries(order.perPerson))
    if (perPerson[id] !== c) add('COST_MISMATCH', `the order says ${id} pays ${c}, the items cost ${perPerson[id] ?? 'nothing'}`);
  return { violations: v, perPerson, total };
}
