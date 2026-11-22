// Loads the fictional canteen data. Plain code, no model.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DATA_DIR = process.env.CANTEEN_DATA || path.join(HERE, '..', 'data');
const read = (f) => JSON.parse(readFileSync(path.join(DATA_DIR, f), 'utf8'));

export const stalls = read('stalls.json');
export const items = read('items.json');
export const members = read('members.json');
export const stallById = new Map(stalls.map((s) => [s.id, s]));
export const itemById = new Map(items.map((i) => [i.id, i]));

const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
export const weekday = (date) => DAYS[new Date(date + 'T12:00:00Z').getUTCDay()];
const mins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/** Is the stall open at this time? Pick-up must be inside one opening period. */
export function isOpen(stall, date, time) {
  const periods = stall.hours[weekday(date)] || [];
  return periods.some(([a, b]) => mins(a) <= mins(time) && mins(time) <= mins(b));
}
export function hoursOn(stall, date) {
  return stall.hours[weekday(date)] || [];
}
