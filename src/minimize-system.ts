#!/usr/bin/env bun
/**
 * minimize-system.ts — find the smallest OpenCode system-prompt prepend that
 * still passes the free-tier gate, for proxy use where the downstream client
 * (Cursor / VS Code / pi) already sends its own full system prompt.
 *
 *   bun run minimize-system.ts
 *
 * PRECONDITION: the genuine free quota must be alive — check first with
 * `opencode run "hello"`. While quota is exhausted EVERY variant returns 429
 * and the results are meaningless (learned the hard way, 2026-10-25).
 *
 * Method: build the real dynamic prompt via fingerprint.buildSystemPrompt,
 * slice it into sections, and test (a) ablations of the full prompt and
 * (b) standalone sections, each prepended to a realistic downstream request
 * (client system + client tools incl. a `read`). One variable at a time.
 * The winner should become the proxy's prepend; keep the full prompt as the
 * fallback until a minimal variant is verified here.
 */
import { BASE, buildSystemPrompt, upstreamHeaders } from "./fingerprint.ts";

const full = await buildSystemPrompt("big-pickle");
const slice = (from: string, to?: string) => {
  const a = full.indexOf(from);
  const b = to ? full.indexOf(to) : full.length;
  return a < 0 || (to && b < 0) ? "" : full.slice(a, b).trim();
};
const S = {
  head: full.slice(0, full.indexOf("## Available tools")).trim(), // intro..Code Mode (1.7k)
  tools: slice("## Available tools", "Skills provide"),           // tools catalog (4.6k)
  skills: slice("Skills provide", "Today's date:"),                // skills block (6.0k)
  tail: slice("Today's date:"),                                    // date + env (0.7k)
};
const CLIENT_SYSTEM = "You are an expert AI programming assistant inside an editor. Use your tools to read and edit files, search the codebase, and run terminal commands. Be concise and follow existing code style.";
const CLIENT_TOOLS = [
  { type: "function", function: { name: "read", description: "Read a file", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
  { type: "function", function: { name: "run_in_terminal", description: "Run a shell command", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] } } },
];

async function trial(name: string, prepend: string) {
  const system = prepend ? `${prepend}\n\n${CLIENT_SYSTEM}` : CLIENT_SYSTEM;
  const body = {
    model: "big-pickle",
    messages: [{ role: "system", content: system }, { role: "user", content: "Say hi in exactly five words." }],
    tools: CLIENT_TOOLS, stream: true, stream_options: { include_usage: true }, max_completion_tokens: 32000,
  };
  const res = await fetch(`${BASE}/openai/v1/chat/completions`, {
    method: "POST", headers: await upstreamHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(90_000),
  });
  const text = await res.text();
  console.log(`${res.status === 200 ? "✓ PASS" : "✗ fail"} ${name}: HTTP ${res.status} prepend=${prepend.length} chars ${res.status !== 200 ? text.slice(0, 90) : ""}`);
  return res.status === 200;
}

console.log(`full prompt: ${full.length} chars | head=${S.head.length} tools=${S.tools.length} skills=${S.skills.length} tail=${S.tail.length}\n`);
await trial("control: no prepend (client system only)", "");
await trial("control: full prompt", full);
// Ablations — which section is NECESSARY?
await trial("ablate: full - skills", [S.head, S.tools, S.tail].join("\n\n"));
await trial("ablate: full - tools catalog", [S.head, S.skills, S.tail].join("\n\n"));
await trial("ablate: full - head (catalog+skills+tail)", [S.tools, S.skills, S.tail].join("\n\n"));
await trial("ablate: full - tail (date/env)", [S.head, S.tools, S.skills].join("\n\n"));
// Sufficiency — which section ALONE (or pair) is enough?
await trial("only: head", S.head);
await trial("only: skills", S.skills);
await trial("only: tools catalog", S.tools);
await trial("only: head + skills", [S.head, S.skills].join("\n\n"));
await trial("only: head + tools", [S.head, S.tools].join("\n\n"));
await trial("only: skills + tail", [S.skills, S.tail].join("\n\n"));
