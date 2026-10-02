"use client";

import { useEffect, useState } from "react";
import { ExternalLink, ShieldCheck } from "lucide-react";
import type { TelemetryStatus } from "@openlive/shared";
import { Button, ListGroup, ListRow, Notice, Switch } from "@/components/ui";
import { deletionRequestUrl, EVENTS_URL, PRIVACY_URL } from "@/lib/repo";
import { reportProblemUrl } from "@/lib/reportProblem";
import { telemetry } from "@/lib/telemetry";
import { toast } from "@/lib/toast";
import { useBrainId } from "@/lib/useBrainId";
import { Section } from "./Section";
import { LoadingRows, OneLine } from "./common";

function ExternalRow({ href, label, detail }: { href: string; label: string; detail: string }) {
  return (
    <a href={href} target="_blank" rel="noreferrer" className="group flex min-h-row items-center gap-3 py-2 text-body text-foreground">
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="break-words">{label}</span>
        <OneLine text={detail} className="text-label text-muted-foreground" />
      </span>
      <ExternalLink aria-hidden className="size-3.5 shrink-0 text-faint transition group-hover:text-foreground" />
    </a>
  );
}

// Product-usage sharing, the desktop app's alone: with no bridge there is
// nothing to show. A build that never reports (development, unstamped) says so
// instead of offering a switch that would do nothing.
export function PrivacySettings() {
  // undefined while the shell answers; null when there is no shell to ask.
  const [s, setS] = useState<TelemetryStatus | null | undefined>(undefined);
  const brainId = useBrainId();
  const refresh = () => telemetry.get().then(setS);
  useEffect(() => { void telemetry.get().then(setS); }, []);
  if (s === undefined) return <LoadingRows />;
  if (!s) return null;

  // Settle on what the shell reports back, as the login switch does.
  const flip = async () => {
    setS({ ...s, enabled: !s.enabled });
    await telemetry.set(!s.enabled, "settings");
    await refresh();
  };
  const flipFeedback = async () => {
    setS({ ...s, feedback: !s.feedback });
    await telemetry.setFeedback(!s.feedback);
    await refresh();
  };
  const copyName = () => {
    void navigator.clipboard.writeText(s.username)
      .then(() => toast("Name copied.", "info"))
      .catch(() => toast(s.username, "info")); // clipboard blocked: at least show it
  };
  const report = (
    <Section id="set-privacy-report" title="Report a problem" desc="Something broken? Tell us on GitHub.">
      <ListGroup>
        <ExternalRow href={reportProblemUrl({ appVersion: s.appVersion, osName: s.osName, osMajor: s.osMajor, brainId })} label="Open a GitHub issue"
          detail="Version and OS, never logs" />
      </ListGroup>
    </Section>
  );

  if (!s.active) {
    return (
      <div className="flex flex-col gap-7">
        <Notice tone="info"><ShieldCheck aria-hidden /> This build does not send usage data, so there is nothing to turn on or off.</Notice>
        {report}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-7">
      <Section id="set-privacy-usage" title="Anonymous usage" desc="Never what you say or type, your files, names or keys.">
        <ListGroup>
          <ListRow asLabel label="Share anonymous usage" detail="Feature use, errors and speed"
            info="Which features get used, errors and speed, so OpenLive can get better. Turning it off sends one last anonymous event saying so, then nothing.">
            <Switch on={s.enabled} onFlip={flip} />
          </ListRow>
          <ExternalRow href={EVENTS_URL} label="What is shared" detail="The full list of events" />
          {s.enabled && (
            <ListRow asLabel label="Ask for feedback" detail="Rare, never mid-session"
              info="A quiet thumbs up or down after a longer session, and now and then a 0 to 10 question. Rare, never during a session, and never once you say don't ask again.">
              <Switch on={s.feedback} onFlip={flipFeedback} />
            </ListRow>
          )}
          <ListRow label="Install ID" detail="Random, per install" info="A random ID for this install, not for you. Turning sharing off deletes it.">
            <span className="font-mono text-label text-muted-foreground">{s.installIdTail ? `…${s.installIdTail.slice(-4)}` : "None"}</span>
          </ListRow>
          <ListRow label="Your anonymous name" detail="Labels this install's usage"
            info="Random, made from the install ID, and never typed by you. It labels this install in the usage data. Turning sharing off deletes it, so copy it first if you may want past events deleted.">
            <span className="flex min-w-0 max-w-full items-center gap-2">
              <OneLine text={s.username || "None"} className="font-mono text-label text-muted-foreground" />
              <Button size="sm" variant="ghost" onClick={copyName} disabled={!s.username}>Copy</Button>
            </span>
          </ListRow>
        </ListGroup>
      </Section>
      <Section id="set-privacy-data" title="Your data" desc="What is kept, and asking for it to be deleted.">
        <ListGroup>
          <ExternalRow href={PRIVACY_URL} label="Privacy policy" detail="What is collected, and why" />
          {s.username && (
            <ExternalRow href={deletionRequestUrl(s.username)} label="Request deletion"
              detail="A draft email, sent by you" />
          )}
        </ListGroup>
      </Section>
      {report}
    </div>
  );
}
