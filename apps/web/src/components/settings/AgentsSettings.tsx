"use client";

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderOpen, Check, RefreshCw, ChevronRight } from "lucide-react";
import { api } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import type { AgentId } from "@/lib/live/liveClient";

function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

// Desktop-only native folder picker (falls back to the text field on web).
const bridge = (): ((op: string, arg?: string) => Promise<string>) | undefined =>
  (typeof window !== "undefined" ? (window as unknown as { openlive?: { bridge?: (op: string, arg?: string) => Promise<string> } }).openlive?.bridge : undefined);

// Install/sign-in hint shown when an agent's CLI isn't found on PATH.
const INSTALL: Record<string, string> = {
  "claude-code": "npm i -g @anthropic-ai/claude-code",
  "codex": "npm i -g @openai/codex",
  "cursor": "curl https://cursor.com/install -fsS | bash",
};

// The default ACP adapter command per agent (shown as the override placeholder).
const DEFAULT_CMD: Record<string, string> = {
  "claude-code": "npx -y @zed-industries/claude-code-acp",
  "codex": "npx -y @zed-industries/codex-acp",
  "cursor": "cursor-agent acp",
};

export function AgentsSettings() {
  const qc = useQueryClient();
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["agents"], queryFn: api.agents });
  const home = agents[0]?.home ?? "~";

  const saved = settings?.agentCwd ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = useMutation({
    mutationFn: (v: string) => api.updateSettings({ agentCwd: v }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["settings"] }); setDraft(null); },
  });
  const commit = () => { if ((draft ?? "") !== saved) save.mutate(draft ?? ""); };
  const browse = async () => { const b = bridge(); if (!b) return; const p = await b("pick_folder"); if (p) { setDraft(p); save.mutate(p); } };

  const posture = (id: string) => (settings?.[`posture:${id}`] as string) ?? "ask";
  const savePosture = useMutation({
    mutationFn: ({ id, v }: { id: string; v: string }) => api.updateSettings({ [`posture:${id}`]: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });
  const cmd = (id: string) => (settings?.[`acpCommand:${id}`] as string) ?? "";
  const saveCmd = useMutation({
    mutationFn: ({ id, v }: { id: string; v: string }) => api.updateSettings({ [`acpCommand:${id}`]: v }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["settings"] }),
  });

  return (
    <div className="flex flex-col gap-7">
      <Section title="Coding agents"
        desc={<>Talk to Claude Code, Codex, or Cursor by voice. Each runs on <span className="text-foreground">your own machine with your own login</span> — OpenLive drives it locally over ACP and never sees your agent&apos;s data. Pick one per conversation from the &ldquo;Talk to&rdquo; menu in the top bar or the pre-call screen.</>}>
        <div />
      </Section>

      <Section title="Project folder"
        desc={<>Where a bound agent reads and writes — <span className="text-foreground">its file-access scope</span>. It can only touch files here (and asks permission before changes). Leave blank to use your home folder.</>}>
        <div className="flex items-center gap-2">
          <input value={value} onChange={(e) => setDraft(e.target.value)} onBlur={commit}
            onKeyDown={(e) => { if (e.key === "Enter") commit(); }} placeholder={home} spellCheck={false}
            className="h-9 flex-1 rounded-lg border border-border bg-card px-3 font-mono text-[12px] text-foreground outline-none focus:border-border-heavy" />
          {bridge() && (
            <button onClick={browse} className="flex h-9 items-center gap-1.5 rounded-lg border border-border px-3 text-[12.5px] text-muted-foreground transition hover:border-border-heavy hover:text-foreground">
              <FolderOpen className="size-4" /> Browse…
            </button>
          )}
        </div>
        {save.isSuccess && <p className="mt-1.5 text-[11.5px] text-success">Saved · applies to the next agent you start.</p>}
      </Section>

      <Section title="CLI status"
        desc={<>Whether each agent&apos;s CLI is installed here, and where it keeps its session files on disk. To <span className="text-foreground">resume</span> a conversation, open it from History — OpenLive replays it into the agent via ACP.</>}>
        <div className="flex flex-col gap-2.5">
          {isLoading && <p className="text-[12px] text-muted-foreground">Checking…</p>}
          {agents.map((a) => (
            <div key={a.id} className="rounded-xl border border-border bg-card p-3">
              <div className="flex items-start gap-3">
                <AgentIcon id={a.id as AgentId} className="mt-0.5 size-5 shrink-0 text-foreground" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
                    {a.label}
                    {a.installed
                      ? <span className="flex items-center gap-1 text-[11.5px] font-normal text-success"><Check className="size-3.5" /> installed</span>
                      : <span className="text-[11.5px] font-normal text-muted-foreground">— not found</span>}
                  </div>
                  <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">session store · {a.sessions}</p>
                  {!a.installed && INSTALL[a.id] && (
                    <p className="mt-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      Set up: <code className="rounded bg-foreground/[0.06] px-1 py-0.5 font-mono text-[11px] text-foreground">{INSTALL[a.id]}</code>, then sign in with your account.
                    </p>
                  )}
                </div>
                <label className="flex shrink-0 flex-col items-end gap-1">
                  <span className="text-[10px] uppercase tracking-wide text-faint">Auto-approve</span>
                  <select value={posture(a.id)} onChange={(e) => savePosture.mutate({ id: a.id, v: e.target.value })}
                    className="h-8 rounded-lg border border-border bg-surface px-2 text-[12px] text-foreground outline-none focus:border-border-heavy">
                    <option value="ask">Ask every time</option>
                    <option value="auto-safe">Safe ops</option>
                    <option value="auto-all">Everything</option>
                  </select>
                </label>
              </div>
              <details className="group mt-2.5 border-t border-border pt-2.5">
                <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground transition hover:text-foreground [&::-webkit-details-marker]:hidden">
                  <ChevronRight className="size-3 transition group-open:rotate-90" /> Advanced · ACP command
                </summary>
                <div className="mt-2 space-y-1">
                  <input defaultValue={cmd(a.id)} onBlur={(e) => { const v = e.target.value.trim(); if (v !== cmd(a.id)) saveCmd.mutate({ id: a.id, v }); }}
                    placeholder={DEFAULT_CMD[a.id] ?? "custom acp command"} spellCheck={false}
                    className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 font-mono text-[11.5px] text-foreground outline-none focus:border-border-heavy" />
                  <p className="text-[10.5px] leading-relaxed text-faint">The command OpenLive runs to speak ACP with {a.label} over the Agent Client Protocol. Leave blank for the default; change it if the ecosystem package moves.</p>
                </div>
              </details>
            </div>
          ))}
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 self-start text-[12px] text-muted-foreground transition hover:text-foreground disabled:opacity-50">
            <RefreshCw className={isFetching ? "size-3.5 animate-spin" : "size-3.5"} /> Re-check
          </button>
        </div>
      </Section>
    </div>
  );
}
