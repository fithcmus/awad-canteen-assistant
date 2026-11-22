// The tool service: runs the agent's tools (src/tools.mjs) over HTTP. Read-only, fast.
import http from 'node:http';
import { createServer, logger, readTraceparent, span, newSpanId, readBody, send } from './common.mjs';
import { callTool } from '../src/tools.mjs';

const PORT = Number(process.env.PORT || 4102);
const log = logger('catalog');
createServer(async (req, res) => {
  const start = Date.now(); const ctx = readTraceparent(req.headers.traceparent); const sid = newSpanId();
  const { request, args } = await readBody(req);
  const name = req.url.replace('/tools/', '');
  const r = callTool({ request }, name, args);
  const status = r.ok ? 200 : 400;
  send(res, status, r);
  log({ route: `/tools/${name}`, status, ms: Date.now() - start, ...(ctx ? { trace: ctx.traceId } : {}) });
  span('catalog', ctx, `tool ${name}`, sid, start, { status });
}).listen(PORT, () => console.log(`catalog :${PORT}`));
