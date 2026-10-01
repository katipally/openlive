import { z } from "zod";

// Why a turn failed, as a closed set. The one thing about a failure that ever
// crosses a process boundary: the message text never does. It rides the wire as
// `code` on `error` events, and the agent reports it as `brain_error.class`.

export const API_ERROR_CLASSES = [
  "no_key", "no_model", "auth", "model_not_found", "quota", "rate_limited", "unreachable", "server_error", "bad_request", "stream_error", "other",
] as const;

export const AGENT_ERROR_CLASSES = [
  "agent_no_folder", "agent_start_failed", "agent_start_timeout", "agent_no_output", "agent_stalled", "agent_crashed", "agent_rejected", "agent_refused",
] as const;

export const ERROR_CLASSES = [...API_ERROR_CLASSES, ...AGENT_ERROR_CLASSES] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];
export const errorClassSchema = z.enum(ERROR_CLASSES);

/** The classes a supervised coding agent reports itself, with whether its restart worked. */
export const SUPERVISED_CLASSES: ReadonlySet<ErrorClass> = new Set(["agent_no_output", "agent_stalled", "agent_crashed"]);

const KNOWN: ReadonlySet<unknown> = new Set(ERROR_CLASSES);

/** An error whose class is known where it is thrown, so nothing has to read its words later. */
export class ClassedError extends Error {
  constructor(message: string, readonly errorClass: ErrorClass) { super(message); }
}

export type HttpClass = "4xx" | "5xx" | "none";

const messageOf = (e: unknown): string => {
  try { return typeof e === "string" ? e : e instanceof Error ? e.message : String(e ?? ""); }
  catch { return ""; }
};

/** The status an adapter's `HTTP <status>: <body>` error carries, first of any, so a caller's own words in front do not hide it. */
function httpStatus(e: unknown): number | undefined {
  const m = /\bHTTP (\d{3})\b/.exec(messageOf(e));
  return m ? Number(m[1]) : undefined;
}

const QUOTA = /quota|billing|credit|insufficient[_ ](funds|balance)/i;
const NETWORK = /could not reach|fetch failed|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH|ECONNRESET|ETIMEDOUT|socket hang up|network/i;
const AUTH = /invalid.{0,20}(api.?)?key|authenticat|unauthori[sz]ed|x-api-key|forbidden|permission_denied|rejected the api key/i;
const NO_MODEL = /model.{0,40}(not found|does not exist|not available|unsupported)|unknown model|not_found_error/i;
const RATE = /rate.?limit|too many requests|overloaded/i;
const STREAM = /\bstream\b|terminated|other side closed|UND_ERR|unexpected end|premature close/i;

function byStatus(status: number, text: string): ErrorClass {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "model_not_found";
  if (status === 402 || ((status === 400 || status === 429) && QUOTA.test(text))) return "quota";
  if (status === 400 && NO_MODEL.test(text)) return "model_not_found";
  if (status === 429 || status === 529) return "rate_limited";
  return status >= 500 ? "server_error" : "bad_request";
}

/**
 * The class of a failed turn: the status an adapter threw, a network error, or
 * the words providers use for the same few problems. A class stamped where the
 * error was thrown wins. `fallback` is the answer when nothing matches, so a
 * coding agent's own failure never lands as an API one.
 */
export function classifyError(e: unknown, fallback: ErrorClass = "other"): ErrorClass {
  const tagged = (e as { errorClass?: unknown } | null)?.errorClass;
  if (KNOWN.has(tagged)) return tagged as ErrorClass;
  const cause = (e as { cause?: { code?: unknown } } | null)?.cause?.code;
  const text = `${messageOf(e)} ${typeof cause === "string" ? cause : ""}`;
  if (/^no api key/i.test(text)) return "no_key";
  if (/^no model/i.test(text)) return "no_model";
  const status = httpStatus(e);
  if (status !== undefined) return byStatus(status, text);
  if (QUOTA.test(text)) return "quota";
  if (NETWORK.test(text)) return "unreachable";
  if (AUTH.test(text)) return "auth";
  if (NO_MODEL.test(text)) return "model_not_found";
  if (RATE.test(text)) return "rate_limited";
  if (STREAM.test(text)) return "stream_error";
  return fallback;
}

/** A supervised coding agent that timed out before or after its first output, or died. */
export const supervisorClass = (o: { timedOut: boolean; sawOutput: boolean }): ErrorClass =>
  !o.timedOut ? "agent_crashed" : o.sawOutput ? "agent_stalled" : "agent_no_output";

const CLIENT_ERRORS: ReadonlySet<ErrorClass> = new Set(["auth", "model_not_found", "bad_request", "quota", "rate_limited"]);

/** The HTTP family a class comes from. Asked of the class, since the status is gone once a message is reworded for the person. */
export const httpClassOf = (cls: ErrorClass): HttpClass => (cls === "server_error" ? "5xx" : CLIENT_ERRORS.has(cls) ? "4xx" : "none");
