// Shape checks, in code, before anything else sees the model's output.
// Small on purpose: what a JSON Schema validator (ajv, zod) would do for these shapes.

/** Checks a value against a tiny JSON-Schema subset: type, properties, required,
 *  additionalProperties:false, items, enum, minimum, maximum, pattern. Returns a list of problems. */
export function check(schema, value, at = '$') {
  const p = [];
  const t = Array.isArray(value) ? 'array' : value === null ? 'null' : Number.isInteger(value) ? 'integer' : typeof value;
  const want = schema.type;
  const okType = !want || want === t || (want === 'number' && t === 'integer');
  if (!okType) return [`${at}: expected ${want}, got ${t}`];
  if (schema.enum && !schema.enum.includes(value)) p.push(`${at}: ${JSON.stringify(value)} is not one of ${schema.enum.join(', ')}`);
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) p.push(`${at}: below ${schema.minimum}`);
    if (schema.maximum != null && value > schema.maximum) p.push(`${at}: above ${schema.maximum}`);
  }
  if (typeof value === 'string' && schema.pattern && !new RegExp(schema.pattern).test(value)) p.push(`${at}: does not match ${schema.pattern}`);
  if (t === 'object') {
    for (const r of schema.required || []) if (!(r in value)) p.push(`${at}: missing ${r}`);
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties && k in schema.properties) p.push(...check(schema.properties[k], v, `${at}.${k}`));
      else if (schema.additionalProperties === false) p.push(`${at}: unexpected ${k}`);
    }
  }
  if (t === 'array' && schema.items) value.forEach((x, i) => p.push(...check(schema.items, x, `${at}[${i}]`)));
  return p;
}

export const ORDER_SCHEMA = {
  type: 'object', required: ['items', 'perPerson', 'total'], additionalProperties: false,
  properties: {
    items: { type: 'array', items: { type: 'object', required: ['item', 'member'], additionalProperties: false,
      properties: { item: { type: 'string', pattern: '^s[0-9]+-[0-9]+$' }, member: { type: 'string' } } } },
    perPerson: { type: 'object' },
    total: { type: 'integer', minimum: 0 },
    note: { type: 'string' },
  },
};

/** The model's final text → an order, or the reason it is not one. Accepts a bare JSON object only. */
export function parseOrder(text) {
  let v;
  try { v = JSON.parse(text.trim()); } catch (e) { return { problems: [`not JSON: ${String(text).trim().slice(0, 40)}…`] }; }
  const problems = check(ORDER_SCHEMA, v);
  return problems.length ? { problems } : { order: v };
}
