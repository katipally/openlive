// The command palette's pure half: what a command is and how a query narrows
// the list. No React, no DOM, so it tests on its own.

export interface Command {
  id: string;
  label: string;
  group: string;
  /** Extra words a person might type for this command ("dark", "appearance"). */
  keywords?: string;
  /** Quiet text on the right of the row. */
  hint?: string;
  /** Keycaps on the right of the row, one per key. */
  keys?: string[];
  run: () => void;
}

export interface CommandGroup {
  group: string;
  items: Command[];
}

/** Case-insensitive substring match over label, group and keywords, grouped in
 *  the order groups first appear. Commands whose label matches come first, so
 *  "voice" picks Voice over a row that only mentions voice in its keywords.
 *  O(n) commands per call, each scanned once. */
export function filterCommands(commands: Command[], query: string): CommandGroup[] {
  const q = query.trim().toLowerCase();
  const byLabel: Command[] = [];
  const byOther: Command[] = [];
  for (const c of commands) {
    if (!q || c.label.toLowerCase().includes(q)) byLabel.push(c);
    else if (`${c.group} ${c.keywords ?? ""}`.toLowerCase().includes(q)) byOther.push(c);
  }
  const groups = new Map<string, Command[]>();
  for (const c of [...byLabel, ...byOther]) {
    const items = groups.get(c.group);
    if (items) items.push(c);
    else groups.set(c.group, [c]);
  }
  return Array.from(groups, ([group, items]) => ({ group, items }));
}
