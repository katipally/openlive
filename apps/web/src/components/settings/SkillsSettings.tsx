"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, Eye, FolderOpen, Loader2, Pencil, Plus, RotateCcw, Search, Sparkles, Trash2, TriangleAlert } from "lucide-react";
import { SKILL_DESCRIPTION_MAX, type SkillImportSource, type SkillListWire, type SkillWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { bridge, isDesktop } from "@/lib/platform";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { useLiveStore } from "@/lib/live/liveStore";
import { filterSkills, initialPicks, newSkillProblem, pickKey, pickedItems, skillRole, splitSkills } from "@/lib/skills";
import { Badge, Button, Checkbox, Input, ListGroup, ListRow, Switch, Textarea, Tooltip, groupLabel } from "@/components/ui";
import { BuiltInBadge, EmptyState, MoreMenu, NoMatch, OneLine, QueryState, field, inset, msg, panel, type MenuAction } from "./common";

export const skillsQuery = (workspace: string) => ({ queryKey: ["skills", workspace], queryFn: () => api.skills(workspace) });

/** Agent Skills every brain can load, in Chat and Flow. The agent pushes
 *  nothing, so the list refreshes on focus and on Rescan. Built-in skills and
 *  a call's bound folder's are read in place; only your own folder's edit. */
export function SkillsSettings() {
  const qc = useQueryClient();
  const workspace = useLiveStore((s) => s.boundCwd);
  const { queryKey: key } = skillsQuery(workspace);
  const [adding, setAdding] = useState<"new" | "import" | null>(null);
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  const { data, isLoading, error, refetch, isFetching } = useQuery({ ...skillsQuery(workspace), retry: 1, refetchOnWindowFocus: true });
  const put = (s: SkillWire) => qc.setQueryData<SkillListWire>(key, (l) => l && { ...l, skills: l.skills.map((x) => (x.name === s.name && x.source === s.source ? s : x)) });
  const refresh = () => qc.invalidateQueries({ queryKey: ["skills"] });

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
  const { builtIn, yours } = splitSkills(filterSkills(all, filter));
  const q = filter.trim();
  const section = (label: string, list: SkillWire[], extra?: React.ReactNode) => (
    <section className="flex flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <h3 className={cn(groupLabel, "flex items-center gap-2")}>{label}<span className="tabular-nums">{list.length}</span></h3>
        {extra}
      </div>
      {list.length > 0 && (
        <ListGroup>
          {list.map((s) => <SkillRow key={`${s.source}:${s.name}`} s={s} workspace={workspace} put={put} refresh={refresh} />)}
        </ListGroup>
      )}
    </section>
  );

  return (
    <div id="set-capabilities-skills-list" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input type="search" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a skill" aria-label="Find a skill" className="min-w-0 flex-1 basis-40" />
        <span className="flex items-center gap-1.5">
          {busy && <Loader2 aria-label="Rescanning" className="size-4 animate-spin text-muted-foreground" />}
          <MoreMenu label="More for skills folder" actions={[
            { label: "Open the skills folder", icon: FolderOpen, run: () => void reveal() },
            ...(busy ? [] : [{ label: "Rescan", icon: RotateCcw, run: () => void rescan() }]),
            ...(adding === "import" ? [] : [{ label: "Import", icon: Download, run: () => setAdding("import") }]),
          ]} />
          <Button variant="primary" onClick={() => setAdding("new")} disabled={adding === "new"}><Plus /> New skill</Button>
        </span>
      </div>
      {adding === "new" && <NewPanel taken={all.map((s) => s.name)} onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
      {adding === "import" && <ImportPanel onDone={() => { setAdding(null); void refresh(); }} onCancel={() => setAdding(null)} />}
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} />
      {q && data && builtIn.length + yours.length === 0 && <NoMatch what="skill" query={filter} />}
      {builtIn.length > 0 && section("Built in", builtIn)}
      {data && (!q || yours.length > 0) && section("Yours", yours, (
        <Tooltip label={<span className="break-all">{data.dir}</span>} truncated className="flex min-w-0 flex-1 basis-32">
          <span className="min-w-0 truncate font-mono text-caption text-faint">{data.dir}</span>
        </Tooltip>
      ))}
      {data && !q && yours.length === 0 && !adding && (
        <EmptyState icon={Sparkles} actions={<>
          <Button size="sm" variant="primary" onClick={() => setAdding("new")}><Plus /> New skill</Button>
          <Button size="sm" onClick={() => setAdding("import")}><Download /> Import</Button>
        </>}>No skills of your own yet. Write one, or import yours from other tools.</EmptyState>
      )}
      {data && data.problems.length > 0 && <Problems problems={data.problems} />}
      {data && <p className="text-caption text-muted-foreground">Your API key&rsquo;s model and coding agents alike load a skill when a task calls for it. Type /name in a call to load one yourself.</p>}
    </div>
  );
}

function SkillRow({ s, workspace, put, refresh }: { s: SkillWire; workspace: string; put: (s: SkillWire) => void; refresh: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const { builtIn, own } = skillRole(s.source);
  const flip = () => {
    put({ ...s, enabled: !s.enabled });
    api.setSkillEnabled(s.name, !s.enabled, workspace).then(put).catch((e) => { put(s); toast(`Couldn’t turn ${s.name} ${s.enabled ? "off" : "on"}. ${msg(e)}`); });
  };
  const remove = async () => {
    try { await api.removeSkill(s.name); await refresh(); }
    catch (e) { toast(`Couldn’t remove ${s.name}. ${msg(e)}`); }
  };
  const files = s.resources ? `${s.resources + 1} files` : "SKILL.md";
  const more: MenuAction[] = [
    ...(open ? [] : [{ label: own ? "Edit" : "View", icon: own ? Pencil : Eye, run: () => setOpen(true) }]),
    ...(own ? [{ label: "Remove", icon: Trash2, run: () => void remove(), confirm: "Remove its folder?" }] : []),
  ];

  return (
    <ListRow
      label={(
        <span className={cn("flex min-w-0 flex-wrap items-center gap-1.5", (!s.enabled || s.replacedBy) && "opacity-60")}>
          <OneLine text={s.name} className="font-mono font-medium" />
          {builtIn && <BuiltInBadge />}
          {s.replacedBy && <Badge>{s.replacedBy === "user" ? "Replaced by yours" : "Replaced by the project’s"}</Badge>}
          {s.source === "workspace" && <Badge tone="accent">Workspace</Badge>}
          {s.warnings.length > 0 && (
            <Tooltip label={s.warnings.join(" ")}>
              <span tabIndex={0} className="inline-flex rounded-sm">
                <Badge tone="arc"><TriangleAlert aria-hidden /> {s.warnings.length === 1 ? "1 warning" : `${s.warnings.length} warnings`}</Badge>
              </span>
            </Tooltip>
          )}
          <span className="text-caption text-faint">{files}</span>
        </span>
      )}
      detail={s.description}>
      <span className="flex shrink-0 items-center gap-1">
        <MoreMenu label={`More for ${s.name}`} actions={more} />
        {!s.replacedBy && (
          <label className="flex cursor-pointer items-center">
            <span className="sr-only">Use {s.name}</span>
            <Switch on={s.enabled} onFlip={flip} />
          </label>
        )}
      </span>
      {open && <div className="min-w-0 basis-full"><Editor s={s} workspace={workspace} onSaved={(next) => { put(next); setOpen(false); }} onClose={() => setOpen(false)} /></div>}
    </ListRow>
  );
}

/** SKILL.md as written, editable for OpenLive's own skills and read-only for the rest. */
function Editor({ s, workspace, onSaved, onClose }: { s: SkillWire; workspace: string; onSaved: (s: SkillWire) => void; onClose: () => void }) {
  const { builtIn, own } = skillRole(s.source);
  const { data, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ["skill", s.source, s.name, workspace], queryFn: () => api.skill(s.name, workspace, builtIn), retry: 1, staleTime: 0, gcTime: 0,
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
    <div className={inset}>
      <Tooltip label={<span className="break-all">{s.dir}</span>} truncated className="flex min-w-0 max-w-full">
        <span className="min-w-0 truncate font-mono text-caption text-faint">{s.dir}</span>
      </Tooltip>
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} what="read SKILL.md" />
      {text != null && (
        <label className={field}>SKILL.md
          <Textarea rows={Math.min(24, Math.max(6, text.split("\n").length))} value={text} readOnly={!own} onChange={(e) => setText(e.target.value)}
            spellCheck={false} className="font-mono text-label" />
        </label>
      )}
      {!own && <p className="text-caption text-muted-foreground">{builtIn ? "Built into OpenLive. Turn it off if you do not want it." : "Read from the project folder. Edit it there."}</p>}
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
  const { data: sources, isLoading, error, refetch, isFetching } = useQuery({
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
      <OneLine className="text-label text-foreground" text="Skills found in the other tools on this computer. Each one is copied into OpenLive's folder; the original stays where it is." />
      <QueryState loading={isLoading} error={error} retrying={isFetching} onRetry={() => void refetch()} what="look for skills" />
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
