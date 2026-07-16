"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, ChevronRight, Download, Trash2, LogIn, Loader2 } from "lucide-react";
import { api, type AgentStatus } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import { usePersistedOpen } from "@/lib/disclosure";
import { useAgentActions } from "@/lib/agentActions";
import type { AgentId } from "@/lib/live/liveClient";
import { cn } from "@/lib/cn";

function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

// The default ACP adapter command per agent (shown as the override placeholder).
// Verified 2026-07-15: ACP moved off the deprecated @zed-industries/* packages to
// the vendor-neutral @agentclientprotocol/* org; Cursor's binary is now `agent`.
const DEFAULT_CMD: Record<string, string> = {
  "claude-code": "npx -y @agentclientprotocol/claude-agent-acp",
  "codex": "npx -y @agentclientprotocol/codex-acp",
  "cursor": "agent acp",
};

export function AgentsSettings() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["agents"], queryFn: api.agents });

  return (
    <div className="flex flex-col gap-7">
      <Section title="Coding agents"
        desc={<>Talk to Claude Code, Codex, or Cursor by voice. Each runs on <span className="text-foreground">your own machine with your own login</span> — OpenLive drives it locally over ACP and never sees your agent&apos;s data. Pick one per conversation from the &ldquo;Talk to&rdquo; menu, and choose its project folder + mode when you start the call.</>}>
        <div />
      </Section>

      <Section title="Manage agents"
        desc={<>Install, sign in to, or remove each agent&apos;s CLI right here — everything runs on your machine, and keeps running if you leave this panel. Sign-in opens the agent&apos;s own browser login. To <span className="text-foreground">resume</span> a conversation, open it from History; OpenLive replays it into the agent via ACP.</>}>
        <div className="flex flex-col gap-2.5">
          {isLoading && <p className="text-[12px] text-muted-foreground">Checking…</p>}
          {agents.map((a) => (
            <AgentRow key={a.id} a={a} cmd={(settings?.[`acpCommand:${a.id}`] as string) ?? ""} />
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

// One agent: install / sign-in / uninstall (streamed via the background store, so it
// survives closing this panel), plus the advanced ACP-command override (remembers
// open/closed). Mode/posture is chosen per-call, not here.
function AgentRow({ a, cmd }: { a: AgentStatus; cmd: string }) {
  const qc = useQueryClient();
  const run = useAgentActions((s) => s.runs[a.id]);
  const start = useAgentActions((s) => s.run);
  const [advOpen, setAdvOpen] = usePersistedOpen(`agents:adv:${a.id}`);
  const [confirmUn, setConfirmUn] = useState(false);

  // When a background action finishes, re-check installed status.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run?.running) qc.invalidateQueries({ queryKey: ["agents"] });
    wasRunning.current = !!run?.running;
  }, [run?.running, qc]);

  const saveCmd = (v: string) => { if (v !== cmd) api.updateSettings({ [`acpCommand:${a.id}`]: v }).then(() => qc.invalidateQueries({ queryKey: ["settings"] })); };

  const busy = !!run?.running;
  const running = run?.running ? run.action : null;
  const btn = "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition disabled:opacity-40";

  return (
    <div className="rounded-xl border border-border bg-card p-3">
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
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!a.installed && (
              <button onClick={() => start(a.id, "install")} disabled={busy}
                className={cn(btn, "border-transparent bg-accent text-accent-foreground hover:opacity-90")}>
                {running === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Install
              </button>
            )}
            {a.installed && (
              <button onClick={() => start(a.id, "login")} disabled={busy}
                className={cn(btn, "border-border text-foreground hover:border-border-heavy")}>
                {running === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} Sign in
              </button>
            )}
            {a.installed && (
              <button
                onClick={() => (confirmUn ? (setConfirmUn(false), start(a.id, "uninstall")) : setConfirmUn(true))}
                disabled={busy} onBlur={() => setConfirmUn(false)}
                className={cn(btn, confirmUn ? "border-danger/50 bg-danger/10 text-danger" : "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                {running === "uninstall" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} {confirmUn ? "Confirm?" : "Uninstall"}
              </button>
            )}
          </div>
        </div>
      </div>

      {run && (run.running || run.log) && (
        <pre className="openlive-scroll mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-2.5 font-mono text-[11px] leading-relaxed text-muted-foreground">{run.log || "Starting…"}</pre>
      )}

      <details open={advOpen} onToggle={(e) => setAdvOpen(e.currentTarget.open)} className="group mt-2.5 border-t border-border pt-2.5">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[11px] text-muted-foreground transition hover:text-foreground [&::-webkit-details-marker]:hidden">
          <ChevronRight className="size-3 transition group-open:rotate-90" /> Advanced · ACP command
        </summary>
        <div className="mt-2 space-y-1">
          <input defaultValue={cmd} onBlur={(e) => saveCmd(e.target.value.trim())}
            placeholder={DEFAULT_CMD[a.id] ?? "custom acp command"} spellCheck={false}
            className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 font-mono text-[11.5px] text-foreground outline-none focus:border-border-heavy" />
          <p className="text-[10.5px] leading-relaxed text-faint">The command OpenLive runs to speak ACP with {a.label} over the Agent Client Protocol. Leave blank for the default; change it if the ecosystem package moves.</p>
        </div>
      </details>
    </div>
  );
}
