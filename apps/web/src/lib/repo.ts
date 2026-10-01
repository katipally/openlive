export const REPO_URL = "https://github.com/katipally/openlive";
/** The public list of every event OpenLive can send and what each holds. */
export const EVENTS_URL = `${REPO_URL}/blob/main/docs/TELEMETRY.md`;
/** The privacy policy for the usage data, in plain English. */
export const PRIVACY_URL = `${REPO_URL}/blob/main/docs/PRIVACY.md`;
/** Where deletion and other privacy requests go. */
export const PRIVACY_EMAIL = "privacy@openlive.dev";

const ANON_NAME = /^[a-z]+-[a-z]+-[0-9a-f]{8}$/;

/** A mail draft asking for this install's usage data to be deleted. Only the anonymous name rides in it. */
export function deletionRequestUrl(username: string): string {
  const body = ANON_NAME.test(username) ? `My anonymous name: ${username}` : "";
  return `mailto:${PRIVACY_EMAIL}?subject=${encodeURIComponent("Delete my OpenLive usage data")}&body=${encodeURIComponent(body)}`;
}
