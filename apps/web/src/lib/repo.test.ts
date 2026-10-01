import { describe, expect, it } from "vitest";
import { deletionRequestUrl, PRIVACY_EMAIL } from "./repo";

describe("deletionRequestUrl", () => {
  it("drafts a mail to the privacy address carrying only the anonymous name", () => {
    const url = deletionRequestUrl("swift-otter-1a2b3c4d");
    expect(url.startsWith(`mailto:${PRIVACY_EMAIL}?`)).toBe(true);
    const q = new URLSearchParams(url.slice(url.indexOf("?") + 1));
    expect(q.get("subject")).toBe("Delete my OpenLive usage data");
    expect(q.get("body")).toBe("My anonymous name: swift-otter-1a2b3c4d");
  });
  it("leaves the body empty for anything that is not an anonymous name", () => {
    for (const bad of ["", "None", "a b&cc=dd", "swift-otter-1A2B3C4D", "swift-otter-1a2b3c4d\nBcc: x@y.z"]) {
      expect(new URLSearchParams(deletionRequestUrl(bad).split("?")[1]).get("body")).toBe("");
    }
  });
});
