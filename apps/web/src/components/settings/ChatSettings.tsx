"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { historyKeep } from "@openlive/flow-store/shared";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { chatOnScreen, useUi } from "@/lib/uiStore";
import { useFlowConfig } from "@/lib/flow/useFlowConfig";
import { ListGroup } from "@/components/ui";
import { TalkLinks } from "@/components/flow/FlowSettings";
import { ChatStatusLine } from "@/components/live/ChatStatus";
import { Section } from "./Section";
import { LinkRow, useSettingsNav } from "./nav";
import { AnswerSummary, useDefaultBrain } from "./WhoAnswers";
import { HistorySection } from "./HistorySection";
import { SharedSettings } from "./SharedSettings";

// The Chat tab, in the skeleton Flow's and Dictate's share. The project folder,
// camera, screen and who answers one call are picked in Set up your call, per
// call, so they have no setting here. How a call listens is How you talk.

export function ChatSettings() {
  const { config } = useFlowConfig();
  const answers = useDefaultBrain();
  const go = useSettingsNav();
  return (
    <div className="flex flex-col gap-7">
      <ChatStatusLine id="set-chat-status" />
      {config && (
        <Section id="set-chat-trigger" title="Trigger" desc="How you talk in a call. Set in General.">
          <ListGroup>
            <TalkLinks talk={config.talk} silence={false} />
          </ListGroup>
        </Section>
      )}
      <Section id="set-chat-brain" title="Who answers" desc="New chats start with the default. A chat can switch in its setup.">
        <ListGroup>
          <LinkRow label="The default" value={<AnswerSummary brain={answers.brain} />} onGo={() => go("models", "set-models-default")} />
        </ListGroup>
      </Section>
      <SharedSettings id="set-chat-shared" speaks />
      <ChatHistory />
    </div>
  );
}

/** How long OpenLive's own conversations stay, and Clear all. Agents' CLI sessions are theirs and never touched. */
function ChatHistory() {
  const qc = useQueryClient();
  const onScreen = useUi(chatOnScreen);
  const { data: settings } = useQuery({ queryKey: ["settings"], queryFn: api.settings });
  const { data: workspaces } = useQuery({ queryKey: ["history", "v2"], queryFn: () => api.history(onScreen) });
  const own = workspaces?.flatMap((w) => w.chats.filter((c) => c.source === "openlive"));
  const count = own?.length;
  const open = !!onScreen && !!own?.some((c) => c.id === onScreen);
  const refresh = () => Promise.all([qc.invalidateQueries({ queryKey: ["settings"] }), qc.invalidateQueries({ queryKey: ["history", "v2"] })]);
  return (
    <HistorySection id="set-chat-history" mode="chat" noun="conversations" desc="Your conversations in OpenLive, kept on this machine only."
      keep={historyKeep(settings?.chatHistory)} count={count} held={open ? "open" : undefined} offDetail="Each one goes once it ends"
      onKeep={(chatHistory) => void api.updateSettings({ chatHistory }).then(refresh, () => toast("Couldn't save that setting. Try again."))}
      onClear={() => api.clearChats(onScreen).then(refresh).then(() => true, () => false)}>
      Only conversations started in OpenLive. Sessions from the agents&apos; own CLIs stay as they are.
    </HistorySection>
  );
}
