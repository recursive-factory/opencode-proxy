#!/usr/bin/env bun
/**
 * proxy.ts — expose OpenCode FREE models as a local OpenAI-compatible API
 * for downstream agents (VS Code Chat, pi.dev, …) that bring their own tools.
 *
 *   bun run proxy.ts
 *   PORT=8787 HOST=127.0.0.1 PROXY_API_KEY=optional-secret bun run proxy.ts
 *
 * Endpoints:  GET /health · GET /v1/models · POST /v1/chat/completions
 *
 * The downstream agent's system prompt, messages, and tools are forwarded
 * as-is, with three minimal gate repairs (each verified live):
 *   1. System: downstream clients (Cline / VS Code) are the agent — their
 *      system prompt is the only persona. The upstream gate is measured
 *      (2026-10-25, fresh-IP ablation) to check only an `<env>` block with
 *      a `Working directory:` line, so by default (PROXY_SYSTEM=minimal)
 *      the proxy appends just that ~60-char stub to the client system.
 *      PROXY_SYSTEM=full restores the legacy 13k OpenCode prepend; on a
 *      429 in minimal mode the proxy retries once with the full prompt
 *      and stays in full mode for 1h (gate-rotation self-heal).
 *   2. Tools: upstream requires a tool literally named `read` (verified:
 *      `edit`/`bash`/fake names alone -> 429; any `read` definition -> 200).
 *      The proxy adds NO toolset of its own — if the client has no `read`,
 *      its read-like tool (view/read_file/open/…) is renamed to `read`
 *      upstream and its tool_calls renamed back downstream. Only when the
 *      client has no read-like tool (or none at all) is a stub `read`
 *      appended, with any calls to it suppressed (client can't run it).
 *   3. Identity/transport: Bun.serve + Bun fetch (Node fetch -> 429 on
 *      byte-identical replays), fresh descending ses_ per request,
 *      latest-CLI User-Agent. See fingerprint.ts for the full evidence.
 * Client auth is ignored unless PROXY_API_KEY is set (then Bearer must match).
 */
import { appendFile } from "node:fs/promises";
import { BASE, FALLBACK_FREE, SYSTEM_TEMPLATE, buildMinimalSystem, buildSystemPrompt, isFree, upstreamHeaders } from "./fingerprint.ts";
import { deriveSessionId, langfuseEnabled, sendTrace } from "./langfuse.ts";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "127.0.0.1";
const PROXY_KEY = process.env.PROXY_API_KEY || "";
/** System-prompt mode: "minimal" (env stub, default) or "full" (13k prepend). */
const SYSTEM_MODE = (process.env.PROXY_SYSTEM || "minimal").toLowerCase() === "full" ? "full" : "minimal";
/** After a minimal-mode 429 fallback, stay in full mode until this time. */
let fullModeUntil = 0;
const effectiveSystemMode = (): "minimal" | "full" => (SYSTEM_MODE === "full" || Date.now() < fullModeUntil ? "full" : "minimal");
if (!(await Bun.file(SYSTEM_TEMPLATE).exists())) console.error("WARN: opencode-system.txt missing — upstream will likely 429 every request");

// ------------------------------------------------------------- transform ---
type AnyObj = Record<string, any>;
const toolName = (t: any): string => t?.function?.name || t?.name || "";
const setToolName = (t: any, name: string) => { if (t?.function) t.function.name = name; else if (t) t.name = name; };
const textOf = (content: any): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text || "").join("") : "";

async function transformRequest(client: AnyObj, mode: "minimal" | "full" = effectiveSystemMode()) {
  const model = String(client.model || "big-pickle").replace(/^opencode\//, "");
  const messages: any[] = Array.isArray(client.messages) ? client.messages : [];
  const clientSystem = messages.filter((m) => m?.role === "system").map((m) => textOf(m.content)).filter(Boolean).join("\n\n");
  // minimal: client system is the only persona, env stub appended (gate token).
  // full: legacy behaviour — OpenCode prompt prepended, client system follows.
  const system = mode === "full"
    ? await buildSystemPrompt(model).then((oc) => (clientSystem ? `${oc}\n\n${clientSystem}` : oc))
    : buildMinimalSystem(clientSystem);
  const upstreamMessages = [
    { role: "system", content: system },
    ...messages.filter((m) => m?.role !== "system"),
  ];

  // Tools: client's own. Upstream specifically requires one named `read`;
  // other genuine names (bash/edit/grep/…) do NOT substitute (verified).
  const tools: any[] = Array.isArray(client.tools) ? structuredClone(client.tools) : [];
  const renameBack = new Map<string, string>(); // upstream name -> client name
  let suppress = new Set<string>();             // upstream names the client cannot execute
  const names = tools.map(toolName);
  const stubRead = () => ({ type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { filePath: { type: "string" } }, required: ["filePath"] } } });
  if (tools.length === 0) {
    tools.push(stubRead());
    suppress = new Set(["read"]);
  } else if (!names.includes("read")) {
    const idx = names.findIndex((n) => /read|view|file|open|fetch.*content/i.test(n));
    if (idx >= 0) { renameBack.set("read", names[idx]); setToolName(tools[idx], "read"); }
    else { tools.push(stubRead()); suppress = new Set(["read"]); }
  }

  const body: AnyObj = {
    model, messages: upstreamMessages, tools, stream: true,
    stream_options: { include_usage: true },
    max_completion_tokens: client.max_completion_tokens || client.max_tokens || 32000,
  };
  for (const k of ["temperature", "top_p", "frequency_penalty", "presence_penalty", "stop", "tool_choice", "parallel_tool_calls", "seed"]) {
    if (client[k] !== undefined) body[k] = client[k];
  }
  return { model, body, renameBack, suppress };
}

function fixToolCalls(toolCalls: any, renameBack: Map<string, string>, suppress: Set<string>) {
  if (!Array.isArray(toolCalls)) return toolCalls;
  return toolCalls
    .filter((tc) => !suppress.has(tc?.function?.name || tc?.name))
    .map((tc) => {
      const n = tc?.function?.name || tc?.name;
      if (n && renameBack.has(n)) {
        tc = structuredClone(tc);
        if (tc.function) tc.function.name = renameBack.get(n); else tc.name = renameBack.get(n);
      }
      return tc;
    });
}

// ---------------------------------------------------------------- handlers --
const json = (obj: unknown, status = 200) => Response.json(obj, { status });
const errBody = (message: string, type = "invalid_request_error", extra: AnyObj = {}) => ({ error: { message, type, ...extra } });

async function handleChat(req: Request): Promise<Response> {
  const started = Date.now();
  let client: AnyObj;
  try { client = (await req.json()) as AnyObj; } catch { return json(errBody("invalid JSON body"), 400); }
  let sysMode = effectiveSystemMode();
  let { model, body, renameBack, suppress } = await transformRequest(client, sysMode);
  // Langfuse telemetry (no-op unless LANGFUSE_* keys are set). emit() is
  // idempotent and fire-and-forget — it never blocks the client response.
  const telSession = deriveSessionId(client, req.headers);
  const telUser = req.headers.get("x-langfuse-user-id") || (typeof client.user === "string" ? client.user : undefined);
  let telEmitted = false, telFallback = false, telFirstByte: number | undefined;
  const emit = (status: number, opts: { error?: string; outputText?: string; toolCalls?: string[]; usage?: any } = {}) => {
    if (telEmitted || !langfuseEnabled()) return;
    telEmitted = true;
    sendTrace({
      model, startedMs: started, endedMs: Date.now(), completionStartMs: telFirstByte,
      status, error: opts.error, sysMode, systemChars: textOf(body.messages?.[0]?.content).length,
      messages: body.messages || [], tools: (body.tools || []).map(toolName),
      outputText: opts.outputText || "", toolCalls: opts.toolCalls || [], usage: opts.usage ?? null,
      fallbackRetried: telFallback, clientStream: !!client.stream, sessionId: telSession, userId: telUser,
    });
  };
  if (!isFree(model)) { emit(400, { error: `model '${model}' is not a free model` }); return json(errBody(`model '${model}' is not a free model`, "invalid_request_error", { code: "model_not_free" }), 400); }
  if (model === "jev-1.13-free") { emit(400, { error: "jev-1.13-free uses an unsupported endpoint" }); return json(errBody("jev-1.13-free uses an unsupported endpoint"), 400); }

  const attempt = async (b: AnyObj) => fetch(`${BASE}/openai/v1/chat/completions`, {
    method: "POST", headers: await upstreamHeaders(), body: JSON.stringify(b), signal: AbortSignal.timeout(300_000),
  }).catch(() => null);
  let upstream = await attempt(body);
  // Gate-rotation self-heal: minimal shape rejected (429) -> retry once with
  // the full prompt and stay in full mode for 1h. A genuine quota 429 fails
  // the retry too and is returned as-is (one extra call, only on failure).
  if (upstream && upstream.status === 429 && sysMode === "minimal") {
    await upstream.text().catch(() => {});
    console.log(`↺ ${model} minimal-mode 429 — retrying with full system prompt`);
    telFallback = true;
    sysMode = "full"; fullModeUntil = Date.now() + 3_600_000;
    ({ model, body, renameBack, suppress } = await transformRequest(client, "full"));
    upstream = await attempt(body);
  }
  // One-line request summary — the fastest way to see how a client differs.
  const toolNames = (body.tools || []).map(toolName);
  const msgChars = (body.messages || []).reduce((n: number, m: any) => n + textOf(m.content).length + JSON.stringify(m.tool_calls || "").length, 0);
  const sysChars = textOf(body.messages?.[0]?.content).length;
  console.log(`→ ${model} sys=${sysMode} sysChars=${sysChars} stream=${!!client.stream} msgs=${(body.messages || []).length} chars=${msgChars} tools=[${toolNames.join(",")}] renameBack=${JSON.stringify(Object.fromEntries(renameBack))}`);
  if (process.env.PROXY_DUMP) {
    // Append one line per request (never rewrite the whole file). Panel/Colab
    // sets PROXY_DUMP_FILE so the dump lands in /content/opencode-proxy even
    // in the flat Colab layout; locally it sits beside this source file.
    const dumpFile = process.env.PROXY_DUMP_FILE || `${import.meta.dir}/.proxy-dump.jsonl`;
    const rec = JSON.stringify({ ts: new Date().toISOString(), sysMode, client, upstreamBody: body }) + "\n";
    await appendFile(dumpFile, rec).catch(() => {});
  }
  if (!upstream) { emit(502, { error: "upstream unreachable" }); return json(errBody("upstream unreachable", "upstream_error"), 502); }
  if (!upstream.ok || !upstream.body) {
    console.log(`✗ ${model} -> upstream ${upstream.status} (${Date.now() - started}ms)`);
    const errText = await upstream.text();
    emit(upstream.status, { error: errText.slice(0, 500) });
    return new Response(errText, { status: upstream.status, headers: { "Content-Type": "application/json" } });
  }
  telFirstByte = Date.now();
  console.log(`✓ ${model} client-stream=${!!client.stream} tools=${(body.tools || []).length} (${Date.now() - started}ms to first byte)`);

  if (client.stream) {
    const reader = upstream.body.getReader(), decoder = new TextDecoder(), encoder = new TextEncoder();
    let buf = "";
    // Telemetry accumulators (parsed from the same chunks we pass through).
    let sContent = "", sUsage: any = null; const sTools: string[] = [];
    const fixLine = (line: string): string => {
      const s = line.trim();
      if (!s.startsWith("data:") || s === "data: [DONE]") return line + "\n";
      try {
        const ev = JSON.parse(s.slice(5));
        if (ev.usage) sUsage = ev.usage;
        for (const ch of ev.choices || []) if (ch.delta) {
          if (typeof ch.delta.content === "string") sContent += ch.delta.content;
          ch.delta.tool_calls = fixToolCalls(ch.delta.tool_calls, renameBack, suppress);
          for (const tc of ch.delta.tool_calls || []) { const n = tc?.function?.name; if (n && !sTools.includes(n)) sTools.push(n); }
        }
        return `data: ${JSON.stringify(ev)}\n`;
      } catch { return line + "\n"; }
    };
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const { done, value } = await reader.read();
        if (done) { if (buf.trim()) controller.enqueue(encoder.encode(fixLine(buf))); controller.close(); emit(200, { outputText: sContent, toolCalls: sTools, usage: sUsage }); return; }
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n"); buf = lines.pop() ?? "";
        for (const line of lines) controller.enqueue(encoder.encode(fixLine(line)));
      },
      cancel() { emit(499, { error: "client cancelled stream", outputText: sContent, toolCalls: sTools, usage: sUsage }); reader.cancel().catch(() => {}); },
    });
    return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" } });
  }

  // Non-streaming client: assemble the SSE into one chat.completion.
  const text = await upstream.text();
  let content = "", reasoning = "", finish = "stop", usage: unknown = null, id = "chatcmpl-proxy", created = Math.floor(Date.now() / 1000);
  const calls = new Map<number, any>();
  for (const line of text.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("data:") || s === "data: [DONE]") continue;
    let ev: any; try { ev = JSON.parse(s.slice(5)); } catch { continue; }
    id = ev.id || id; created = ev.created || created; usage = ev.usage || usage;
    const ch = ev.choices?.[0]; if (!ch) continue;
    finish = ch.finish_reason || finish;
    if (typeof ch.delta?.content === "string") content += ch.delta.content;
    if (typeof ch.delta?.reasoning_content === "string") reasoning += ch.delta.reasoning_content;
    for (const tc of ch.delta?.tool_calls || []) {
      const cur = calls.get(tc.index) || { id: tc.id || `call_${tc.index}`, type: "function", function: { name: "", arguments: "" } };
      if (tc.id) cur.id = tc.id;
      if (tc.function?.name) cur.function.name += tc.function.name;
      if (tc.function?.arguments) cur.function.arguments += tc.function.arguments;
      calls.set(tc.index, cur);
    }
  }
  const toolCalls = fixToolCalls([...calls.values()], renameBack, suppress);
  emit(200, { outputText: content, toolCalls: toolCalls.map((tc: any) => tc?.function?.name || tc?.name).filter(Boolean), usage });
  return json({
    id, object: "chat.completion", created, model,
    choices: [{ index: 0, finish_reason: toolCalls.length ? "tool_calls" : finish, message: { role: "assistant", content: content || null, ...(reasoning && { reasoning_content: reasoning }), ...(toolCalls.length && { tool_calls: toolCalls }) } }],
    ...(usage ? { usage } : {}),
  });
}

Bun.serve({
  port: PORT,
  hostname: HOST,
  idleTimeout: 255, // agent turns can idle while the model thinks
  async fetch(req) {
    const url = new URL(req.url);
    try {
      if (PROXY_KEY && req.headers.get("authorization") !== `Bearer ${PROXY_KEY}` && url.pathname !== "/health")
        return json(errBody("invalid proxy API key", "auth_error"), 401);
      if (req.method === "GET" && url.pathname === "/health") return json({ ok: true, runtime: `bun ${Bun.version}` });
      if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
        try {
          const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(10_000) });
          const data = (((await r.json()) as any)?.data || []).filter((m: any) => isFree(m.id) && m.id !== "jev-1.13-free");
          if (data.length) return json({ object: "list", data });
        } catch { /* fall through to fallback */ }
        return json({ object: "list", data: FALLBACK_FREE.map((id) => ({ id, object: "model", owned_by: "opencode" })) });
      }
      if (req.method === "POST" && (url.pathname === "/v1/chat/completions" || url.pathname === "/chat/completions")) return await handleChat(req);
      return json(errBody(`no route ${req.method} ${url.pathname}`), 404);
    } catch (e) {
      return json(errBody(String((e as Error)?.message || e), "proxy_error"), 500);
    }
  },
});
console.log(`opencode-free proxy on http://${HOST}:${PORT}/v1  (bun ${Bun.version}, models: free only)`);
