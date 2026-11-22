// The rules assistant: retrieval over the canteen's own rules (data/policies.md), then generation
// with quotes, then a check in code that every quote really is in the rule it cites.
// Retrieval here is BM25 over words. Embeddings would find "money back" for "refund"; the
// shape of the pipeline is the same: retrieve → put in the prompt → generate → check.
//   env: RULES_K (chunks given to the model, default 3), RULES_PROMPT (a file in src/prompts/, default rules-v1.md)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR } from './data.mjs';
import { callModel } from './model.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_K = Number(process.env.RULES_K || 3);
export const PROMPT_FILE = path.resolve(HERE, 'prompts', process.env.RULES_PROMPT || 'rules-v1.md');
export const REFUSAL = 'The rules do not say.';

/** The rules of one data folder, one chunk per "## <id> <title>" section. */
export function loadChunks(dir = DATA_DIR) {
  return readFileSync(path.join(dir, 'policies.md'), 'utf8').split('\n## ').slice(1).map((c) => {
    const [head, ...rest] = c.split('\n');
    const [id, ...title] = head.split(' ');
    return { id, title: title.join(' '), text: rest.join(' ').trim() };
  });
}
export const CHUNKS = loadChunks();

const STOP = new Set('the and for can are not with that this from what when how does will may has have was who its our your you any all one each only'.split(' '));
const words = (s) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));

/** BM25 (k1 1.2, b 0.75) over title + text. Plain code, no model, the same answer every time. */
export function retrieve(q, k = DEFAULT_K, chunks = CHUNKS) {
  const docs = chunks.map((c) => words(c.title + ' ' + c.text));
  const avg = docs.reduce((a, d) => a + d.length, 0) / docs.length;
  const df = new Map();
  for (const d of docs) for (const w of new Set(d)) df.set(w, (df.get(w) || 0) + 1);
  const qs = [...new Set(words(q))];
  return chunks.map((c, i) => {
    let s = 0;
    for (const w of qs) {
      const f = docs[i].filter((x) => x === w).length;
      if (!f) continue;
      const idf = Math.log(1 + (docs.length - df.get(w) + 0.5) / (df.get(w) + 0.5));
      s += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].length / avg));
    }
    return { ...c, score: Math.round(s * 100) / 100 };
  }).filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

export const SCHEMA = { type: 'object', required: ['answer', 'citations'], additionalProperties: false, properties: {
  answer: { type: 'string' },
  citations: { type: 'array', items: { type: 'object', required: ['id', 'quote'], additionalProperties: false,
    properties: { id: { type: 'string' }, quote: { type: 'string' } } } } } };
const norm = (s) => String(s).toLowerCase().replace(/[“”"']/g, '').replace(/\s+/g, ' ').trim();

/** Checks each citation against the real text. The model's word is not evidence. */
export function checkCitations(citations, chunks = CHUNKS) {
  return citations.map(({ id, quote }) => {
    const c = chunks.find((x) => x.id === id);
    if (!c) return { id, quote, ok: false, why: `${id} does not exist` };
    if (!norm(quote)) return { id, quote, ok: false, why: 'empty quote' };
    return norm(c.text).includes(norm(quote)) ? { id, quote, ok: true } : { id, quote, ok: false, why: `not in ${id}` };
  });
}

/**
 * Answers one question from the rules. Returns what the API would send back:
 * { question, retrieved:[{id,score}], answer, citations:[{id,quote,ok,why}], costUsd, seconds, tokensIn, tokensOut, model, error }
 * error is set when no answer came back (the provider failed, the time limit, an answer that is not the JSON shape).
 */
export async function answerFromRules(q, { useRetrieval = true, k = DEFAULT_K, chunks = CHUNKS, timeoutMs = 60_000 } = {}) {
  const found = useRetrieval ? retrieve(q, k, chunks) : [];
  const context = found.map((c) => `[${c.id}] ${c.title}: ${c.text}`).join('\n');
  const system = readFileSync(PROMPT_FILE, 'utf8').trim();
  const prompt = (useRetrieval ? `Rules:\n${context || '(none found)'}\n\n` : '') + `Question: ${q}`;
  const { child, done } = callModel({ system, prompt, jsonSchema: SCHEMA });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  const r = await done;
  clearTimeout(timer);
  let out = r.structured;
  let error = r.error;
  if (!error && r.killed) error = `no answer within ${timeoutMs / 1000} s`;
  if (!error && !out) { try { out = JSON.parse(r.text); } catch { error = `not the JSON shape: ${String(r.text).slice(0, 80)}`; } }
  if (out && (typeof out.answer !== 'string' || !Array.isArray(out.citations))) { error ??= 'not the JSON shape: answer or citations missing'; out = null; }
  return { question: q, retrieved: found.map(({ id, score }) => ({ id, score })), answer: out?.answer ?? '',
    citations: out ? checkCitations(out.citations.filter((c) => c && typeof c === 'object'), chunks) : [],
    costUsd: Math.round((r.costUsd || 0) * 1e6) / 1e6, seconds: Math.round(r.ms / 100) / 10, tokensIn: r.tokensIn, tokensOut: r.tokensOut,
    model: r.model, error: error || null, ...(r.status ? { httpStatus: r.status, retryAfter: r.retryAfter } : {}) };
}

// CLI: node src/rag.mjs [--no-retrieval] [--k N] "question"
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const useRetrieval = !argv.includes('--no-retrieval');
  const ki = argv.indexOf('--k'); const k = ki < 0 ? DEFAULT_K : Number(argv.splice(ki, 2)[1]);
  const q = argv.filter((a) => a !== '--no-retrieval').join(' ');
  const r = await answerFromRules(q, { useRetrieval, k });
  if (useRetrieval) console.log(`retrieved: ${r.retrieved.map((x) => `${x.id} (${x.score})`).join(', ') || 'nothing'}`);
  else console.log('retrieved: (retrieval off: the model sees only the question)');
  if (r.error) console.log(`error: ${r.error}`);
  for (const l of r.answer.match(/.{1,72}(\s|$)/g) || [r.answer]) console.log(`answer: ${l.trim()}`);
  for (const c of r.citations) console.log(`${c.ok ? 'OK  ' : 'FAIL'} ${c.id} "${String(c.quote).slice(0, 52)}${String(c.quote).length > 52 ? '…' : ''}"${c.ok ? '' : ' — ' + c.why}`);
  console.log(`# ${r.model} · $${r.costUsd.toFixed(4)} · ${r.seconds} s`);
}
