"use client";

import { useEffect, useRef } from "react";
import { Wrench } from "lucide-react";
import { useChat } from "@/lib/chatStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";

// The running conversation, always visible beside the orb. Assistant text is
// filled word-by-word in lockstep with the VOICE (see useLiveSession), so the
// panel always shows exactly what was actually said.
export function TranscriptPanel({ chatId }: { chatId: string }) {
  const msgs = useChat(chatId);
  const { userCaption, userPartial } = useLiveStore();
  const scroller = useRef<HTMLDivElement>(null);

  // Stick to the bottom as new words/turns land.
  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, userCaption]);

  const empty = msgs.length === 0 && !(userPartial && userCaption);

  return (
    <aside className="flex h-full w-full flex-col border-l border-border bg-surface/40">
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4 text-[13px] font-semibold">Transcript</div>
      <div ref={scroller} className="takt-scroll flex-1 space-y-4 overflow-y-auto p-4">
        {empty && (
          <p className="mt-8 text-center text-[12.5px] text-faint">Your conversation will appear here.</p>
        )}
        {msgs.map((m) => (
          <div key={m.id} className={cn("flex flex-col gap-1", m.role === "user" ? "items-end" : "items-start")}>
            <span className="px-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">
              {m.role === "user" ? "You" : "OpenLive"}
            </span>
            {m.tools.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {m.tools.map((t, i) => (
                  <span key={i} className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground">
                    <Wrench className="size-3" /> {t.tool}
                  </span>
                ))}
              </div>
            )}
            {m.text && (
              <div className={cn("max-w-[92%] rounded-2xl px-3 py-2 text-[13px] leading-relaxed",
                m.role === "user" ? "bg-accent text-accent-foreground" : "bg-card text-foreground")}>
                {m.text}
              </div>
            )}
          </div>
        ))}
        {userPartial && userCaption && (
          <div className="flex flex-col items-end gap-1">
            <span className="px-1 text-[10.5px] font-medium uppercase tracking-wide text-faint">You</span>
            <div className="max-w-[92%] rounded-2xl bg-accent/50 px-3 py-2 text-[13px] italic leading-relaxed text-accent-foreground">
              {userCaption}
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
