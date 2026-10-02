"use client";

import { Bug, createLucideIcon, ExternalLink, FolderOpen, RotateCcw } from "lucide-react";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { resetTours } from "@/components/SpotlightTour";
import { bridge, isDesktop } from "@/lib/platform";
import { REPO_URL } from "@/lib/repo";
import { reportProblem } from "@/lib/reportProblem";
import { toast } from "@/lib/toast";
import { useAppVersion } from "@/lib/useAppVersion";
import { useBrainId } from "@/lib/useBrainId";
import { cn } from "@/lib/cn";
import { Section } from "./Section";
import { card, OneLine } from "./common";
import { Button, ListGroup, ListRow } from "@/components/ui";

// lucide-react 1.0 dropped its brand icons; this is its last Github mark (ISC).
// Each node needs a key: lucide renders the nodes as an array of siblings.
const Github = createLucideIcon("github", [
  ["path", { d: "M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4", key: "tonmht" }],
  ["path", { d: "M9 18c-4.51 2-5-2-7-2", key: "9comsn" }],
]);

export function AboutSettings() {
  const version = useAppVersion();
  const brainId = useBrainId();
  const links = [
    { href: REPO_URL, label: "GitHub repository", icon: Github },
    { href: `${REPO_URL}/releases`, label: "Releases & changelog", icon: ExternalLink },
  ];
  return (
    <div className="flex flex-col gap-7">
      <div className={cn(card, "flex-row items-center gap-3 p-card-x")}>
        <OpenLiveMark size={34} />
        <div className="flex min-w-0 flex-1 flex-col">
          <p className="break-words text-body font-semibold text-foreground">OpenLive {version && <span className="font-normal text-muted-foreground">v{version}</span>}</p>
          <OneLine text="Ears, eyes, and a voice for your AI." className="text-label text-muted-foreground" />
        </div>
      </div>

      {isDesktop && bridge && (
        <Section id="set-about-folder" title="OpenLive folder" desc="Settings, memory, connectors (mcp.json), skills, chats and logs.">
          <ListGroup>
            <ListRow label="Show OpenLive folder" detail="Keys and tokens stay encrypted">
              <Button size="sm" onClick={() => void bridge?.("open_home").then((r) => { if (r !== "Opened.") toast(r); })}>
                <FolderOpen aria-hidden /> Open
              </Button>
            </ListRow>
          </ListGroup>
        </Section>
      )}

      <Section id="set-about-tours" title="Tours" desc="The short walkthroughs each screen shows the first time.">
        <ListGroup>
          <ListRow label="Show first-run tours again" detail="Each plays on its next open">
            <Button size="sm" onClick={() => { resetTours(); toast("Tours reset. Each plays again the next time you open its screen.", "info"); }}>
              <RotateCcw aria-hidden /> Replay tours
            </Button>
          </ListRow>
        </ListGroup>
      </Section>

      <Section id="set-about-links" title="Links" desc="Source, releases, and where to file an issue.">
        <ListGroup>
          {links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer" className={linkRow}>
              <l.icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 break-words">{l.label}</span>
              <ExternalLink aria-hidden className="size-3.5 shrink-0 text-faint transition group-hover:text-foreground" />
            </a>
          ))}
          <button type="button" onClick={() => void reportProblem(brainId)} className={cn(linkRow, "w-full text-left")}>
            <Bug aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 break-words">Report an issue</span>
            <ExternalLink aria-hidden className="size-3.5 shrink-0 text-faint transition group-hover:text-foreground" />
          </button>
        </ListGroup>
      </Section>
    </div>
  );
}

const linkRow = "group flex min-h-row items-center gap-3 py-2 text-body text-foreground";
