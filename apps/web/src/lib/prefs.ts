import { persisted, type Fields } from "./persist";

// The remembered groups that are not the window's own view (uiStore.ts) or its
// folds (disclosure.ts). Each one's fields are checked here, on the way in from
// the file, so a bad one falls back to its default alone.

const str = (v: unknown, max = 4096): string | undefined => (typeof v === "string" && v.length <= max ? v : undefined);
const isObj = (v: unknown): v is Fields => !!v && typeof v === "object" && !Array.isArray(v);
const strings = (v: unknown, max: number): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length <= 4096).slice(0, max) : []);
/** Only the fields `pick` keeps a value for. */
const only = (fields: Fields, pick: (k: string, v: unknown) => unknown): Fields => {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) { const x = pick(k, v); if (x !== undefined) out[k] = x; }
  return out;
};

// ── voice: the pipeline (lib/live/pipelineConfig.ts) and Chat's old push-to-talk switch (lib/flow/useFlowConfig.ts settles the talk mode from it) ──

export interface VoicePrefs {
  /** The saved pipeline config as written; mergePipelineConfig checks it on every read. */
  pipeline: Fields | null;
  pttEnabled: boolean;
}
export const useVoicePrefs = persisted<VoicePrefs>("voice", () => ({ pipeline: null, pttEnabled: false }), {
  partialize: (s) => ({ pipeline: s.pipeline, pttEnabled: s.pttEnabled }),
  clean: (f) => only(f, (k, v) =>
    k === "pipeline" ? (isObj(v) ? v : undefined)
    : k === "pttEnabled" ? (typeof v === "boolean" ? v : undefined)
    : undefined) as Partial<VoicePrefs>,
});

// ── sessions: per chat and per agent picks (lib/live/useLiveSession.ts) ──
// One field per chat and per agent, so two windows saving different chats
// both land.

export interface ChatPrefs { bind?: string; cwd?: string; resume?: string }
export interface AgentPrefs { meta?: Fields; model?: string; mode?: string; opts?: Record<string, string> }
export type SessionPrefs = { recentFolders: string[] } & { [k: `chat:${string}`]: ChatPrefs | undefined } & { [k: `agent:${string}`]: AgentPrefs | undefined };

/** Chats remembered at most; past it the oldest pick goes. A forgotten chat
 *  only loses its agent and folder, which History still knows. */
export const CHAT_PREFS_MAX = 500;

function chatPrefs(v: unknown): ChatPrefs | undefined {
  if (!isObj(v)) return undefined;
  const out = only(v, (k, x) => (k === "bind" || k === "cwd" || k === "resume" ? str(x) : undefined));
  return Object.keys(out).length ? out : undefined;
}
function agentPrefs(v: unknown): AgentPrefs | undefined {
  if (!isObj(v)) return undefined;
  const out = only(v, (k, x) =>
    k === "meta" ? (isObj(x) ? x : undefined)
    : k === "model" || k === "mode" ? str(x, 512)
    : k === "opts" ? (isObj(x) ? only(x, (_, y) => str(y, 512)) : undefined)
    : undefined);
  return Object.keys(out).length ? out : undefined;
}
export function cleanSessions(f: Fields): Partial<SessionPrefs> {
  return only(f, (k, v) =>
    k === "recentFolders" ? strings(v, 8)
    : k.startsWith("chat:") ? chatPrefs(v)
    : k.startsWith("agent:") ? agentPrefs(v)
    : undefined) as Partial<SessionPrefs>;
}

export const useSessionPrefs = persisted<SessionPrefs>("sessions", () => ({ recentFolders: [] }), {
  partialize: (s) => s as Fields,
  clean: cleanSessions,
});

/** Merge into one chat's picks, keeping the newest CHAT_PREFS_MAX chats. O(chats) when a new chat pushes one out. */
export function setChatPrefs(chatId: string, patch: ChatPrefs): void {
  useSessionPrefs.setState((s) => {
    const key = `chat:${chatId}` as const;
    const next = { ...s, [key]: { ...s[key], ...patch } } as SessionPrefs;
    if (s[key]) return next;
    const chats = Object.keys(next).filter((k) => k.startsWith("chat:"));
    for (const k of chats.slice(0, Math.max(0, chats.length - CHAT_PREFS_MAX))) delete (next as Fields)[k];
    return next;
  }, true);
}
export const chatPrefsOf = (chatId: string): ChatPrefs => useSessionPrefs.getState()[`chat:${chatId}`] ?? {};

export function setAgentPrefs(agentId: string, patch: AgentPrefs): void {
  useSessionPrefs.setState((s) => {
    const key = `agent:${agentId}` as const;
    const cur = s[key] ?? {};
    return { [key]: { ...cur, ...patch, opts: { ...cur.opts, ...patch.opts } } } as unknown as Partial<SessionPrefs>;
  });
}
export const agentPrefsOf = (agentId: string): AgentPrefs => useSessionPrefs.getState()[`agent:${agentId}`] ?? {};

// ── onboarding: Welcome, Flow's and Dictate's first runs (lib/flow/onboarding.ts, DictateHome) and the tours (SpotlightTour) ──

export interface OnboardingPrefs {
  welcomed: boolean;
  /** Flow's first-run flag, see lib/flow/onboarding.ts; null before it starts. */
  flowOnboarded: string | null;
  /** Dictate's first run on its home was finished or skipped. */
  dictateOnboarded: boolean;
  /** Tour ids already played. */
  tours: string[];
}
const NEVER_ONBOARDED = (): OnboardingPrefs => ({ welcomed: false, flowOnboarded: null, dictateOnboarded: false, tours: [] });
export const useOnboarding = persisted<OnboardingPrefs>("onboarding", NEVER_ONBOARDED, {
  partialize: (s) => ({ welcomed: s.welcomed, flowOnboarded: s.flowOnboarded, dictateOnboarded: s.dictateOnboarded, tours: s.tours }),
  clean: (f) => only(f, (k, v) =>
    k === "welcomed" || k === "dictateOnboarded" ? (typeof v === "boolean" ? v : undefined)
    : k === "flowOnboarded" ? str(v, 32)
    : k === "tours" ? strings(v, 200)
    : undefined) as Partial<OnboardingPrefs>,
});

/** Show me around again: Welcome, Flow's setup, Dictate's first run and every tour play again, as for someone new. */
export function resetOnboarding(): void { useOnboarding.setState(NEVER_ONBOARDED()); }
