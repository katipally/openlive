import { ArrowLeftRight, Bookmark, Brain, Clipboard, ExternalLink, Eye, FileSearch, FolderInput, Globe, Hammer, ListTodo, Pencil, Search, Terminal, Trash2, Wrench } from "lucide-react";
import type { ToolKind } from "@openlive/shared";

// Human labels + icon per tool — shared by the transcript (chips) and the in-call
// status line, so "Searching the web" reads the same everywhere.
export const TOOL_META: Record<string, { label: string; active: string; icon: typeof Wrench }> = {
  web_search: { label: "Searched the web", active: "Searching the web", icon: Search },
  fetch_url: { label: "Read a page", active: "Reading a page", icon: Globe },
  remember: { label: "Saved a note", active: "Saving a note", icon: Bookmark },
  update_todos: { label: "Updated the plan", active: "Planning", icon: ListTodo },
  clipboard_read: { label: "Read the clipboard", active: "Reading the clipboard", icon: Clipboard },
  clipboard_write: { label: "Copied to clipboard", active: "Copying", icon: Clipboard },
  open_url: { label: "Opened a link", active: "Opening a link", icon: ExternalLink },
  look: { label: "Took a look", active: "Looking", icon: Eye },
};

export const toolMeta = (tool: string) =>
  TOOL_META[tool] ?? { label: tool.replace(/_/g, " "), active: `Using ${tool.replace(/_/g, " ")}`, icon: Wrench };

// ACP tool-call kinds (coding agents) → icon + spoken-status verb. Zed's
// kind→icon mapping, translated to lucide.
export const KIND_META: Record<ToolKind, { icon: typeof Wrench; active: string }> = {
  read: { icon: FileSearch, active: "Reading" },
  edit: { icon: Pencil, active: "Editing" },
  delete: { icon: Trash2, active: "Deleting" },
  move: { icon: FolderInput, active: "Moving" },
  search: { icon: Search, active: "Searching" },
  execute: { icon: Terminal, active: "Running" },
  think: { icon: Brain, active: "Thinking" },
  fetch: { icon: Globe, active: "Fetching" },
  switch_mode: { icon: ArrowLeftRight, active: "Switching mode" },
  other: { icon: Hammer, active: "Working" },
};
export const kindMeta = (kind: ToolKind) => KIND_META[kind] ?? KIND_META.other;
