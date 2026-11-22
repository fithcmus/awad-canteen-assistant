// node src/ask.mjs [--times N] "question"  — one call (or N identical calls), no tools, no data.
import { callModel } from './model.mjs';

const argv = process.argv.slice(2);
const opt = (name) => { const i = argv.indexOf(name); return i < 0 ? null : argv.splice(i, 2)[1]; };
const times = Number(opt('--times') || 1);
const system = opt('--system') || undefined;
const q = argv.join(' ');
const wrap = (s, w = 74) => s.replace(/\*\*/g, '').split('\n').filter((l) => l.trim())
  .flatMap((l) => l.match(new RegExp(`.{1,${w}}(\\s|$)`, 'g')) || [l]).map((l) => l.trimEnd());

for (let n = 1; n <= times; n++) {
  const r = await callModel({ prompt: q, system }).done;
  const lines = wrap(r.text);
  if (times > 1) console.log(`# answer ${n}: ${lines.slice(0, 3).join(' ').slice(0, 220)}`);
  else console.log(lines.join('\n'));
  console.log(`# ${r.model} · ${r.tokensIn} tokens in, ${r.tokensOut} out · $${r.costUsd.toFixed(4)} · ${(r.ms / 1000).toFixed(1)} s`);
}
