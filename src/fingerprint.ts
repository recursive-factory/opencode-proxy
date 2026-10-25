/**
 * fingerprint.ts — the shared OpenCode free-tier client fingerprint.
 * Used by hit-model.ts (CLI) and proxy.ts (local OpenAI-compatible server).
 *
 * Everything here was measured against https://opencode.ai/inference with
 * the real CLI (v2.1.4) as ground truth (MITM + baseURL-redirect captures,
 * one-variable-at-a-time replays):
 *   - Transport: Bun fetch passes; Node fetch -> 429 on byte-identical bytes.
 *   - User-Agent: opencode/latest/<latest @opencode/cli version>/cli
 *   - Session: ses_<12 hex><14 base62> where the hex encodes the *descending*
 *     OpenCode identifier ~(Date.now() * 0x1000 + counter) & 2^48-1.
 *     Ascending timestamps and UUIDs are decoded and rejected.
 *   - System: the full captured OpenCode agent prompt must be present
 *     (generic/truncated system prompts -> 429).
 *   - Tools: a tool literally named `read` must be present (edit/bash/fake
 *     names alone are rejected; any `read` definition passes).
 * If upstream answers 429 FreeUsageLimitError on a previously-working shape,
 * the gate has rotated: re-capture the real CLI's request and re-bisect.
 */

import { existsSync, realpathSync } from "node:fs";

export const BASE = (process.env.OPENCODE_BASE || "https://opencode.ai/inference").replace(/\/$/, "");
export const DIR = import.meta.dir;
/** Data files live in ../data (repo layout: src/ + data/) or beside this file (flat Colab copy). */
export function dataPath(name: string): string {
  for (const p of [`${DIR}/${name}`, `${DIR}/../data/${name}`]) if (existsSync(p)) return p;
  return `${DIR}/${name}`;
}
export const SYSTEM_TEMPLATE = dataPath("opencode-system.txt");
export const FALLBACK_FREE = ["big-pickle", "beam-free", "deepseek-v4.1-flash-free", "flint-40b-free", "glm-5.3-flash-free", "mimo-v2.6-flash-free", "nemotron-3.5-lightning-free", "nemotron-3.5-super-vl-free"];
export const UNSUPPORTED = new Set(["jev-1.13", "jev-1.13-free"]); // proprietary systemone endpoint
export const isFree = (id: string) => id === "big-pickle" || id.endsWith("-free");

// ---------------------------------------------------------------- session --
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
export const randB62 = (n: number) => [...crypto.getRandomValues(new Uint8Array(n))].map((b) => B62[b % 62]).join("");

/** Fresh descending OpenCode session id (one per CLI run / upstream request). */
export function freshSession(): string {
  const hex = ((~(BigInt(Date.now()) * 0x1000n + 1n)) & 0xffffffffffffn).toString(16).padStart(12, "0");
  return `ses_${hex}${randB62(14)}`;
}
const SES_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const envSession = () => {
  const s = process.env.OPENCODE_SESSION;
  return s && SES_RE.test(s) ? s : null;
};

// ------------------------------------------------------------- user-agent --
const stateFile = `${DIR}/.opencode-ids.json`;
type State = { version?: string; versionAt?: number };
async function loadState(): Promise<State> {
  try { return await Bun.file(stateFile).json(); } catch { return {}; }
}
let uaCache = process.env.OPENCODE_UA || "";
/** `opencode/latest/<latest @opencode/cli>/cli`, version cached 24h. */
export async function resolveUA(): Promise<string> {
  if (uaCache) return uaCache;
  const state = await loadState();
  if (!state.version || Date.now() - (state.versionAt || 0) > 86_400_000) {
    try {
      const r = await fetch("https://registry.npmjs.org/@opencode/cli/latest", { signal: AbortSignal.timeout(4000) });
      const v = ((await r.json()) as any)?.version;
      if (/^\d+\.\d+\.\d+/.test(v || "")) {
        state.version = v; state.versionAt = Date.now();
        await Bun.write(stateFile, JSON.stringify(state, null, 2) + "\n").catch(() => {});
      }
    } catch { /* offline: cached / last-known version */ }
  }
  return (uaCache = `opencode/latest/${state.version || "2.1.4"}/cli`);
}

// ------------------------------------------------------------ system text --
/**
 * The system prompt is built DYNAMICALLY, the way the CLI builds it per
 * session — the captured opencode-system.txt is only the template for the
 * stable harness wording. Substituted per request:
 *   - "# Your Model" block      -> the actual requested model
 *   - <available_skills>        -> live scan (see scanSkills)
 *   - "Today's date:"           -> today
 *   - <env>                     -> cwd, git?, platform, tmpdir
 * If anything dynamic fails, that region falls back to the captured text.
 */
let templateCache: string | null = null;
async function loadTemplate(): Promise<string> {
  if (templateCache !== null) return templateCache;
  try { templateCache = await Bun.file(SYSTEM_TEMPLATE).text(); }
  catch { templateCache = ""; }
  return templateCache;
}

type Skill = { id: string, name: string, description: string };
const BUILTIN_SKILLS: Skill[] = [ // shipped with the CLI, not on disk
  { id: "opencode", name: "OpenCode", description: "Use this skill for any question about OpenCode itself, including how OpenCode works, using or configuring it, migrating from V1 to V2, troubleshooting it, developing plugins or integrations, using the OpenCode SDK, clients, server, or API, and contributing to the OpenCode codebase. Also use it for OpenCode agents, commands, skills, tools, permissions, MCP servers, providers, models, themes, keybinds, formatters, the CLI, TUI, desktop app, and web app." },
  { id: "report", name: "Report", description: "Use when the user wants to report an opencode issue or bug. Collect standard diagnostics, add user-specific reproduction context, and publish the issue with GitHub CLI." },
];
let skillsCache: { at: number, skills: Skill[] } | null = null;
/**
 * Scan skill directories the way the CLI does: every <dir>/*\/SKILL.md whose
 * frontmatter does NOT set `disable-model-invocation: true`, plus built-ins.
 * Verified against a live capture: 12 on-disk + 2 built-in = the 14 the CLI sent.
 */
export async function scanSkills(): Promise<Skill[]> {
  if (skillsCache && Date.now() - skillsCache.at < 60_000) return skillsCache.skills;
  const home = process.env.HOME || "";
  const dirs = [`${process.cwd()}/.opencode/skills`, `${home}/.config/opencode/skills`, `${home}/.agents/skills`, `${home}/.claude/skills`];
  const found = new Map<string, Skill>();
  for (const dir of dirs) {
    try {
      for await (const rel of new Bun.Glob("*/SKILL.md").scan({ cwd: dir })) {
        try {
          const md = await Bun.file(`${dir}/${rel}`).text();
          const fm = md.match(/^---\n([\s\S]*?)\n---/);
          if (!fm || /disable-model-invocation:\s*true/.test(fm[1])) continue;
          // Minimal frontmatter reader: plain scalars + folded (>) / literal (|) blocks.
          const field = (k: string) => {
            const lines = fm[1].split("\n");
            const i = lines.findIndex((l) => new RegExp(`^${k}:`).test(l));
            if (i < 0) return "";
            const first = lines[i].slice(k.length + 1).trim();
            if (!/^[>|][-+]?$/.test(first)) return first.replace(/^["']|["']$/g, "");
            const block: string[] = [];
            for (let j = i + 1; j < lines.length && /^\s+\S/.test(lines[j]); j++) block.push(lines[j].trim());
            return (first.startsWith(">") ? block.join(" ") : block.join("\n")).replace(/\s+/g, " ").trim();
          };
          const id = rel.split("/")[0];
          const name = field("name") || id, description = field("description");
          if (description && !found.has(name)) found.set(name, { id, name, description });
        } catch { /* unreadable skill: skip */ }
      }
    } catch { /* dir does not exist: skip */ }
  }
  const skills = [...found.values(), ...BUILTIN_SKILLS.filter((b) => !found.has(b.name))]
    .sort((a, b) => a.id.localeCompare(b.id));
  skillsCache = { at: Date.now(), skills };
  return skills;
}

const prettyModelName = (id: string) => id.split("-").map((w) => (/^\d/.test(w) || w.length <= 1 ? w : w[0].toUpperCase() + w.slice(1))).join(" ");
const today = () => {
  const d = new Date(), days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"], months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  return `${days[d.getDay()]} ${months[d.getMonth()]} ${d.getDate()} ${d.getFullYear()}`;
};
const xmlEscape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const tmpdir = () => { try { const t = realpathSync(process.env.TMPDIR || "/tmp"); return t.endsWith("/") ? t : t + "/"; } catch { return process.env.TMPDIR || "/tmp/"; } };

/** Full system prompt for one upstream request, built fresh for `model`. */
export async function buildSystemPrompt(model: string): Promise<string> {
  let out = await loadTemplate();
  if (!out) return "";
  const skills = await scanSkills().catch(() => []);
  if (skills.length) {
    const block = `<available_skills>\n${skills.map((s) => `  <skill>\n    <id>${s.id}</id>\n    <name>${xmlEscape(s.name)}</name>\n    <description>${xmlEscape(s.description)}</description>\n  </skill>`).join("\n")}\n</available_skills>`;
    out = out.replace(/<available_skills>[\s\S]*?<\/available_skills>/, block);
  }
  const git = Bun.spawnSync(["git", "rev-parse", "--is-inside-work-tree"], { cwd: process.cwd() }).stdout.toString().trim() === "true";
  return out
    .replace(/# Your Model\n(?:- .*\n)+/, `# Your Model\n- Name: ${prettyModelName(model)}\n- Provider ID: opencode\n- Model ID: ${model}\n`)
    .replace(/Today's date: .*/, `Today's date: ${today()}`)
    .replaceAll("{{CWD}}", process.cwd())
    .replace(/Platform: .*/, `Platform: ${process.platform}`)
    .replace(/Is directory a git repo: .*/, `Is directory a git repo: ${git ? "yes" : "no"}`)
    .replace(/Prefer \/private\/var\/folders\/\S+\/T\/opencode/, `Prefer ${tmpdir()}opencode`);
}

// --------------------------------------------------------------- headers ---
const hex = (bytes: number) => [...crypto.getRandomValues(new Uint8Array(bytes))].map((b) => b.toString(16).padStart(2, "0")).join("");
/** The full header set the real CLI sends on every inference request. */
export async function upstreamHeaders(session = freshSession()): Promise<Record<string, string>> {
  const traceId = hex(16), spanId = hex(8);
  return {
    "Content-Type": "application/json",
    "User-Agent": await resolveUA(),
    Authorization: `Bearer ${process.env.OPENCODE_API_KEY || "public"}`,
    "x-opencode-client": "cli",
    // CLI stores a per-project 40-hex hash in its DB; format reproduced as
    // sha1(cwd) — the value itself is not known to be gated.
    "x-opencode-project": new Bun.CryptoHasher("sha1").update(process.cwd()).digest("hex"),
    "x-opencode-session": session,
    "x-opencode-session-id": session,
    "x-session-affinity": session,
    "x-session-id": session,
    b3: `${traceId}-${spanId}-1-${spanId}`,
    traceparent: `00-${traceId}-${spanId}-01`,
  };
}

// ---------------------------------------------------------------- models ---
/** Live free-model roster from GET {BASE}/v1/models, fallback if unreachable. */
export async function fetchFreeModels(): Promise<{ models: string[]; source: string }> {
  try {
    const r = await fetch(`${BASE}/v1/models`, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const ids = (((await r.json()) as any)?.data || []).map((m: any) => m.id).filter(Boolean) as string[];
    const free = ids.filter(isFree);
    if (free.length) return { models: free.sort(), source: `${BASE}/v1/models` };
  } catch (e) {
    console.error(`(model list fetch failed: ${(e as Error).message} — using fallback roster)`);
  }
  return { models: [...FALLBACK_FREE, "jev-1.13-free"], source: "fallback roster" };
}
