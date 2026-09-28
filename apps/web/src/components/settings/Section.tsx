// One settings section: title, description, content, and optionally the one
// action that belongs beside the title (Add a word).
export function Section({ id, title, desc, action, children }: {
  id?: string; title: React.ReactNode; desc: React.ReactNode; action?: React.ReactNode; children: React.ReactNode;
}) {
  return (
    <section id={id} className="pb-8 last:pb-0">
      <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
        <div className="min-w-[12rem] flex-1">
          <h2 className="flex flex-wrap items-center gap-2 text-callout font-semibold text-foreground">{title}</h2>
          <p className="mt-1 text-label leading-relaxed text-muted-foreground">{desc}</p>
        </div>
        {action}
      </div>
      <div className="mt-3.5">{children}</div>
    </section>
  );
}
