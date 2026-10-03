"use client";

import type { ReactNode } from "react";
import type { HistoryKeep } from "@openlive/flow-store/shared";
import { ConfirmButton, ListGroup, ListRow, Select } from "@/components/ui";
import { MODE_LABEL, useUi, type AppMode } from "@/lib/uiStore";
import { featureUsed } from "@/lib/featureUse";
import { toast } from "@/lib/toast";
import { LinkRow } from "./nav";
import { Section } from "./Section";

const KEEPS: { id: HistoryKeep; label: string }[] = [
  { id: "off", label: "Keep nothing" }, { id: "day", label: "Keep 1 day" }, { id: "week", label: "Keep 7 days" },
  { id: "month", label: "Keep 30 days" }, { id: "forever", label: "Keep forever" },
];

/** How long a mode's history stays on this machine, Clear all, and the way to
 *  the list on the mode's own screen. The same rows in Chat, Flow and Dictate. */
export function HistorySection({ id, mode, noun, keep, onKeep, count, onClear, offDetail, desc, children }: {
  /** The section's anchor, written out where it is used so the deep-link test can find it. */
  id: string;
  mode: AppMode;
  /** Plural, lower case: "conversations", "sessions", "dictations". */
  noun: string;
  keep: HistoryKeep;
  onKeep: (keep: HistoryKeep) => void;
  /** How many are kept now; unknown while it loads. */
  count?: number;
  /** Deletes them all. False when that failed. */
  onClear: () => Promise<boolean>;
  /** What Keep nothing means for this mode. */
  offDetail: string;
  desc: string;
  /** A note under the rows, for what the section never touches. */
  children?: ReactNode;
}) {
  const inCall = useUi((s) => s.liveOpen);
  const name = MODE_LABEL[mode];
  const clear = () => {
    featureUsed(`n_${mode}_history_clear`);
    void onClear().then((ok) => ok || toast("Couldn't delete them. Try again."));
  };
  // The list is on the mode's screen, which Chat's drawer opens over its home.
  const show = () => {
    useUi.getState().closeSettings();
    useUi.getState().setMode(mode);
    if (mode === "chat") useUi.getState().setHistoryOpen(true);
  };

  return (
    <Section id={id} title="History" desc={desc}>
      <div className="flex flex-col gap-3">
        <ListGroup>
          <ListRow label={`Keep ${noun}`} detail={keep === "off" ? offDetail : count === undefined ? undefined : count === 1 ? "1 kept now" : `${count} kept now`}>
            <Select value={keep} onChange={(e) => onKeep(e.target.value as HistoryKeep)} aria-label={`How long to keep ${noun}`}>
              {KEEPS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
            </Select>
          </ListRow>
          {!!count && (
            <ListRow label="Clear all" detail={`Deletes every kept ${noun.replace(/s$/, "")}`}>
              <ConfirmButton label="Clear all" confirm={count === 1 ? "Delete it" : `Delete all ${count}`} onConfirm={clear} />
            </ListRow>
          )}
          {!inCall && (
            <LinkRow label={`Your ${noun}`} value={`In ${name}`} shared={false} onGo={show} />
          )}
        </ListGroup>
        {children && <p className="text-caption text-muted-foreground">{children}</p>}
      </div>
    </Section>
  );
}
