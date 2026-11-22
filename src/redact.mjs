// What may leave for the model provider. The request's free-text note is written by a person,
// so it can hold names, student IDs, emails and phone numbers. Code removes what it can recognise:
// the names we hold for the members, and the patterns. What it cannot recognise still goes out,
// which is why the note is optional and the model gets member ids, never names.
import { members } from './data.mjs';

const PATTERNS = [
  [/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, '[email]'],
  [/(\+84|0)\d{9}\b/g, '[phone]'],
  [/\b\d{8}\b/g, '[student id]'],
];

export function redact(text) {
  if (!text) return { text: '', removed: [] };
  let out = text; const removed = [];
  for (const u of Object.values(members.users)) {
    if (u.name && out.includes(u.name)) { out = out.split(u.name).join('[member]'); removed.push('name'); }
  }
  for (const [re, tag] of PATTERNS) out = out.replace(re, () => { removed.push(tag.slice(1, -1)); return tag; });
  return { text: out, removed };
}
