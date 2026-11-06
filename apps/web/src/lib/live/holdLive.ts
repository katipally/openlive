/** How long a push-to-talk hold's microphone may stay silent after it opens before it counts as dead. */
export const WIRED_WAIT_MS = 300;
export const BLUETOOTH_WAIT_MS = 2500;
export const UNKNOWN_WAIT_MS = 1000;

const BLUETOOTH = /airpods|bluetooth|hands-?free|headset|buds|beats|bose|jabra|wh-\d|wf-\d/i;
const WIRED = /built-?in|macbook|imac|mac mini|mac studio|internal|usb|line[ -]?in/i;

/** The wait for a device, by the name the browser gives it. A Bluetooth headset
 *  switches profile on open, which takes seconds; a name that says neither gets the middle. */
export function micWaitMs(label: string): number {
  if (BLUETOOTH.test(label)) return BLUETOOTH_WAIT_MS;
  return WIRED.test(label) ? WIRED_WAIT_MS : UNKNOWN_WAIT_MS;
}

/** `live`: a frame with sound has come. `silent` only once the device's wait is up with none. */
export function holdVerdict(label: string, waitedMs: number, live: boolean): "live" | "waiting" | "silent" {
  return live ? "live" : waitedMs >= micWaitMs(label) ? "silent" : "waiting";
}
