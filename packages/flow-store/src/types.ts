export const SESSION_FORMAT_VERSION = 1;

export type EntryType =
  | "message"
  | "tool_call"
  | "tool_result"
  | "session_state"
  | "context"
  | "compaction"
  | "custom";

/** Line 1 of a session file. */
export interface SessionHeader {
  v: number;
  kind: "header";
  id: string;
  createdAt: string;
  title?: string;
  [key: string]: unknown;
}

/** Every line after the header. `parentId` makes the log a tree, so a branch or a
 *  fork is just another entry pointing at an older tip. */
export interface SessionEntry {
  id: string;
  parentId: string | null;
  seq: number;
  timestamp: string;
  type: EntryType;
  [key: string]: unknown;
}

export type SessionState = "active" | "archived" | "crash";

/** Written by the owning process as a `session_state` entry. Absence of a lock
 *  file never means anything here: the log is the truth. */
export interface SessionStateEntry extends SessionEntry {
  type: "session_state";
  state: SessionState;
  pid: number;
  processStartId: string | null;
}

export interface LeaseOwner {
  version: number;
  token: string;
  pid: number;
  processStartId: string | null;
  sessionPath: string;
  createdAt: string;
}
