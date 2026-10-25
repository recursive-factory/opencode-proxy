# OpenCode Free-Model Proxy

Use OpenCode's **free** AI models from tools that normally can't reach them — Cursor, VS Code Chat, pi.dev, or any OpenAI-compatible client.

OpenCode's free tier is officially limited to OpenCode's own client. This project runs a small local proxy (Bun + TypeScript) that speaks to the free models the way the real OpenCode client does, and re-serves them as a standard OpenAI Chat Completions API. Your tools keep their own prompts and tools; the proxy handles the rest.

> ⚠️ **This is just an experiment** — a personal interoperability and learning project, not a product. OpenCode intends the free tier for its own client only (upstream returns a generic `429 FreeUsageLimitError` to everyone else), so this workaround may stop working at any time and may not align with OpenCode's terms. Prefer the supported paid/Go models for anything serious. See [Disclaimer](#disclaimer) and the full reverse-engineering notes in [AGENT.md](AGENT.md).

---

## How it works

```
Cursor / VS Code Chat / pi.dev        (your tool's own prompt + tools)
        │  OpenAI Chat Completions
        ▼
src/proxy.ts  ── client-fingerprint repairs ──►  https://opencode.ai/inference
        │                                          (free models: *-free + big-pickle)
        └── streaming or JSON back, tool names restored
```

To be accepted upstream, every request needs (measured, not guessed — see [AGENT.md §4](AGENT.md)):

1. **Bun's HTTP transport** (the real client runs on Bun; Node fetch is rejected on identical bytes)
2. A **versioned User-Agent** tracking the latest `@opencode/cli` release
3. A **fresh session ID** per request, encoded the way OpenCode encodes them
4. A **gate stub in the system prompt**: an `<env>` block with a `Working directory:` line, appended to your client's own system prompt (measured 2026-10-25 — the full 13k OpenCode prompt also passes and remains as an automatic fallback, `PROXY_SYSTEM=full`)
5. A tool literally named **`read`** — if your client calls it something else (e.g. Cursor's `view`), the proxy renames it upstream and renames the calls back, invisibly

---

## Quick start (local)

You need [Bun](https://bun.sh):

```bash
git clone https://github.com/recursive-factory/opencode-proxy.git
cd opencode-proxy
bun run proxy
```

The proxy listens on `http://127.0.0.1:8787`. Try it:

```bash
curl http://127.0.0.1:8787/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model": "big-pickle", "messages": [{"role": "user", "content": "Say hi in five words"}]}'
```

See what's available (the roster is live — don't hardcode it):

```bash
bun run list
```

On 2026-10-25 the free roster was: `big-pickle`, `beam-free`, `deepseek-v4.1-flash-free`, `flint-40b-free`, `glm-5.3-flash-free`, `mimo-v2.6-flash-free`, `nemotron-3.5-lightning-free`, `nemotron-3.5-super-vl-free` (plus `jev-1.13-free`, which uses a proprietary endpoint and is **not** supported here).

Optional: require a key from clients —

```bash
PROXY_API_KEY=my-secret bun run proxy
```

Run the proxy in your own terminal; background processes spawned by agents don't persist.

---

## Client setup

**Cursor / VS Code Chat** — in `chatLanguageModels.json`, add a `customendpoint` model with `apiType: "chat-completions"` and:

- URL: `http://127.0.0.1:8787/v1/chat/completions` (the *full* URL — this schema requires it)
- `toolCalling: true`

**pi.dev** — in `~/.pi/agent/models.json`, add a provider with:

- `baseUrl`: `http://127.0.0.1:8787/v1`
- `api`: `openai-completions`
- `apiKey`: `not-needed`
- models: from `bun run list`

**Anything else** that speaks OpenAI Chat Completions: base URL `…/v1`, any API key, model = any free model ID. Only Chat Completions is served (no Responses/Anthropic/Gemini routes).

---

## Run it in Google Colab (no coding)

Free quota is **per IP address** — when your home IP is used up, run the same stack in Colab on a fresh IP and expose it with a public address:

[![Open In Colab](https://colab.research.google.com/assets/colab-badge.svg)](https://colab.research.google.com/github/recursive-factory/opencode-proxy/blob/main/notebooks/opencode-colab.ipynb)

The notebook is a button-driven control panel for non-coders:

1. Run the panel cell (▶)
2. Press the big **🚀 One-click: do everything for me** button — it runs setup, the tests, and startup in order (or click **1 · Setup** → **2 · Run tests** → **3 · Start public address** one by one)
3. Copy the address from the green box into your app (API key: `not-needed`)

Two tunnel choices in Step 3:

| Tunnel | Address | Needs |
|---|---|---|
| **zrok** (recommended) | The same `https://<name>.shares.zrok.io` every time | A free zrok.io account; two Colab secrets (below) |
| **Cloudflare** | A new random `*.trycloudflare.com` each session | Nothing |

Colab secrets (🔑 in the left sidebar → **Secrets**, notebook access on):

| Secret | Required | What it is |
|---|---|---|
| `OC_PROXY_GITHUB_REPO_TOKEN` | If this repo is private | A read-only GitHub token for this repo, so the notebook can download the code. Create it under GitHub → Settings → Developer settings → Fine-grained tokens, with access to only this repository and **Contents: Read-only** permission |
| `ZROK_TOKEN` | For zrok | Your zrok enable token |
| `ZROK_NAME` | For zrok | The name in your address, e.g. `my-proxy` → `https://my-proxy.shares.zrok.io` (no built-in default) |

The notebook works whether this repo is public or private — with a private repo, the Open in Colab button will ask you to sign in to GitHub, and the panel downloads code using `OC_PROXY_GITHUB_REPO_TOKEN`. Without that secret, a private repo returns "404" and Setup fails.

**Quota used up?** The tunnel points at one Colab runtime, so a dead runtime = dead address. Menu **Runtime → Restart session**, run the panel, click 1 → 2 → 3 again. The zrok address stays the same (the panel reclaims the name from the old session automatically); client configs never change.

---

## Commands

| Command | What it does |
|---|---|
| `bun run proxy` | Start the OpenAI-compatible proxy on `127.0.0.1:8787` |
| `bun run list` | Print the live free-model roster |
| `bun run src/hit-model.ts <model> "hi"` | One-shot call to a single free model from the terminal |
| `bun run all-free` | Hit every free model once (costs quota — don't spam) |
| `bun run probe` | Gate bisection tooling (see AGENT.md) |
| `bun run minimize` | Find the smallest system prompt that still passes upstream (~11 calls — only with live quota) |
| `bun run typecheck` | `tsc --noEmit` |

## Configuration

Environment variables for the proxy:

| Variable | Meaning |
|---|---|
| `PORT` / `HOST` | Listen address (default `8787` / `127.0.0.1`) |
| `PROXY_API_KEY` | If set, clients must send `Authorization: Bearer <value>` |
| `PROXY_SYSTEM` | `minimal` (default: client system + ~60-char gate stub) or `full` (legacy 13k OpenCode prepend). Minimal mode auto-retries once with the full prompt on a 429 |
| `PROXY_WORKDIR` | Working-directory path written into the gate stub (default: the proxy's cwd) |
| `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` | Enable Langfuse tracing via OpenTelemetry — every request becomes a trace (root span + generation) grouped by conversation session, with token usage and explicit $0 cost for the free models. No keys = tracing off |
| `LANGFUSE_BASE_URL` | Langfuse host (default `https://cloud.langfuse.com`; US: `https://us.cloud.langfuse.com`, or your self-hosted URL). In Colab, set the keys as Secrets and the panel forwards them |
| `LANGFUSE_CAPTURE_CONTENT` | `1` to also send prompt/completion text (truncated at 32k chars). Off by default — prompts can contain file contents; metadata (model, tokens, tool names, latency, status) is always sent when tracing is on |
| `PROXY_DUMP=1` | Dump each request/response pair to `.proxy-dump.jsonl` (contains full prompts — delete after debugging). In Colab, use the panel's **🔍 Request inspector** section instead (Enable dump → send one request → Show breakdown → Turn off & clear); `PROXY_DUMP_FILE` overrides the dump path |
| `OPENCODE_API_KEY` | Use instead of the anonymous `Bearer public` lane (paid/Go) |
| `OPENCODE_BASE` | Upstream base (default `https://opencode.ai/inference`) |
| `OPENCODE_UA` | Pin the User-Agent instead of tracking latest `@opencode/cli` |

## Repo layout

```
src/fingerprint.ts       The upstream "client fingerprint" (UA, session IDs, system prompt) — shared by everything
src/proxy.ts             The OpenAI-compatible proxy server
src/langfuse.ts          Optional Langfuse tracing via OpenTelemetry (OTLP/HTTP, no dependencies)
src/hit-model.ts         Terminal CLI for one-shot model calls and roster/probes
src/minimize-system.ts   Finds the smallest system prompt that still passes upstream
data/opencode-system.txt Captured OpenCode system-prompt template (dynamic parts filled per request)
data/opencode-tools.json The real client's tool definitions (used by hit-model.ts)
notebooks/               Colab notebook + its ipywidgets control panel (colab_panel.py)
AGENT.md                 Everything we reverse-engineered, and the playbook for when it breaks
```

## Known quirks

- **`429 FreeUsageLimitError` usually doesn't mean quota.** It's the generic rejection for a wrong fingerprint *and* the message for real quota exhaustion. If the real OpenCode CLI also fails, it's quota (wait / change IP); if the CLI works, the fingerprint has rotated — see the playbook in [AGENT.md §7](AGENT.md).
- **Streaming reasoning:** with `big-pickle`, streamed replies can include visible reasoning text; non-streaming responses separate it into `reasoning_content`.
- The proxy is **stateless**: your client resends full history each turn, and every upstream request gets a fresh session ID — multi-turn and tool calls work because of that, not despite it.
- Payloads can be large (Cursor sends ~200 KB of tools per request). The proxy logs a one-line summary per request so you can see what's flowing.

## Security

- Locally the proxy binds `127.0.0.1` only. **If you expose it through a tunnel, set `PROXY_API_KEY`** — otherwise anyone with the address can spend the free lane through your IP. (The Colab setup runs keyless by the owner's choice; the unguessable/reserved URL is the only protection. Don't share it.)
- `.proxy-dump.jsonl` and traffic captures contain full prompts and file contents: gitignored, and delete them when done.

## When it breaks

It will, eventually — upstream rotates the gate. Start with [AGENT.md](AGENT.md): §4 is the measured gate contract, §6 explains how the captures were made (and how to redo them), §7 is the step-by-step recovery playbook.

## Disclaimer

This repository is an **experiment** shared for research, learning, and personal interoperability testing only.

- It is **not affiliated with, endorsed by, or supported by** Anomaly Innovations, OpenCode, zrok, or Cloudflare. All product names belong to their respective owners.
- OpenCode's free models are offered for use through OpenCode's own client. Accessing them through other clients may conflict with OpenCode's terms of service — **you are responsible for how you use this code**, and for complying with the terms of any service you connect to it.
- There is no guarantee this works today or tomorrow: the upstream behaviour it relies on is undocumented and can change or be blocked at any time.
- Provided **as-is, without warranty of any kind**. Don't use it for production, commercial, or redistributed offerings — if you need these models seriously, use OpenCode's supported paid options.
