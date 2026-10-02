import { AlarmClock, AppWindow, ArrowLeftRight, BookOpen, Bookmark, BookPlus, Brain, Camera, Clipboard, ExternalLink, Eye, FilePen, FileSearch, FileText, FolderInput, FolderOpen, Globe, Hammer, Hourglass, Keyboard, LayoutGrid, ListTodo, LogIn, MousePointerClick, PackageSearch, Pencil, Plug, RefreshCw, ScanText, Search, Sparkles, Terminal, TextCursorInput, Trash2, Undo2, Users, Wrench } from "lucide-react";
import type { ToolKind } from "@openlive/shared";

// Human labels + icon per tool, shared by the transcript (chips), the in-call
// status line and Flow, so "Searching the web" reads the same everywhere.
// `label` is said once it is done, `active` while it runs.
export interface ToolMeta { label: string; active: string; icon: typeof Wrench; connector?: string }
export const TOOL_META: Record<string, ToolMeta> = {
  web_search: { label: "Searched the web", active: "Searching the web", icon: Search },
  fetch_url: { label: "Read a page", active: "Reading a page", icon: Globe },
  remember: { label: "Saved a note", active: "Saving a note", icon: Bookmark },
  update_todos: { label: "Updated the plan", active: "Planning", icon: ListTodo },
  clipboard_read: { label: "Read the clipboard", active: "Reading the clipboard", icon: Clipboard },
  clipboard_write: { label: "Copied to clipboard", active: "Copying", icon: Clipboard },
  open_url: { label: "Opened a link", active: "Opening a link", icon: ExternalLink },
  look: { label: "Took a look", active: "Looking", icon: Eye },

  // Flow's own tools. Without these the orb says "Using read screen text" while
  // it drives someone's machine, which is the moment the words matter most.
  insert_text: { label: "Typed for you", active: "Typing", icon: TextCursorInput },
  read_selection: { label: "Read your selection", active: "Reading your selection", icon: TextCursorInput },
  get_context: { label: "Checked what you are in", active: "Checking what you are in", icon: AppWindow },
  screenshot: { label: "Looked at the screen", active: "Looking at the screen", icon: Eye },
  read_screen_text: { label: "Read the screen", active: "Reading the screen", icon: ScanText },
  list_windows: { label: "Listed your windows", active: "Looking at your windows", icon: AppWindow },
  get_window: { label: "Checked a window", active: "Checking a window", icon: AppWindow },
  camera_frame: { label: "Took a camera frame", active: "Looking through the camera", icon: Camera },
  click: { label: "Clicked", active: "Clicking", icon: MousePointerClick },
  double_click: { label: "Double clicked", active: "Clicking", icon: MousePointerClick },
  right_click: { label: "Right clicked", active: "Opening a menu", icon: MousePointerClick },
  move: { label: "Moved the pointer", active: "Moving the pointer", icon: MousePointerClick },
  drag: { label: "Dragged", active: "Dragging", icon: MousePointerClick },
  scroll: { label: "Scrolled", active: "Scrolling", icon: MousePointerClick },
  type: { label: "Typed", active: "Typing", icon: Keyboard },
  keypress: { label: "Pressed keys", active: "Pressing keys", icon: Keyboard },
  mouse_down: { label: "Held the button", active: "Holding the button", icon: MousePointerClick },
  mouse_up: { label: "Let go", active: "Letting go", icon: MousePointerClick },
  window_activate: { label: "Brought a window forward", active: "Switching windows", icon: AppWindow },
  window_move: { label: "Moved a window", active: "Moving a window", icon: AppWindow },
  window_resize: { label: "Resized a window", active: "Resizing a window", icon: AppWindow },
  window_close: { label: "Closed a window", active: "Closing a window", icon: AppWindow },
  window_minimize: { label: "Minimised a window", active: "Minimising a window", icon: AppWindow },
  open_app: { label: "Opened an app", active: "Opening an app", icon: ExternalLink },
  wait: { label: "Waited for the screen", active: "Waiting for the screen", icon: Hourglass },
  shell: { label: "Ran a command", active: "Running a command", icon: Terminal },

  set_timer: { label: "Set a timer", active: "Setting a timer", icon: AlarmClock },
  remind: { label: "Set a reminder", active: "Setting a reminder", icon: AlarmClock },
  list_reminders: { label: "Checked your reminders", active: "Checking your reminders", icon: AlarmClock },
  cancel_reminder: { label: "Cancelled a reminder", active: "Cancelling a reminder", icon: AlarmClock },

  find_files: { label: "Searched your files", active: "Searching your files", icon: FileSearch },
  list_edits: { label: "Checked recent edits", active: "Checking recent edits", icon: Undo2 },
  undo_edit: { label: "Undid an edit", active: "Undoing an edit", icon: Undo2 },

  list_dir: { label: "Listed a folder", active: "Listing a folder", icon: FolderOpen },
  read_file: { label: "Read a file", active: "Reading a file", icon: FileText },
  write_file: { label: "Wrote a file", active: "Writing a file", icon: FilePen },
  edit_file: { label: "Edited a file", active: "Editing a file", icon: Pencil },

  list_apps: { label: "Listed your apps", active: "Checking your apps", icon: LayoutGrid },
  get_app_state: { label: "Looked at an app", active: "Looking at an app", icon: AppWindow },
  perform_action: { label: "Acted in an app", active: "Acting in an app", icon: MousePointerClick },
  set_value: { label: "Filled in a field", active: "Filling in a field", icon: TextCursorInput },

  activate_skill: { label: "Loaded a skill", active: "Loading a skill", icon: Sparkles },
  read_skill_file: { label: "Read a skill file", active: "Reading a skill file", icon: BookOpen },
  save_skill: { label: "Saved a skill", active: "Saving a skill", icon: BookPlus },

  find_tools: { label: "Looked for a tool", active: "Looking for a tool", icon: PackageSearch },
  // Shown as the connector tool they run; these only show when that is unknown.
  read_tool: { label: "Used a connector", active: "Using a connector", icon: Plug },
  use_tool: { label: "Used a connector", active: "Using a connector", icon: Plug },
  list_connectors: { label: "Checked your connectors", active: "Checking your connectors", icon: Plug },
  add_connector: { label: "Added a connector", active: "Adding a connector", icon: Plug },
  connector_sign_in: { label: "Opened a sign-in", active: "Signing in", icon: LogIn },
  reconnect_connector: { label: "Reconnected a connector", active: "Reconnecting", icon: RefreshCw },

  delegate: { label: "Asked the assistant", active: "Asking the assistant", icon: Users },
};

/** "many_tools-server" as "Many tools server". */
const words = (s: string) => { const w = s.replace(/[_-]+/g, " ").trim(); return w.charAt(0).toUpperCase() + w.slice(1); };

/** A connector tool is named `<connector>__<tool>`: it shows as both, in words. */
export function toolMeta(tool: string): ToolMeta {
  const known = TOOL_META[tool];
  if (known) return known;
  const cut = tool.indexOf("__");
  if (cut > 0) {
    const connector = words(tool.slice(0, cut)), label = `${connector} · ${words(tool.slice(cut + 2))}`;
    return { label, active: label, icon: Plug, connector };
  }
  return { label: words(tool), active: `Using ${words(tool).toLowerCase()}`, icon: Wrench };
}

/** The tool at work, with its gist when it has one: "Setting a timer · 10 min". */
export const toolActive = (tool: string, summary?: string) => (summary ? `${toolMeta(tool).active} · ${summary}` : toolMeta(tool).active);

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

/** A coding agent's own tool in Flow, which reports what it does and the file it touches. */
export const agentToolLabel = (kind: string, target?: string) => {
  const verb = kindMeta(kind as ToolKind).active;
  return target ? `${verb} ${target}` : verb;
};
