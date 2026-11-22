# Canteen assistant — a teaching demo of an LLM inside a backend

CSC13114 · Advanced Web Application Development · Faculty of Information Technology, VNU-HCM
University of Science · HK1 2026–2027 · sessions 9–11

A small backend for a fictional university canteen ("Canteen B") with two LLM features:

- **The group-order assistant** (`src/agent.mjs`): an agent that drafts a lunch order for a group
  through five read-only tools, under each member's diet, allergies and spending cap. The backend
  parses and validates the draft, repairs it at most twice, and only a **human gate in the API**
  (`src/orders.mjs`) can charge the members' wallets.
- **The rules assistant** (`src/rag.mjs`): answers a question about the canteen's rules
  (`data/policies.md`) by retrieval (BM25) and generation with quotes, then checks in code that every
  quote really is in the rule it cites.

All data is made up: the stalls, the dishes, the members, the rules. No real person, shop or
university office is described. The code is written to be read in a lecture; it has no
dependencies beyond Node.

## What you need

- **Node 22.13 or later.** Nothing to install: `npm install` is not needed.
- For the tests: nothing else. They use **fake models** (below).
- For a real model, one of:
  - the **`claude` CLI**, logged in (a Claude subscription or an Anthropic API key). This is the
    default, and the only provider the order assistant supports (its tools are served over MCP to
    the CLI);
  - **any server that speaks the OpenAI chat-completions API**, for the rules assistant and
    `src/ask.mjs`: a free tier such as Google AI Studio (Gemini), Groq or OpenRouter, or a model on
    your own machine with Ollama. Free tiers and their limits change; check the provider's page.

## Run it

```bash
npm test                                   # 16 tests, fake models, a few seconds, no key, no cost
npm run rules -- "Can I cancel a pre-order 30 minutes before pick-up?"
npm run order -- d01 --summary --verbose   # the order assistant on request d01 (claude CLI only)
npm run serve                              # the backend on :3009 (see the top of src/server.mjs)
npm run gate-demo                          # with the server running: one order through the human gate
```

`npm run rules` prints the chunks it retrieved, the answer, each citation with `OK` or `FAIL`, and
the model, cost and time of the call. Run the same question three times: the answers can differ.

## Choosing the model

Settings are environment variables. Put them in a file `.env` at the root; the `npm run` scripts
read it. **`.env` is in `.gitignore`: never commit it, never put a key in a file that is.**

| Variable | Meaning |
|---|---|
| `CANTEEN_PROVIDER` | `claude` (default) or `openai` |
| `CANTEEN_MODEL` | `haiku` by default with `claude`; required with `openai` |
| `CANTEEN_BASE_URL` | `openai` only: the API base, ending before `/chat/completions` |
| `CANTEEN_API_KEY` | `openai` only: the key, unless the server is on your machine |
| `CANTEEN_PRICE` | `openai` only: `<input>,<output>` in USD per million tokens, to record a cost; default `0,0` |
| `CANTEEN_JSON` | `openai` only: `schema` (default), `object` or `off`, how the JSON shape is asked for; use `object` if the server refuses `schema` |
| `RULES_K` | chunks of the rules given to the model (default 3) |
| `RULES_PROMPT` | the rules assistant's system prompt, a file in `src/prompts/` (default `rules-v1.md`) |

Examples (check the model names on the provider's page):

```bash
# Ollama on your machine: `ollama pull qwen2.5:3b` first
CANTEEN_PROVIDER=openai
CANTEEN_BASE_URL=http://localhost:11434/v1
CANTEEN_MODEL=qwen2.5:3b

# Google AI Studio, OpenAI-compatible endpoint
CANTEEN_PROVIDER=openai
CANTEEN_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai
CANTEEN_MODEL=<a Gemini model name>
CANTEEN_API_KEY=<your key>
```

A smaller or different model gives different answers. That is the point of measuring it.

## The fake models

Tests never call a real model. Two fakes stand in for the `claude` CLI:

- **`test/fake-model.mjs`** plays a scripted agent: it talks to the real tool server over MCP and
  follows a list of steps (`{ "tool": …, "args": … }`, `{ "repeat": n, … }`, `{ "sleep": ms }`,
  `{ "text": … }`) instead of thinking. `test/agent.test.mjs` uses it to show that the limits hold
  (12 tool calls, 90 seconds, 2 repair rounds) and that the backend's validator, not the model,
  decides whether an order is valid.
- **`test/fake-cli.mjs`** returns the answer you put in `FAKE_ANSWER` (or fails with `FAKE_FAIL`,
  or hangs for `FAKE_SLEEP_MS`). `test/rag.test.mjs` uses it to test the code around the rules
  assistant: retrieval, the citation check, errors and the time limit.

Point the code at a fake yourself with `CANTEEN_MODEL_CMD=test/fake-cli.mjs`:

```bash
CANTEEN_MODEL_CMD=test/fake-cli.mjs \
FAKE_ANSWER='{"answer":"Yes, any time.","citations":[{"id":"P5","quote":"until 60 minutes before pick-up"}]}' \
  node src/rag.mjs "Can I cancel 30 minutes before pick-up?"
```

The quote is checked `OK` and the answer is wrong. A test with a fake proves what the code does
with an answer; it says nothing about how often the real model gives a right one. That needs an
eval: many questions, several runs, read as a distribution.

## What is where

| Path | What it is |
|---|---|
| `src/rag.mjs`, `src/prompts/rules-v1.md` | the rules assistant: retrieve, generate, check quotes |
| `src/agent.mjs`, `src/prompts/order-v1.md` | the order assistant's loop: limits, schema, validator, repair rounds |
| `src/tools.mjs`, `src/mcp-server.mjs` | the five read-only tools, served to the CLI over MCP |
| `src/validate.mjs`, `src/schema.mjs` | the backend's checks: plain code, run last on every order |
| `src/orders.mjs`, `src/server.mjs` | drafts and the human gate; the HTTP API (demo tokens: `Authorization: Bearer u1`) |
| `src/redact.mjs` | what is removed from free text before it leaves for the provider |
| `src/model.mjs`, `src/ask.mjs` | one call to a model, through the CLI or an OpenAI-compatible server |
| `ops/` | session 11: four small services (gateway, planner, tool catalog, a **fake** model provider) that write logs and traces, and the scripts that read them |
| `data/` | the fictional canteen: stalls, dishes, members, rules, two sample order requests |

## Safety notes

- The tools are read-only. No tool places an order or moves money; that is an API action behind
  the human gate.
- Every model call costs money or free-tier quota. The order assistant makes up to three model
  calls and twelve tool calls per request, about USD 0.03 with Claude Haiku; a rules question is
  one call, well under a cent.
- Do not put real personal data in requests or notes: the text is sent to the provider.
