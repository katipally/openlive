"use client";

import { useState } from "react";
import { Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { FlowConfig } from "@openlive/flow-store";
import { DICTATE_LIMITS } from "@openlive/flow-store/shared";
import { Button, Input, ListGroup, Textarea, Tooltip } from "@/components/ui";
import { toast } from "@/lib/toast";
import type { Snippet } from "@/lib/dictate/words";
import { Section } from "./Section";
import { EmptyState, NoMatch } from "./common";

type Dictate = FlowConfig["dictate"];
type Save = (patch: Partial<Dictate>) => void;

// Past this many entries a filter appears, and past SHOWN the list folds until
// asked, so hundreds of words stay findable without a wall of them.
const FILTER_AT = 12;
const SHOWN = 40;

/** Dictate's Words: the dictionary and the snippets, both kept in Flow's config. */
export function DictateWords({ own, save }: { own: Dictate; save: Save }) {
  return (
    <div className="flex flex-col gap-7">
      <Dictionary words={own.words} save={(words) => save({ words })} />
      <Snippets snippets={own.snippets} save={(snippets) => save({ snippets })} />
    </div>
  );
}

function Dictionary({ words, save }: { words: string[]; save: (w: string[]) => void }) {
  const [draft, setDraft] = useState("");
  const [filter, setFilter] = useState("");
  const [all, setAll] = useState(false);
  const word = draft.trim();
  const dupe = words.some((w) => w.toLowerCase() === word.toLowerCase());
  const full = words.length >= DICTATE_LIMITS.words;
  const add = () => { if (word && !dupe && !full) { save([word, ...words]); setDraft(""); } };
  const remove = (w: string) => {
    const before = words;
    save(words.filter((x) => x !== w));
    toast(`Removed “${w}”`, "info", { undo: () => save(before), commit: () => {} });
  };
  const q = filter.trim().toLowerCase();
  const matched = q ? words.filter((w) => w.toLowerCase().includes(q)) : words;
  const shown = all || q ? matched : matched.slice(0, SHOWN);

  return (
    <Section id="set-dictate-dictionary" title="Dictionary" desc="Names and jargon to spell right.">
      <div className="flex flex-col gap-3">
        <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); add(); }}>
          <Input size="md" value={draft} onChange={(e) => setDraft(e.target.value)} maxLength={DICTATE_LIMITS.word}
            placeholder="Add a word or name" aria-label="Add a word or name" className="min-w-0 flex-1 basis-48" />
          <Button size="sm" type="submit" disabled={!word || dupe || full}><Plus /> Add</Button>
        </form>
        {dupe && <p className="text-label text-muted-foreground">“{word}” is already in the dictionary.</p>}
        {full && <p className="text-label text-muted-foreground">The dictionary holds {DICTATE_LIMITS.words} words. Remove some to add more.</p>}
        {words.length > FILTER_AT && (
          <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${words.length} words`} aria-label="Filter words" />
        )}
        {!words.length && <EmptyState>No words yet. Add names and terms it keeps getting wrong.</EmptyState>}
        {q && !matched.length && <NoMatch what="word" query={filter} />}
        {shown.length > 0 && (
          <ul className="flex flex-wrap gap-1.5">
            {shown.map((w) => (
              <li key={w} className="flex min-w-0 max-w-full items-center gap-1 rounded-full border border-border bg-card py-0.5 pl-3 pr-0.5 text-label text-foreground">
                <span className="min-w-0 break-words">{w}</span>
                <Button variant="ghost" size="sm" icon onClick={() => remove(w)} aria-label={`Remove ${w}`}><X /></Button>
              </li>
            ))}
          </ul>
        )}
        {!all && !q && matched.length > SHOWN && (
          <Button size="sm" variant="ghost" className="self-start" onClick={() => setAll(true)}>Show all {matched.length}</Button>
        )}
      </div>
    </Section>
  );
}

const BLANK: Snippet = { trigger: "", text: "" };

function Snippets({ snippets, save }: { snippets: Snippet[]; save: (s: Snippet[]) => void }) {
  const [editing, setEditing] = useState<number | null>(null); // an index, or -1 for a new one
  const [filter, setFilter] = useState("");
  const commit = (s: Snippet) => {
    save(editing === -1 || editing === null ? [...snippets, s] : snippets.map((x, i) => (i === editing ? s : x)));
    setEditing(null);
  };
  const remove = (i: number) => {
    const before = snippets;
    save(snippets.filter((_, j) => j !== i));
    toast(`Removed “${before[i]!.trigger}”`, "info", { undo: () => save(before), commit: () => {} });
  };
  const q = filter.trim().toLowerCase();
  const shown = snippets.map((s, i) => [s, i] as const).filter(([s]) => !q || `${s.trigger} ${s.text}`.toLowerCase().includes(q));
  const taken = (trigger: string, at: number | null) => snippets.some((s, i) => i !== at && s.trigger.toLowerCase() === trigger.toLowerCase());

  const add = editing !== -1 && (
    <Button size="sm" onClick={() => setEditing(-1)} disabled={snippets.length >= DICTATE_LIMITS.snippets}><Plus /> New snippet</Button>
  );
  return (
    <Section id="set-dictate-snippets" title="Snippets" desc="Say a phrase, get the full text." action={add}>
      <div className="flex flex-col gap-3">
        {editing === -1 && <SnippetForm initial={BLANK} taken={(t) => taken(t, null)} onSave={commit} onCancel={() => setEditing(null)} />}
        {snippets.length > FILTER_AT && (
          <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${snippets.length} snippets`} aria-label="Filter snippets" />
        )}
        {!snippets.length && editing !== -1 && <EmptyState>No snippets yet. Like “my address” typing your full address.</EmptyState>}
        {q && !shown.length && <NoMatch what="snippet" query={filter} />}
        {shown.length > 0 && (
          <ListGroup>
            {shown.map(([s, i]) => editing === i ? (
              <div key={i} className="py-2">
                <SnippetForm initial={s} taken={(t) => taken(t, i)} onSave={commit} onCancel={() => setEditing(null)} />
              </div>
            ) : (
              <div key={i} className="flex min-h-row flex-wrap items-center gap-x-3 gap-y-1 py-2">
                <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                  <span className="break-words text-body text-foreground">{s.trigger}</span>
                  <Tooltip label={s.text} truncated className="flex min-w-0 max-w-full">
                    <span className="line-clamp-2 whitespace-pre-line break-words text-label text-muted-foreground">{s.text}</span>
                  </Tooltip>
                </span>
                <span className="flex">
                  <Tooltip label="Edit"><Button variant="ghost" size="sm" icon onClick={() => setEditing(i)} aria-label={`Edit ${s.trigger}`}><Pencil /></Button></Tooltip>
                  <Tooltip label="Delete"><Button variant="ghost" size="sm" icon onClick={() => remove(i)} aria-label={`Delete ${s.trigger}`}><Trash2 /></Button></Tooltip>
                </span>
              </div>
            ))}
          </ListGroup>
        )}
      </div>
    </Section>
  );
}

function SnippetForm({ initial, taken, onSave, onCancel }: { initial: Snippet; taken: (trigger: string) => boolean; onSave: (s: Snippet) => void; onCancel: () => void }) {
  const [d, setD] = useState(initial);
  const s = { trigger: d.trigger.trim(), text: d.text };
  const clash = !!s.trigger && taken(s.trigger);
  const ok = !!s.trigger && !!s.text.trim() && !clash;
  return (
    <form className="flex flex-col gap-2 rounded-xl bg-card p-3 shadow-card"
      onSubmit={(e) => { e.preventDefault(); if (ok) onSave(s); }} onKeyDown={(e) => { if (e.key === "Escape") onCancel(); }}>
      <Input size="md" autoFocus value={d.trigger} onChange={(e) => setD({ ...d, trigger: e.target.value })} maxLength={DICTATE_LIMITS.trigger}
        placeholder="When I say (sign off)" aria-label="When I say" invalid={clash} />
      {clash && <p className="text-label text-muted-foreground">Another snippet already uses that phrase.</p>}
      <Textarea value={d.text} onChange={(e) => setD({ ...d, text: e.target.value })} maxLength={DICTATE_LIMITS.text} rows={3}
        placeholder="Type (Thanks, Yash)" aria-label="Type" />
      <div className="flex flex-wrap items-center gap-1.5">
        <Button variant="primary" size="sm" type="submit" disabled={!ok}>Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}
