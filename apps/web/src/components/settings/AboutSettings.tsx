"use client";

import { Github, ExternalLink } from "lucide-react";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { useAppVersion } from "@/lib/useAppVersion";
import { Section } from "./Section";

export function AboutSettings() {
  const version = useAppVersion();
  const links = [
    { href: "https://github.com/katipally/openlive", label: "GitHub repository", icon: Github },
    { href: "https://github.com/katipally/openlive/releases", label: "Releases & changelog", icon: ExternalLink },
  ];
  return (
    <div className="flex flex-col gap-7">
      <Section title="Links" desc="Source, releases, and where to file an issue.">
        <div className="flex flex-col gap-2">
          {links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer"
              className="flex items-center gap-2.5 rounded-lg bg-card px-3 py-2.5 text-label text-foreground shadow-[var(--shadow-card)] transition hover:shadow-[var(--shadow-pop)]">
              <l.icon className="size-4 text-muted-foreground" />
              <span className="flex-1">{l.label}</span>
              <ExternalLink className="size-3.5 text-faint" />
            </a>
          ))}
        </div>
      </Section>

      <div className="flex items-center gap-3 pt-1">
        <OpenLiveMark size={34} />
        <div>
          <p className="text-body font-semibold text-foreground">OpenLive {version && <span className="font-normal text-muted-foreground">v{version}</span>}</p>
          <p className="text-label text-muted-foreground">Ears, eyes, and a voice for your AI.</p>
        </div>
      </div>
    </div>
  );
}
