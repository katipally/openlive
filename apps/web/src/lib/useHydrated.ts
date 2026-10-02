import { useSyncExternalStore } from "react";

const noSubscribe = () => () => {};

/** False on the server and during hydration, true from then on. A view the
 *  server seeds from ui.json but that reads this machine (the desktop shell, its
 *  platform) mounts behind it, so its first client render matches the HTML. */
export const useHydrated = () => useSyncExternalStore(noSubscribe, () => true, () => false);
