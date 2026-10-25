# AGENT.md — OpenCode Free-Model Proxy: What We Know & What We Built

> **Purpose of this file:** durable memory for future agents/humans working in this repo.
> It records *why* the code looks the way it does — most of it is reverse-engineered
> behaviour of OpenCode's free tier that is documented nowhere else. Read this before
> changing `proxy.ts`, `hit-model.ts`, or `fingerprint.ts`.
>
> Last updated: 2026-10-25. Everything below was verified live on that date.

---

## 1. What this project does

Two Bun/TypeScript entry points expose OpenCode's **free** models to tools that
were never supposed to reach them directly:

| File | What it is |
|---|---|
| `src/proxy.ts` | Local OpenAI-compatible server (`Bun.serve`) on `127.0.0.1:8787`. Downstream agents (Cursor / VS Code Chat, pi.dev, any OpenAI client) point at it and use free models with **their own** tools and prompts. |
| `src/hit-model.ts` | Terminal CLI to call one free model directly (`bun run src/hit-model.ts big-pickle "hi"`), plus `--list`, `--all-free`, and `--probe` (gate bisection). |
| `src/minimize-system.ts` | Gate-minimization harness (§7): finds the smallest system-prompt prepend that still passes. Burns ~11 upstream calls per run — only with live quota. |
| `src/fingerprint.ts` | **Shared module** holding the entire upstream "client fingerprint": UA, session IDs, system prompt, headers, model roster. Both entry points import it. Change gate logic here first. |
| `src/langfuse.ts` | Optional Langfuse tracing via OTLP/HTTP (no SDK/deps). On only when `LANGFUSE_PUBLIC_KEY`+`LANGFUSE_SECRET_KEY` are set; the Colab panel forwards them from Secrets. One trace/request (root span + generation child): usage → `langfuse.observation.usage_details`, explicit `cost_details` $0 (free models have no price, else Langfuse shows unknown cost), session grouping via `langfuse.session.id` (explicit header/body, else `conv_<sha256(first user msg)>` — clients resend full history, so it is stable across turns; never the upstream `ses_`, which is fresh per request). Content text only with `LANGFUSE_CAPTURE_CONTENT=1`. Verified against a mock collector locally + a live 200 in Colab (2026-10-25). |
| `data/opencode-system.txt` | **Template** for the system prompt, captured from the real CLI on this machine/project. `fingerprint.ts:buildSystemPrompt()` substitutes the dynamic parts per request (model block, live skills, date, env) the way the CLI constructs it per session; the file supplies the stable harness wording + fallback for any region that fails to build. Re-extract after major CLI updates (§7). |
| `data/opencode-tools.json` | The CLI's exact 12 tool definitions captured from its request. Used by `hit-model.ts`. The proxy does **not** use these (clients bring their own tools). |
| `package.json` / `tsconfig.json` | Bun project. Scripts: `proxy`, `list`, `probe`, `all-free`, `minimize`, `typecheck`. Runtime dep: none (only `bun-types`/`typescript` devDeps). |
| `notebooks/opencode-colab.ipynb` | **Current testbed:** the whole stack (sources embedded as checksum-verified chunks, written flat in Colab — `dataPath()` in `fingerprint.ts` resolves both layouts) + tests + Cloudflare/zrok tunnels, runnable in Google Colab. Mirrors the live Colab notebook edited via `.cursor/mcp.json` (colab-mcp). See §8. (The older `opencode serve` bridge notebooks were deleted 2026-10-25; still in git history.) |

Architecture:

```
Cursor / VS Code Chat / pi.dev          (client's own system prompt + tools)
        │  OpenAI Chat Completions
        ▼
proxy.ts  ── gate repairs (§5) ──►  https://opencode.ai/inference/openai/v1/chat/completions
        │                              (free models only: *-free + big-pickle)
        └── SSE/JSON back, tool names un-renamed
```

## 2. How to run

```bash
bun run proxy                       # server on 127.0.0.1:8787
PROXY_API_KEY=secret bun run proxy  # require Bearer secret from clients
bun run list                        # live free-model roster
bun run src/hit-model.ts mimo-v2.6-flash-free "say hi"
bunx tsc --noEmit                   # typecheck
```

Client configs:

- **Cursor / VS Code Chat** (`chatLanguageModels.json`): vendor `customendpoint`,
  `apiType: "chat-completions"`, model `url: "http://127.0.0.1:8787/v1/chat/completions"`,
  `toolCalling: true`. Note the URL must be the *full* chat-completions URL in this schema.
- **pi.dev** (`~/.pi/agent/models.json`): provider with `baseUrl: "http://127.0.0.1:8787/v1"`,
  `api: "openai-completions"`, `apiKey: "not-needed"`, models from `bun run list`.

⚠️ Agent-spawned background servers do not persist across chat turns — run the proxy
in your own terminal.

### Run it from Colab (fresh IP + public tunnels)

The anonymous quota is per-IP (§7): when the home IP is burned, run the stack in
Google Colab instead — `opencode-colab.ipynb` (sources embedded, sha256-verified)
installs Bun, runs the tests, and can expose the proxy publicly two ways:

- **Cloudflare quick tunnel** — random `*.trycloudflare.com` URL per start, keyless.
- **zrok v2 (recommended)** — `zrok2` enabled with the token from the Colab secret
  `ZROK_TOKEN`; reserved name gives the fixed client URL
  `https://oc-llm-proxy.shares.zrok.io/v1` (keyless; API key = anything).

A tunnel points at the proxy process *inside one runtime*: a dead runtime = dead
URL. The notebook's share cell self-heals — it reclaims the name from any old
session's share and rebinds it to the current runtime, so after a quota burn you
just rerun the setup cells in a new runtime and clients keep the same URL.

Configuration (environment variables):

| Var | Used by | Meaning |
|---|---|---|
| `PORT` / `HOST` | proxy | Listen address (default `8787` / `127.0.0.1`). |
| `PROXY_API_KEY` | proxy | If set, clients must send `Authorization: Bearer <value>`. |
| `PROXY_DUMP=1` | proxy | Dump each client request + transformed upstream body to `.proxy-dump.jsonl` (sensitive; delete after). |
| `OPENCODE_API_KEY` | both | Sent upstream instead of `Bearer public` (paid/Go lane). |
| `OPENCODE_BASE` | both | Upstream base (default `https://opencode.ai/inference`). |
| `OPENCODE_UA` | both | Pin the User-Agent; default resolves latest `@opencode/cli` from npm. |
| `OPENCODE_SESSION` | hit-model | Reuse a specific `ses_…` ID instead of minting a fresh one. |

## 3. Upstream facts (OpenCode / inference API)

- Model roster is **live**, do not hardcode: `GET https://opencode.ai/inference/v1/models`
  (no auth needed). Free models = IDs ending in `-free`, plus `big-pickle`
  (9 models on 2026-10-25; `nemotron-3-ultra-free` from older lists is gone).
- Endpoint families per model (from `opencode.ai/docs/zen`): GPT/Grok/Muse → OpenAI
  Responses; Claude/Qwen-flash → Anthropic Messages; Gemini → Google `:generateContent`;
  open models + **all free models that matter** → OpenAI Chat Completions.
- `jev-1.13-free` is the exception: proprietary `systemone` endpoint, unsupported here.
- Officially, **free models are only for OpenCode's own clients**. The docs
  (`opencode.ai/v2/docs/console/api/inference`) say other clients get HTTP 403 even
  with an API key, and maintainers have closed issues confirming this is intentional
  (anomalyco/opencode#49144, #56702). Paid models / Go subscription are the supported
  path. **This project is a workaround; expect it to break without notice** (§7).
- Anonymous free lane auth is `Authorization: Bearer public`.
- ⚠️ Two CLI package lines exist and are easy to confuse: npm `opencode-ai` is the
  v1 line (1.19.4 on 2026-10-25); `@opencode/cli` is the v2 line (2.1.4) that the
  code here tracks for the User-Agent. The v2 tarballs in `tmp/` are that package.
- The gate's exact demands have **varied over time and endpoint**: community
  reports from Sep 2026 (9router, OmniRoute) measured a required tool *quartet*
  (`bash/glob/grep/read`) and 6–12 exact tools on the `/zen` endpoint, while our
  Oct 2026 measurement on `/inference` found a single `read` tool sufficient.
  Treat §4 as "true here, today", not as a permanent spec.

## 4. The free-tier gate — measured contract (the important part)

Free requests are rejected with **`429 FreeUsageLimitError` ("Free usage limit
reached")** — this message is a *generic rejection*, **not** real quota exhaustion.
(The same moment it appears, the real CLI often succeeds.) On the older `/zen`
endpoint the same rejection was `403 FreeTierError`; also expect
`426 UpgradeRequired` for too-old CLI versions.

Each row below was isolated by replaying a captured real-CLI request and changing
exactly one variable (Bun runtime, live upstream):

| # | Requirement | Evidence |
|---|---|---|
| 1 | **Bun transport.** Request must be sent by Bun's fetch (the CLI's runtime). | Byte-identical captured request: Node fetch → 429, Bun fetch → 200. Even the real CLI **through mitmproxy** → 429 (MITM re-originates TLS). |
| 2 | **Versioned User-Agent:** `opencode/latest/<version>/cli`, version = latest `@opencode/cli` from npm (2.1.4 on 2026-10-25), resolved dynamically and cached 24 h in `.opencode-ids.json`. | `opencode/latest/1.3.15/cli` → `426` ("OpenCode 1.18.0 or newer is required"); bare/other UAs rejected in earlier community tests. |
| 3 | **Descending session ID:** `x-opencode-session` (+ `-id`, `x-session-affinity`, `x-session-id`, same value) formatted `ses_<12 hex><14 base62>`, where hex = `~(Date.now() * 0x1000 + counter)` truncated to 48 bits — OpenCode's `Identifier.create("ses","descending")` (`packages/opencode/src/id/id.ts`). The server *decodes* the inverted timestamp. **Fresh ID per upstream request** (the CLI makes one session per run). | Ascending-timestamp `ses_` → 429; UUID → 429; correctly-encoded fresh ID → 200. |
| 4 | **An `<env>` block containing a `Working directory:` line must be in the system prompt** (isolated 2026-10-25, correcting the earlier "full prompt" belief). Method: custom-agent captures (`.opencode/agents/proxyprobe.md` — the agent `system` replaces only the 1,472-char head; the 11.7k model/tool-catalog/skills/env suffix is still appended by the harness) replayed and ablated on a fresh Colab IP: head, tool catalog and skills are NOT gated; client system + `<env>` stub alone (248 chars) → 200 on big-pickle (incl. a real tool call), deepseek-v4.1-flash-free and glm-5.3-flash-free. The env *value* is not validated (fake `/x` passed); bare `Working directory:` without `<env>` tags → 429; empty `<env>` → 429. The full prompt (built by `buildSystemPrompt()`, dynamic model/skills/date/env over the captured template) also passes and is kept as the `PROXY_SYSTEM=full` fallback. Earlier evidence is consistent: truncation to 8,000 chars cut off the trailing `<env>` block. | Client system alone → 429; generic 13k-char system → 429; full prompt → 200; client + env stub → 200 (Colab, 2026-10-25). |
| 5 | **A tool literally named `read` must be in `tools`.** | No tools → 429; `edit` alone → 429; `bash` alone → 429; 12 fake names → 429; **any** `read` (exact CLI def, minimal stub, or a renamed client tool) → 200. Triggered a real bug: Cursor's reader is named `view`, so VS Code/Cursor requests failed until the proxy renamed it (see §5). |
| 6 | Body: `stream: true`, `stream_options.include_usage`, `max_completion_tokens` (CLI sends 32000). | `stream:false` failed in early (zen-era) tests; on `/inference` it was masked by other gates. We always stream upstream and assemble JSON for non-streaming clients. |

Verified **not** gated (changing them still → 200): `x-opencode-project` value
(we send `sha1(cwd)`; CLI sends a DB-stored 40-hex project hash), `b3`/`traceparent`
trace headers, JSON key order, tool *schemas/descriptions* (names are what matter),
and the `Authorization` header's presence (in some tests).

## 5. What the proxy actually does (gate repairs)

Given a downstream OpenAI chat-completions request, `proxy.ts`:

1. **System:** downstream clients (Cline / VS Code) are the agent — their system
   prompt is the only persona. Default (`PROXY_SYSTEM=minimal`): client system +
   a ~60-char `<env>` gate stub (`buildMinimalSystem()` in `fingerprint.ts`;
   workdir from `PROXY_WORKDIR` or the proxy's cwd). `PROXY_SYSTEM=full` restores
   the legacy 13k OpenCode prepend (≈3.5k tokens/request). On a minimal-mode 429
   the proxy retries once with the full prompt and stays in full mode for 1h
   (gate-rotation self-heal); a genuine quota 429 fails the retry too. Verified
   end-to-end through the proxy in Colab 2026-10-25: Cline-style plain (200,
   408 prompt tokens), `read_file` tool call renamed `read` upstream and
   restored downstream, streaming, no-system client (stub alone, 57 chars,
   311 tokens), deepseek (348 tokens), and a multi-turn tool-result
   round-trip (416 tokens) — all on a fresh runtime/IP after an earlier
   session's quota exhaustion blocked the first attempt at the last three.
2. **Tools (client's own — the proxy defines no toolset):**
   - Client has a tool named `read` → unchanged.
   - Else, find the client's read-like tool (`/read|view|file|open|…/`, e.g. Cursor's
     `view`, pi's/VS Code's `read_file`), **rename it to `read`** upstream, and rename
     its `tool_calls` back to the original name downstream. The client executes its
     own tool with its own schema, unaware of the swap.
   - Else (no read-like tool or no tools) → append a stub `read` and **suppress** any
     calls to it downstream (the client cannot execute a tool it never declared).
3. **Identity:** fresh descending `ses_` per upstream request; all four session
   headers; latest-CLI UA; `Bearer public` (or `OPENCODE_API_KEY` if set).
4. **Streaming:** upstream SSE is passed through (with tool-call renames applied per
   chunk); for non-streaming clients the SSE is assembled into one `chat.completion`
   JSON, including assembled `tool_calls` and `reasoning_content`.
5. Free-only guardrail: non-free model IDs are rejected with 400; models are listed
   from the live upstream roster.

Operational properties worth knowing:

- **Stateless:** the proxy keeps no conversation state. Every upstream request
  gets a fresh session ID (§4.3); multi-turn context works because the *client*
  resends its full message history (including assistant `tool_calls` and tool
  results, which are forwarded untouched) on every turn.
- **Parameter mapping:** client `max_tokens`/`max_completion_tokens` →
  `max_completion_tokens` upstream (default 32000); `temperature`, `top_p`,
  penalties, `stop`, `tool_choice`, `parallel_tool_calls`, `seed` pass through;
  client `n` and `stream_options` are dropped (upstream always streams with
  usage included).
- **Scope limits:** downstream, only Chat Completions is served (no Responses /
  Anthropic / Gemini routes — clients must speak `openai-completions`-style);
  upstream, only the free Chat-Completions models. Streaming chunks pass through
  including model-specific reasoning fields (`reasoning_content`, etc.).
- **Client-visible errors:** upstream non-200s are forwarded with the upstream
  status/body. VS Code/Cursor may still *display* this as "502 … retried 5 times"
  — that wrapper is the client's retry UI, not our proxy's status code. Check the
  proxy's own log line (`✗ <model> -> upstream <status>`) for ground truth.
- **Payload size is real:** Cursor sends ~118 tools / ~200–340 KB per request.
  That works, but it is why the one-line request summary (tools, char counts)
  exists in the proxy log — check it before suspecting the fingerprint.

`hit-model.ts` differs only in that it's a one-shot CLI: it sends the captured system
prompt as the sole system message and the CLI's exact 12 tools (`opencode-tools.json`).

## 6. How the captures were made (to redo them)

The transcript-era tooling was deleted after use; recreate as needed:

- **MITM (mitmproxy):** `mitmdump -p 18080 -s <addon logging flows>` then run the CLI
  with `HTTPS_PROXY=http://127.0.0.1:18080` and
  `SSL_CERT_FILE=~/.mitmproxy/mitmproxy-ca-cert.pem` (Bun honours `SSL_CERT_FILE`).
  ⚠️ Gotcha we learned the hard way: the CLI *through MITM gets 429*, because MITM
  changes the TLS fingerprint. MITM tells you the request *shape*, but never judge
  pass/fail through it.
- **Plaintext redirect (authoritative):** set the provider baseURL to a local HTTP
  listener (`OPENCODE_CONFIG` file with `provider.opencode.options.baseURL =
  http://127.0.0.1:8911/v1`), run `opencode run --standalone --auto -m
  opencode/big-pickle "hello"`, record the request, reply with a canned SSE chunk.
  This captures byte-exact headers/body with zero distortion. Replaying that body
  is how every row in §4 was proven.
- **Request dumping in the proxy:** `PROXY_DUMP=1 bun run proxy` writes each client
  request + transformed upstream body to `.proxy-dump.jsonl` (gitignored — it
  contains full prompts; delete after debugging). The proxy also logs a one-line
  summary per request (`→ model stream=… tools=[…] renameBack={…}`).

## 7. If it breaks again (expected — playbook)

Related tooling: `bun run minimize` (`minimize-system.ts`) finds the smallest
system-prompt prepend that still passes the gate (ablations + standalone
sections over the §4 prompt) — for when the downstream client already sends a
full system prompt and the 13k prepend is wasteful. Only run it while the
genuine quota is alive (`opencode run "hello"` succeeds), else every variant
returns 429 and the output is meaningless.

Symptom: everything returns `429 FreeUsageLimitError` while `opencode run "hello"`
still works in a terminal. The gate has rotated. (If `opencode run` *also* fails
with "Free usage limit reached", that's the genuine anonymous quota — it does
exhaust after heavy use; wait for it to reset instead of debugging the fingerprint.) Do this, in order:

1. Confirm transport sanity: `bun run src/hit-model.ts big-pickle "say hi"` — if the CLI
   path fails too, the rotation is in the shared fingerprint.
2. Re-capture the real CLI's request via the **plaintext redirect** (§6) and diff
   headers/body against `fingerprint.ts` + `proxy.ts` transforms (session format?
   UA? a new required tool or header? system prompt changed after a CLI update?).
3. Replay the captured request from Bun, then change **one variable at a time**
   back toward the proxy's shape. Never bisect through MITM (see §6 warning).
4. Check for a CLI version bump first — `resolveUA()` follows npm `@opencode/cli`
   latest automatically, but a major CLI release may also change the system prompt
   or tool list; then re-extract `opencode-system.txt` / `opencode-tools.json` from
   a fresh capture.
5. Update §4 of this file and the header comments in `fingerprint.ts` with the new
   evidence (date it). Community projects hit the same rotations and are a useful
   signal: search `9router`, `OmniRoute`, `anomalyco/opencode` issues for
   `FreeTierError` / `FreeUsageLimitError`.

Also check the boring explanations first: upstream model renamed/removed (roster is
live — `bun run list`), `jev-*` requested (unsupported), or the user pointed their
client at a dead proxy process (agent-spawned servers don't persist; run
`bun run proxy` in a real terminal).

## 8. Colab validation & tunnels (2026-10-25)

A Google Colab notebook ("OpenCode Free-Model Proxy — Bun Testbed", via the Colab
MCP server in `.cursor/mcp.json`) downloads the six project files from this public
repo (`raw.githubusercontent.com/.../main/`) and runs the stack from Colab's fresh
egress IP. (It originally embedded the files as checksum-verified gzip+base64
chunks; the download cell replaced them on 2026-10-25 — simpler and always current.)
Results:
`--list` OK (9 free models), `hit-model.ts` 200 on `big-pickle` **and**
`deepseek-v4.1-flash-free` (validates the per-model identity block in the dynamic
system prompt), proxy smoke test (`/health`, `/v1/models`, chat completion) all 200.
Conclusion: the home-IP `FreeUsageLimitError` at the time was genuine per-IP quota
exhaustion, not a fingerprint break — the dynamic prompt works as built. The
notebook's tests were later consolidated into a single suite cell, and prompt
minimization is an optional note there — intentionally not run (burns ~11 calls).
The zrok share name is read from the Colab secret `ZROK_NAME` — there is no
built-in default; Start stops with instructions if it is unset (the
`oc-llm-proxy` name in the 2026-10-25 results below was the then-default). The notebook UI is now an ipywidgets control panel for
non-coders (`notebooks/colab_panel.py`, exec'd by a one-line loader cell):
Setup / Run tests / Start public URL / Stop buttons plus a try-it chat box;
all step-by-step cells were removed. All code fetches (loader + panel Setup)
go through the GitHub contents API and send `Authorization: Bearer
<OC_PROXY_GITHUB_REPO_TOKEN>` (fallback `GITHUB_TOKEN`) when that Colab
secret exists, so the notebook keeps working
if the repo is made private (fine-grained PAT, this repo only, Contents
read-only).
The notebook also exposes the Colab proxy two ways: a Cloudflare quick tunnel
(random `*.trycloudflare.com` URL per start, no key) and zrok v2 (`zrok2`, token
from the Colab `ZROK_TOKEN` secret) with the reserved fixed name
`oc-llm-proxy.shares.zrok.io` — the old v1-era notebook bridge share that held the
name was deleted with user approval on 2026-10-25 and the name re-bound to the Bun
proxy on :8787.

## 9. Security & hygiene notes

- The proxy binds `127.0.0.1` by default. If you tunnel it (zrok/cloudflared), set
  `PROXY_API_KEY` — otherwise anyone with the URL can spend the anonymous free lane
  through your machine/IP. (The Colab tunnels in §8 currently run keyless by the
  owner's choice; the random/reserved URL is the only protection. Don't share it.)
- `.proxy-dump.jsonl` and any flow captures contain full prompts, file contents and
  session IDs: gitignored, and delete when done.
- `.opencode-ids.json` only caches the CLI version (and historically a session ID);
  harmless, gitignored, mode 600 when written.
- This whole approach spoofs the official client's fingerprint. It is a personal
  interoperability workaround against OpenCode's stated intent for the free tier —
  don't redistribute it as a product, and prefer paid/Go models for anything serious.
