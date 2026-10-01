"use client";

import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from "react";
import { AnimatePresence, motion, useDragControls } from "motion/react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { X, MessagesSquare, Plus, MoreHorizontal, Search } from "lucide-react";
import { api } from "@/lib/api";
import { useUi } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { setConversationBind, setConversationFolder, setConversationResume } from "@/lib/live/useLiveSession";
import { AgentIcon } from "./live/AgentIcon";
import { OpenLiveOrb } from "./OpenLiveOrb";
import { useHistoryOverrides } from "@/lib/historyOverrides";
import { STAGGER_MAX, useMotionTokens } from "@/lib/motion";
import { useFocusTrap } from "@/lib/useFocusTrap";
import { Button, Tooltip, Input, SidePanelHeader, sidePanel, Segmented, type SegOption, menuItem, menuPanel, useMenu, groupLabel, ConfirmButton } from "@/components/ui";
import { cn } from "@/lib/cn";
import { isDesktop, isMacDesktop, basename } from "@/lib/platform";
import type { AgentId } from "@/lib/live/liveClient";
import { agentLabel, isAgentId } from "@openlive/shared";
import type { HistoryChat } from "@openlive/shared";
import { canDelete, flattenHistory, folderSessions, groupHistory, relativeTime, spanLabel } from "@/lib/historyList";
import { SpotlightTour } from "@/components/SpotlightTour";
import { deferDelete, usePendingDeletes } from "@/lib/deferredDelete";

type ResumeFn = (c: HistoryChat, cwd: string) => void;

const SESSION_FILTERS: SegOption<"all" | "openlive">[] = [
  { id: "all", label: "All", title: "Every session for these folders, including ones created in the agents' own CLIs" },
  { id: "openlive", label: "OpenLive", title: "Only sessions started from OpenLive. Hides agent-CLI sessions" },
];

// Rows rendered at first and per "Show more": a long agent history stays quick to open.
const PAGE = 120;
const ROW = "[data-hist-row]";
// A drag left past this, or a flick faster than this, puts the drawer away.
const CLOSE_PX = 96;
const FLICK_PX_S = 500;
// How long the first reveal's stagger owns the rows; past it they are plain rows.
const REVEAL_MS = 700;
// Rows that glide to their new place when the order changes. Only the top of the
// list: it is what is on screen when the drawer opens and where a reorder lands
// (an updated session moves to the top), and it keeps the cost of measuring for
// the animation O(LAYOUT_ROWS) per render however long the history is.
const LAYOUT_ROWS = 40;

// Left Sessions drawer: every conversation, newest first under date headings,
// each row wearing its agent's mark with its folder, when and how long. Search
// matches titles and folder names; rename and delete sit on the row (hover,
// focus or the open one). A delete waits behind an Undo toast.
export function HistorySidebar() {
  const open = useUi((s) => s.historyOpen);
  const setOpen = useUi((s) => s.setHistoryOpen);
  const resumeChat = useUi((s) => s.resumeChat);
  const setLiveOpen = useUi((s) => s.setLiveOpen);
  const activeChatId = useUi((s) => s.activeChatId);
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const drag = useDragControls();
  const dragged = useRef(false);
  const { smooth, gentle, fade, exit: leave, reduce } = useMotionTokens();
  const layoutKey = useId();
  const [settled, setSettled] = useState(false);
  const [query, setQuery] = useState("");
  const [limit, setLimit] = useState(PAGE);
  // "all" = every session, including ones the agents' own CLIs created;
  // "openlive" = only sessions started from OpenLive.
  const [filter, setFilter] = useState<"all" | "openlive">(() =>
    typeof window !== "undefined" && localStorage.getItem("ol-sessions-filter") === "openlive" ? "openlive" : "all");
  useEffect(() => { localStorage.setItem("ol-sessions-filter", filter); }, [filter]);
  const { data: workspaces = [], isLoading, error } = useQuery({ queryKey: ["history", "v2"], queryFn: api.history, enabled: open });
  const pendingDeletes = usePendingDeletes((st) => st.keys);
  const overrides = useHistoryOverrides((st) => st.titles);
  const all = useMemo(() => flattenHistory(workspaces), [workspaces]);

  // Filter and Undo-pending deletes, then search, before anything counts or groups. O(n).
  // A folder's "Delete all" counts what the filter shows, not what the search does.
  const listed = useMemo(() => all.filter(({ chat }) =>
    !pendingDeletes.has(`chat:${chat.id}`) && (filter === "all" || chat.source !== "external"),
  ), [all, pendingDeletes, filter]);
  const folders = useMemo(() => folderSessions(listed), [listed]);
  const q = query.trim().toLowerCase();
  const rows = useMemo(() => q ? listed.filter(({ chat, cwd }) =>
    (overrides[chat.id] ?? chat.title).toLowerCase().includes(q) || cwd.toLowerCase().includes(q),
  ) : listed, [listed, q, overrides]);
  const groups = useMemo(() => groupHistory(rows.slice(0, limit)), [rows, limit]);
  useEffect(() => setLimit(PAGE), [q, filter]);

  useEffect(() => { if (!open) setQuery(""); }, [open]);

  // The first rows on screen after opening cascade in (CSS, the first
  // STAGGER_MAX only), once the data is there, so rows never pop in unanimated.
  // A refetch or a search later changes rows without replaying it.
  useEffect(() => {
    if (!open) { setSettled(false); return; }
    if (isLoading) return;
    const t = setTimeout(() => setSettled(true), REVEAL_MS);
    return () => clearTimeout(t);
  }, [open, isLoading]);

  const close = () => setOpen(false);
  useFocusTrap(root, open, close);

  const resume: ResumeFn = (c, cwd) => {
    // OpenLive chat → reopen it. External agent session → a fresh OpenLive
    // conversation that loadSession-s the agent's own prior thread. Either way, set
    // agent + workspace so the lobby shows the right setup and pre-connects.
    let chatId = c.id;
    featureUsed(c.source === "external" ? "n_history_resume_cli_session" : "n_history_resume");
    if (c.source === "external") {
      useUi.getState().newConversation();
      chatId = useUi.getState().activeChatId;
      setConversationResume(chatId, c.resumeSessionId ?? c.id);
    } else {
      resumeChat(chatId);
    }
    setConversationBind(chatId, (c.agentId ?? null) as AgentId | null);
    if (cwd) setConversationFolder(chatId, cwd);
    setLiveOpen(true);
    close();
  };

  const newChat = () => { setOpen(false); useUi.getState().newConversation(); useUi.getState().setLiveOpen(true); };

  // Up/Down walk the rows (from the search field too), Home/End jump to the ends.
  const walk = (e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    const inField = target.matches('input[type="search"]');
    if (!inField && !target.matches(ROW)) return;
    const items = Array.from(list.current?.querySelectorAll<HTMLElement>(ROW) ?? []);
    if (!items.length) return;
    const at = items.indexOf(target);
    const next = e.key === "ArrowDown" ? (inField ? 0 : Math.min(at + 1, items.length - 1))
      : e.key === "ArrowUp" && !inField ? Math.max(at - 1, 0)
      : e.key === "Home" && !inField ? 0 : e.key === "End" && !inField ? items.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    items[next]!.focus();
  };

  const now = new Date();
  // Headings and rows in paint order, for the reveal's stagger.
  let node = 0;
  const rise = (): CSSProperties | undefined => {
    const i = node++;
    return !settled && i < STAGGER_MAX ? ({ "--i": i } as CSSProperties) : undefined;
  };
  let at = 0;
  return (
    <>
    <AnimatePresence>
      {open && (
        <motion.div key="scrim" className="fixed inset-0 z-drawer-scrim scrim" onClick={close}
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0, transition: leave }} transition={fade} />
      )}
      {open && (
      // Drags left to put away, from anywhere but a field (where a drag selects
      // text). A drag that ends over a row is not a click on it.
      <motion.aside key="drawer" ref={root} role="dialog" aria-modal="true" aria-label="Sessions" onKeyDown={walk}
        initial={{ x: "-105%", opacity: 0.6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: "-105%", opacity: 0.6, transition: reduce ? leave : { ...smooth, opacity: leave } }}
        transition={{ ...smooth, opacity: fade }}
        drag="x" dragListener={false} dragControls={drag} dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 1, right: 0 }} dragMomentum={false}
        onPointerDown={(e) => { dragged.current = false; if (!(e.target as HTMLElement).closest("input, textarea, [role=menu]")) drag.start(e); }}
        onDragStart={() => { dragged.current = true; }}
        onDragEnd={(_, i) => { if (i.offset.x < -CLOSE_PX || i.velocity.x < -FLICK_PX_S) close(); }}
        onClickCapture={(e) => { if (dragged.current) { e.preventDefault(); e.stopPropagation(); } }}
        style={{ touchAction: "pan-y" }}
        className={cn(sidePanel(true), "fixed bottom-3 left-3 top-3 z-drawer w-[min(22.5rem,calc(100%-1.5rem))] overflow-hidden")}>
        {/* Clear of the macOS traffic lights, which sit over this corner. */}
        <SidePanelHeader title="Sessions" className={cn(isMacDesktop && "pt-8", isDesktop && "[-webkit-app-region:drag]")}>
          <Tooltip label="Close sessions" className={cn(isDesktop && "[-webkit-app-region:no-drag]")}>
            <Button variant="ghost" size="sm" icon onClick={close} aria-label="Close sessions"><X /></Button>
          </Tooltip>
        </SidePanelHeader>

        <div className="flex shrink-0 flex-col gap-2.5 px-3 pb-2" data-tour="history-actions">
          <Input type="search" icon={<Search />} value={query} onChange={(e) => { if (!query && e.target.value) featureUsed("n_history_search"); setQuery(e.target.value); }} placeholder="Search chats & folders" spellCheck={false}
            aria-label="Search sessions" onKeyDown={(e) => { if (e.key === "Escape" && query) { e.preventDefault(); e.stopPropagation(); setQuery(""); } }} />
          <Segmented label="Which sessions to show" size="sm" className="grid w-full"
            value={filter} onChange={setFilter} options={SESSION_FILTERS} />
        </div>

        {/* layoutScroll: the gliding rows are measured inside this scroller. */}
        <motion.div ref={list} layoutScroll className="openlive-scroll min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
          {isLoading && <SkeletonRows />}
          {error && <p className="px-3 py-6 text-label text-muted-foreground">Sessions could not be read.</p>}
          {!isLoading && !error && rows.length === 0 && (
            <div className="animate-fade-in flex flex-col items-center gap-1.5 px-6 py-12 text-center">
              <MessagesSquare className="mb-1 size-5 text-faint" aria-hidden />
              <p className="break-words text-body text-muted-strong">
                {q ? <>Nothing matches &ldquo;{query.trim()}&rdquo;.</> : filter === "openlive" ? "No OpenLive sessions yet." : "No sessions yet."}
              </p>
              {!q && (
                <p className="text-caption text-muted-foreground">
                  {filter === "openlive" ? "Switch to All to see sessions from the agents' own CLIs." : "Start a conversation and it will be here."}
                </p>
              )}
            </div>
          )}
          {groups.map((g) => {
            const head = rise();
            return (
              <section key={g.label} aria-label={g.label}>
                <motion.h3 layout={at < LAYOUT_ROWS ? "position" : false} transition={gentle} style={head}
                  className={cn("px-3 pb-1.5 pt-5", groupLabel, head && "ol-rise")}>{g.label}</motion.h3>
                {g.rows.map(({ chat, cwd }) => {
                  const row = <ChatRow c={chat} cwd={cwd} folder={folders.get(cwd)} now={now} selected={chat.id === activeChatId} resume={resume} rise={rise()} />;
                  // A row can change heading as well as place, so it glides by layoutId.
                  return at++ < LAYOUT_ROWS
                    ? <motion.div key={chat.id} layoutId={`${layoutKey}-${chat.id}`} layout="position" transition={gentle}>{row}</motion.div>
                    : <div key={chat.id}>{row}</div>;
                })}
              </section>
            );
          })}
          {rows.length > limit && (
            <Button variant="ghost" size="sm" className="mx-1.5 mt-2" onClick={() => setLimit((n) => n + PAGE)}>
              Show more
            </Button>
          )}
        </motion.div>

        <footer className="shrink-0 border-t border-border px-3 pb-3 pt-2">
          <Button className="w-full" onClick={newChat}><Plus /> New conversation</Button>
        </footer>
      </motion.aside>
      )}
    </AnimatePresence>

      {open && <SpotlightTour id="history" steps={[
        { target: "history-actions", title: "All your conversations", body: "Every agent's sessions, newest first, including ones from the agents' own CLIs. Search by title or folder, or show only the ones started here." },
      ]} />}
    </>
  );
}

// One conversation: the agent's mark, title, folder and agent; when and how long
// on the right, swapped for its options on hover, focus, or while it is the
// open one. Title = an OpenLive-side override (external sessions) or the
// real title (OpenLive sessions).
function ChatRow({ c, cwd, folder, now, selected, resume, rise }: { c: HistoryChat; cwd: string; folder?: HistoryChat[]; now: Date; selected: boolean; resume: ResumeFn; rise?: CSSProperties }) {
  const qc = useQueryClient();
  const override = useHistoryOverrides((st) => st.titles[c.id]);
  const setOverride = useHistoryOverrides((st) => st.setTitle);
  const [editing, setEditing] = useState(false);
  const title = override ?? c.title;
  const span = spanLabel(c.createdAt, c.updatedAt);

  const commit = (val: string) => {
    setEditing(false);
    const t = val.trim();
    if (!t || t === title) return;
    if (c.source === "external") setOverride(c.id, t); // can't rewrite the agent's file — OpenLive-side title
    else api.renameChat(c.id, t).then(() => qc.invalidateQueries({ queryKey: ["history", "v2"] }));
  };

  // Nothing is deleted until the Undo toast is gone, so no confirm is needed,
  // even for an agent's own on-disk session.
  const del = () => deferDelete(`chat:${c.id}`, `Deleted “${title}”`, async () => {
    if (c.source === "external") await api.deleteExternalSession(c.agentId ?? "", c.resumeSessionId ?? c.id);
    else await api.deleteChat(c.id);
    await qc.invalidateQueries({ queryKey: ["history", "v2"] });
  }, "Couldn’t delete that conversation. It’s back in the list.");

  const mark = (
    <span aria-hidden className="grid size-[1.625rem] shrink-0 place-items-center rounded-md bg-foreground/[0.06]">
      {c.agentId && isAgentId(c.agentId) ? <AgentIcon id={c.agentId} className="size-3.5" /> : <OpenLiveOrb size={15} />}
    </span>
  );
  const where = `${cwd ? basename(cwd) : "No folder"} · ${agentLabel(c.agentId)}${c.source === "external" ? " · CLI" : ""}`;

  if (editing) {
    return (
      <div className="flex min-h-14 items-center gap-2.5 px-2.5">
        {mark}
        <Input autoFocus defaultValue={title} spellCheck={false} aria-label="Session title"
          onBlur={(e) => commit(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit((e.target as HTMLInputElement).value);
            if (e.key === "Escape") { e.preventDefault(); setEditing(false); }
          }}
          className="flex-1" />
      </div>
    );
  }

  return (
    <div style={rise} className={cn("group/s flex min-h-14 items-center gap-1 rounded-lg pr-1.5 transition", rise && "ol-rise",
      selected ? "bg-accent-soft" : "hover:bg-foreground/[0.06] focus-within:bg-foreground/[0.06]")}>
      <button type="button" data-hist-row onClick={() => resume(c, cwd)} aria-current={selected || undefined}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch rounded-lg py-1.5 pl-2.5 text-left">
        {mark}
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <Tooltip label={title} truncated><span className="truncate text-body font-medium text-foreground">{title}</span></Tooltip>
          <Tooltip label={cwd}><span className="truncate text-caption text-muted-foreground">{where}</span></Tooltip>
        </span>
      </button>
      {/* When and how long, swapped for the options in the same cell, so the
          title never reflows under the pointer. */}
      <span className="grid shrink-0 items-center justify-items-end [&>*]:[grid-area:1/1]">
        <span aria-hidden={selected || undefined} className={cn("flex flex-col items-end text-caption tabular-nums text-muted-foreground transition-opacity",
          selected ? "opacity-0" : "group-hover/s:opacity-0 group-focus-within/s:opacity-0")}>
          <span>{relativeTime(c.updatedAt, now)}</span>
          {span && <span className="text-faint">{span}</span>}
        </span>
        <RowMenu title={title} selected={selected} onRename={() => setEditing(true)} onDelete={canDelete(c) ? del : undefined}
          folder={cwd && folder?.length ? { name: basename(cwd), chats: folder } : undefined} />
      </span>
    </div>
  );
}

/** Row-shaped placeholders while the list loads. They wait a beat before
 *  fading in, so a quick load never flashes them, and they hold the rows' own
 *  height, so the list does not jump when it arrives. */
function SkeletonRows() {
  return (
    <div role="status" className="ol-skeleton pt-9">
      <span className="sr-only">Loading sessions</span>
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} aria-hidden className="flex min-h-14 items-center gap-2.5 px-2.5">
          <span className="size-[1.625rem] shrink-0 rounded-md bg-foreground/[0.06]" />
          <span className="flex min-w-0 flex-1 flex-col gap-1.5">
            <span className="h-2.5 w-3/4 rounded-full bg-foreground/[0.07]" />
            <span className="h-2 w-1/2 rounded-full bg-foreground/[0.05]" />
          </span>
        </div>
      ))}
    </div>
  );
}

// Hides every chat of one folder behind a single Undo toast, then deletes them.
function useDeleteFolder() {
  const qc = useQueryClient();
  return (name: string, chats: HistoryChat[]) => deferDelete(chats.map((c) => `chat:${c.id}`),
    `Deleted ${chats.length} from ${name}`, async () => {
      const ok = await Promise.all(chats.map((c) => (c.source === "external"
        ? api.deleteExternalSession(c.agentId ?? "", c.resumeSessionId ?? c.id)
        : api.deleteChat(c.id)).then(() => true, () => false)));
      await qc.invalidateQueries({ queryKey: ["history", "v2"] });
      return !ok.includes(false);
    }, "Some could not be deleted. They're back in the list.");
}

/** Rename and Delete for one row, then Delete all for its folder, which asks first. */
function RowMenu({ title, selected, onRename, onDelete, folder }: {
  title: string; selected: boolean; onRename: () => void; onDelete?: () => void; folder?: { name: string; chats: HistoryChat[] };
}) {
  const root = useRef<HTMLDivElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const { open, mounted, requestClose, toggle } = useMenu(root, panel);
  const deleteFolder = useDeleteFolder();
  return (
    <div ref={root} className={cn("relative shrink-0 transition-opacity", !selected && !open && "opacity-0 group-hover/s:opacity-100 group-focus-within/s:opacity-100")}>
      <Tooltip label="Options">
        <Button variant="ghost" size="sm" icon onClick={toggle} aria-label={`Options for ${title}`} aria-haspopup="menu" aria-expanded={open}>
          <MoreHorizontal />
        </Button>
      </Tooltip>
      {mounted && (
        <div ref={panel} role="menu" aria-label="Session options"
          className={cn("absolute right-0 top-full z-overlay mt-1 flex w-max min-w-[9rem] max-w-[min(18rem,80vw)] origin-top-right flex-col", menuPanel)}>
          <button type="button" role="menuitem" onClick={() => { requestClose(); onRename(); }} className={cn(menuItem, "text-label font-medium")}>
            Rename
          </button>
          {onDelete && (
            <button type="button" role="menuitem" onClick={() => { requestClose(); onDelete(); }} className={cn(menuItem, "text-label font-medium text-destructive-text")}>
              Delete
            </button>
          )}
          {folder && (
            <>
              <div role="separator" className="-mx-1.5 my-1.5 border-t border-hairline" />
              <ConfirmButton role="menuitem" label={`Delete all from ${folder.name} (${folder.chats.length})`}
                confirm={`Delete ${folder.chats.length}?`} className="text-left [&>span]:max-w-full [&>span]:truncate"
                onConfirm={() => { requestClose(); deleteFolder(folder.name, folder.chats); }} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
