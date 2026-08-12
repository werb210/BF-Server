// BF_SERVER_INBOX_CID_REGEX_v43
import { describe, it, expect } from "vitest";
import {
  extractCidRefs,
  matchCidAttachment,
  soleUnusedInlineImage,
  type CidAttachment,
} from "../inlineCid.js";

describe("extractCidRefs", () => {
  it("keeps a Gmail content-id whole instead of cutting it at the letter s", () => {
    const html = '<img src="cid:ii_ms8k2p9v0" alt="Nith Nadarajah License.jpg">';
    expect(extractCidRefs(html)).toEqual(["ii_ms8k2p9v0"]);
  });
  it("stops at whitespace rather than swallowing the rest of the tag", () => {
    expect(extractCidRefs("<img src=cid:logo001 width=10>")).toEqual(["logo001"]);
  });
  it("handles a domain-qualified content-id", () => {
    expect(extractCidRefs('<img src="cid:image001.png@01DA5C7E.9F2A1B40">')).toEqual(["image001.png@01DA5C7E.9F2A1B40"]);
  });
  it("returns each reference once, in document order", () => {
    expect(extractCidRefs('<img src="cid:aaa"><img src="cid:bbb"><img src="cid:aaa">')).toEqual(["aaa", "bbb"]);
  });
  it("finds references inside a css url()", () => {
    expect(extractCidRefs('<div style="background:url(cid:sig_msabc123)"></div>')).toEqual(["sig_msabc123"]);
  });
  it("returns nothing for a body with no cid references", () => {
    expect(extractCidRefs("<p>plain text</p>")).toEqual([]);
  });
});

describe("matchCidAttachment", () => {
  const atts: CidAttachment[] = [
    { id: "A1", name: "Nith Nadarajah License.jpg", contentId: "<ii_ms8k2p9v0>", contentType: "image/jpeg", isInline: true },
    { id: "A2", name: "statements.pdf", contentId: null, contentType: "application/pdf", isInline: false },
  ];
  it("matches a content-id wrapped in angle brackets", () => expect(matchCidAttachment("ii_ms8k2p9v0", atts)?.id).toBe("A1"));
  it("matches on the attachment name when the content-id does not agree", () => expect(matchCidAttachment("Nith Nadarajah License.jpg", atts)?.id).toBe("A1"));
  it("matches the name with its extension dropped", () => expect(matchCidAttachment("Nith Nadarajah License", atts)?.id).toBe("A1"));
  it("still resolves a reference truncated by the old regex", () => expect(matchCidAttachment("ii_ms8k", atts)?.id).toBe("A1"));
  it("refuses a prefix match too short to be meaningful", () => expect(matchCidAttachment("ii_m", atts)).toBeNull());
  it("returns null when nothing matches", () => expect(matchCidAttachment("unrelated_cid_value", atts)).toBeNull());
});

describe("soleUnusedInlineImage", () => {
  it("binds the one image nobody claimed", () => {
    const atts: CidAttachment[] = [{ id: "A1", contentType: "image/jpeg", isInline: true }, { id: "A2", contentType: "application/pdf", isInline: false }];
    expect(soleUnusedInlineImage(atts, new Set())?.id).toBe("A1");
  });
  it("declines when more than one image is spare", () => {
    const atts: CidAttachment[] = [{ id: "A1", contentType: "image/png", isInline: true }, { id: "A2", contentType: "image/png", isInline: true }];
    expect(soleUnusedInlineImage(atts, new Set())).toBeNull();
  });
  it("declines when the only image is already used", () => {
    expect(soleUnusedInlineImage([{ id: "A1", contentType: "image/png", isInline: true }], new Set(["A1"]))).toBeNull();
  });
});
