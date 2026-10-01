"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FolderOpen, Loader2, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import { SKILL_DESCRIPTION_MAX, type SkillImportSource, type SkillListWire, type SkillWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useLiveStore } from "@/lib/live/liveStore";
import { filterSkills, initialPicks, newSkillProblem, pickKey, pickedItems } from "@/lib/skills";
import { Badge, Button, Checkbox, ConfirmButton, Input, ListGroup, Switch, Textarea, Tooltip, groupLabel } from "@/components/ui";
import { Section } from "./Section";

const KEY = ["skills"];
// Past this many skills a filter appears, as on Connectors.
const FILTER_AT = 8;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const field = "flex min-w-0 flex-col gap-1 text-label text-muted-foreground";
const panel = "flex flex-col gap-3 rounded-xl bg-card p-3 shadow-card";
const inset = "flex flex-col gap-3 rounded-lg border border-border p-3";

/** Agent Skills every brain can load, in Chat and Flow. The agent pushes
 *  nothing, so the list refreshes on focus and on Rescan. A call's bound
 *  folder adds that project's skills, shown read-only. */
export function SkillsSettings() {
  const qc = useQueryClient();
  const workspace = useLiveStore((s) => s.boundCwd);
  const key = [...KEY, workspace];
  const [adding, setAdding] = useState<"new" | "import" | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: key, queryFn: () => api.skills(workspace), retry: 1, refetchOnWindowFocus: true,
  });
  const put = (s: SkillWire) => qc.setQueryData<SkillListWire>(key, (l) => l && { ...l, skills: l.skills.map((x) => (x.name === s.name ? s : x)) });
  const refresh = () => qc.invalidateQueries({ queryKey: KEY });

  const rescan = async () => {
    setBusy(true);
    try { qc.setQueryData(key, await api.rescanSkills(workspace)); }
    catch (e) { toast(`Couldn’t rescan. ${msg(e)}`); }
    finally { setBusy(false); }
  };
  const reveal = async () => {
    try {
      const { path } = await api.revealSkills();
      if (isDesktop && bridge) void bridge("open_path", path);
      else toast(`Your skills folder is ${path}`, "info");
    } catch (e) { toast(`Couldn’t open the skills folder. ${msg(e)}`); }
  };

  const all = data?.skills ?? [];
  const shown = filterSkills(all, filter);
  const actions = !adding && (
    <span className="flex flex-wrap gap-1.5">
      <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
      <Button size="sm" onClick={() => setAdding("new")}><Plus /> New skill</Button>
    </span>
  );

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-skills-list" title="Skills" action={actions}
        desc={<>Instructions for specific kinds of tasks, in the open Agent Skills format. Every brain can load one when a task calls for it, in Chat and Flow, for API models and coding agents alike. Type /name in a call&apos;s text box to load one yourself. Changes apply from the next call or Flow session.</>}>
        <div className="flex flex-col gap-2">
          {data && (
            <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <Tooltip label={<span className="break-all">{data.dir}</span>} truncated className="flex min-w-0 flex-1 basis-48">
                <span className="min-w-0 truncate font-mono text-caption text-faint">{data.dir}</span>
              </Tooltip>
              <span className="flex flex-wrap gap-1.5">
                <Button variant="ghost" size="sm" onClick={() => void reveal()}><FolderOpen /> Open folder</Button>
                <Button variant="ghost" size="sm" onClick={() => void rescan()} disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <RotateCcw />} Rescan</Button>
              </span>
            </div>
          )}
          {adding === "new" && <NewPanel taken={all.map((s) => s.name)} onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
          {adding === "import" && <ImportPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
          {isLoading && <p className="text-label text-muted-foreground">Looking…</p>}
          {isError && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t reach OpenLive&apos;s agent. {msg(error)}</span>
              <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
              </Button>
            </div>
          )}
          {data && all.length === 0 && !adding && (
            <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-card-x py-5 text-center">
              <p className="text-label text-muted-foreground">No skills yet. Write one, drop a skill folder into the folder above, or bring over the ones you use in Claude Code, Codex or Gemini CLI.</p>
              <span className="flex flex-wrap justify-center gap-1.5">
                <Button size="sm" variant="primary" onClick={() => setAdding("new")}><Plus /> New skill</Button>
                <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
              </span>
            </div>
          )}
          {all.length > FILTER_AT && (
            <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${all.length} skills`} aria-label="Find a skill" />
          )}
          {filter.trim() && shown.length === 0 && <p className="text-label text-muted-foreground">No skill matches &ldquo;{filter.trim()}&rdquo;.</p>}
          {shown.length > 0 && (
            <ListGroup>
              {shown.map((s) => <SkillRow key={`${s.source}:${s.name}`} s={s} workspace={workspace} put={put} refresh={refresh} />)}
            </ListGroup>
          )}
          {data && data.problems.length > 0 && <Problems problems={data.problems} />}
        </div>
      </Section>
    </div>
  );
}

function SkillRow({ s, workspace, put, refresh }: { s: SkillWire; workspace: string; put: (s: SkillWire) => void; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const own = s.source === "user";
  const flip = () => {
    put({ ...s, enabled: !s.enabled });
    api.setSkillEnabled(s.name, !s.enabled, workspace).then(put).catch((e) => { put(s); toast(`Couldn’t turn ${s.name} ${s.enabled ? "off" : "on"}. ${msg(e)}`); });
  };
  const remove = async () => {
    try { await api.removeSkill(s.name); await refresh(); }
    catch (e) { toast(`Couldn’t remove ${s.name}. ${msg(e)}`); }
  };

  return (
    <div className={cn("py-3 transition", !s.enabled && "opacity-60")}>
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-all font-mono text-body font-medium text-foreground">{s.name}</span>
            {!own && <Badge tone="accent">Workspace</Badge>}
          </div>
          <Tooltip label={s.description} truncated className="flex min-w-0 max-w-full">
            <p className="mt-0.5 line-clamp-2 min-w-0 break-words text-caption text-muted-foreground">{s.description}</p>
          </Tooltip>
        </div>
        <label className="flex cursor-pointer items-center">
          <span className="sr-only">Use {s.name}</span>
          <Switch on={s.enabled} onFlip={flip} />
        </label>
      </div>
      {s.warnings.map((w, i) => <p key={i} className="mt-1 break-words text-caption text-arc-text">{w}</p>)}
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <span className="px-1 text-caption text-faint">{s.resources ? `${s.resources} ${s.resources === 1 ? "file" : "files"} beside SKILL.md` : "SKILL.md only"}</span>
        <span className="ml-auto flex flex-wrap gap-1.5">
          {!open && <Button variant="ghost" size="sm" onClick={() => setOpen(true)} aria-label={`${own ? "Edit" : "View"} ${s.name}`}>{own ? <Pencil /> : <Eye />} {own ? "Edit" : "View"}</Button>}
          {own && <ConfirmButton label="Remove" confirm="Remove its folder?" onConfirm={remove} />}
        </span>
      </div>
      {open && <Editor s={s} workspace={workspace} onSaved={(next) => { put(next); setOpen(false); }} onClose={() => setOpen(false)} />}
    </div>
  );
}

/** SKILL.md as written, editable for OpenLive's own skills and read-only for a workspace's. */
function Editor({ s, workspace, onSaved, onClose }: { s: SkillWire; workspace: string; onSaved: (s: SkillWire) => void; onClose: () => void }) {
  const own = s.source === "user";
  const { data, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["skill", s.source, s.name, workspace], queryFn: () => api.skill(s.name, workspace), retry: 1, staleTime: 0, gcTime: 0,
  });
  const [text, setText] = useState<string | null>(null);
  const [problem, setProblem] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data) setText(data.text); }, [data]);
  const save = async () => {
    if (text == null) return;
    if (text === data?.text) return onClose();
    setBusy(true);
    setProblem("");
    try { onSaved(await api.saveSkill(s.name, text)); }
    catch (e) { setProblem(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={cn(inset, "mt-2.5")}>
      <Tooltip label={<span className="break-all">{s.dir}</span>} truncated className="flex min-w-0 max-w-full">
        <span className="min-w-0 truncate font-mono text-caption text-faint">{s.dir}</span>
      </Tooltip>
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t read SKILL.md. {msg(error)}</span>
          <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry</Button>
        </div>
      )}
      {text == null && !isError && <p className="text-label text-muted-foreground">Reading…</p>}
      {text != null && (
        <label className={field}>SKILL.md
          <Textarea rows={Math.min(24, Math.max(6, text.split("\n").length))} value={text} readOnly={!own} onChange={(e) => setText(e.target.value)}
            spellCheck={false} className="font-mono text-label" />
        </label>
      )}
      {!own && <p className="text-caption text-muted-foreground">This skill is read from the project folder. Edit it there.</p>}
      {problem && <p role="alert" className="break-words text-label text-destructive">{problem}</p>}
      <span className="flex flex-wrap gap-1.5">
        {own && <Button variant="primary" size="sm" onClick={() => void save()} disabled={busy || text == null}>{busy && <Loader2 className="animate-spin" />} Save</Button>}
        <Button variant="ghost" size="sm" onClick={onClose}>{own ? "Cancel" : "Close"}</Button>
      </span>
    </div>
  );
}

function NewPanel({ taken, onDone, onCancel }: { taken: string[]; onDone: () => void; onCancel: () => void }) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [body, setBody] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const helpId = useId();
  const problem = newSkillProblem(name, description, taken);
  const ready = !!name.trim() && !!description.trim() && !problem.name && !problem.description;
  const submit = async () => {
    setError("");
    setBusy(true);
    try { await api.createSkill({ name: name.trim(), description: description.trim(), body }); onDone(); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className={panel}>
      <label className={field}>Name, also its folder&apos;s name
        <Input size="md" autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="meeting-notes" invalid={!!problem.name}
          aria-describedby={helpId} spellCheck={false} autoCapitalize="off" className="font-mono" />
        <span id={helpId} className={cn("text-caption", problem.name ? "text-destructive" : "text-faint")}>
          {problem.name || "Lowercase letters, digits and single hyphens, up to 64 characters."}
        </span>
      </label>
      <label className={field}>What it does, and when to use it
        <Textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} invalid={!!problem.description}
          placeholder="Writes meeting notes in the team's format. Use when the user asks to sum up a meeting." />
        <span className={cn("text-caption", problem.description ? "text-destructive" : "text-faint")}>
          {problem.description || `${description.trim().length} of ${SKILL_DESCRIPTION_MAX} characters. Models decide to load a skill from this alone.`}
        </span>
      </label>
      <label className={field}>Instructions (Markdown)
        <Textarea rows={8} value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} className="font-mono text-label"
          placeholder={"# Meeting notes\n\n1. Start with the decisions.\n2. Then owners and dates."} />
      </label>
      {error && <p role="alert" className="break-words text-label text-destructive">{error}</p>}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void submit()} disabled={!ready || busy}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Create</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

function Problems({ problems }: { problems: SkillListWire["problems"] }) {
  return (
    <section className="mt-2 flex flex-col gap-1.5">
      <h3 className={groupLabel}>{problems.length === 1 ? "A folder that did not load" : `${problems.length} folders that did not load`}</h3>
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
        {problems.map((p) => (
          <div key={p.dir} className="flex min-w-0 flex-col gap-0.5 py-2">
            <Tooltip label={<span className="break-all">{p.dir}</span>} truncated className="flex min-w-0 max-w-full">
              <span className="min-w-0 truncate font-mono text-caption text-foreground">{p.dir}</span>
            </Tooltip>
            <p className="break-words text-caption text-destructive">{p.error}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function ImportPanel({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const { data: sources, isError, error, refetch, isFetching } = useQuery({
    queryKey: ["skill-imports"], queryFn: api.skillImports, retry: 1, staleTime: 0, gcTime: 0,
  });
  const [picks, setPicks] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (sources) setPicks(initialPicks(sources)); }, [sources]);
  const flip = (k: string) => setPicks((p) => { const n = new Set(p); if (n.has(k)) n.delete(k); else n.add(k); return n; });
  const items = sources ? pickedItems(sources, picks) : [];
  const withSkills = sources?.filter((s) => s.skills.length || s.problems.length) ?? [];
  const empty = sources?.filter((s) => !s.skills.length && !s.problems.length).map((s) => s.label) ?? [];

  const commit = async () => {
    setBusy(true);
    try {
      const r = await api.importSkills(items);
      const n = r.imported.length;
      toast(`Imported ${n} ${n === 1 ? "skill" : "skills"}.${r.skipped.length ? ` Skipped ${r.skipped.map((s) => `${s.name} (${s.reason})`).join(", ")}.` : ""}`, "info");
      onDone();
    } catch (e) { toast(`Couldn’t import. ${msg(e)}`); }
    finally { setBusy(false); }
  };

  return (
    <div className={panel}>
      <p className="text-label text-foreground">Skills found in the other tools on this computer. Each one is copied into OpenLive&apos;s folder; the original stays where it is.</p>
      {!sources && !isError && <p className="text-label text-muted-foreground">Looking…</p>}
      {isError && (
        <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t look for skills. {msg(error)}</span>
          <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>{isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry</Button>
        </div>
      )}
      {withSkills.map((s) => <ImportSource key={s.source} s={s} picks={picks} flip={flip} />)}
      {sources && !withSkills.length && <p className="text-label text-muted-foreground">No skills found.</p>}
      {empty.length > 0 && <p className="break-words text-caption text-faint">Nothing in {empty.join(", ")}.</p>}
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void commit()} disabled={!items.length || busy}>
          {busy ? <Loader2 className="animate-spin" /> : <Download />} Import {items.length || ""}
        </Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}

function ImportSource({ s, picks, flip }: { s: SkillImportSource; picks: ReadonlySet<string>; flip: (k: string) => void }) {
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
        <h3 className={groupLabel}>{s.label}</h3>
        <Tooltip label={<span className="break-all">{s.path}</span>} truncated className="flex min-w-0 flex-1">
          <span className="min-w-0 truncate font-mono text-caption text-faint">{s.path}</span>
        </Tooltip>
      </div>
      {s.skills.length > 0 && (
        <div className="flex flex-col divide-y divide-border rounded-lg border border-border px-3">
          {s.skills.map((k) => {
            const key = pickKey(s.source, k.name);
            return (
              <div key={key} className="flex flex-col gap-1 py-2">
                <label className="flex cursor-pointer items-start gap-2.5">
                  <Checkbox checked={picks.has(key)} onChange={() => flip(key)} className="mt-0.5" />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="min-w-0 break-all font-mono text-label font-medium text-foreground">{k.name}</span>
                      {k.duplicateOf && <Badge>Same name as one in {k.duplicateOf}</Badge>}
                    </span>
                    <Tooltip label={k.description} truncated className="flex min-w-0 max-w-full">
                      <span className="line-clamp-2 min-w-0 break-words text-caption text-muted-foreground">{k.description}</span>
                    </Tooltip>
                  </span>
                </label>
                {k.warnings.map((w, i) => <p key={i} className="break-words pl-7 text-caption text-arc-text">{w}</p>)}
              </div>
            );
          })}
        </div>
      )}
      {s.problems.map((p) => (
        <p key={p.dir} className="break-words text-caption text-destructive"><span className="break-all font-mono">{p.dir.split(/[\\/]/).pop()}</span>: {p.error}</p>
      ))}
    </section>
  );
}
