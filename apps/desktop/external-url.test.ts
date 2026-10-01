import { describe, expect, it } from "vitest";
import { createRequire } from "node:module";
import { deletionRequestUrl } from "../web/src/lib/repo";

const { isExternalUrl } = createRequire(import.meta.url)("./external-url.cjs");

describe("isExternalUrl", () => {
  it("hands web links to the system", () => {
    expect(isExternalUrl("https://github.com/katipally/openlive")).toBe(true);
    expect(isExternalUrl("http://localhost:3000/x")).toBe(true);
  });
  it("hands a draft to the privacy address and nothing else", () => {
    expect(isExternalUrl("mailto:privacy@openlive.dev")).toBe(true);
    expect(isExternalUrl("mailto:privacy@openlive.dev?subject=Delete%20my%20OpenLive%20usage%20data&body=x")).toBe(true);
    expect(isExternalUrl("mailto:someone@example.com")).toBe(false);
    expect(isExternalUrl("mailto:privacy@openlive.dev,evil@example.com")).toBe(false);
    expect(isExternalUrl("mailto:privacy@openlive.dev.evil.com")).toBe(false);
    expect(isExternalUrl("mailto:evil@example.com?to=privacy@openlive.dev")).toBe(false);
    expect(isExternalUrl("mailto:privacy@openlive.dev\nBcc: x")).toBe(false);
    for (const q of ["?cc=evil@example.com", "?subject=x&bcc=evil@example.com", "?TO=evil@example.com"]) expect(isExternalUrl(`mailto:privacy@openlive.dev${q}`)).toBe(false);
  });
  it("judges header names after decoding them, and lets only subject and body through", () => {
    for (const q of ["?%63c=evil@example.com", "?subject=a&%62cc=evil@example.com", "?%74o=evil@example.com", "?%54O=evil@example.com", "?%2563c=evil@example.com", "?su%62ject=x&%43c=e@x.com", "?subject=x&%ZZ=1", "?subject=a%0ABcc:evil@example.com", "?subject=x#&cc=evil@example.com", "?x=1", "?&", "?cc", "?subject=x&&cc=e@x.com"]) {
      expect(isExternalUrl(`mailto:privacy@openlive.dev${q}`), q).toBe(false);
    }
    for (const q of ["?SUBJECT=x", "?su%62ject=x", "?Body=line%0Aline%0D%0Aline", "?subject=x&body=a%3Dcc%3Dy", "?body"]) {
      expect(isExternalUrl(`mailto:privacy@openlive.dev${q}`), q).toBe(true);
    }
  });
  it("hands over exactly what Request deletion builds, with or without a name", () => {
    for (const name of ["swift-otter-1a2b3c4d", "not a name"]) expect(isExternalUrl(deletionRequestUrl(name)), name).toBe(true);
  });
  it("refuses every other scheme", () => {
    for (const u of ["file:///etc/passwd", "data:text/html,x", "javascript:alert(1)", "tel:123", "smb://host/share", ""]) expect(isExternalUrl(u)).toBe(false);
  });
});
