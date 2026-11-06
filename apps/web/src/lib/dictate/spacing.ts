/** How much of the text before the caret is read, and kept, as context. */
export const BEFORE_MAX = 320;

const NO_SPACE_AFTER = /[\s(\[{<"'`“‘«‹¿¡]$/u;

/** Whether dictated words need a space of their own after `before`, the text
 *  before the caret: not at the start of a field or line, after a space, or
 *  after an opening bracket or quote. */
export const needsSpace = (before: string) => before !== "" && !NO_SPACE_AFTER.test(before);
