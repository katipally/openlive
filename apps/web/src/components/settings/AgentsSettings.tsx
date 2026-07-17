"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, RefreshCw, Download, Trash2, LogIn, LogOut, Loader2, ArrowUpCircle, Copy } from "lucide-react";
import { api, type AgentStatus } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import { useAgentActions } from "@/lib/agentActions";
import type { AgentId } from "@/lib/live/liveClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Section } from "./Section";

export function AgentsSettings() {
  // Re-probe on window focus: sign-in/out finishes in a separate terminal, so
  // coming back to the app should reflect the new state without a manual click.
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchOnWindowFocus: true });

  return (
    <div className="flex flex-col gap-7">
      <Section title="Coding agents"
        desc={<>Each agent runs on <span className="text-foreground">your own machine with your own login</span> — OpenLive drives it locally over ACP and never sees its data. Install, sign in or out (opens the agent&apos;s own flow in a terminal), or hide an agent from the pickers and History — its sessions stay on disk.</>}>
        <div className="flex flex-col gap-2.5">
          {isLoading && <p className="text-label text-muted-foreground">Checking…</p>}
          {agents.map((a) => (
            <AgentRow key={a.id} a={a} />
          ))}
          <button onClick={() => refetch()} disabled={isFetching}
            className="flex items-center gap-1.5 self-start text-label text-muted-foreground transition hover:text-foreground disabled:opacity-50">
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
  // Wizard agents (hermes) aren't "signed out" in this state — their setup was
  // started but never finished (no provider picked). Say that.
  if (a.credState === "login_required") return { text: a.wizard ? "Setup incomplete" : "Sign in needed", cls: "text-arc" };
  return { text: "Installed", cls: "text-success" }; // creds unknowable — don't cry wolf
}

// One agent: status (probed, never asked of the agent), install / sign-in /
// sign-out / uninstall (streamed via the background store, so it survives closing
// this panel), a visibility toggle, and the advanced ACP-command override.
function AgentRow({ a }: { a: AgentStatus }) {
  const qc = useQueryClient();
  const run = useAgentActions((s) => s.runs[a.id]);
  const start = useAgentActions((s) => s.run);
  const [confirmUn, setConfirmUn] = useState(false);
  const [waiting, setWaiting] = useState(false);

  // When a background action finishes, re-check installed/signed-in status.
  // A terminal action (sign-in) merely OPENS a terminal and returns — the user
  // finishes there, so keep polling and the row flips by itself. Detect that from
  // the server's own success marker rather than guessing from the action: a
  // headless install streams its result inline and is already DONE, so telling the
  // user to go finish in a terminal would just be wrong.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run?.running) {
      qc.invalidateQueries({ queryKey: ["agents"] });
      if (run?.log.includes("Continues in the terminal window")) setWaiting(true);
    }
    wasRunning.current = !!run?.running;
  }, [run?.running, run?.log, qc]);

  // Poll every 3s while waiting; stop when the agent is ready or after 5 min.
  useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 3000, enabled: waiting });
  useEffect(() => {
    if (!waiting) return;
    if (a.credState === "ready") { setWaiting(false); return; }
    const t = setTimeout(() => setWaiting(false), 5 * 60_000);
    return () => clearTimeout(t);
  }, [waiting, a.credState]);

  const copyLogin = () => {
    void navigator.clipboard.writeText(a.loginCommand)
      .then(() => toast("Command copied — paste it into any terminal."))
      .catch(() => toast(a.loginCommand)); // clipboard blocked: at least show it
  };

  const setHidden = (hidden: boolean) =>
    api.updateSettings({ [`agentHidden:${a.id}`]: hidden ? "1" : "" }).then(() => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    });

  const busy = !!run?.running;
  const running = run?.running ? run.action : null;
  const chip = statusChip(a);
  const btn = "flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-label font-medium transition disabled:opacity-40";

  return (
    <div className={cn("rounded-xl bg-card p-3 shadow-[var(--shadow-card)] transition", a.hidden && "opacity-60")}>
      <div className="flex items-start gap-3">
        <AgentIcon id={a.id as AgentId} className="mt-0.5 size-5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-body font-medium text-foreground">
            {a.label}
            <span className={cn("flex items-center gap-1 text-caption font-normal", chip.cls)}>
              {a.installed && a.credState === "ready" && <Check className="size-3.5" />}
              {chip.text}
            </span>
          </div>
          <p className="mt-0.5 truncate font-mono text-caption text-faint">
            {a.version ? <>{a.version} · </> : null}
            {a.credState === "ready" && a.authDetail ? <>{a.authDetail} · </> : null}session store · {a.sessions}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!a.installed && a.canInstall && (
              <button onClick={() => start(a.id, "install")} disabled={busy}
                className={cn(btn, "border-transparent bg-accent text-accent-foreground hover:opacity-90")}>
                {running === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Install
              </button>
            )}
            {a.installed && a.credState !== "ready" && (
              <>
                <button onClick={() => start(a.id, "login")} disabled={busy}
                  className={cn(btn, a.credState === "login_required"
                    ? "border-transparent bg-accent text-accent-foreground hover:opacity-90"
                    : "border-border text-foreground hover:border-border-heavy")}>
                  {running === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} {a.wizard ? "Finish setup" : "Sign in"}
                </button>
                <button onClick={copyLogin} title={`Copy the command to run yourself: ${a.loginCommand}`}
                  className={cn(btn, "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                  <Copy className="size-3.5" /> Copy command
                </button>
              </>
            )}
            {a.installed && a.credState === "ready" && a.canLogout && (
              <button onClick={() => start(a.id, "logout")} disabled={busy}
                className={cn(btn, "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                {running === "logout" ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Sign out
              </button>
            )}
            {a.installed && a.canUpdate && (
              <button onClick={() => start(a.id, "update")} disabled={busy}
                title="Reinstall the latest CLI release"
                className={cn(btn, "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                {running === "update" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />} Update
              </button>
            )}
            {a.installed && a.canUninstall && (
              <button
                onClick={() => (confirmUn ? (setConfirmUn(false), start(a.id, "uninstall")) : setConfirmUn(true))}
                disabled={busy} onBlur={() => setConfirmUn(false)}
                title={a.wizard ? `Removes ${a.sessions} — including its chat history and credentials` : undefined}
                className={cn(btn, confirmUn ? "border-danger/50 bg-danger/10 text-danger" : "border-border text-muted-foreground hover:border-border-heavy hover:text-foreground")}>
                {running === "uninstall" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} {confirmUn ? "Confirm?" : "Uninstall"}
              </button>
            )}
            <label className="ml-auto flex cursor-pointer select-none items-center gap-2 text-caption text-muted-foreground" title={a.hidden ? "Hidden from pickers and History" : "Shown in pickers and History"}>
              {a.hidden ? "Hidden" : "Shown"}
              <button role="switch" aria-checked={!a.hidden} onClick={() => setHidden(!a.hidden)}
                className={cn("relative h-5 w-9 rounded-full transition", a.hidden ? "bg-foreground/15" : "bg-accent")}>
                <span className={cn("absolute top-0.5 size-4 rounded-full bg-white shadow transition-[left]", a.hidden ? "left-0.5" : "left-[18px]")} />
              </button>
            </label>
          </div>
        </div>
      </div>

      {confirmUn && a.wizard && (
        <p className="mt-2 text-caption text-danger">This deletes {a.sessions} — Hermes chat history and credentials included. There is no undo.</p>
      )}

      {waiting && a.credState !== "ready" && (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Waiting for you to finish in the terminal — this updates by itself.
        </p>
      )}

      {run && (run.running || run.log) && (
        <pre className="openlive-scroll mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-2.5 font-mono text-caption leading-relaxed text-muted-foreground">{run.log || "Starting…"}</pre>
      )}

    </div>
  );
}
