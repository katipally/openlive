"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Download, Trash2, LogIn, LogOut, Loader2, ArrowUpCircle, Copy } from "lucide-react";
import { api, type AgentStatus } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import { useAgentActions, trackAgentAction, type ActionKind } from "@/lib/agentActions";
import { telemetry } from "@/lib/telemetry";
import type { AgentId } from "@/lib/live/liveClient";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { Switch, Button, Tooltip, Chip, ListGroup } from "@/components/ui";
import { Section } from "./Section";

export function AgentsSettings() {
  // Re-probe on window focus: sign-in/out finishes in a separate terminal, so
  // coming back to the app should reflect the new state without a manual click.
  const { data: agents = [], isLoading, refetch, isFetching } = useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchOnWindowFocus: true });

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-agents-list" title="Coding agents"
        desc={<>Each agent runs on <span className="text-foreground">your own machine with your own login</span>. OpenLive drives it locally over ACP and never sees its data. Install, sign in or out (opens the agent&apos;s own flow in a terminal), or hide an agent from the pickers and History. Its sessions stay on disk.</>}>
        <div className="flex flex-col gap-2.5">
          {isLoading && <p className="text-label text-muted-foreground">Checking…</p>}
          {agents.length > 0 && <ListGroup>{agents.map((a) => <AgentRow key={a.id} a={a} />)}</ListGroup>}
          <Button variant="ghost" size="sm" className="self-start" onClick={() => refetch()} disabled={isFetching}>
            <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Re-check
          </Button>
        </div>
      </Section>
    </div>
  );
}

/** The row's single readiness verdict, derived from install + credential probes. */
function statusChip(a: AgentStatus) {
  if (!a.installed) return { text: "Not installed", dot: "muted" } as const;
  if (a.credState === "ready") return { text: "Ready", dot: "success" } as const;
  // Wizard agents (hermes) aren't "signed out" in this state — their setup was
  // started but never finished (no provider picked). Say that.
  if (a.credState === "login_required") return { text: a.wizard ? "Setup incomplete" : "Sign in needed", dot: "arc" } as const;
  return { text: "Installed", dot: "success" } as const; // creds unknowable — don't cry wolf
}

// One agent: status (probed, never asked of the agent), install / sign-in /
// sign-out / uninstall (streamed via the background store, so it survives closing
// this panel), a visibility toggle, and the advanced ACP-command override.
function AgentRow({ a }: { a: AgentStatus }) {
  const qc = useQueryClient();
  const run = useAgentActions((s) => s.runs[a.id]);
  const start = useAgentActions((s) => s.run);
  const [confirmUn, setConfirmUn] = useState(false);
  const [waiting, setWaiting] = useState<{ action: ActionKind; startedAt: number } | null>(null);
  // An install or sign-in just ended, so the next time this agent reads Ready is its first.
  const readyNext = useRef(false);

  // When a background action finishes, re-check installed/signed-in status.
  // A terminal action (sign-in) merely OPENS a terminal and returns — the user
  // finishes there, so keep polling and the row flips by itself. Detect that from
  // the server's own result marker rather than guessing from the action: a
  // headless install streams its result inline and is already DONE, so telling the
  // user to go finish in a terminal would just be wrong.
  const wasRunning = useRef(false);
  useEffect(() => {
    if (wasRunning.current && !run?.running) {
      qc.invalidateQueries({ queryKey: ["agents"] });
      if (run?.result === "terminal_opened") setWaiting({ action: run.action, startedAt: run.startedAt });
      if (run?.result === "terminal_opened" || (run?.action === "install" && run.result === "ok")) readyNext.current = true;
    }
    wasRunning.current = !!run?.running;
  }, [run, qc]);

  // Poll every 3s while waiting; stop when the agent is ready or after 5 min.
  // Either ending is reported, except a sign-out's: the agent still reads Ready when it starts waiting.
  useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchInterval: 3000, enabled: !!waiting });
  useEffect(() => {
    if (!waiting) return;
    const end = (result: "signed_in" | "wait_timeout") => {
      setWaiting(null);
      if (waiting.action !== "logout") trackAgentAction(a.id, waiting.action, result, waiting.startedAt);
    };
    if (a.credState === "ready") { end("signed_in"); return; }
    const t = setTimeout(() => end("wait_timeout"), 5 * 60_000);
    return () => clearTimeout(t);
  }, [waiting, a.credState, a.id]);

  useEffect(() => {
    if (!readyNext.current || !a.installed || a.credState !== "ready") return;
    readyNext.current = false;
    telemetry.track("onboarding_step", { step: "first_agent_ready" });
  }, [a.installed, a.credState]);

  const copyLogin = () => {
    void navigator.clipboard.writeText(a.loginCommand)
      .then(() => toast("Command copied. Paste it into any terminal."))
      .catch(() => toast(a.loginCommand)); // clipboard blocked: at least show it
  };

  const setHidden = (hidden: boolean) =>
    api.updateSettings({ [`agentHidden:${a.id}`]: hidden ? "1" : "" }).then(() => {
      qc.invalidateQueries({ queryKey: ["agents"] });
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["history"] });
    }).catch(() => toast(`Couldn’t ${hidden ? "hide" : "show"} ${a.label}. Try again.`));

  const busy = !!run?.running;
  const running = run?.running ? run.action : null;
  const chip = statusChip(a);

  return (
    <div className={cn("py-3 transition", a.hidden && "opacity-60")}>
      <div className="flex items-start gap-3">
        <AgentIcon id={a.id as AgentId} className="mt-0.5 size-5 shrink-0 text-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2 text-body font-medium text-foreground">
            {a.label}
            <Chip dot={chip.dot}>{chip.text}</Chip>
          </div>
          <p className="mt-0.5 truncate font-mono text-caption text-faint">
            {a.version ? <>{a.version} · </> : null}
            {a.credState === "ready" && a.authDetail ? <>{a.authDetail} · </> : null}session store · {a.sessions}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-1.5">
            {!a.installed && a.canInstall && (
              <Button variant="primary" size="sm" onClick={() => start(a.id, "install")} disabled={busy}>
                {running === "install" ? <Loader2 className="size-3.5 animate-spin" /> : <Download className="size-3.5" />} Install
              </Button>
            )}
            {a.installed && a.credState !== "ready" && (
              <>
                <Button variant={a.credState === "login_required" ? "primary" : "secondary"} size="sm" onClick={() => start(a.id, "login")} disabled={busy}>
                  {running === "login" ? <Loader2 className="size-3.5 animate-spin" /> : <LogIn className="size-3.5" />} {a.wizard ? "Finish setup" : "Sign in"}
                </Button>
                <Tooltip label={`Copy the command to run yourself: ${a.loginCommand}`}>
                  <Button size="sm" onClick={copyLogin}>
                    <Copy className="size-3.5" /> Copy command
                  </Button>
                </Tooltip>
              </>
            )}
            {a.installed && a.credState === "ready" && a.canLogout && (
              <Button size="sm" onClick={() => start(a.id, "logout")} disabled={busy}>
                {running === "logout" ? <Loader2 className="size-3.5 animate-spin" /> : <LogOut className="size-3.5" />} Sign out
              </Button>
            )}
            {a.installed && a.canUpdate && (
              <Tooltip label="Reinstall the latest CLI release">
                <Button size="sm" onClick={() => { if (!busy) start(a.id, "update"); }} aria-disabled={busy || undefined}>
                  {running === "update" ? <Loader2 className="size-3.5 animate-spin" /> : <ArrowUpCircle className="size-3.5" />} Update
                </Button>
              </Tooltip>
            )}
            {a.installed && a.canUninstall && (
              <Tooltip label={a.wizard && `Removes ${a.sessions}, including its chat history and credentials`}>
                <Button variant={confirmUn ? "destructive" : "secondary"} size="sm" aria-disabled={busy || undefined}
                  onClick={() => { if (busy) return; if (confirmUn) { setConfirmUn(false); start(a.id, "uninstall"); } else setConfirmUn(true); }}
                  onBlur={() => setConfirmUn(false)}>
                  {running === "uninstall" ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />} {confirmUn ? "Confirm?" : "Uninstall"}
                </Button>
              </Tooltip>
            )}
            <Tooltip label={a.hidden ? "Hidden from pickers and History" : "Shown in pickers and History"} className="ml-auto">
              <label className="flex cursor-pointer select-none items-center gap-2 text-caption text-muted-foreground">
                {a.hidden ? "Hidden" : "Shown"}
                <Switch on={!a.hidden} onFlip={() => setHidden(!a.hidden)} />
              </label>
            </Tooltip>
          </div>
        </div>
      </div>

      {confirmUn && a.wizard && (
        <p className="mt-2 text-caption text-danger">This deletes {a.sessions}, Hermes chat history and credentials included. There is no undo.</p>
      )}

      {waiting && a.credState !== "ready" && (
        <p className="mt-2 flex items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 className="size-3 animate-spin" /> Waiting for you to finish in the terminal. This updates by itself.
        </p>
      )}

      {run && (run.running || run.log) && (
        <pre className="openlive-scroll mt-2.5 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-surface p-2.5 font-mono text-caption leading-relaxed text-muted-foreground">{run.log || "Starting…"}</pre>
      )}

    </div>
  );
}
