import type { ComponentProps } from "react";
import { cn } from "@/lib/cn";

// The app's one button. Every button is a capsule; an icon button is a circle
// the same height as its text siblings, so a row of mixed buttons lines up.
// Heights come from the spacing tokens (sm 28 / md 36 / lg 44).

export type ButtonVariant = "primary" | "secondary" | "ghost" | "accent" | "destructive";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground shadow-primary enabled:hover:brightness-110",
  secondary: "border border-border bg-secondary text-foreground shadow-rim enabled:hover:border-border-heavy",
  ghost: "text-muted-strong enabled:hover:bg-foreground/10 enabled:hover:text-foreground",
  /** A ghost that is the way out of a notice: Undo, Retry now. */
  accent: "text-link-foreground enabled:hover:bg-accent-soft",
  destructive: "bg-destructive-fill text-white enabled:hover:brightness-110",
};

const SIZE: Record<ButtonSize, { text: string; icon: string }> = {
  sm: { text: "h-control-sm gap-1.5 px-3 text-label [&_svg]:size-3.5", icon: "size-control-sm [&_svg]:size-3.5" },
  md: { text: "h-control-md gap-1.5 px-3.5 text-body [&_svg]:size-4", icon: "size-control-md [&_svg]:size-4" },
  lg: { text: "h-control-lg gap-2 px-5 text-title-sm [&_svg]:size-[1.125rem]", icon: "size-control-lg [&_svg]:size-[1.125rem]" },
};

/** The classes alone, for an element that must look like a button but is not one (a link). */
export function buttonClass({ variant = "secondary", size = "md", icon = false }: { variant?: ButtonVariant; size?: ButtonSize; icon?: boolean } = {}) {
  return cn(
    "inline-flex shrink-0 items-center justify-center whitespace-nowrap rounded-full font-medium transition disabled:cursor-not-allowed disabled:opacity-40 aria-disabled:cursor-not-allowed aria-disabled:opacity-40 [&_svg]:shrink-0",
    VARIANT[variant],
    icon ? cn(SIZE[size].icon, variant === "ghost" && "text-muted-foreground") : SIZE[size].text,
  );
}

/** A word you press inside a sentence: the one inline link look. Size comes
 *  from the sentence around it. */
export const linkClass = "font-medium text-link-foreground underline-offset-2 transition hover:underline";

export function Button({ variant, size, icon, className, type = "button", ...rest }: ComponentProps<"button"> & {
  variant?: ButtonVariant; size?: ButtonSize;
  /** A circle holding only an icon. Give it an aria-label. */
  icon?: boolean;
}) {
  return <button type={type} className={cn(buttonClass({ variant, size, icon }), className)} {...rest} />;
}
