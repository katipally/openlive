"use client";

import { useEffect, useId, useImperativeHandle, useLayoutEffect, useRef, useState, type Ref } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ArrowUp, Check, CornerDownLeft, Paperclip, X } from "lucide-react";
import { agentLabel } from "@openlive/shared";
import { useLiveStore } from "@/lib/live/liveStore";
import { acceptFiles, composeMessage, filterCommands, promoteCommand, slashQuery, type Command } from "@/lib/live/composer";
import { useMotionTokens } from "@/lib/motion";
import { Button, Swap, Tooltip, menuPanel, groupLabel } from "@/components/ui";
import { cn } from "@/lib/cn";

export interface ComposerHandle { addFiles: (files: File[]) => void }
type Attachment = { id: string; name: string; data: string; mime: string };

const NO_COMMANDS: Command[] = [];
const SENT_MS = 900;
// Past this the model sees no more detail (vision inputs are scaled to about
// this size), and a phone photo would cost a megabyte per turn for nothing.
const MAX_SIDE = 1600;

/** An image, scaled down and re-encoded the way camera frames travel. */
async function toJpeg(file: File): Promise<{ data: string; mime: string }> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(bmp.width * scale));
  c.height = Math.max(1, Math.round(bmp.height * scale));
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = "#fff"; // a transparent PNG would turn black as a JPEG
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close();
  const url = c.toDataURL("image/jpeg", 0.86);
  return { data: url.slice(url.indexOf(",") + 1), mime: "image/jpeg" };
}

// Type mid-call, in API mode and with every agent: a growing field (Enter
// sends, Shift+Enter breaks the line, an IME composition is never cut short),
// images by button, paste or drop, and the agent's slash commands as a chip.
// A send joins the queue the live session drains once the reply is over and
// the user is not talking, so typing never cuts the mic or the voice.
export function Composer({ ref, onSent }: { ref?: Ref<ComposerHandle>; onSent: () => void }) {
  const commands = useLiveStore((s) => s.agentMeta?.commands ?? NO_COMMANDS);
  const agent = useLiveStore((s) => s.boundAgent);
  const [text, setText] = useState("");
  const [command, setCommand] = useState<Command | null>(null);
  const [images, setImages] = useState<Attachment[]>([]);
  const [note, setNote] = useState("");
  const [forced, setForced] = useState(false); // opened by the "/" button over a draft
  const [dismissed, setDismissed] = useState(false); // Esc, until the draft changes
  const [active, setActive] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [sent, setSent] = useState(false);
  const [reading, setReading] = useState(0); // images still being scaled down
  const field = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const listId = useId();
  const highlightId = useId();
  const { smooth, snappy, fade, exit: leave } = useMotionTokens();

  const query = command ? null : forced ? "" : slashQuery(text);
  const matches = query == null ? NO_COMMANDS : filterCommands(commands, query);
  const menuOpen = query != null && commands.length > 0 && !dismissed;
  const optionId = (i: number) => `${listId}-${i}`;

  useEffect(() => { setActive(0); }, [query]);
  // The send button holds its check for a beat, then is a send button again.
  useEffect(() => {
    if (!sent) return;
    const t = setTimeout(() => setSent(false), SENT_MS);
    return () => clearTimeout(t);
  }, [sent]);
  useEffect(() => { if (menuOpen) document.getElementById(optionId(active))?.scrollIntoView({ block: "nearest" }); }, [active, menuOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  // Grow with the text up to the field's max height, then scroll inside it.
  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [text, command]);

  const addFiles = (files: File[]) => {
    // Images still being read count toward the limit, and hold the send: a send
    // before one lands would go without it and leave it on the next message.
    const { accepted, rejected } = acceptFiles(images.length + reading, files);
    setNote(rejected[0]?.reason ?? "");
    setReading((n) => n + accepted.length);
    for (const f of accepted) {
      toJpeg(f)
        .then((j) => setImages((cur) => [...cur, { id: crypto.randomUUID(), name: f.name || "Pasted image", ...j }]))
        .catch(() => setNote(`Couldn't read ${f.name || "that image"}.`))
        .finally(() => setReading((n) => n - 1));
    }
  };
  useImperativeHandle(ref, () => ({ addFiles }));

  const change = (v: string) => {
    setDismissed(false);
    setNote("");
    const p = command ? null : promoteCommand(v, commands);
    if (p) { setCommand(p.command); setText(p.rest); setForced(false); return; }
    setText(v);
  };

  const pick = (c: Command) => {
    setCommand(c);
    // A "/query" draft was only ever the command's name; a draft the "/" button opened over is the command's words.
    if (!forced || slashQuery(text) != null) setText("");
    setForced(false);
    field.current?.focus();
  };

  const message = composeMessage(command, text, images.length);
  const send = () => {
    if (!message || reading) return;
    const st = useLiveStore.getState();
    st.set({ typedQueue: [...st.typedQueue, { id: crypto.randomUUID(), text: message, images: images.map(({ data, mime }) => ({ data, mime })) }] });
    setText(""); setCommand(null); setImages([]); setNote(""); setForced(false); setSent(true);
    onSent();
  };

  const onKey = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Enter that confirms an IME composition (Japanese, Chinese, ...) is not a send.
    if (e.nativeEvent.isComposing || e.keyCode === 229) return;
    if (menuOpen && matches.length) {
      if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => (a + 1) % matches.length); return; }
      if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => (a - 1 + matches.length) % matches.length); return; }
      if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); pick(matches[active]!); return; }
    }
    if (menuOpen && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); setDismissed(true); setForced(false); return; }
    if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); return; }
    const el = e.currentTarget;
    if (e.key === "Backspace" && command && el.selectionStart === 0 && el.selectionEnd === 0) { e.preventDefault(); setCommand(null); }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files);
    if (!files.length) return;
    // Rich copies carry text and a picture of it: keep the text, as a paste should.
    if (!e.clipboardData.getData("text/plain")) e.preventDefault();
    addFiles(files);
  };

  const toggleCommands = () => {
    if (menuOpen) { setDismissed(true); setForced(false); }
    else if (!text) { setText("/"); setDismissed(false); }
    else { setForced(true); setDismissed(false); }
    field.current?.focus();
  };

  const label = agent ? agentLabel(agent) : "Commands";
  return (
    <div className="@container group/composer relative mx-3 mb-3 shrink-0"
      onDragOver={(e) => { if (e.dataTransfer.types.includes("Files")) { e.preventDefault(); setDragging(true); } }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false); }}
      onDrop={(e) => { e.preventDefault(); setDragging(false); addFiles(Array.from(e.dataTransfer.files)); }}>
      <AnimatePresence>
        {menuOpen && (
          <motion.div initial={{ opacity: 0, y: 6, scale: 0.98 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: 6, scale: 0.98, transition: leave }}
            transition={{ ...smooth, opacity: fade }}
            className={cn("absolute inset-x-0 bottom-full z-30 mb-2 flex max-h-[min(22rem,50vh)] origin-bottom flex-col", menuPanel)}>
            <div className={cn("flex shrink-0 items-center justify-between gap-2 px-2.5 pb-1.5 pt-1", groupLabel)}>
              <span className="truncate">{agent ? `${label} commands` : label}</span>
              <span className="shrink-0 normal-case tracking-normal">Esc to close</span>
            </div>
            <motion.div layoutScroll id={listId} role="listbox" aria-label={`${label} commands`} className="openlive-scroll min-h-0 overflow-y-auto">
              {matches.length === 0 && <p className="px-2.5 py-3 text-center text-label text-faint">No command matches</p>}
              {matches.map((c, i) => (
                <button key={c.name} id={optionId(i)} type="button" role="option" aria-selected={i === active} tabIndex={-1}
                  onMouseEnter={() => setActive(i)} onMouseDown={(e) => e.preventDefault()} onClick={() => pick(c)}
                  className="relative isolate flex min-h-9 w-full items-center gap-2.5 rounded-sm px-2.5 py-1.5 text-left">
                  {/* One highlight that travels to the active row, by key or pointer. */}
                  {i === active && <motion.span layoutId={highlightId} transition={snappy} aria-hidden className="absolute inset-0 -z-10 rounded-sm bg-foreground/[0.07]" />}
                  <span className={cn("max-w-[45%] shrink-0 truncate font-mono text-label", i === active ? "text-link-foreground" : "text-foreground")}>/{c.name}</span>
                  <span className="min-w-0 flex-1 truncate text-label text-muted-foreground">{c.description}</span>
                  {c.hint && <span className="hidden max-w-[30%] shrink truncate font-mono text-caption text-faint @[22rem]:inline">{c.hint}</span>}
                  {i === active && <CornerDownLeft aria-hidden className="size-3 shrink-0 text-faint" />}
                </button>
              ))}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* The kit's text field (components/Input), grown to hold a toolbar. */}
      <div className={cn("flex flex-col rounded-lg border bg-control shadow-xs transition-[border-color,box-shadow]",
        dragging ? "border-accent ring-3 ring-accent/15" : "border-border focus-within:border-accent focus-within:ring-3 focus-within:ring-accent/15")}>
        <AnimatePresence initial={false}>
          {images.length > 0 && (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={fade} className="overflow-hidden">
              <div className="flex flex-wrap gap-1.5 px-2 pt-2">
                <AnimatePresence mode="popLayout" initial={false}>
                {images.map((a) => (
                  <motion.span key={a.id} layout initial={{ opacity: 0, scale: 0.8 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.8, transition: leave }}
                    transition={{ ...snappy, opacity: fade }}
                    className="inline-flex h-8 max-w-full items-center gap-1.5 rounded-md bg-foreground/[0.06] pl-[3px] pr-1 ring-1 ring-inset ring-border">
                    <img src={`data:${a.mime};base64,${a.data}`} alt="" className="size-[26px] shrink-0 rounded-sm object-cover" />
                    <span className="min-w-0 truncate text-label">{a.name}</span>
                    <Button variant="ghost" icon size="sm" aria-label={`Remove ${a.name}`} className="size-7"
                      onClick={() => setImages((cur) => cur.filter((x) => x.id !== a.id))}><X /></Button>
                  </motion.span>
                ))}
                </AnimatePresence>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        <div className="flex items-start gap-1.5 px-3 pb-1 pt-2">
          <AnimatePresence mode="popLayout" initial={false}>
            {command && (
              <motion.span key={command.name} initial={{ opacity: 0, scale: 0.85 }} animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.85, transition: leave }} transition={{ ...snappy, opacity: fade }}
                className="mt-px inline-flex h-5 max-w-[50%] shrink-0 origin-left items-center rounded-sm bg-accent-soft px-1.5 font-mono text-label text-link-foreground">
                <Tooltip label={command.description} className="min-w-0"><span className="truncate">/{command.name}</span></Tooltip>
              </motion.span>
            )}
          </AnimatePresence>
          <textarea ref={field} value={text} rows={1} onChange={(e) => change(e.target.value)} onKeyDown={onKey} onPaste={onPaste}
            onBlur={() => setForced(false)}
            placeholder={command ? (command.hint ?? "Add details, or press Enter") : commands.length ? "Type a message, or / for commands" : "Type a message"}
            aria-label="Type a message" aria-autocomplete={commands.length ? "list" : undefined}
            aria-controls={menuOpen ? listId : undefined} aria-expanded={commands.length ? menuOpen : undefined}
            aria-activedescendant={menuOpen && matches[active] ? optionId(active) : undefined}
            className="openlive-scroll max-h-[40vh] min-h-5 min-w-0 flex-1 resize-none bg-transparent text-body text-foreground outline-none placeholder:text-faint" />
        </div>

        <div className="flex items-center gap-0.5 px-1.5 pb-1.5">
          <input ref={picker} type="file" accept="image/*" multiple hidden
            onChange={(e) => { addFiles(Array.from(e.target.files ?? [])); e.target.value = ""; }} />
          <Tooltip label="Attach an image">
            <Button variant="ghost" icon size="sm" aria-label="Attach an image" onClick={() => picker.current?.click()}><Paperclip /></Button>
          </Tooltip>
          {commands.length > 0 && !command && (
            <Tooltip label={`${label} commands`}>
              <Button variant="ghost" icon size="sm" aria-label="Commands" aria-pressed={menuOpen}
                className={cn("font-mono text-callout", menuOpen && "bg-accent-soft text-link-foreground")}
                onMouseDown={(e) => e.preventDefault()} onClick={toggleCommands}>
                /
              </Button>
            </Tooltip>
          )}
          <span key={note} aria-live="polite" className={cn("min-w-0 flex-1 truncate px-1.5 text-right text-caption", note ? "ol-shake text-danger" : "text-faint")}>
            {/* Only while typing: at rest the toolbar is just its buttons. */}
            {note || <span className="hidden @[20rem]:group-focus-within/composer:inline">Enter to send · Shift+Enter for a new line</span>}
          </span>
          <Tooltip label="Send (Enter)">
            <Button variant={message || sent ? "primary" : "secondary"} icon size="sm" aria-label={sent ? "Sent" : "Send"} disabled={(!message && !sent) || reading > 0} onClick={send}>
              <Swap id={sent ? "sent" : "send"}>{sent ? <Check /> : <ArrowUp />}</Swap>
            </Button>
          </Tooltip>
        </div>
      </div>
    </div>
  );
}
