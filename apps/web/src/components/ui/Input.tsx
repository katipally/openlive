import type { ComponentProps, ReactNode } from "react";
import { cn } from "@/lib/cn";

// The app's one text field. A field sits on the control surface behind a
// hairline; type="search" sits recessed in a track, the way the kit draws
// search. Heights match Button (sm 28, md 36, lg 44), plus field (32), which is
// Select's height and the default. `className` sizes the whole field (width,
// flex); every other prop reaches the <input>, ref included.

export type InputSize = "sm" | "field" | "md" | "lg";

const SIZE: Record<InputSize, string> = {
  sm: "h-control-sm px-2.5 text-label [&_svg]:size-3.5",
  field: "h-field px-2.5 text-body [&_svg]:size-3.5",
  md: "h-control-md px-3 text-body [&_svg]:size-4",
  lg: "h-control-lg px-3.5 text-title-sm [&_svg]:size-[1.125rem]",
};

export function Input({ size = "field", invalid, icon, trailing, className, type = "text", ...input }: Omit<ComponentProps<"input">, "size"> & {
  size?: InputSize;
  /** Draws the error state and sets aria-invalid. */
  invalid?: boolean;
  /** Leads the field, e.g. a search glass. Decorative. */
  icon?: ReactNode;
  /** Ends the field, e.g. a spinner. */
  trailing?: ReactNode;
}) {
  const search = type === "search";
  return (
    <span className={cn("flex min-w-0 cursor-text items-center gap-2 rounded-md text-foreground transition has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-50 focus-within:ring-3 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
      search ? "bg-track shadow-track" : "border border-border bg-control shadow-xs focus-within:border-accent",
      // Turning invalid shakes the field once; staying invalid does not repeat it.
      invalid ? "ol-shake border-destructive focus-within:border-destructive focus-within:ring-destructive/15" : "focus-within:ring-accent/15",
      SIZE[size], className)}>
      {icon && <span aria-hidden className="contents">{icon}</span>}
      <input type={type} aria-invalid={invalid || undefined} {...input}
        className="h-full min-w-0 flex-1 bg-transparent text-inherit outline-none placeholder:text-faint disabled:cursor-not-allowed" />
      {trailing}
    </span>
  );
}

/** Input's multi-line sibling: the same field, growing by hand (resize-y). */
export function Textarea({ invalid, className, ...rest }: ComponentProps<"textarea"> & { invalid?: boolean }) {
  return (
    <textarea aria-invalid={invalid || undefined} {...rest}
      className={cn("w-full min-w-0 resize-y rounded-md border border-border bg-control px-3 py-2 text-body leading-relaxed text-foreground shadow-xs outline-none transition placeholder:text-faint focus:border-accent focus:ring-3 focus:ring-accent/15 disabled:cursor-not-allowed disabled:opacity-50",
        invalid && "border-destructive focus:border-destructive focus:ring-destructive/15", className)} />
  );
}
