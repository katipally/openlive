import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "./paths";

// AES-256-GCM for provider API keys at rest. Key precedence:
//   1. OPENLIVE_ENC_KEY env (64 hex chars)  2. data/.enc-key (auto-created)
// This is the trust boundary: plaintext keys never leave the server and are
// never returned to the browser (the UI only ever sees key_last4).

function loadKey(): Buffer {
  const fromEnv = process.env.OPENLIVE_ENC_KEY?.trim();
  if (fromEnv) {
    // Set-but-malformed is a MISCONFIGURATION — fail loudly. Silently falling back to
    // the auto file key encrypts data under a different key than the operator
    // configured; a later "corrected" boot then fails every decrypt while the UI still
    // reports hasKey:true. Surfacing it here makes the fix obvious.
    if (!/^[0-9a-fA-F]{64}$/.test(fromEnv)) {
      throw new Error("OPENLIVE_ENC_KEY must be exactly 64 hex characters (a 32-byte key). Fix or unset it — refusing to fall back to the auto-generated file key.");
    }
    return Buffer.from(fromEnv, "hex");
  }
  const keyFile = resolve(DATA_DIR, ".enc-key");
  if (existsSync(keyFile)) {
    return Buffer.from(readFileSync(keyFile, "utf8").trim(), "hex");
  }
  const generated = randomBytes(32);
  mkdirSync(DATA_DIR, { recursive: true }); // first write may precede any store write
  writeFileSync(keyFile, generated.toString("hex"), { mode: 0o600 });
  return generated;
}

let key: Buffer | null = null;
function getKey(): Buffer {
  if (!key) key = loadKey();
  return key;
}

/** Returns iv:tag:ciphertext, all hex. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", getKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

export function decryptSecret(stored: string): string {
  const [ivHex, tagHex, dataHex] = stored.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("malformed ciphertext");
  const decipher = createDecipheriv("aes-256-gcm", getKey(), Buffer.from(ivHex, "hex"));
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([decipher.update(Buffer.from(dataHex, "hex")), decipher.final()]).toString("utf8");
}
