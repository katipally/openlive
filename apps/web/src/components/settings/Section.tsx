// One settings section: title, description, content. Was re-defined in three
// settings tabs; single copy so the P4 de-boxing pass touches one file.
export function Section({ title, desc, children }: { title: string; desc: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-border pb-7 last:border-0 last:pb-0">
      <h2 className="text-[14px] font-semibold text-foreground">{title}</h2>
      <p className="mt-1 max-w-xl text-[12.5px] leading-relaxed text-muted-foreground">{desc}</p>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}
