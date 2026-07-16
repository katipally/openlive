"use client";

import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Brain, Check, ChevronRight, Copy, Download, ListTodo, Loader2, PanelRightClose } from "lucide-react";
import { useChat, type ChatMsg, type Part } from "@/lib/chatStore";
import { gsap, useGSAP, DUR, EASE, prefersReduced } from "@/lib/gsap";
import { useLiveStore } from "@/lib/live/liveStore";
import { toolMeta as meta } from "@/lib/live/toolMeta";
import { cn } from "@/lib/cn";

// The running conversation, beside the orb. Assistant turns render as they
// happened — a collapsible "work" block (reasoning + tools, interleaved) followed
// by the spoken answer, filled word-by-word in lockstep with the VOICE (see
// useLiveSession) so it always shows exactly what was said. Resizable + closable.
export function TranscriptPanel({ chatId, width, onResize, onClose }: {
  chatId: string; width: number; onResize: (w: number) => void; onClose: () => void;
}) {
  const msgs = useChat(chatId);
  const { userCaption, userPartial, todos } = useLiveStore();
  const scroller = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);

  // Slide in from the right edge when opened (enter-only; close unmounts, which
  // reads fine for a side panel — same rule as menus/usePopIn).
  useGSAP(() => {
    if (prefersReduced()) return;
    gsap.fromTo(asideRef.current, { x: 24, autoAlpha: 0 }, { x: 0, autoAlpha: 1, duration: DUR.base, ease: EASE.out });
  }, { scope: asideRef });

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, userCaption]);

  // Drag the left edge to resize; clamped to a sane range.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const move = (ev: PointerEvent) => onResize(Math.min(640, Math.max(280, window.innerWidth - ev.clientX)));
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); document.body.style.userSelect = ""; };
    document.body.style.userSelect = "none";
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  const empty = msgs.length === 0 && !(userPartial && userCaption);

  return (
    <aside ref={asideRef} style={{ width }} className="ol-panel-in relative m-3 ml-0 flex shrink-0 flex-col overflow-hidden rounded-2xl bg-surface-raised text-left shadow-[var(--shadow-pop)]">
      <div onPointerDown={startResize} title="Drag to resize"
        className="absolute inset-y-0 -left-1 z-10 w-2 cursor-col-resize" />
      <div className="flex h-12 shrink-0 items-center justify-between pl-4 pr-2 text-[13px] font-semibold">
        Activity
        <div className="flex items-center">
          {msgs.length > 0 && (
            <button onClick={() => exportTranscript(msgs)} title="Export transcript as Markdown" aria-label="Export transcript"
              className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
              <Download className="size-4" />
            </button>
          )}
          <button onClick={onClose} title="Hide activity" aria-label="Hide activity"
            className="grid size-7 place-items-center rounded-md text-muted-foreground transition hover:bg-foreground/10 hover:text-foreground">
            <PanelRightClose className="size-4" />
          </button>
        </div>
      </div>
      {todos.length > 0 && <PlanCard todos={todos} />}
      <div ref={scroller} className="openlive-scroll flex-1 space-y-5 overflow-y-auto p-4">
        {empty && <p className="mt-8 text-center text-[12.5px] text-faint">Your conversation will appear here.</p>}
        {msgs.map((m, i) => (
          <Message key={m.id} msg={m} streaming={m.role === "assistant" && !m.done && i === msgs.length - 1} />
        ))}
        {userPartial && userCaption && (
          <div className="flex justify-end">
            <div className="max-w-[85%] rounded-2xl bg-accent/40 px-3 py-1.5 text-[13px] italic leading-relaxed text-foreground">{userCaption}</div>
          </div>
        )}
      </div>
    </aside>
  );
}

// The agent's working plan (ACP plan updates / the built-in update_todos tool),
// pinned above the transcript while a plan is active. Session-scoped — cleared
// on teardown, replaced whole on every update.
function PlanCard({ todos }: { todos: { text: string; done: boolean }[] }) {
  const done = todos.filter((t) => t.done).length;
  return (
    <div className="mx-4 mb-1 shrink-0 rounded-lg bg-card/40 px-2.5 py-2 shadow-[var(--shadow-xs)]">
      <div className="flex items-center gap-2 text-[11.5px] font-medium text-muted-foreground">
        <ListTodo className="size-3.5 shrink-0 text-accent" />
        Plan
        <span className="ml-auto text-faint">{done}/{todos.length}</span>
      </div>
      <ul className="openlive-scroll mt-1.5 flex max-h-36 flex-col gap-1 overflow-y-auto">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-[12px] leading-relaxed">
            <span className={cn(
              "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border",
              t.done ? "border-accent bg-accent text-accent-foreground" : "border-border-heavy",
            )}>
              {t.done && <Check className="size-2.5" strokeWidth={3} />}
            </span>
            <span className={cn(t.done ? "text-faint line-through" : "text-foreground")}>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Download the conversation as a Markdown file (agent replies are already
 *  markdown; tool runs become one-liners). */
function exportTranscript(msgs: ChatMsg[]) {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") { lines.push(`**You:** ${m.text ?? ""}`, ""); continue; }
    const body = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n").trim();
    const tools = m.parts.filter((p): p is Extract<Part, { kind: "tool" }> => p.kind === "tool");
    if (tools.length) lines.push(tools.map((t) => `> _${meta(t.tool).label}${t.summary ? `: ${t.summary}` : ""}_`).join("\n"), "");
    if (body) lines.push(`**Assistant:** ${body}`, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `openlive-transcript-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** One-tap copy with a brief ✓ confirmation. */
function CopyButton({ text, title, className }: { text: string; title: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button title={title} aria-label={title}
      onClick={() => { navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {}); }}
      className={cn("grid size-6 place-items-center rounded-md text-faint transition hover:bg-foreground/10 hover:text-foreground", className)}>
      {ok ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
    </button>
  );
}

// Agent replies are markdown — render them as such (code blocks with a copy
// button, inline code, lists, links, tables via GFM). react-markdown builds
// React elements, so model-authored text can't inject HTML.
function MarkdownText({ text }: { text: string }) {
  return (
    <div className="ol-md min-w-0 text-[13px] leading-relaxed text-foreground">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>, // the code renderer below owns the block chrome
          code: ({ className, children }) => {
            const body = String(children ?? "");
            if (!body.includes("\n") && !className) {
              return <code className="rounded bg-foreground/8 px-1 py-0.5 font-mono text-[12px]">{body}</code>;
            }
            return (
              <span className="group/code relative my-1.5 block overflow-hidden rounded-lg bg-surface shadow-[var(--shadow-xs)]">
                <CopyButton text={body.replace(/\n$/, "")} title="Copy code"
                  className="absolute right-1.5 top-1.5 bg-card/80 opacity-0 backdrop-blur transition group-hover/code:opacity-100" />
                <code className="openlive-scroll block overflow-x-auto whitespace-pre p-2.5 font-mono text-[12px] leading-relaxed">{body}</code>
              </span>
            );
          },
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer" className="text-link-foreground underline underline-offset-2">{children}</a>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function Message({ msg, streaming }: { msg: ChatMsg; streaming: boolean }) {
  if (msg.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl bg-accent px-3 py-1.5 text-[13px] leading-relaxed text-accent-foreground">{msg.text}</div>
      </div>
    );
  }

  // Group consecutive reasoning/tool parts into one "work" block; text renders as markdown.
  type Seg = { kind: "work"; parts: Part[] } | { kind: "text"; text: string };
  const segs: Seg[] = [];
  for (const p of msg.parts) {
    if (p.kind === "reasoning" || p.kind === "tool") {
      const last = segs[segs.length - 1];
      if (last?.kind === "work") last.parts.push(p);
      else segs.push({ kind: "work", parts: [p] });
    } else {
      segs.push({ kind: "text", text: p.text });
    }
  }
  const fullText = segs.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text).join("\n").trim();

  return (
    <div className="group/msg flex flex-col gap-2">
      {streaming && segs.length === 0 && <span className="arc-shimmer text-[13px] font-medium">Thinking…</span>}
      {segs.map((seg, i) =>
        seg.kind === "work"
          ? <WorkBlock key={i} parts={seg.parts} active={streaming && i === segs.length - 1} />
          : <MarkdownText key={i} text={seg.text} />,
      )}
      {!streaming && fullText && (
        <CopyButton text={fullText} title="Copy message" className="-mt-1 self-start opacity-0 transition group-hover/msg:opacity-100" />
      )}
    </div>
  );
}

// A run of reasoning + tool calls — the message's "work". Expanded while active,
// auto-collapses to a one-line summary once the answer starts.
function WorkBlock({ parts, active }: { parts: Part[]; active: boolean }) {
  const [open, setOpen] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => { if (wasActive.current && !active) setOpen(false); wasActive.current = active; }, [active]);
  const expanded = open || active;

  const tools = parts.filter((p): p is Extract<Part, { kind: "tool" }> => p.kind === "tool");
  const running = tools.find((t) => !t.done);
  const hasReasoning = parts.some((p) => p.kind === "reasoning");

  return (
    <div className="rounded-lg bg-card/40 shadow-[var(--shadow-xs)]">
      <button onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition hover:text-foreground">
        {active ? <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" /> : <Brain className="size-3.5 shrink-0 text-faint" />}
        {active ? (
          <span className="arc-shimmer font-medium">{running ? `${meta(running.tool).active}…` : "Thinking…"}</span>
        ) : (
          <>
            <span className="font-medium text-foreground/80">Worked it out</span>
            {tools.length > 0 && <span className="text-faint">· {tools.length} step{tools.length === 1 ? "" : "s"}</span>}
            {hasReasoning && <span className="text-faint">· reasoned</span>}
          </>
        )}
        <ChevronRight className={cn("ml-auto size-3.5 shrink-0 transition", expanded && "rotate-90")} />
      </button>
      {expanded && (
        <div className="flex flex-col gap-1.5 px-2.5 pb-2.5">
          {parts.map((p, i) =>
            p.kind === "reasoning"
              ? <p key={i} className="whitespace-pre-wrap border-l-2 border-border pl-2.5 text-[12px] italic leading-relaxed text-muted-foreground">{p.text}</p>
              : p.kind === "tool" ? <ToolRow key={i} part={p} /> : null,
          )}
        </div>
      )}
    </div>
  );
}

function ToolRow({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const m = meta(part.tool);
  const Icon = m.icon;
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      {part.done ? <Icon className="size-3.5 shrink-0 text-faint" /> : <Loader2 className="size-3.5 shrink-0 animate-spin text-accent" />}
      <span className="shrink-0">{part.done ? m.label : `${m.active}…`}</span>
      {part.summary && <span className="truncate text-faint">· {part.summary}</span>}
    </div>
  );
}
