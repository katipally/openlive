// What the agent's /edits routes send: the edits OpenLive's own file tools made,
// each kept with the file as it was before, in cache/checkpoints.

export interface EditWire {
  id: string;
  /** The workspace folder the edit was made in. */
  root: string;
  /** Relative to `root`, with forward slashes. */
  path: string;
  /** UTC ISO. */
  at: string;
  tool: "write_file" | "edit_file" | "undo_edit";
  /** "+12 -3 lines", "created, +4 lines". */
  summary: string;
}

/** The newest edits first. */
export interface EditsWire {
  items: EditWire[];
}
