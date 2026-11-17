import { describe, expect, it } from "vitest";
import { escapeXml, stripQuotes, xmlBlocks, xmlText, xmlValue, xmlValues } from "./xml.ts";

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

  it("leaves out-of-range numeric entities unchanged instead of throwing", () => {
    expect(xmlText("<Code>&#x110000;</Code>", "Code")).toBe("&#x110000;");
    expect(xmlText("<Code>&#99999999999;</Code>", "Code")).toBe("&#99999999999;");
  });

  it("decodes decimal entities and does not decode upper-case named entities", () => {
    expect(xmlText("<Key>a&#47;b</Key>", "Key")).toBe("a/b");
    expect(xmlText("<Key>a&AMP;b</Key>", "Key")).toBe("a&AMP;b");
  });

  it("reads elements that carry attributes", () => {
    expect(xmlBlocks('<Foo xmlns="http://s3.amazonaws.com/doc/2006-03-01/">x</Foo>', "Foo")).toEqual(["x"]);
  });

  it("does not let a self-closing element swallow the next block", () => {
    expect(xmlBlocks("<Part /><Part>2</Part>", "Part")).toEqual(["2"]);
    expect(xmlBlocks("<Part/><Part>2</Part>", "Part")).toEqual(["2"]);
  });

  it("returns undefined for a tag that is absent", () => {
    expect(xmlText("<Error><Code>X</Code></Error>", "Message")).toBeUndefined();
  });

  it("escapes text for XML", () => {
    expect(escapeXml(`a<b>&"c'`)).toBe("a&lt;b&gt;&amp;&quot;c&apos;");
  });

  it("keeps edge whitespace in text and trims it from values", () => {
    expect(xmlText("<Key> a\u00a0</Key>", "Key")).toBe(" a\u00a0");
    expect(xmlText("<Key>a&#32;</Key>", "Key")).toBe("a ");
    expect(xmlValue("<IsTruncated>\n  true\n</IsTruncated>", "IsTruncated")).toBe("true");
  });

  it("decodes and trims the value of every element with the tag, in document order", () => {
    expect(xmlValues("<Rule><Header> a&amp;b </Header><Other>x</Other><Header>c</Header></Rule>", "Header")).toEqual([
      "a&b",
      "c",
    ]);
  });
});
