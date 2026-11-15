import { describe, expect, it } from "vitest";
import { escapeXml, stripQuotes, xmlBlocks, xmlText } from "./xml.ts";

describe("xml reader", () => {
  const listParts = `<?xml version="1.0"?><ListPartsResult><PartNumberMarker>0</PartNumberMarker>
    <Part><PartNumber>1</PartNumber><ETag>&quot;abc&quot;</ETag><Size>5242880</Size></Part>
    <Part><PartNumber>2</PartNumber><ETag>"def"</ETag><Size>10</Size></Part></ListPartsResult>`;

  it("returns the inner XML of each Part element, not of PartNumberMarker", () => {
    expect(xmlBlocks(listParts, "Part")).toEqual([
      "<PartNumber>1</PartNumber><ETag>&quot;abc&quot;</ETag><Size>5242880</Size>",
      '<PartNumber>2</PartNumber><ETag>"def"</ETag><Size>10</Size>',
    ]);
  });

  it("reads a tag that follows longer tags with the same prefix", () => {
    const xml =
      "<NextPartNumberMarker>3</NextPartNumberMarker><PartNumberMarker>0</PartNumberMarker><PartNumber>7</PartNumber>";
    expect(xmlText(xml, "PartNumber")).toBe("7");
  });

  it("decodes entities once and strips ETag quotes", () => {
    expect(stripQuotes(xmlText(xmlBlocks(listParts, "Part")[0] ?? "", "ETag") ?? "")).toBe("abc");
    expect(xmlText("<Key>a&amp;b&#x2F;c</Key>", "Key")).toBe("a&b/c");
    expect(xmlText("<Key>a&amp;lt;b</Key>", "Key")).toBe("a&lt;b");
  });

  it("returns undefined for a tag that is absent", () => {
    expect(xmlText("<Error><Code>X</Code></Error>", "Message")).toBeUndefined();
  });

  it("escapes text for XML", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });
});
