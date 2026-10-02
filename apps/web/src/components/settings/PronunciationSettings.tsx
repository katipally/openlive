"use client";

import { useEffect, useState } from "react";
import { ChevronRight, Loader2, Pencil, Play, Plus, Search, Trash2 } from "lucide-react";
import type { LanguageCode } from "@openlive/shared";
import type { LexiconEntry } from "@openlive/shared/speech/lexicon";
import { loadPipelineConfig, savePipelineConfig, onPipelineConfig, CURATED_LANGUAGES, PRONUNCIATION_LIMITS } from "@/lib/live/pipelineConfig";
import { languageLabel } from "@/lib/live/engineMenu";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { playPreview } from "./PipelineSettings";
import { cn } from "@/lib/cn";
import { Select, Checkbox, Button, Tooltip, Input, Chip, ListGroup } from "@/components/ui";
import { Section } from "./Section";
import { EmptyState, NoMatch } from "./common";

const BLANK: LexiconEntry = { from: "", to: "", lang: "", matchCase: false, wholeWord: true };
const field = "min-w-0 flex-1 basis-40";
// Past this many entries a filter appears, so a long list stays findable.
const FILTER_AT = 8;

/** The pronunciation dictionary, kept in the pipeline config with the rest of
 *  the voice settings. A change applies from the next reply. */
export function PronunciationSettings() {
  const [cfg, setCfg] = useState(() => loadPipelineConfig());
  useEffect(() => onPipelineConfig(setCfg), []);
  const [editing, setEditing] = useState<number | null>(null); // an entry's index, or -1 for a new one
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  // The list sits behind one row until opened; adding or editing a word opens it.
  const [open, setOpen] = useState(false);
  const shownList = open || editing !== null;
  const entries = cfg.pronunciations;
  const save = (list: LexiconEntry[]) => setCfg(savePipelineConfig({ ...cfg, pronunciations: list }));

  const say = async (key: string, text: string, list: LexiconEntry[]) => {
    setBusy(key);
    try { await playPreview(text, { ...cfg, pronunciations: list }); }
    catch (e) { log.error("tts", "pronunciation preview:", e); toast("Couldn’t play it. Download the voice in Speech engine, then try again."); }
    finally { setBusy(null); }
  };
  const commit = (entry: LexiconEntry) => {
    save(editing === -1 || editing === null ? [...entries, entry] : entries.map((e, i) => (i === editing ? entry : e)));
    setEditing(null);
  };
  const remove = (i: number) => {
    const before = entries;
    save(entries.filter((_, j) => j !== i));
    toast(`Removed “${before[i]!.from}”`, "info", { undo: () => savePipelineConfig({ ...loadPipelineConfig(), pronunciations: before }), commit: () => {} });
  };
  const q = filter.trim().toLowerCase();
  const shown = entries.map((e, i) => [e, i] as const).filter(([e]) => !q || `${e.from} ${e.to}`.toLowerCase().includes(q));

  const add = editing !== -1 && (
    <Button size="sm" onClick={() => { setOpen(true); setEditing(-1); }} disabled={entries.length >= PRONUNCIATION_LIMITS.entries}>
      <Plus /> Add a word
    </Button>
  );
  return (
    <Section id="set-voice-pronunciation" title="Pronunciation" action={add}
      desc="Numbers, dates, money and symbols are already read the way a person says them. For a name or brand the voice gets wrong, write how to say it.">
      <div className="flex flex-col gap-2">
        <ListGroup>
          <button type="button" aria-expanded={shownList} onClick={() => { setOpen(!shownList); if (shownList) setEditing(null); }}
            className="group flex min-h-row w-full items-center gap-x-4 py-2 text-left">
            <span className="min-w-0 flex-1 break-words text-body text-foreground">Words it says your way</span>
            <span className="shrink-0 text-body tabular-nums text-muted-foreground transition group-hover:text-foreground">
              {entries.length ? `${entries.length} ${entries.length === 1 ? "word" : "words"}` : "None yet"}
            </span>
            <ChevronRight aria-hidden className={cn("size-4 shrink-0 text-muted-foreground transition-transform motion-reduce:transition-none", shownList && "rotate-90")} />
          </button>
        </ListGroup>
        {shownList && <>
        {editing === -1 && (
          <EntryForm initial={BLANK} busy={busy === "draft"} onSave={commit} onCancel={() => setEditing(null)}
            onTry={(e) => void say("draft", e.from, [...entries, e])} />
        )}
        {entries.length > FILTER_AT && (
          <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${entries.length} words`} aria-label="Find a word" />
        )}
        {entries.length === 0 && editing !== -1 && (
          <EmptyState>No words yet. Add a name or brand the voice gets wrong, and how to say it.</EmptyState>
        )}
        {q && shown.length === 0 && <NoMatch what="word" query={filter} />}
        {shown.length > 0 && <ListGroup>
          {shown.map(([e, i]) => editing === i ? (
            <div key={i} className="py-2">
              <EntryForm initial={e} busy={busy === "draft"} onSave={commit} onCancel={() => setEditing(null)}
                onTry={(draft) => void say("draft", draft.from, entries.map((x, j) => (j === i ? draft : x)))} />
            </div>
          ) : (
            <div key={i} className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 py-2">
              <span className="min-w-0 flex-1 basis-48 break-words text-label text-foreground">
                {e.from} <span className="text-faint">→</span> <span className="text-muted-foreground">{e.to || "(silent)"}</span>
              </span>
              <span className="flex flex-wrap gap-1">
                {e.lang && <Chip>{languageLabel(e.lang as LanguageCode)}</Chip>}
                {e.matchCase && <Chip>Exact case</Chip>}
                {!e.wholeWord && <Chip>Inside words too</Chip>}
              </span>
              <span className="flex">
                <Tooltip label="Hear it">
                  <Button variant="ghost" size="sm" icon onClick={() => { if (busy === null) void say(`row:${i}`, e.from, entries); }} aria-disabled={busy !== null || undefined} aria-label={`Hear “${e.from}”`}>
                    {busy === `row:${i}` ? <Loader2 className="animate-spin" /> : <Play />}
                  </Button>
                </Tooltip>
                <Tooltip label="Edit"><Button variant="ghost" size="sm" icon onClick={() => setEditing(i)} aria-label={`Edit “${e.from}”`}><Pencil /></Button></Tooltip>
                <Tooltip label="Delete"><Button variant="ghost" size="sm" icon onClick={() => remove(i)} aria-label={`Delete “${e.from}”`}><Trash2 /></Button></Tooltip>
              </span>
            </div>
          ))}
        </ListGroup>}
        </>}
      </div>
    </Section>
  );
}

function EntryForm({ initial, busy, onSave, onCancel, onTry }: {
  initial: LexiconEntry; busy: boolean; onSave: (e: LexiconEntry) => void; onCancel: () => void; onTry: (e: LexiconEntry) => void;
}) {
  const [d, setD] = useState(initial);
  const entry = { ...d, from: d.from.trim(), to: d.to.trim() };
  const set = (patch: Partial<LexiconEntry>) => setD({ ...d, ...patch });
  const keys = (e: React.KeyboardEvent) => { if (e.key === "Enter" && entry.from) onSave(entry); if (e.key === "Escape") onCancel(); };
  return (
    <div className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-card">
      <div className="flex flex-wrap gap-2">
        <Input size="md" autoFocus value={d.from} onChange={(e) => set({ from: e.target.value })} onKeyDown={keys} maxLength={PRONUNCIATION_LIMITS.from}
          placeholder="Word or phrase, as written (Nginx)" aria-label="Word or phrase, as written" className={field} />
        <Input size="md" value={d.to} onChange={(e) => set({ to: e.target.value })} onKeyDown={keys} maxLength={PRONUNCIATION_LIMITS.to}
          placeholder="Say it as (engine x)" aria-label="Say it as" className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-label text-muted-foreground">
        <Select value={d.lang} onChange={(e) => set({ lang: e.target.value })} aria-label="Language">
          <option value="">All languages</option>
          {CURATED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{languageLabel(l.code)}</option>)}
        </Select>
        <label className="flex cursor-pointer items-center gap-2"><Checkbox checked={d.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} /> Exact case</label>
        <label className="flex cursor-pointer items-center gap-2"><Checkbox checked={!d.wholeWord} onChange={(e) => set({ wholeWord: !e.target.checked })} /> Inside words too</label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <Button size="sm" onClick={() => onTry(entry)} disabled={busy || !entry.from}>
          {busy ? <Loader2 className="animate-spin" /> : <Play />} Hear it
        </Button>
        <Button variant="primary" size="sm" onClick={() => onSave(entry)} disabled={!entry.from}>Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
