import { AppWindow, ArrowLeftRight, Bookmark, Brain, Camera, Clipboard, ExternalLink, Eye, FileSearch, FolderInput, Globe, Hammer, Hourglass, Keyboard, ListTodo, MousePointerClick, Pencil, ScanText, Search, Terminal, TextCursorInput, Trash2, Wrench } from "lucide-react";
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
