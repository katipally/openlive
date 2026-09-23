// Where a key press already belongs to the focused element, so app-level
// shortcuts must stay out of the way. Duck-typed so it tests without a DOM.
type KeyTarget = { tagName: string; isContentEditable?: boolean; getAttribute?: (name: string) => string | null } | null | undefined;

const TEXT_TAGS = new Set(["INPUT", "TEXTAREA", "SELECT"]);
const CONTROL_TAGS = new Set(["BUTTON", "A", "SUMMARY"]);
const CONTROL_ROLES = new Set(["button", "switch", "checkbox", "radio", "menuitem", "menuitemradio", "menuitemcheckbox", "tab", "option", "slider", "link", "combobox"]);

/** Typing goes here: letters are text, not shortcuts. */
export const isTextTarget = (el: KeyTarget): boolean =>
  !!el && (TEXT_TAGS.has(el.tagName) || !!el.isContentEditable);

/** Space and Enter activate this element natively. */
export const isControlTarget = (el: KeyTarget): boolean =>
  !!el && (isTextTarget(el) || CONTROL_TAGS.has(el.tagName) || CONTROL_ROLES.has(el.getAttribute?.("role") ?? ""));
