"use client";

import { useEffect, useRef } from "react";
import { useChat } from "@/lib/chatStore";
import { useLiveStore } from "@/lib/live/liveStore";
import { cn } from "@/lib/cn";

// The running conversation, chat-scroll style: the AI's reply renders directly as
// ambient text; each of your turns is a right-aligned bubble. Newest at the
// bottom, auto-scrolls. Preloaded on resume via chatStore.
export function ConversationView({ chatId, dimmed }: { chatId: string; dimmed?: boolean }) {
  const msgs = useChat(chatId);
  const { userCaption, userPartial } = useLiveStore();
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [msgs, userCaption]);

  const empty = msgs.length === 0 && !(userPartial && userCaption);

  return (
    <div ref={scroller} className={cn("takt-scroll absolute inset-0 overflow-y-auto px-6 pb-40 pt-6 transition-opacity", dimmed && "opacity-40")}>
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {empty && <p className="mt-24 text-center text-[13px] text-faint">Say hello to start the conversation.</p>}
        {msgs.map((m) => (
          m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent px-4 py-2.5 text-[14px] leading-relaxed text-accent-foreground">
                {m.text}
              </div>
            </div>
          ) : (
            <div key={m.id} className="flex flex-col gap-1">
              {m.tools.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {m.tools.map((t, i) => <span key={i} className="rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] text-muted-foreground">{t.tool}</span>)}
                </div>
              )}
              {m.text && <p className="max-w-[92%] text-[16px] leading-relaxed text-foreground/90">{m.text}</p>}
            </div>
          )
        ))}
        {userPartial && userCaption && (
          <div className="flex justify-end">
            <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-accent/50 px-4 py-2.5 text-[14px] italic leading-relaxed text-accent-foreground">
              {userCaption}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
