import { decrypt, encrypt, loadKey } from "@openlive/shared/home";
import { PATHS } from "./paths";

// AES-256-GCM for every secret at rest. Key precedence:
//   1. OPENLIVE_ENC_KEY env (64 hex chars)  2. secrets/.enc-key (auto-created)
// This is the trust boundary: plaintext keys never leave the server and are
// never returned to the browser (the UI only ever sees key_last4).

let key: Buffer | null = null;
const getKey = (): Buffer => (key ??= loadKey(PATHS.encKey));

/** Returns iv:tag:ciphertext, all hex. */
export const encryptSecret = (plaintext: string): string => encrypt(getKey(), plaintext);
export const decryptSecret = (stored: string): string => decrypt(getKey(), stored);
