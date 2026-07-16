"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, ChevronRight, Download, Trash2, LogIn, LogOut, Loader2 } from "lucide-react";
import { adapterCommand, isAgentId } from "@openlive/shared";
import { api, type AgentStatus } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import { usePersistedOpen } from "@/lib/disclosure";
import { useAgentActions } from "@/lib/agentActions";
import type { AgentId } from "@/lib/live/liveClient";
import { cn } from "@/lib/cn";
import { Section } from "./Section";

export function AgentsSettings() {
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // Re-probe on window focus: sign-in/out finishes in a separate terminal, so
  // coming back to the app should reflect the new state without a manual click.
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchOnWindowFocus: true });

  return (
    <div className="flex flex-col gap-7">
      <Section title="Coding agents"
        desc={<>Talk to Claude Code, Codex, Cursor, OpenCode, or Hermes by voice. Each runs on <span className="text-foreground">your own machine with your own login</span> — OpenLive drives it locally over ACP and never sees your agent&apos;s data. Pick one per conversation from the &ldquo;Talk to&rdquo; menu, and choose its project folder + mode when you start the call.</>}>
        <div />
      </Section>

      <Section title="Manage agents"
        desc={<>Install, sign in to, or remove each agent&apos;s CLI right here — everything runs on your machine, and keeps running if you leave this panel. Sign-in and sign-out open the agent&apos;s own flow in a terminal. Toggle an agent off to hide it from the pickers and History (its sessions stay on disk).</>}>
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

/** The row's single readiness verdict, derived from install + credential probes. */
function statusChip(a: AgentStatus) {
  if (!a.installed) return { text: "Not installed", cls: "text-muted-foreground" };
  if (a.credState === "ready") return { text: "Ready", cls: "text-success" };
  if (a.credState === "login_required") return { text: "Sign in needed", cls: "text-arc" };
  return { text: "Installed", cls: "text-success" }; // creds unknowable — don't cry wolf
}

// One agent: status (probed, never asked of the agent), install / sign-in /
// sign-out / uninstall (streamed via the background store, so it survives closing
// this panel), a visibility toggle, and the advanced ACP-command override.
function AgentRow({ a, cmd }: { a: AgentStatus; cmd: string }) {
  const qc = useQueryClient();
  const run = useAgentActions((s) => s.runs[a.id]);
  const start = useAgentActions((s) => s.run);
  const [advOpen, setAdvOpen] = usePersistedOpen(`agents:adv:${a.id}`);
  const [confirmUn, setConfirmUn] = useState(false);

  // When a background action finishes, re-check installed/signed-in status.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run?.running) qc.invalidateQueries({ queryKey: ["agents"] });
    wasRunning.current = !!run?.running;
  }, [run?.running, qc]);

  const saveCmd = (v: string) => { if (v !== cmd) api.updateSettings({ [`acpCommand:${a.id}`]: v }).then(() => qc.invalidateQueries({ queryKey: ["settings"] })); };
  const setHidden = (hidden: boolean) =>
    api.updateSettings({ [`agentHidden:${a.id}`]: hidden ? "1" : "" }).then(() => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    });

  const busy = !!run?.running;
  const running = run?.running ? run.action : null;
  const chip = statusChip(a);
  const btn = "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-[12px] font-medium transition disabled:opacity-40";

  return (
    <div className={cn("rounded-xl bg-card p-3 shadow-[var(--shadow-card)] transition", a.hidden && "opacity-60")}>
      <div className="flex items-start gap-3">
        <AgentIcon id={a.id as AgentId} className="mt-0.5 size-5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
            {a.label}
            <span className={cn("flex items-center gap-1 text-[11.5px] font-normal", chip.cls)}>
              {a.installed && a.credState === "ready" && <Check className="size-3.5" />}
              {chip.text}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-[11.5px] text-faint">
            {a.credState === "ready" && a.authDetail ? <>{a.authDetail} · </> : null}session store · {a.sessions}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!a.installed && (
              <button onClick={() => start(a.id, "install")} disabled={busy}
                className={cn(btn, "border-transparent bg-accent text-accent-foreground hover:opacity-90")}>
                {running === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Install
              </button>
            )}
            {a.installed && a.credState !== "ready" && (
              <button onClick={() => start(a.id, "login")} disabled={busy}
                className={cn(btn, a.credState === "login_required"
                  ? "border-transparent bg-accent text-accent-foreground hover:opacity-90"
                  : "border-border text-foreground hover:border-border-heavy")}>
                {running === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} Sign in
              </button>
            )}
            {a.installed && a.credState === "ready" && a.canLogout && (
              <button onClick={() => start(a.id, "logout")} disabled={busy}
                className={cn(btn, "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                {running === "logout" ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Sign out
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
            <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-[11.5px] text-muted-foreground" title={a.hidden ? "Hidden from pickers and History" : "Shown in pickers and History"}>
              {a.hidden ? "Hidden" : "Shown"}
              <button role="switch" aria-checked={!a.hidden} onClick={() => setHidden(!a.hidden)}
                className={cn("relative h-5 w-9 rounded-full transition", a.hidden ? "bg-foreground/15" : "bg-accent")}>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", a.hidden ? "left-0.5" : "left-[18px]")} />
              </button>
            </label>
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
            placeholder={isAgentId(a.id) ? adapterCommand(a.id) : "custom acp command"} spellCheck={false}
            className="h-8 w-full rounded-lg border border-border bg-surface px-2.5 font-mono text-[11.5px] text-foreground outline-none focus:border-border-heavy" />
          <p className="text-[10.5px] leading-relaxed text-faint">The command OpenLive runs to speak ACP with {a.label} over the Agent Client Protocol. Leave blank for the default; change it if the ecosystem package moves.</p>
        </div>
      </details>
    </div>
  );
}
