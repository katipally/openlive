// Tiny scoped logger for the web app. error/warn always log (dev console);
// debug is opt-in via localStorage["openlive-debug"] so routine diagnostics
// never spam a user's console. User-actionable failures should ALSO toast
// (lib/toast.ts) — logging alone is invisible to a voice-first user.
const debugOn = () => { try { return !!localStorage.getItem("openlive-debug"); } catch { return false; } };

export const log = {
  error: (scope: string, ...args: unknown[]) => console.error(`[${scope}]`, ...args),
  warn: (scope: string, ...args: unknown[]) => console.warn(`[${scope}]`, ...args),
  debug: (scope: string, ...args: unknown[]) => { if (debugOn()) console.warn(`[${scope}]`, ...args); },
};
