import { clsx, type ClassValue } from "clsx";
import { extendTailwindMerge } from "tailwind-merge";

// tailwind-merge must be taught the custom type-scale utilities (globals.css
// @theme --text-*). Unknown `text-*` classes are otherwise classified as text
// COLOR, so a later `text-muted-foreground` would silently delete `text-label`
// from the class list.
const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [
        "text-micro", "text-caption", "text-label", "text-body", "text-callout",
        "text-title-sm", "text-title", "text-title-lg", "text-display", "text-chat",
      ],
    },
  },
});

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
