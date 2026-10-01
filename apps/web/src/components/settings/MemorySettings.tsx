"use client";

import { useEffect, useId, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Loader2, Pencil, Plus, RotateCcw, Search } from "lucide-react";
import { NOTE_MAX_CHARS, type MemoryWire, type NoteWire } from "@openlive/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { cn } from "@/lib/cn";
import { relativeTime } from "@/lib/historyList";
import { budgetMeter, filterNotes, noteProblem } from "@/lib/memory";
import { Badge, Button, ConfirmButton, Input, ListGroup, Textarea, Tooltip } from "@/components/ui";
import { Section } from "./Section";

const KEY = ["memory"];
// Past this many notes a filter appears, as on Connectors and Skills.
const FILTER_AT = 8;
// Notes drawn at once: the list can run to hundreds, and the filter reaches the rest.
const PAGE = 50;
const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const BAR = { ok: "bg-accent", near: "bg-arc", full: "bg-destructive-fill" } as const;

/** The notes every brain carries into its prompt. The agent adds to them on its
 *  own, so the list refreshes on focus. Every change answers with the whole list,
 *  because one note joining or leaving moves the budget's cutoff for the others. */
export function MemorySettings() {
  const qc = useQueryClient();
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState(PAGE);
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: KEY, queryFn: api.memory, retry: 1, refetchOnWindowFocus: true,
  });
  const put = (m: MemoryWire) => qc.setQueryData<MemoryWire>(KEY, m);
  useEffect(() => setShown(PAGE), [filter]);

  const clear = async () => {
    try { put(await api.clearNotes()); }
    catch (e) { toast(`Couldn’t clear memory. ${msg(e)}`); }
  };

  const all = data?.notes ?? [];
  const matches = filterNotes(all, filter);
  const meter = data && budgetMeter(data);

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-memory-list" title="Memory"
        action={all.length > 0 && <ConfirmButton label="Clear all" confirm={`Clear all ${all.length}?`} onConfirm={clear} />}
        desc={<>Short facts about you, saved when you ask an assistant to remember something or added here. Every brain reads them in Chat and Flow, API models and coding agents alike. Only what fits the budget below goes into the prompt, newest first. Changes apply from the next call or Flow session.</>}>
        <div className="flex flex-col gap-2">
          {isLoading && <p className="text-label text-muted-foreground">Looking…</p>}
          {isError && (
            <div role="alert" className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <span className="min-w-0 flex-1 basis-48 break-words text-label text-muted-foreground">Couldn&apos;t reach OpenLive&apos;s agent. {msg(error)}</span>
              <Button size="sm" onClick={() => void refetch()} disabled={isFetching}>
                {isFetching ? <Loader2 className="animate-spin" /> : <RotateCcw />} Retry
              </Button>
            </div>
          )}
          {data && meter && (
            <>
              <div className="flex flex-col gap-1.5">
                <div role="meter" aria-label="Prompt budget used by memory" aria-valuemin={0} aria-valuemax={data.budget} aria-valuenow={Math.min(data.used, data.budget)}
                  className="h-1.5 w-full overflow-hidden rounded-full bg-foreground/10">
                  <div className={cn("h-full rounded-full transition-[width] duration-meter", BAR[meter.tone])} style={{ width: `${meter.pct}%` }} />
                </div>
                <p className="break-words text-caption text-muted-foreground">
                  {data.used.toLocaleString()} of {data.budget.toLocaleString()} characters of the prompt in use.
                  {meter.unused > 0 && <span className="text-arc-text"> {meter.unused} older {meter.unused === 1 ? "note is" : "notes are"} saved but not in use. Delete or shorten some to bring {meter.unused === 1 ? "it" : "them"} back.</span>}
                </p>
              </div>
              <AddNote notes={all} full={all.length >= data.max} onSaved={put} />
            </>
          )}
          {data && all.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-card-x py-5 text-center">
              <p className="text-label text-muted-foreground">Nothing remembered yet. Add a fact above, or ask an assistant to remember one: &ldquo;Remember that I prefer short answers.&rdquo;</p>
            </div>
          )}
          {all.length > FILTER_AT && (
            <Input type="search" size="md" icon={<Search />} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Find among ${all.length} notes`} aria-label="Find a note" />
          )}
          {filter.trim() && matches.length === 0 && <p className="text-label text-muted-foreground">No note matches &ldquo;{filter.trim()}&rdquo;.</p>}
          {matches.length > 0 && (
            <ListGroup>
              {matches.slice(0, shown).map((n) => <NoteRow key={n.id} n={n} all={all} put={put} />)}
            </ListGroup>
          )}
          {matches.length > shown && (
            <Button size="sm" className="self-center" onClick={() => setShown((s) => s + PAGE)}>Show {Math.min(PAGE, matches.length - shown)} more of {matches.length - shown}</Button>
          )}
        </div>
      </Section>
    </div>
  );
}

/** The one text box over the list. Enter saves; a line break typed with Shift is tidied to a space on the server. */
function AddNote({ notes, full, onSaved }: { notes: readonly NoteWire[]; full: boolean; onSaved: (m: MemoryWire) => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const helpId = useId();
  const problem = noteProblem(text, notes);
  const ready = !!text.trim() && !problem && !full;
  const submit = async () => {
    if (!ready || busy) return;
    setError("");
    setBusy(true);
    try { onSaved(await api.addNote(text)); setText(""); }
    catch (e) { setError(msg(e)); }
    finally { setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-start gap-2">
        <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} invalid={!!problem} aria-label="Add a note" aria-describedby={helpId}
          placeholder="They prefer short answers." className="min-w-0 flex-1 basis-64 resize-none"
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void submit(); } }} />
        <Button variant="primary" size="md" onClick={() => void submit()} disabled={!ready || busy}>{busy ? <Loader2 className="animate-spin" /> : <Plus />} Add</Button>
      </div>
      <p id={helpId} className={cn("break-words text-caption", problem || error || full ? "text-destructive" : "text-faint")}>
        {full ? "Memory is full. Delete a note to add another." : error || problem || `${text.replace(/\s+/g, " ").trim().length} of ${NOTE_MAX_CHARS} characters. One short fact.`}
      </p>
    </div>
  );
}

function NoteRow({ n, all, put }: { n: NoteWire; all: readonly NoteWire[]; put: (m: MemoryWire) => void }) {
  const [editing, setEditing] = useState(false);
  const remove = async () => {
    try { put(await api.removeNote(n.id)); }
    catch (e) { toast(`Couldn’t delete that note. ${msg(e)}`); }
  };
  return (
    <div className="py-3">
      {editing ? (
        <Editor n={n} all={all} onSaved={(m) => { put(m); setEditing(false); }} onCancel={() => setEditing(false)} />
      ) : (
        <>
          <Tooltip label={n.text} truncated className="flex min-w-0 max-w-full">
            <p className={cn("line-clamp-3 min-w-0 break-words text-body text-foreground", !n.inUse && "text-muted-foreground")}>{n.text}</p>
          </Tooltip>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {!n.inUse && (
              <Tooltip label="Past the prompt budget, so no assistant is told it. It stays saved.">
                <Badge tone="arc">Not in use</Badge>
              </Tooltip>
            )}
            {n.at != null && <span className="px-1 text-caption text-faint">Saved {relativeTime(new Date(n.at).toISOString())}</span>}
            <span className="ml-auto flex flex-wrap gap-1.5">
              <Button variant="ghost" size="sm" onClick={() => setEditing(true)} aria-label={`Edit: ${n.text.slice(0, 40)}`}><Pencil /> Edit</Button>
              <ConfirmButton label="Delete" confirm="Delete it?" onConfirm={remove} />
            </span>
          </div>
        </>
      )}
    </div>
  );
}

function Editor({ n, all, onSaved, onCancel }: { n: NoteWire; all: readonly NoteWire[]; onSaved: (m: MemoryWire) => void; onCancel: () => void }) {
  const [text, setText] = useState(n.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const problem = noteProblem(text, all, n.id);
  const ready = !!text.trim() && !problem;
  const save = async () => {
    if (!ready || busy) return;
    if (text === n.text) return onCancel();
    setError("");
    setBusy(true);
    try { onSaved(await api.saveNote(n.id, text)); }
    catch (e) { setError(msg(e)); setBusy(false); }
  };
  return (
    <div className="flex flex-col gap-2">
      <Textarea rows={3} autoFocus value={text} onChange={(e) => setText(e.target.value)} invalid={!!problem} aria-label="Edit note"
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          else if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void save(); }
        }} />
      <p className={cn("break-words text-caption", problem || error ? "text-destructive" : "text-faint")}>
        {error || problem || `${text.replace(/\s+/g, " ").trim().length} of ${NOTE_MAX_CHARS} characters.`}
      </p>
      <span className="flex flex-wrap gap-1.5">
        <Button variant="primary" size="sm" onClick={() => void save()} disabled={!ready || busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>
        <Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>
      </span>
    </div>
  );
}
