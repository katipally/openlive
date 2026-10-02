"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ShieldQuestion } from "lucide-react";
import { isTruncated } from "@/lib/truncated";
import { cn } from "@/lib/cn";
import { Disclosure } from "@/components/ui";

/** An approval's question as one line naming the action. The whole question,
 *  and any `details`, open under it when the line is cut or details exist. */
export function AskLine({ id, question, details }: { id?: string; question: string; details?: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [cut, setCut] = useState(false);
  const text = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = text.current;
    if (!el) return;
    const measure = () => setCut(isTruncated(el));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [question]);
  const more = cut || !!details;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 items-start gap-2">
        <ShieldQuestion aria-hidden className="mt-0.5 size-4 shrink-0 text-arc" />
        <span ref={text} id={id} className="min-w-0 flex-1 truncate text-body font-medium text-foreground">{question}</span>
        {more && (
          <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label={open ? "Hide details" : "Show details"}
            className="grid size-5 shrink-0 place-items-center rounded-sm text-muted-foreground transition hover:text-foreground">
            <ChevronDown aria-hidden className={cn("size-4 transition-transform motion-reduce:transition-none", open && "rotate-180")} />
          </button>
        )}
      </div>
      <Disclosure open={open && more}>
        <div className="flex flex-col gap-2 pl-6">
          {cut && <p className="break-words text-label text-muted-foreground">{question}</p>}
          {details}
        </div>
      </Disclosure>
    </div>
  );
}
