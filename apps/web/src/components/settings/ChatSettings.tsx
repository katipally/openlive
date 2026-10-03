"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Switch, ListGroup, ListRow } from "@/components/ui";
import { Section } from "./Section";

// What only a call does. The project folder, camera, screen and the model or
// agent for a call are picked in Set up your call, per call, so they have no
// setting here. How a call listens is How you talk, shared with Flow and Dictate.

/** Spoken progress for coding-agent turns: a short voiced one-liner ("Step 2 of
 *  4: refactor the store.") when a tool has run a while and the agent is quiet. */
function NarrateToggle() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  // On unless explicitly "0": mirrors narrationEnabled() on the server, so the
  // switch always shows what the session will actually do.
  const on = (data as Record<string, string> | undefined)?.narrateProgress !== "0";
  const flip = () => void api.updateSettings({ narrateProgress: on ? "0" : "1" })
    .then(() => qc.invalidateQueries({ queryKey: ["settings"] }))
    .catch(() => toast("Couldn’t save that setting. Try again."));
  return (
    <ListRow asLabel label="Narrate agent progress" detail="Short spoken updates"
      info={<>While a coding agent works in silence, speak its plan steps out loud (&ldquo;Step 2 of 4: …&rdquo;). At most a few short lines a turn.</>}>
      <Switch on={on} onFlip={flip} />
    </ListRow>
  );
}

export function ChatSettings() {
  return (
    <div className="flex flex-col gap-7">
      <Section id="set-chat-narrate" title="While an agent works" desc="What a call says while a coding agent is busy.">
        <ListGroup>
          <NarrateToggle />
        </ListGroup>
      </Section>
    </div>
  );
}
