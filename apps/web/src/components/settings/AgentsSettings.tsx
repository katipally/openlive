"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw, Download, Trash2, LogIn, LogOut, Loader2, ArrowUpCircle, Copy, Eye, EyeOff, Search, Bot } from "lucide-react";
import { api, type AgentStatus } from "@/lib/api";
import { AgentIcon } from "@/components/live/AgentIcon";
import { useAgentActions, trackAgentAction, type ActionKind } from "@/lib/agentActions";
import { telemetry } from "@/lib/telemetry";
import type { AgentId } from "@/lib/live/liveClient";
import { toast } from "@/lib/toast";
import { Button, Tooltip, Input, groupLabel, type DotTone } from "@/components/ui";
import { useSettingsNav } from "./nav";
import { EmptyState, FILTER_AT, NoMatch, OneLine, QueryState, StatusCard, grid2, type MenuAction } from "./common";

// Re-probe on window focus: sign-in/out finishes in a separate terminal, so
// coming back to the app should reflect the new state without a manual click.
const useAgents = () => useQuery({ queryKey: ["agents"], queryFn: api.agents, refetchOnWindowFocus: true });

/** The page's one action: probe every agent again. */
export function AgentsRecheck() {
  const { refetch, isFetching } = useAgents();
  return (
    <Button size="sm" onClick={() => refetch()} disabled={isFetching}>
      <RefreshCw className={isFetching ? "animate-spin" : undefined} /> Re-check
    </Button>
  );
}

type Group = "ready" | "signin" | "missing";
const groupOf = (a: AgentStatus): Group =>
  !a.installed ? "missing" : a.credState === "login_required" ? "signin" : "ready";
const GROUPS: readonly { id: Group; label: string }[] = [
  { id: "ready", label: "Ready" },
  { id: "signin", label: "Sign in needed" },
  { id: "missing", label: "Not installed" },
];

export function AgentsSettings() {
  const { data: agents = [], isLoading, error, refetch, isFetching } = useAgents();
  const go = useSettingsNav();
  const [query, setQuery] = useState("");
  const q = query.trim().toLowerCase();
  const shown = q ? agents.filter((a) => a.label.toLowerCase().includes(q)) : agents;
  const openModels = <Button size="sm" onClick={() => go("models")}>Open Models</Button>;

  return (
    <div id="set-agents-list" className="flex flex-col gap-7">
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => refetch()} what="check the coding agents" />
      {agents.length > FILTER_AT && (
        <Input type="search" size="sm" icon={<Search />} value={query} onChange={(e) => setQuery(e.target.value)}
          placeholder="Find an agent" aria-label="Find an agent" className="w-full max-w-xs" />
      )}
      {q && !shown.length && <NoMatch what="agent" query={query} />}
      {!isLoading && !error && !agents.length && (
        <EmptyState icon={Bot} actions={openModels}>No coding agents found. Keep using an API model.</EmptyState>
      )}
      {agents.length > 0 && GROUPS.map((g) => {
        const list = shown.filter((a) => groupOf(a) === g.id);
        // An empty Ready group still shows on a fresh machine, to say what to do.
        if (!list.length && (q || g.id !== "ready")) return null;
        return (
          <section key={g.id} aria-label={g.label} className="flex flex-col gap-3">
            <h2 className={groupLabel}>{g.label} <span className="font-normal tabular-nums">{list.length}</span></h2>
            {list.length
              ? <div className={grid2}>{list.map((a) => <AgentCard key={a.id} a={a} />)}</div>
              : <EmptyState icon={Bot} actions={openModels}>Nothing ready yet. Install one below, or keep using an API model.</EmptyState>}
          </section>
        );
      })}
    </div>
  );
}

/** The card's single readiness verdict, derived from install + credential probes. */
function statusOf(a: AgentStatus): { text: string; tone: DotTone } {
  if (!a.installed) return { text: "Not installed", tone: "muted" };
  if (a.credState === "ready") return { text: "Ready", tone: "success" };
  // Wizard agents (hermes) aren't "signed out" in this state: their setup was
  // started but never finished (no provider picked). Say that.
  if (a.credState === "login_required") return { text: a.wizard ? "Setup incomplete" : "Sign in needed", tone: "arc" };
  return { text: "Installed", tone: "success" }; // creds unknowable: don't cry wolf
}

const RUNNING: Record<ActionKind, string> = { install: "Installing", uninstall: "Uninstalling", login: "Signing in", logout: "Signing out", update: "Updating" };

// One agent: status (probed, never asked of the agent), install / sign-in /
// sign-out / uninstall (streamed via the background store, so it survives closing
// this panel), and whether it shows in the pickers.
function AgentCard({ a }: { a: AgentStatus }) {
  const qc = useQueryClient();
  const run = useAgentActions((s) => s.runs[a.id]);
  const start = useAgentActions((s) => s.run);
  const [open, setOpen] = useState(false);
  const [waiting, setWaiting] = useState<{ action: ActionKind; startedAt: number } | null>(null);
  // An install or sign-in just ended, so the next time this agent reads Ready is its first.
  const readyNext = useRef(false);

  // When a background action finishes, re-check installed/signed-in status.
  // A terminal action (sign-in) merely OPENS a terminal and returns; the user
  // finishes there, so keep polling and the card flips by itself. Detect that from
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
  const status = statusOf(a);
  const spin = (kind: ActionKind, Icon: typeof Download) => running === kind ? <Loader2 className="animate-spin" /> : <Icon />;

  // While a run is in flight only the copy stays: the store runs one action per agent.
  const more: MenuAction[] = !a.installed ? [] : [
    ...(a.canUpdate && !busy ? [{ label: "Update", icon: ArrowUpCircle, run: () => start(a.id, "update") }] : []),
    { label: "Copy sign-in command", icon: Copy, run: copyLogin },
    ...(a.credState === "ready" && a.canLogout && !busy ? [{ label: "Sign out", icon: LogOut, run: () => start(a.id, "logout") }] : []),
    ...(a.canUninstall && !busy ? [{
      label: "Uninstall", icon: Trash2, run: () => start(a.id, "uninstall"),
      confirm: a.wizard ? "Delete its history and keys too?" : "Uninstall?",
    }] : []),
  ];

  let action: ReactNode = null;
  if (!a.installed && a.canInstall) {
    action = <Button variant="primary" size="sm" onClick={() => start(a.id, "install")} disabled={busy}>{spin("install", Download)} Install</Button>;
  } else if (a.installed && a.credState !== "ready") {
    action = (
      <Button variant={a.credState === "login_required" ? "primary" : "secondary"} size="sm" onClick={() => start(a.id, "login")} disabled={busy}>
        {spin("login", LogIn)} {a.wizard ? "Finish setup" : "Sign in"}
      </Button>
    );
  } else if (a.installed) {
    action = <Button variant="ghost" size="sm" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? "Show less" : "Details"}</Button>;
  }

  const eyeLabel = a.hidden ? `Hidden from pickers and History. Show ${a.label}` : `Shown in pickers and History. Hide ${a.label}`;
  const detail = [
    a.version ?? (a.installed ? null : "Not installed"),
    a.installed && a.credState === "ready" ? "signed in" : null,
    a.hidden ? "hidden" : null,
  ].filter(Boolean).join(" · ");

  return (
    <StatusCard className={a.hidden ? "opacity-60" : undefined}
      icon={<AgentIcon id={a.id as AgentId} className="text-foreground" />}
      name={a.label} detail={detail || undefined}
      tone={running ? "accent" : status.tone} status={running ? RUNNING[running] : status.text}
      action={action} more={more}
      aside={(
        <Tooltip label={eyeLabel}>
          <Button variant="ghost" size="sm" icon aria-label={eyeLabel} aria-pressed={!a.hidden} onClick={() => setHidden(!a.hidden)}>
            {a.hidden ? <EyeOff /> : <Eye />}
          </Button>
        </Tooltip>
      )}>
      {open && a.installed && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 border-t border-border pt-3 text-label">
          {a.version && <Fact term="Version"><OneLine text={a.version} className="font-mono" /></Fact>}
          {a.authDetail && <Fact term="Signed in as"><OneLine text={a.authDetail} /></Fact>}
          <Fact term="Sessions"><OneLine text={a.sessions} className="font-mono" /></Fact>
          <Fact term="Sign in with"><OneLine text={a.loginCommand} className="font-mono" /></Fact>
        </dl>
      )}

      {waiting && a.credState !== "ready" && (
        <p className="flex items-center gap-1.5 text-caption text-muted-foreground">
          <Loader2 className="size-3 shrink-0 animate-spin" /> Finish in the terminal. This updates by itself.
        </p>
      )}

      {run && (run.running || run.log) && (
        <pre className="openlive-scroll max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-border bg-surface p-2.5 font-mono text-caption leading-relaxed text-muted-foreground">{run.log || "Starting…"}</pre>
      )}
    </StatusCard>
  );
}

function Fact({ term, children }: { term: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="min-w-0 text-foreground">{children}</dd>
    </>
  );
}
