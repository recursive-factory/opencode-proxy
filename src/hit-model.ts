#!/usr/bin/env bun
/**
 * hit-model.ts — hit OpenCode FREE models directly from the terminal. Bun only.
 *
 *   bun hit-model.ts --list              # live free models from /inference/v1/models
 *   bun hit-model.ts [model] "prompt"    # default model: big-pickle
 *   bun hit-model.ts --probe [model]     # bisect the free-tier gate, variant by variant
 *   bun hit-model.ts --all-free "prompt" # smoke-test every free model, sequentially
 *
 * Free-only: the roster is fetched live, filtered to `*-free` + big-pickle.
 * jev-1.13-free uses a proprietary systemone endpoint and is unsupported.
 * The request fingerprint lives in fingerprint.ts — read its header first.
 * Env: OPENCODE_BASE, OPENCODE_UA, OPENCODE_SESSION, OPENCODE_API_KEY.
 */
import { BASE, UNSUPPORTED, buildSystemPrompt, dataPath, envSession, fetchFreeModels, freshSession, isFree, upstreamHeaders } from "./fingerprint.ts";
const FALLBACK_TOOL_NAMES = ["edit", "glob", "grep", "question", "read", "shell", "skill", "subagent", "webfetch", "websearch", "write", "execute"];
let CHAT_TOOLS: unknown[];
try { CHAT_TOOLS = await Bun.file(dataPath("opencode-tools.json")).json(); }
catch {
  CHAT_TOOLS = FALLBACK_TOOL_NAMES.map((name) => ({
    type: "function",
    function: { name, description: name, parameters: { type: "object", properties: { input: { type: "string" } } } },
  }));
}

type HitOpts = { session?: string; ua?: string; auth?: boolean; stream?: boolean; tools?: boolean; system?: boolean; timeoutMs?: number };
type HitResult = { status: number; ms: number; text: string; error: string };

async function hit(model: string, prompt: string, opts: HitOpts = {}): Promise<HitResult> {
  const headers: Record<string, string> = {
    ...(await upstreamHeaders(opts.session ?? envSession() ?? freshSession())),
    ...(opts.ua ? { "User-Agent": opts.ua } : {}),
  };
  if (opts.auth === false) delete headers.Authorization;
  const stream = opts.stream !== false;
  const system = opts.system !== false ? await buildSystemPrompt(model) : "";
  const body = {
    model,
    messages: [...(system ? [{ role: "system", content: system }] : []), { role: "user", content: prompt }],
    stream,
    ...(stream && { stream_options: { include_usage: true } }),
    ...(opts.tools !== false && { tools: CHAT_TOOLS }),
    max_completion_tokens: 32000,
  };
  const started = Date.now();
  const res = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(opts.timeoutMs || 90_000),
  });
  const ms = () => Date.now() - started;
  if (!res.ok) return { status: res.status, ms: ms(), text: "", error: (await res.text()).slice(0, 500) };

  if ((res.headers.get("content-type") || "").includes("text/event-stream") && res.body) {
    let text = "";
    const reader = res.body.getReader(), decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const line of lines) {
        const s = line.trim();
        if (!s.startsWith("data:") || s === "data: [DONE]") continue;
        try {
          const c = (JSON.parse(s.slice(5)) as any).choices?.[0]?.delta?.content;
          if (typeof c === "string") text += c;
        } catch { /* keep-alive / usage chunk */ }
      }
    }
    return { status: res.status, ms: ms(), text, error: "" };
  }
  const json: any = await res.json().catch(() => null);
  const c = json?.choices?.[0]?.message?.content;
  return { status: res.status, ms: ms(), text: typeof c === "string" ? c : "", error: json ? "" : "non-JSON response" };
}

// -------------------------------------------------------------------- CLI ---
const args = Bun.argv.slice(2);
const flag = (name: string) => { const i = args.indexOf(name); return i >= 0 ? (args.splice(i, 1), true) : false; };
const list = flag("--list"), probe = flag("--probe"), allFree = flag("--all-free");
if (flag("--help") || (!list && !probe && !allFree && args.length === 0)) {
  console.log('Usage: bun hit-model.ts --list\n       bun hit-model.ts [model] "prompt"\n       bun hit-model.ts --probe [model]\n       bun hit-model.ts --all-free "prompt"');
  process.exit(1);
}

const { models: FREE_MODELS, source } = await fetchFreeModels();
const supported = FREE_MODELS.filter((m) => !UNSUPPORTED.has(m));
const show = (model: string, r: HitResult) => console.log(r.status === 200
  ? `✓ ${model}  ${r.status}  ${r.ms}ms\n${r.text.trim() || "(empty text — model may have attempted a tool call)"}`
  : `✗ ${model}  ${r.status}  ${r.ms}ms\n${r.error}`);

if (list) {
  console.log(`Free models (from ${source}):`);
  for (const m of FREE_MODELS) console.log(`  ${m}${UNSUPPORTED.has(m) ? "  (unsupported: systemone endpoint)" : ""}`);
  process.exit(0);
}

if (probe) {
  const model = args[0] || "big-pickle";
  const variants: [string, HitOpts][] = [
    ["full contract (captured CLI fingerprint)", {}],
    ["no system prompt (plain chat)", { system: false }],
    ["no tools", { tools: false }],
    ["stream: false", { stream: false }],
    ["UUID session (original snippet)", { session: "123e4567-e89b-12d3-a456-426614174000" }],
    ["old User-Agent: opencode/latest/1.3.15/cli", { ua: "opencode/latest/1.3.15/cli" }],
    ["no Authorization header", { auth: false }],
  ];
  console.log(`Probing ${model} @ ${BASE}/openai/v1/chat/completions  (runtime: bun ${Bun.version})\n`);
  for (const [name, v] of variants) {
    try { const r = await hit(model, "Say hi in exactly five words.", v); console.log(`${r.status === 200 ? "✓" : "✗"} ${name}: HTTP ${r.status} ${r.ms}ms${r.error ? " — " + r.error.slice(0, 160) : ""}`); }
    catch (e) { console.log(`✗ ${name}: ${(e as Error).message}`); }
  }
  process.exit(0);
}

if (allFree) {
  const prompt = args.join(" ") || "Say hi in exactly five words.";
  let ok = 0;
  for (const model of FREE_MODELS) {
    if (UNSUPPORTED.has(model)) { console.log(`– ${model}  skipped (unsupported: systemone endpoint)\n---`); continue; }
    try { const r = await hit(model, prompt); show(model, r); if (r.status === 200) ok++; } catch (e) { console.log(`✗ ${model}  ${(e as Error).message}`); }
    console.log("---");
  }
  console.log(`${ok}/${supported.length} supported free models answered`);
  process.exit(ok ? 0 : 2);
}

const model = args[0] || "big-pickle";
const prompt = args.length > 1 ? args.slice(1).join(" ") : "Say hi in exactly five words.";
if (!isFree(model)) { console.error(`✗ '${model}' is not a free model (this script is free-only; --list shows the roster)`); process.exit(1); }
if (UNSUPPORTED.has(model)) { console.error(`✗ '${model}' uses the proprietary systemone endpoint — not supported`); process.exit(1); }
if (!FREE_MODELS.includes(model)) console.error(`(note: '${model}' not in live free list from ${source} — trying anyway)`);
try {
  const r = await hit(model, prompt);
  show(model, r);
  process.exit(r.status === 200 ? 0 : 2);
} catch (e) {
  console.error(`✗ ${model}  ${(e as Error).name === "TimeoutError" ? "timed out" : (e as Error).message}`);
  process.exit(2);
}
