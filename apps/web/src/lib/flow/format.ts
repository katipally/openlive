// Every number Flow prints. All of them are read at a glance next to each other,
// so they share one set of rules: clocks in the person's own locale, durations
// as minutes and seconds, and short latencies in the unit that keeps them to
// two significant figures.

const pad = (n: number) => String(n).padStart(2, "0");

/** "16:12", in the person's locale. */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

/** "15:48:02". The transcript needs the second; the list does not. */
export function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** "Today", "Yesterday", or the date. Groups a long history without a library. */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  const days = Math.floor((midnight.getTime() - d.getTime()) / 86_400_000);
  if (days < 0) return "Today";
  if (days === 0) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(d.getFullYear() === midnight.getFullYear() ? {} : { year: "numeric" }) });
}

/** "on 4 March 2026", for a stamp read back as part of a sentence. */
export function dateLabel(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "earlier" : `on ${d.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" })}`;
}

/** "0:09", and "1:05:03" once a session runs past the hour. */
export function duration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const s = total % 60;
  const m = Math.floor(total / 60) % 60;
  const h = Math.floor(total / 3600);
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** "340 ms" under a second, "1.4 s" over it. */
export function latency(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}
