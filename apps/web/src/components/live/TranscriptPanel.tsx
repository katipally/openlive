"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useShallow } from "zustand/react/shallow";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { AlertCircle, ArrowDown, Brain, Check, ChevronRight, Copy, Download, Image as ImageIcon, Keyboard, ListTodo, Loader2, PanelRightClose } from "lucide-react";
import { useChat, type ChatMsg, type Part } from "@/lib/chatStore";
import { usePresence } from "@/lib/usePopIn";
import { useLiveStore } from "@/lib/live/liveStore";
import { kindMeta, toolMeta as meta } from "@/lib/live/toolMeta";
import { cn } from "@/lib/cn";
import { usePointerDrag } from "@/lib/usePointerDrag";
import { formatDuration, segmentTurn, summarizeWork, type ToolPart } from "@/lib/live/timeline";
import { useMotionTokens } from "@/lib/motion";
import { Disclosure, Button, SidePanelHeader, sidePanel, Swap, Tooltip } from "@/components/ui";
import { ToolGlyph } from "./ToolGlyph";
import { ToolCallCard } from "./ToolCallCard";
import { Composer, type ComposerHandle } from "./Composer";

// The running conversation, beside the orb. Assistant turns render as they
// happened — a collapsible "work" block (reasoning + tools, interleaved) followed
// by the spoken answer, filled word-by-word in lockstep with the VOICE (see
// useLiveSession) so it always shows exactly what was said. Resizable + closable,
// with a composer at the foot for typing mid-call.
export function TranscriptPanel({ open, chatId, width, overlay, onResize, onClose, onSendAside, onNotForYou }: {
  open: boolean; chatId: string; width: number; onResize: (w: number) => void; onClose: () => void; onSendAside?: (id: string) => void; onNotForYou?: (id: string) => void;
  /** The window is too narrow to sit beside the stage: float over it instead. */
  overlay?: boolean;
}) {
  const msgs = useChat(chatId);
  const { userCaption, userPartial, todos, queue } = useLiveStore(useShallow((s) => ({
    userCaption: s.userCaption, userPartial: s.userPartial, todos: s.todos, queue: s.typedQueue,
  })));
  const scroller = useRef<HTMLDivElement>(null);
  const feed = useRef<HTMLDivElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const { reduce, smooth, fade, exit: leave } = useMotionTokens();
  // Messages already here when the panel opened arrive with it; only later ones rise in.
  const [firstCount] = useState(msgs.length);

  // Slides in from the right edge on open and back out on close before unmounting.
  const mounted = usePresence(asideRef, open, { x: 24 });

  // Follow new words only while the reader is already at the bottom; scrolling
  // up to reread must not get yanked back on every word. Anything that grows the
  // feed (a word, a terminal line, a card opening) or shrinks the view (the
  // composer growing, a resize) keeps a pinned reader at the end. O(1) per change.
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAway(!pinned.current);
  };
  useLayoutEffect(() => {
    const el = scroller.current, body = feed.current;
    if (!mounted || !el || !body) return;
    el.scrollTop = el.scrollHeight;
    const ro = new ResizeObserver(() => { if (pinned.current) el.scrollTop = el.scrollHeight; });
    ro.observe(body);
    ro.observe(el);
    return () => ro.disconnect();
  }, [mounted]);
  const toLatest = () => {
    pinned.current = true;
    setAway(false);
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: reduce ? "auto" : "smooth" });
  };

  // Drag the left edge to resize; clamped to a sane range.
  const drag = usePointerDrag();
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    document.body.style.userSelect = "none";
    const right = asideRef.current?.getBoundingClientRect().right ?? window.innerWidth;
    drag((ev) => onResize(Math.min(640, Math.max(280, right - ev.clientX))), () => { document.body.style.userSelect = ""; });
  };

  if (!mounted) return null;
  const empty = msgs.length === 0 && queue.length === 0 && !(userPartial && userCaption);

  return (
    // The setup panel's shape, the same inset on every side: docked beside the
    // stage, or floating over it when the window is too narrow for both.
    <aside ref={asideRef} aria-label="Activity" style={{ width }}
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) e.preventDefault(); }}
      onDrop={(e) => { e.preventDefault(); composer.current?.addFiles(Array.from(e.dataTransfer.files)); }}
      className={cn(sidePanel(overlay), "max-w-[calc(100%-1.5rem)] shrink-0 overflow-hidden",
        overlay ? "absolute inset-y-3 right-3 z-30" : "relative my-3 mr-3")}>
      <Tooltip label="Drag to resize" className="absolute inset-y-0 left-0 z-10 w-2">
        <div onPointerDown={startResize} className="w-full cursor-col-resize" />
      </Tooltip>
      <SidePanelHeader title="Activity">
        {msgs.length > 0 && (
          <Tooltip label="Export transcript as Markdown"><Button variant="ghost" icon size="sm" onClick={() => exportTranscript(msgs)} aria-label="Export transcript"><Download /></Button></Tooltip>
        )}
        <Tooltip label="Hide activity" keys="T"><Button variant="ghost" icon size="sm" onClick={onClose} aria-label="Hide activity"><PanelRightClose /></Button></Tooltip>
      </SidePanelHeader>
      {todos.length > 0 && <PlanCard todos={todos} />}
      <div className="relative min-h-0 flex-1">
        {/* overflow-anchor off: we pin to the bottom ourselves; browser scroll
            anchoring fights content-visibility height estimates. */}
        <div ref={scroller} onScroll={onScroll} className="openlive-scroll h-full overflow-y-auto [overflow-anchor:none]">
          {/* From the top while it is short, as a chat reads; once it overflows,
              the pin above keeps it at the latest. */}
          <div ref={feed} className="flex flex-col gap-turn px-5 pb-4 pt-1">
            {empty && <p className="text-label text-muted-foreground">Your conversation will appear here. Talk, or type below.</p>}
            {msgs.map((m, i) => (
              <Message key={m.id} msg={m} fresh={i >= firstCount} streaming={m.role === "assistant" && !m.done && i === msgs.length - 1} onSendAside={onSendAside} onNotForYou={onNotForYou} />
            ))}
            {userPartial && userCaption && (
              <div className="flex justify-end">
                <div className="max-w-[85%] rounded-xl rounded-br-md bg-accent-soft px-3 py-1.5 text-body italic text-muted-strong">{userCaption}</div>
              </div>
            )}
            <AnimatePresence initial={false}>
              {queue.map((q) => (
                <motion.div key={q.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, transition: leave }} transition={{ ...smooth, opacity: fade }}>
                  <QueuedBubble text={q.text} images={q.images.length} id={q.id} />
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
        <AnimatePresence>
          {away && (
            <motion.div initial={{ opacity: 0, y: 8, scale: 0.94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 8, scale: 0.94, transition: leave }}
              transition={{ ...smooth, opacity: fade }}
              className="pointer-events-none absolute inset-x-0 bottom-3 flex justify-center">
              <Button size="sm" onClick={toLatest} className="pointer-events-auto border-hairline shadow-pop surface-float">
                <ArrowDown /> Jump to latest
              </Button>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      <Composer ref={composer} onSent={toLatest} />
    </aside>
  );
}

/** A typed message waiting for the reply under way (or the user's own words)
 *  to finish. "Send now" cuts the reply, as speaking over it would. */
function QueuedBubble({ id, text, images }: { id: string; text: string; images: number }) {
  const interrupt = useLiveStore((s) => s.interruptReply);
  const drop = () => { const st = useLiveStore.getState(); st.set({ typedQueue: st.typedQueue.filter((q) => q.id !== id) }); };
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="ol-selectable max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-md border border-dashed border-border-heavy px-3 py-1.5 text-body text-muted-foreground">
        {images > 0 && <span className="mr-1 inline-flex items-center gap-1 text-faint"><ImageIcon className="size-3.5" />{images}</span>}{text}
      </div>
      <span className="flex items-center gap-2 text-micro text-faint">
        Sends when the reply ends
        {interrupt && <button type="button" onClick={interrupt} className="hit underline-offset-2 hover:text-foreground hover:underline">Send now</button>}
        <button type="button" onClick={drop} className="hit underline-offset-2 hover:text-foreground hover:underline">Remove</button>
      </span>
    </div>
  );
}

// The agent's working plan (ACP plan updates / the built-in update_todos tool),
// pinned above the transcript while a plan is active. Session-scoped — cleared
// on teardown, replaced whole on every update.
function PlanCard({ todos }: { todos: { text: string; done: boolean }[] }) {
  const done = todos.filter((t) => t.done).length;
  return (
    <div className="mx-4 mb-1 shrink-0 rounded-lg bg-card/40 px-2.5 py-2 shadow-xs">
      <div className="flex items-center gap-2 text-caption font-medium text-muted-foreground">
        <ListTodo className="size-3.5 shrink-0 text-accent" />
        Plan
        <span className="ml-auto text-faint">{done}/{todos.length}</span>
      </div>
      <ul className="openlive-scroll mt-1.5 flex max-h-36 flex-col gap-1 overflow-y-auto">
        {todos.map((t, i) => (
          <li key={i} className="flex items-start gap-2 text-label leading-relaxed">
            <span className={cn(
              "mt-0.5 grid size-3.5 shrink-0 place-items-center rounded-full border",
              t.done ? "border-accent bg-accent text-accent-foreground" : "border-border-heavy",
            )}>
              {t.done && <Check className="ol-pop size-2.5" strokeWidth={3} />}
            </span>
            <span className={cn(t.done ? "text-faint line-through" : "text-foreground")}>{t.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** A voice turn's speaker as shown: "Other voice 2" for the voiceprint's "other 2", else "You". */
const speakerName = (speaker?: string) => (speaker && speaker !== "you" ? speaker.replace(/^other/, "Other voice") : "You");

/** Download the conversation as a Markdown file (agent replies are already
 *  markdown; tool runs become one-liners). */
function exportTranscript(msgs: ChatMsg[]) {
  const lines: string[] = [];
  for (const m of msgs) {
    if (m.role === "user") { lines.push(`**${speakerName(m.speaker)}${m.aside ? " (taken as side talk, not sent)" : m.notForYou ? " (marked not for you)" : ""}:** ${m.text ?? ""}`, ""); continue; }
    const body = m.parts.filter((p) => p.kind === "text").map((p) => (p as { text: string }).text).join("\n").trim();
    const tools = m.parts.filter((p): p is Extract<Part, { kind: "tool" } | { kind: "acp_tool" }> => p.kind === "tool" || p.kind === "acp_tool");
    if (tools.length) lines.push(tools.map((t) => t.kind === "tool"
      ? `> _${meta(t.tool).label}${t.summary ? `: ${t.summary}` : ""}_`
      : `> _${t.call.title}${t.call.status === "failed" ? " (failed)" : ""}_`).join("\n"), "");
    if (body) lines.push(`**Assistant:** ${body}`, "");
  }
  const blob = new Blob([lines.join("\n")], { type: "text/markdown" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `openlive-transcript-${new Date().toISOString().slice(0, 10)}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/** One-tap copy; the icon turns into a check for a beat. */
function CopyButton({ text, label, className }: { text: string; label: string; className?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Tooltip label={label} className={className}>
      <button aria-label={ok ? "Copied" : label}
        onClick={() => { navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1200); }).catch(() => {}); }}
        className="grid size-7 place-items-center rounded-md text-faint transition hover:bg-foreground/10 hover:text-foreground">
        <Swap id={ok ? "ok" : "copy"}>{ok ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}</Swap>
      </button>
    </Tooltip>
  );
}

// Agent replies are markdown — render them as such (code blocks with a copy
// button, inline code, lists, links, tables via GFM). react-markdown builds
// React elements, so model-authored text can't inject HTML. Memoized: markdown
// parsing is the most expensive thing in this panel — never re-parse unchanged text.
const MarkdownText = memo(function MarkdownText({ text, muted }: { text: string; muted?: boolean }) {
  return (
    <div className={cn("ol-md min-w-0 leading-relaxed", muted ? "text-label text-muted-foreground" : "text-body text-foreground")}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          pre: ({ children }) => <>{children}</>, // the code renderer below owns the block chrome
          code: ({ className, children }) => {
            const body = String(children ?? "");
            if (!body.includes("\n") && !className) {
              return <code className="rounded-sm bg-foreground/8 px-1 py-0.5 font-mono text-label">{body}</code>;
            }
            return (
              <span className="group/code relative my-1.5 block overflow-hidden rounded-lg bg-surface shadow-xs">
                <CopyButton text={body.replace(/\n$/, "")} label="Copy code"
                  className="absolute right-1.5 top-1.5 rounded-md opacity-0 surface-float transition group-hover/code:opacity-100 has-focus-visible:opacity-100" />
                <code className="openlive-scroll block overflow-x-auto whitespace-pre p-2.5 font-mono text-label leading-relaxed">{body}</code>
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
});

// Memoized: during the word-by-word voice reveal only ONE message object changes
// per frame (chatStore preserves identities), so the rest skip re-render.
const Message = memo(function Message({ msg, fresh, streaming, onSendAside, onNotForYou }: { msg: ChatMsg; fresh: boolean; streaming: boolean; onSendAside?: (id: string) => void; onNotForYou?: (id: string) => void }) {
  const rise = fresh && "animate-fade-up";
  if (msg.aside) {
    return (
      <div className={cn("flex flex-col items-end gap-0.5", rise)}>
        <div className="ol-selectable max-w-[85%] rounded-xl rounded-br-md border border-dashed border-border px-3 py-1.5 text-body text-faint">{msg.text}</div>
        <span className="text-micro text-faint">
          Taken as side talk, not sent{onSendAside && <> · <button onClick={() => onSendAside(msg.id)} className="hit underline underline-offset-2 hover:text-foreground">Send it</button></>}
        </span>
      </div>
    );
  }
  if (msg.role === "user") {
    const other = msg.speaker && msg.speaker !== "you";
    return (
      <div className={cn("flex flex-col items-end gap-1", rise)}>
        {other && <span className="text-micro text-faint">{speakerName(msg.speaker)}</span>}
        {msg.images && msg.images.length > 0 && (
          <div className="flex max-w-[85%] flex-wrap justify-end gap-1.5">
            {msg.images.map((src, i) => <img key={i} src={src} alt={`Attached image ${i + 1}`} className="max-h-28 max-w-full rounded-lg object-cover shadow-xs" />)}
          </div>
        )}
        <div className={cn("ol-selectable max-w-[85%] whitespace-pre-wrap break-words rounded-xl rounded-br-md px-3 py-1.5 text-body", other ? "bg-foreground/10 text-foreground" : "bg-accent-soft text-foreground")}>{msg.text}</div>
        {msg.typed && <span className="flex items-center gap-1 text-micro text-faint"><Keyboard aria-hidden className="size-3" />Typed</span>}
        {/* Only a turn with a logged judgment: the mark is a training label. */}
        {msg.judged && onNotForYou && (msg.notForYou
          ? <span className="text-micro text-faint">Marked not for you</span>
          : <Tooltip label="This wasn't said to the agent: stops a reply to it and marks it in the judgment log">
              <button onClick={() => onNotForYou(msg.id)} className="hit text-micro text-faint underline-offset-2 hover:text-foreground hover:underline focus-visible:underline">Not for you</button>
            </Tooltip>)}
      </div>
    );
  }

  const segs = segmentTurn(msg.parts, msg.endedAt);
  const fullText = segs.filter((s) => s.kind === "text").map((s) => (s as { text: string }).text).join("\n").trim();

  return (
    // ol-cv: off-screen messages skip layout/paint — the panel stays smooth on
    // long transcripts without a virtualization library.
    <div className={cn("ol-cv group/msg flex flex-col gap-beat", rise)}>
      {streaming && segs.length === 0 && <span className="arc-shimmer text-body font-medium">Thinking…</span>}
      {segs.map((seg, i) => {
        const live = streaming && i === segs.length - 1;
        if (seg.kind === "work") return <WorkBlock key={i} parts={seg.parts} active={live} startedAt={seg.startedAt} endedAt={seg.endedAt} />;
        if (seg.kind === "step") return seg.part.kind === "tool" ? <ToolRow key={i} part={seg.part} /> : <ToolCallCard key={seg.part.call.id} call={seg.part.call} standalone />;
        // The trailing segment updates every frame while the voice reveals it —
        // render it as plain text (spoken prose has no markdown by design) and
        // flip to markdown once the segment closes or the turn finishes.
        return live
          ? <div key={i} className="min-w-0 whitespace-pre-wrap text-body text-foreground">{seg.text}</div>
          : <MarkdownText key={i} text={seg.text} />;
      })}
      {!streaming && fullText && (
        <CopyButton text={fullText} label="Copy message" className="-mt-1 self-start opacity-0 transition group-hover/msg:opacity-100 has-focus-visible:opacity-100" />
      )}
    </div>
  );
});

// A run of reasoning + tool calls: the message's quiet work. Open while it runs
// (and while an ask inside it waits), then folded to one line that says what it
// did and how long it took; the steps hang off a thin rail when opened.
const WorkBlock = memo(function WorkBlock({ parts, active, startedAt, endedAt }: { parts: Part[]; active: boolean; startedAt?: number; endedAt?: number }) {
  const [open, setOpen] = useState(false);
  const wasActive = useRef(active);
  useEffect(() => { if (wasActive.current && !active) setOpen(false); wasActive.current = active; }, [active]);
  // A pending permission targeting one of these calls must stay visible even
  // after the block auto-collapses — force it open while the ask is live.
  const permTool = useLiveStore((s) => s.permission?.toolCallId);
  const hasPendingAsk = !!permTool && parts.some((p) => p.kind === "acp_tool" && p.call.id === permTool);
  const expanded = open || active || hasPendingAsk;

  const tools = parts.filter((p): p is ToolPart => p.kind === "tool" || p.kind === "acp_tool");
  const failed = tools.filter((t) => (t.kind === "tool" ? t.detail === "error" : t.call.status === "failed")).length;
  const running = tools.find((t) => (t.kind === "tool" ? !t.done : t.call.status === "pending" || t.call.status === "in_progress"));
  const runningLabel = running?.kind === "tool" ? `${meta(running.tool).active}…`
    : running?.kind === "acp_tool" ? `${kindMeta(running.call.kind).active} ${running.call.title}…` : "Thinking…";
  const hasReasoning = parts.some((p) => p.kind === "reasoning");
  const summary = summarizeWork(tools);
  const took = startedAt && endedAt ? formatDuration(endedAt - startedAt) : null;

  return (
    <div className="animate-fade-in flex flex-col">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={expanded}
        className="flex min-h-7 w-full min-w-0 items-center gap-1.5 text-left text-label text-muted-foreground transition hover:text-foreground">
        <ChevronRight aria-hidden className={cn("size-3.5 shrink-0 transition-transform duration-base ease-standard motion-reduce:transition-none", expanded && "rotate-90")} />
        {active ? (
          <span className="arc-shimmer min-w-0 truncate font-medium">{runningLabel}</span>
        ) : (
          <span className="min-w-0 truncate">
            {summary.label}
            {summary.multiKind && <span className="text-faint"> · {tools.length} steps</span>}
            {hasReasoning && <span className="text-faint"> · reasoned</span>}
            {took && <span className="text-faint"> · {took}</span>}
          </span>
        )}
        {!active && failed > 0 && <span className="flex shrink-0 items-center gap-1 text-destructive"><AlertCircle className="size-3" />{failed} failed</span>}
      </button>
      <Disclosure open={expanded}>
        <div className="ml-1.5 flex flex-col gap-1 border-l border-border py-1 pl-3.5">
          {parts.map((p, i) =>
            p.kind === "reasoning" ? <ReasoningRow key={i} text={p.text} live={active && i === parts.length - 1} />
              : p.kind === "tool" ? <ToolRow key={i} part={p} />
              : p.kind === "acp_tool" ? <ToolCallCard key={p.call.id} call={p.call} /> : null,
          )}
        </div>
      </Disclosure>
    </div>
  );
});

/** The model's reasoning, muted and folded: open while it streams, one tap after. */
function ReasoningRow({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState<boolean | null>(null);
  const expanded = open ?? live;
  return (
    <div className="flex flex-col">
      <button type="button" onClick={() => setOpen(!expanded)} aria-expanded={expanded}
        className="flex min-h-7 items-center gap-2 text-left text-label text-faint transition hover:text-foreground">
        <Brain aria-hidden className="size-3.5 shrink-0" />
        <span className={cn(live && "arc-shimmer")}>{live ? "Reasoning…" : "Reasoning"}</span>
        <ChevronRight aria-hidden className={cn("size-3 shrink-0 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
      </button>
      <Disclosure open={expanded}>
        <div className="pb-1 pl-5.5"><MarkdownText text={text} muted /></div>
      </Disclosure>
    </div>
  );
}

/** A built-in tool: one line, the full summary a tap away when it is cut off. */
function ToolRow({ part }: { part: Extract<Part, { kind: "tool" }> }) {
  const [full, setFull] = useState(false);
  const m = meta(part.tool);
  const failed = part.done && part.detail === "error";
  return (
    <button type="button" onClick={() => part.summary && setFull((v) => !v)} aria-expanded={part.summary ? full : undefined}
      className={cn("animate-fade-in flex min-h-7 w-full min-w-0 items-center gap-2 text-left text-label text-muted-foreground", part.summary && "transition hover:text-foreground", full && "items-start py-1")}>
      {!part.done ? <Loader2 aria-hidden className="size-3.5 shrink-0 animate-spin text-accent" />
        : failed ? <AlertCircle aria-hidden className="size-3.5 shrink-0 text-destructive" />
        : <ToolGlyph tool={part.tool} />}
      <span className={cn("shrink-0", failed && "text-destructive")}>{part.done ? m.label : `${m.active}…`}</span>
      {failed && <span className="shrink-0 text-micro text-destructive">failed</span>}
      {part.summary && <span className={cn("min-w-0 font-mono text-caption text-faint", full ? "whitespace-pre-wrap break-words" : "truncate")}>{part.summary}</span>}
    </button>
  );
}
