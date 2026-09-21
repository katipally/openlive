"use client";

import { cn } from "@/lib/cn";

// The one centred column every Flow surface sits in.
//
// `m-auto` on the inner block is what makes it balanced at any window height:
// while the content is shorter than the window it centres, and the moment it is
// taller it falls back to ordinary top-aligned scrolling. `justify-center` would
// centre too, and then clip the top of anything that overgrew the window with no
// way to scroll back to it.

export function FlowCanvas({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className="openlive-scroll flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className={cn("m-auto flex w-full max-w-[46rem] flex-col gap-6 px-6 py-8", className)}>
        {children}
      </div>
    </div>
  );
}
