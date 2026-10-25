/**
 * langfuse.ts — optional Langfuse tracing via OpenTelemetry (OTLP/HTTP JSON).
 *
 * No SDK and no dependencies: one POST per completed request to
 *   {LANGFUSE_BASE_URL}/api/public/otel/v1/traces     (Basic pk:sk auth)
 * Docs: https://langfuse.com/integrations/native/opentelemetry
 *
 * Disabled unless both LANGFUSE_PUBLIC_KEY and LANGFUSE_SECRET_KEY are set.
 * Every request is traced (no sampling). Trace shape: a root span
 * `opencode-proxy/chat` + one child `generation` span carrying the model,
 * usage and cost, so Langfuse can aggregate tokens/cost per model/session.
 *
 * Sessions: traces are grouped by `langfuse.session.id`, resolved in order:
 *   1. `x-langfuse-session-id` request header (or body session_id / metadata)
 *   2. derived `conv_<hash>` of the first user message — the downstream
 *      client (Cline / VS Code) resends full history every turn, so the
 *      first user message is a stable conversation key across turns
 *   3. upstream session id is NOT used (it is fresh per request by design)
 *
 * Usage/cost: upstream `usage` is mapped to `langfuse.observation.usage_details`
 * ({input, output, total, cached_tokens, reasoning_tokens}). Free models have
 * no price, so `cost_details` is sent explicitly as 0 — Langfuse then shows a
 * real $0 instead of "unknown cost", and token totals still aggregate.
 *
 * Content: prompts can contain file contents/tool results, so message and
 * completion text are only sent with LANGFUSE_CAPTURE_CONTENT=1 (truncated).
 * Metadata (model, tokens, tool names, sizes, latency, status) is always sent.
 */
import { createHash } from "node:crypto";

type AnyObj = Record<string, any>;

const HOST = (process.env.LANGFUSE_BASE_URL || process.env.LANGFUSE_HOST || "https://cloud.langfuse.com").replace(/\/$/, "");
const PK = process.env.LANGFUSE_PUBLIC_KEY || "";
const SK = process.env.LANGFUSE_SECRET_KEY || "";
export const langfuseEnabled = () => Boolean(PK && SK);
const CAPTURE_CONTENT = /^(1|true|yes)$/i.test(process.env.LANGFUSE_CAPTURE_CONTENT || "");
const ENV_NAME = (process.env.LANGFUSE_ENVIRONMENT || "production").replace(/[^a-z0-9-_]/gi, "-").toLowerCase();
const MAX_CONTENT = 32_000;

const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
const nano = (ms: number) => (BigInt(Math.round(ms)) * 1_000_000n).toString();
const trunc = (s: string) => (s.length > MAX_CONTENT ? s.slice(0, MAX_CONTENT) + `…[truncated ${s.length - MAX_CONTENT} chars]` : s);

type Attr = { key: string; value: AnyObj };
const str = (key: string, v: string): Attr => ({ key, value: { stringValue: v } });
const int = (key: string, v: number): Attr => ({ key, value: { intValue: String(Math.round(v)) } });
const bool = (key: string, v: boolean): Attr => ({ key, value: { boolValue: v } });

const textOf = (content: any): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p) => p?.text || "").join("") : "";

/** Session id for grouping traces of one downstream conversation in Langfuse. */
export function deriveSessionId(client: AnyObj, headers: Headers): string {
  const fromBody = client?.session_id || client?.metadata?.session_id || client?.metadata?.langfuse_session_id;
  const explicit = headers.get("x-langfuse-session-id") || headers.get("x-session-id") || fromBody;
  if (explicit && String(explicit).length <= 200) return String(explicit);
  const firstUser = (Array.isArray(client?.messages) ? client.messages : []).find((m: any) => m?.role === "user");
  const seed = firstUser ? textOf(firstUser.content) : "";
  if (seed) return `conv_${createHash("sha256").update(seed).digest("hex").slice(0, 24)}`;
  return `req_${hex(12)}`;
}

export type TraceInput = {
  model: string;
  startedMs: number;          // Date.now() at request start
  endedMs: number;
  completionStartMs?: number; // first upstream byte (TTFT for the generation)
  status: number;             // upstream/final HTTP status
  error?: string;
  sysMode: string;
  systemChars: number;
  messages: any[];            // upstream messages actually sent to the model
  tools: string[];            // upstream tool names
  outputText: string;
  toolCalls: string[];        // client-facing tool names called
  usage: AnyObj | null;       // upstream usage object, if any
  fallbackRetried: boolean;
  clientStream: boolean;
  sessionId: string;
  userId?: string;
};

/** Fire-and-forget: never blocks or fails the client response. */
export function sendTrace(t: TraceInput): void {
  if (!langfuseEnabled()) return;
  try {
    const traceId = hex(16), rootId = hex(8), genId = hex(8);
    const usage = t.usage || {};
    const inputTokens = Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) || 0;
    const outputTokens = Number(usage.completion_tokens ?? usage.output_tokens ?? 0) || 0;
    const cached = Number(usage.prompt_tokens_details?.cached_tokens ?? usage.opencode?.tokens?.cache_read ?? 0) || 0;
    const reasoning = Number(usage.completion_tokens_details?.reasoning_tokens ?? usage.opencode?.tokens?.reasoning ?? 0) || 0;
    const usageDetails: AnyObj = { input: inputTokens, output: outputTokens, total: Number(usage.total_tokens ?? inputTokens + outputTokens) || 0 };
    if (cached) usageDetails.cached_tokens = cached;
    if (reasoning) usageDetails.reasoning_tokens = reasoning;

    const output = CAPTURE_CONTENT
      ? trunc(JSON.stringify({ content: t.outputText, ...(t.toolCalls.length && { tool_calls: t.toolCalls }) }))
      : JSON.stringify({ tool_calls: t.toolCalls, content_chars: t.outputText.length });
    const input = CAPTURE_CONTENT
      ? trunc(JSON.stringify(t.messages))
      : JSON.stringify({ messages: t.messages.length, system_chars: t.systemChars, tools: t.tools });

    // Trace-level attributes are set on BOTH spans (Langfuse recommends
    // propagating them to every span for reliable filtering/aggregation).
    const traceAttrs: Attr[] = [
      str("langfuse.trace.name", "opencode-proxy/chat"),
      str("langfuse.session.id", t.sessionId),
      str("langfuse.environment", ENV_NAME),
      ...(t.userId ? [str("langfuse.user.id", t.userId)] : []),
      str("langfuse.trace.metadata.sys_mode", t.sysMode),
      str("langfuse.trace.metadata.model", t.model),
    ];
    const rootSpan: AnyObj = {
      traceId, spanId: rootId, name: "opencode-proxy/chat", kind: 2,
      startTimeUnixNano: nano(t.startedMs), endTimeUnixNano: nano(t.endedMs),
      attributes: [
        ...traceAttrs,
        str("langfuse.observation.type", "span"),
        str("langfuse.trace.input", input), str("langfuse.trace.output", output),
        int("http.response.status_code", t.status),
        int("proxy.latency_ms", t.endedMs - t.startedMs),
        bool("proxy.fallback_retried", t.fallbackRetried),
        bool("proxy.client_stream", t.clientStream),
        ...(t.error ? [str("langfuse.observation.level", "ERROR"), str("langfuse.observation.status_message", trunc(t.error))] : []),
      ],
      status: t.status >= 400 ? { code: 2, message: t.error || `HTTP ${t.status}` } : { code: 1 },
    };
    const genSpan: AnyObj = {
      traceId, spanId: genId, parentSpanId: rootId, name: `chat ${t.model}`, kind: 2,
      startTimeUnixNano: nano(t.startedMs), endTimeUnixNano: nano(t.endedMs),
      attributes: [
        ...traceAttrs,
        str("langfuse.observation.type", "generation"),
        str("langfuse.observation.model.name", t.model),
        str("gen_ai.request.model", t.model),
        str("langfuse.observation.input", input),
        str("langfuse.observation.output", output),
        str("langfuse.observation.usage_details", JSON.stringify(usageDetails)),
        int("gen_ai.usage.input_tokens", usageDetails.input),
        int("gen_ai.usage.output_tokens", usageDetails.output),
        // Free models: explicit $0 so Langfuse aggregates a real zero cost.
        str("langfuse.observation.cost_details", JSON.stringify({ input: 0, output: 0, total: 0 })),
        ...(t.completionStartMs ? [str("langfuse.observation.completion_start_time", new Date(t.completionStartMs).toISOString())] : []),
        ...(t.error ? [str("langfuse.observation.level", "ERROR"), str("langfuse.observation.status_message", trunc(t.error))] : []),
      ],
      status: t.status >= 400 ? { code: 2, message: t.error || `HTTP ${t.status}` } : { code: 1 },
    };
    const payload = {
      resourceSpans: [{
        resource: { attributes: [str("service.name", "opencode-proxy"), str("deployment.environment.name", ENV_NAME)] },
        scopeSpans: [{ scope: { name: "opencode-proxy", version: "1.0.0" }, spans: [rootSpan, genSpan] }],
      }],
    };
    fetch(`${HOST}/api/public/otel/v1/traces`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Basic ${btoa(`${PK}:${SK}`)}`,
        "x-langfuse-ingestion-version": "4",
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5_000),
    }).then(async (r) => {
      if (!r.ok) console.log(`⚠ langfuse export ${r.status}: ${(await r.text().catch(() => "")).slice(0, 160)}`);
    }).catch((e) => console.log(`⚠ langfuse export failed: ${(e as Error).message}`));
  } catch (e) {
    console.log(`⚠ langfuse export failed: ${(e as Error).message}`);
  }
}
