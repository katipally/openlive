"use client";

import { useId, useRef, useState } from "react";
import { ExternalLink, KeyRound } from "lucide-react";
import { useLiveStore } from "@/lib/live/liveStore";
import { usePresence } from "@/lib/usePopIn";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { bridge, isDesktop } from "@/lib/platform";
import { ModalVoiceInput } from "./ModalVoiceInput";
import { Checkbox, Input, RadioGroup, Button, linkClass, sidePanel } from "@/components/ui";
import { cn } from "@/lib/cn";

// Overlay for an agent elicitation. URL mode: we already opened the browser and
// spoke the ask — this card is the visible Done/Cancel + a re-open link. Form
// mode: renders the ACP ElicitationSchema (flat, primitive-typed fields only:
// string/enum, number, integer, boolean, multi-select array).
export function ElicitationPrompt() {
  const live = useLiveStore((s) => s.elicitation);
  const answer = useLiveStore((s) => s.answerElicitation);
  const rootRef = useRef<HTMLDivElement>(null);
  const open = !!live && !!answer;
  // Retain the last elicitation through the exit fade (it's null once answered).
  const last = useRef(live);
  if (live) last.current = live;
  const elicitation = live ?? last.current;
  const mounted = usePresence(rootRef, open);
  const titleId = useId();
  useFocusTrap(rootRef, mounted, () => answer?.("cancel"));
  if (!mounted || !elicitation || !answer) return null;
  return (
    // Centered modal, same ergonomics as the permission prompt: the agent is
    // blocked on this input, so it owns the stage until answered. z-modal keeps it
    // above Settings if that's open mid-call.
    <div ref={rootRef} className="ol-over-settings fixed inset-0 z-modal grid place-items-center scrim px-4">
      <div role="dialog" aria-modal="true" aria-labelledby={titleId} className={cn(sidePanel(true), "animate-modal-in w-full max-w-md gap-3 p-4")}>
        <div className="flex items-start gap-2.5">
          <KeyRound className="mt-0.5 size-5 shrink-0 text-accent" aria-hidden />
          <p id={titleId} className="text-body leading-relaxed text-foreground">{elicitation.message}</p>
        </div>
        {elicitation.mode === "url"
          ? <UrlBody url={elicitation.url ?? ""} answer={answer} />
          : <FormBody schema={elicitation.schema} answer={answer} />}
      </div>
    </div>
  );
}

function UrlBody({ url, answer }: { url: string; answer: NonNullable<ReturnType<typeof useLiveStore.getState>["answerElicitation"]> }) {
  const reopen = () => {
    if (isDesktop && bridge) void bridge("open_url", url);
    else window.open(url, "_blank", "noopener");
  };
  return (
    <>
      {url && (
        <button onClick={reopen} className={cn("flex items-center gap-1.5 self-start text-label", linkClass)}>
          <ExternalLink className="size-3.5" />Open the link again
        </button>
      )}
      <ModalVoiceInput hint="Say “done” when finished, or “cancel”" />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => answer("cancel")}>Cancel</Button>
        <Button variant="primary" size="sm" onClick={() => answer("accept")}>Done</Button>
      </div>
    </>
  );
}

// ── form mode ────────────────────────────────────────────────────────────────

type PropSchema = {
  type?: string; title?: string | null; description?: string | null;
  enum?: unknown[]; oneOf?: Array<{ const?: unknown; title?: string | null }>;
  minimum?: number | null; maximum?: number | null; default?: unknown;
  items?: { enum?: unknown[]; oneOf?: Array<{ const?: unknown; title?: string | null }> };
};
type FormSchema = { title?: string | null; properties?: Record<string, PropSchema>; required?: string[] | null };

const choices = (p: PropSchema): { value: string; label: string }[] => {
  if (p.enum) return p.enum.map((v) => ({ value: String(v), label: String(v) }));
  if (p.oneOf) return p.oneOf.map((o) => ({ value: String(o.const ?? ""), label: o.title || String(o.const ?? "") }));
  return [];
};

function FormBody({ schema, answer }: { schema: unknown; answer: NonNullable<ReturnType<typeof useLiveStore.getState>["answerElicitation"]> }) {
  const s = (schema ?? {}) as FormSchema;
  const props = Object.entries(s.properties ?? {});
  const required = new Set(s.required ?? []);
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    Object.fromEntries(props.filter(([, p]) => p.default !== undefined).map(([k, p]) => [k, p.default])));
  const setV = (k: string, v: unknown) => setValues((old) => ({ ...old, [k]: v }));

  const missing = props.filter(([k]) => required.has(k)).some(([k]) => {
    const v = values[k];
    return v === undefined || v === "" || (Array.isArray(v) && v.length === 0);
  });

  const submit = () => {
    // Only send fields the user actually set — numbers coerced, empties dropped.
    const content: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) if (v !== undefined && v !== "") content[k] = v;
    answer("accept", content);
  };

  return (
    <>
      <div className="openlive-scroll flex max-h-72 flex-col gap-2.5 overflow-y-auto">
        {props.map(([key, p]) => (
          <Field key={key} name={key} p={p} required={required.has(key)} value={values[key]} onChange={(v) => setV(key, v)} />
        ))}
      </div>
      <ModalVoiceInput hint="Say your answer, or “cancel” to dismiss" />
      <div className="flex justify-end gap-2">
        <Button size="sm" onClick={() => answer("decline")}>Decline</Button>
        <Button variant="primary" size="sm" onClick={submit} disabled={missing}>Submit</Button>
      </div>
    </>
  );
}

function Field({ name, p, required, value, onChange }: {
  name: string; p: PropSchema; required: boolean; value: unknown; onChange: (v: unknown) => void;
}) {
  const label = p.title || name;
  const opts = choices(p);

  return (
    <label className="flex flex-col gap-1 text-label text-muted-foreground">
      <span>{label}{required && <span className="text-destructive"> *</span>}</span>
      {p.description && <span className="text-caption text-faint">{p.description}</span>}
      {p.type === "boolean" ? (
        <Checkbox checked={!!value} onChange={(e) => onChange(e.target.checked)} className="cursor-pointer self-start" />
      ) : p.type === "array" ? (
        <MultiSelect items={choices({ enum: p.items?.enum, oneOf: p.items?.oneOf })} value={Array.isArray(value) ? (value as string[]) : []} onChange={onChange} />
      ) : opts.length ? (
        // All options visible (not a dropdown) so they're glanceable and speakable —
        // say the choice and the voice path selects it; tap works too.
        <RadioGroup label={label} name={name} value={String(value ?? "")} onChange={onChange} options={opts} />
      ) : p.type === "number" || p.type === "integer" ? (
        <Input type="number" value={value == null ? "" : String(value)} min={p.minimum ?? undefined} max={p.maximum ?? undefined}
          step={p.type === "integer" ? 1 : "any"}
          onChange={(e) => onChange(e.target.value === "" ? undefined : p.type === "integer" ? Math.trunc(Number(e.target.value)) : Number(e.target.value))}
          className="w-full" />
      ) : (
        <Input value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className="w-full" />
      )}
    </label>
  );
}

function MultiSelect({ items, value, onChange }: { items: { value: string; label: string }[]; value: string[]; onChange: (v: string[]) => void }) {
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  return (
    <div className="flex flex-col gap-1">
      {items.map((o) => (
        <label key={o.value} className="flex items-center gap-2 text-label text-foreground">
          <Checkbox checked={value.includes(o.value)} onChange={() => toggle(o.value)} className="cursor-pointer" />
          {o.label}
        </label>
      ))}
    </div>
  );
}
