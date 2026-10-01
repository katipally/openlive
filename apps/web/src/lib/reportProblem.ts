import { REPO_URL } from "./repo";
import { telemetry } from "./telemetry";
import { brainIdOf, failureCodeOf } from "./telemetryIds";

// A prefilled GitHub bug report. Only closed values ride in it (the version
// number, an OS name and major, a brain id, a failure code), each checked here
// against its own shape, so nothing the person said, typed or had on screen can
// end up in the address. The headings are .github/ISSUE_TEMPLATE/bug_report.md's.

const VERSION = /^\d+\.\d+\.\d+(-[A-Za-z0-9.]+)?$/;
const OS_NAMES = ["macOS", "Windows", "Linux"];
const OS_MAJOR = /^\d{1,2}$/;

let lastFailure: ReturnType<typeof failureCodeOf>;
/** The code of the newest Flow failure card, for the report. Anything outside the closed set clears it. */
export const noteLastFailure = (code: string): void => { lastFailure = failureCodeOf(code); };

export interface ProblemFacts { appVersion?: string; osName?: string; osMajor?: string; brainId?: string }

export function reportProblemUrl(f: ProblemFacts = {}): string {
  const os = OS_NAMES.find((n) => n === f.osName);
  const major = f.osMajor && OS_MAJOR.test(f.osMajor) ? f.osMajor : undefined;
  const body = [
    "**What happened**",
    "A clear description of the bug.",
    "",
    "**Steps to reproduce**",
    "1.",
    "2.",
    "3.",
    "",
    "**Expected**",
    "What you thought would happen.",
    "",
    "**Environment**",
    `- OS and version: ${[os, os && major].filter(Boolean).join(" ")}`,
    `- OpenLive version: ${f.appVersion && VERSION.test(f.appVersion) ? f.appVersion : ""}`,
    `- Model provider: ${brainIdOf(f.brainId) ?? ""}`,
    ...(lastFailure ? [`- Last failure: ${lastFailure}`] : []),
    "",
    "**Logs**",
    "Any console output from the app.",
  ].join("\n");
  return `${REPO_URL}/issues/new?labels=bug&body=${encodeURIComponent(body)}`;
}

/** Opens the report in the browser. The desktop shell hands an https window to the real browser. */
export async function reportProblem(brainId?: string): Promise<void> {
  const s = await telemetry.get();
  window.open(reportProblemUrl({ appVersion: s?.appVersion, osName: s?.osName, osMajor: s?.osMajor, brainId }), "_blank", "noopener");
}
