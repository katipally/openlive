"use client";

import { useEffect, useState } from "react";
import { Loader2, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { LanguageCode } from "@openlive/shared";
import type { LexiconEntry } from "@openlive/shared/speech/lexicon";
import { loadPipelineConfig, savePipelineConfig, onPipelineConfig, CURATED_LANGUAGES, PRONUNCIATION_LIMITS } from "@/lib/live/pipelineConfig";
import { languageLabel } from "@/lib/live/engineMenu";
import { toast } from "@/lib/toast";
import { log } from "@/lib/log";
import { playPreview } from "./PipelineSettings";

const BLANK: LexiconEntry = { from: "", to: "", lang: "", matchCase: false, wholeWord: true };
const field = "h-9 min-w-0 flex-1 basis-40 rounded-lg bg-surface px-3 text-label text-foreground outline-none placeholder:text-faint";
const iconButton = "flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition hover:bg-surface hover:text-foreground disabled:opacity-40";
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
  const entries = cfg.pronunciations;
  const save = (list: LexiconEntry[]) => setCfg(savePipelineConfig({ ...cfg, pronunciations: list }));

  const say = async (key: string, text: string, list: LexiconEntry[]) => {
    setBusy(key);
    try { await playPreview(text, { ...cfg, pronunciations: list }); }
    catch (e) { log.error("tts", "pronunciation preview:", e); toast("Couldn’t play it. Download the voice under Text-to-speech, then try again."); }
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

  return (
    <div className="flex max-w-xl flex-col gap-2">
      {editing === -1 ? (
        <EntryForm initial={BLANK} busy={busy === "draft"} onSave={commit} onCancel={() => setEditing(null)}
          onTry={(e) => void say("draft", e.from, [...entries, e])} />
      ) : (
        <button onClick={() => setEditing(-1)} disabled={entries.length >= PRONUNCIATION_LIMITS.entries}
          className="flex h-9 items-center gap-1.5 self-start rounded-lg bg-foreground px-3 text-label font-medium text-background transition hover:opacity-90 disabled:opacity-40">
          <Plus className="size-4" /> Add a word
        </button>
      )}
      {entries.length > FILTER_AT && (
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${entries.length} words`} aria-label="Find a word"
          className="h-9 w-full rounded-lg bg-card px-3 text-label text-foreground shadow-[var(--shadow-card)] outline-none placeholder:text-faint" />
      )}
      {entries.length === 0 && editing !== -1 && (
        <p className="text-label text-faint">No words yet. Add a name or brand the voice gets wrong, and how to say it.</p>
      )}
      {shown.map(([e, i]) => editing === i ? (
        <EntryForm key={i} initial={e} busy={busy === "draft"} onSave={commit} onCancel={() => setEditing(null)}
          onTry={(draft) => void say("draft", draft.from, entries.map((x, j) => (j === i ? draft : x)))} />
      ) : (
        <div key={i} className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xl bg-card px-3 py-2 shadow-[var(--shadow-card)]">
          <span className="min-w-0 flex-1 basis-48 break-words text-label text-foreground">
            {e.from} <span className="text-faint">→</span> <span className="text-muted-foreground">{e.to || "(silent)"}</span>
          </span>
          <span className="flex flex-wrap gap-1 text-micro text-faint">
            {e.lang && <span className="rounded-full bg-surface px-2 py-0.5">{languageLabel(e.lang as LanguageCode)}</span>}
            {e.matchCase && <span className="rounded-full bg-surface px-2 py-0.5">Exact case</span>}
            {!e.wholeWord && <span className="rounded-full bg-surface px-2 py-0.5">Inside words too</span>}
          </span>
          <span className="flex">
            <button onClick={() => void say(`row:${i}`, e.from, entries)} disabled={busy !== null} title="Hear it" aria-label={`Hear “${e.from}”`} className={iconButton}>
              {busy === `row:${i}` ? <Loader2 className="size-4 animate-spin" /> : <Play className="size-4" />}
            </button>
            <button onClick={() => setEditing(i)} title="Edit" aria-label={`Edit “${e.from}”`} className={iconButton}><Pencil className="size-4" /></button>
            <button onClick={() => remove(i)} title="Delete" aria-label={`Delete “${e.from}”`} className={iconButton}><Trash2 className="size-4" /></button>
          </span>
        </div>
      ))}
    </div>
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
    <div className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-[var(--shadow-card)]">
      <div className="flex flex-wrap gap-2">
        <input autoFocus value={d.from} onChange={(e) => set({ from: e.target.value })} onKeyDown={keys} maxLength={PRONUNCIATION_LIMITS.from}
          placeholder="Word or phrase, as written (Nginx)" aria-label="Word or phrase, as written" className={field} />
        <input value={d.to} onChange={(e) => set({ to: e.target.value })} onKeyDown={keys} maxLength={PRONUNCIATION_LIMITS.to}
          placeholder="Say it as (engine x)" aria-label="Say it as" className={field} />
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-label text-muted-foreground">
        <select value={d.lang} onChange={(e) => set({ lang: e.target.value })} aria-label="Language"
          className="ol-select h-8 min-w-0 max-w-full rounded-lg bg-surface px-2 text-label text-foreground outline-none">
          <option value="">All languages</option>
          {CURATED_LANGUAGES.map((l) => <option key={l.code} value={l.code}>{languageLabel(l.code)}</option>)}
        </select>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={d.matchCase} onChange={(e) => set({ matchCase: e.target.checked })} /> Exact case</label>
        <label className="flex items-center gap-1.5"><input type="checkbox" checked={!d.wholeWord} onChange={(e) => set({ wholeWord: !e.target.checked })} /> Inside words too</label>
      </div>
      <div className="flex flex-wrap items-center gap-1.5">
        <button onClick={() => onTry(entry)} disabled={busy || !entry.from}
          className="flex h-8 items-center gap-1.5 rounded-lg bg-surface px-2.5 text-label font-medium text-foreground transition hover:opacity-90 disabled:opacity-40">
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Play className="size-3.5" />} Hear it
        </button>
        <button onClick={() => onSave(entry)} disabled={!entry.from}
          className="flex h-8 items-center rounded-lg bg-foreground px-2.5 text-label font-medium text-background transition hover:opacity-90 disabled:opacity-40">Save</button>
        <button onClick={onCancel} className="flex h-8 items-center rounded-lg px-2.5 text-label text-muted-foreground transition hover:text-foreground">Cancel</button>
      </div>
    </div>
  );
}
