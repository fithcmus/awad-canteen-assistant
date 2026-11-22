// node src/sse-client.mjs <url> [--leave-after <seconds>] — what the browser sees, with times.
const [url, flag, secs] = process.argv.slice(2);
const leaveAfter = flag === '--leave-after' ? Number(secs) * 1000 : null;
const t0 = Date.now();
const s = () => `${((Date.now() - t0) / 1000).toFixed(1).padStart(5)} s`;
const ac = new AbortController();
if (leaveAfter) setTimeout(() => { console.log(`[${s()}] browser: tab closed`); ac.abort(); }, leaveAfter);
let text = ''; let chunks = 0; let firstAt = null;
try {
  const res = await fetch(url, { signal: ac.signal });
  const dec = new TextDecoder();
  for await (const part of res.body) {
    for (const ev of dec.decode(part).split('\n\n')) {
      const m = ev.match(/^data: (.*)$/m);
      if (!m || ev.startsWith('event: done')) continue;
      const d = JSON.parse(m[1]);
      if (typeof d !== 'string') continue;
      if (firstAt == null) { firstAt = s(); console.log(`[${firstAt}] browser: first words on screen`); }
      chunks++; text += d;
    }
  }
  console.log(`[${s()}] browser: answer complete, ${chunks} chunks, ${text.length} characters`);
  console.log('  ' + text.replace(/\s+/g, ' ').slice(0, 70) + '…');
} catch (e) {
  if (e.name !== 'AbortError') throw e;
  console.log(`[${s()}] browser: had ${chunks} chunks when it left`);
}
