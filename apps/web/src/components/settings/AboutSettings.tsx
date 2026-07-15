"use client";

import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Sun, Moon, Github, ExternalLink } from "lucide-react";
import { OpenLiveMark } from "@/components/OpenLiveMark";
import { useAppVersion } from "@/lib/useAppVersion";
import { cn } from "@/lib/cn";

const THEMES = [
  { id: "system", label: "System", icon: Monitor },
  { id: "light", label: "Light", icon: Sun },
  { id: "dark", label: "Dark", icon: Moon },
] as const;

function ThemePicker() {
  const { theme, setTheme } = useTheme();
  // next-themes resolves on the client only — avoid a hydration mismatch.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const active = mounted ? theme ?? "system" : "system";
  return (
    <div className="inline-flex rounded-lg border border-border bg-card p-1">
      {THEMES.map((t) => (
        <button key={t.id} onClick={() => setTheme(t.id)}
          className={cn("flex items-center gap-1.5 rounded-md px-3.5 py-1.5 text-[12.5px] font-medium transition",
            active === t.id ? "bg-foreground text-background shadow-sm" : "text-muted-foreground hover:bg-foreground/[0.06] hover:text-foreground")}>
          <t.icon className="size-3.5" /> {t.label}
        </button>
      ))}
    </div>
  );
}

function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}

export function AboutSettings() {
  const version = useAppVersion();
  const links = [
    { href: "https://github.com/katipally/openlive", label: "GitHub repository", icon: Github },
    { href: "https://github.com/katipally/openlive/releases", label: "Releases & changelog", icon: ExternalLink },
  ];
  return (
    <div className="flex flex-col gap-7">
      <Section title="Appearance" desc="Match your system, or force light or dark. Applies everywhere, instantly.">
        <ThemePicker />
      </Section>

      <Section title="Links" desc="Source, releases, and where to file an issue.">
        <div className="flex flex-col gap-2">
          {links.map((l) => (
            <a key={l.href} href={l.href} target="_blank" rel="noreferrer"
              className="flex items-center gap-2.5 rounded-lg border border-border bg-card px-3 py-2.5 text-[12.5px] text-foreground transition hover:border-border-heavy">
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
          <p className="text-[13px] font-semibold text-foreground">OpenLive {version && <span className="font-normal text-muted-foreground">v{version}</span>}</p>
          <p className="text-[12px] text-muted-foreground">Ears, eyes, and a voice for your AI.</p>
        </div>
      </div>
    </div>
  );
}
