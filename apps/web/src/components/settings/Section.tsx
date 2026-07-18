// One settings section: title, description, content. Was re-defined in three
// settings tabs; single copy so the P4 de-boxing pass touches one file.
export function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="pb-8 last:pb-0">
      <h2 className="text-callout font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-label leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}
