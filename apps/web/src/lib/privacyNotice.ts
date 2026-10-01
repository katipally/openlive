import { telemetry } from "./telemetry";

/** Whether the first-run notice is still owed: a build that reports at all, to a person who has not seen it and has not turned sharing off. */
export async function noticeOwed(): Promise<boolean> {
  const s = await telemetry.get();
  return !!s?.active && s.enabled && !s.noticeSeen;
}
