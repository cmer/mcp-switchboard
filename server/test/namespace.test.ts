import { describe, expect, it } from "vitest";
import { nsName, nsResourceUri, parseNsName, parseNsResourceUri } from "../src/core/namespace.js";
import { isReservedSlug, isValidSlug, slugify } from "../src/lib/slug.js";

describe("namespace", () => {
  it("round-trips tool names", () => {
    expect(nsName("github", "create_issue")).toBe("github__create_issue");
    expect(parseNsName("github__create_issue")).toEqual({ slug: "github", name: "create_issue" });
  });

  it("splits on the FIRST __ so tool names may contain __ themselves", () => {
    expect(parseNsName("gh__weird__tool")).toEqual({ slug: "gh", name: "weird__tool" });
  });

  it("rejects malformed names", () => {
    expect(parseNsName("no-separator")).toBeNull();
    expect(parseNsName("__leading")).toBeNull();
    expect(parseNsName("trailing__")).toBeNull();
  });

  it("round-trips resource URIs", () => {
    const uri = "file:///home/carl/notes.md?x=1&y=2";
    const ns = nsResourceUri("files", uri);
    expect(ns).toBe(`sb://files/${encodeURIComponent(uri)}`);
    expect(parseNsResourceUri(ns)).toEqual({ slug: "files", uri });
  });

  it("rejects malformed resource URIs", () => {
    expect(parseNsResourceUri("http://example.com/x")).toBeNull();
    expect(parseNsResourceUri("sb://UPPER/abc")).toBeNull();
  });
});

describe("slug", () => {
  it("forbids underscores so __ splitting stays unambiguous", () => {
    expect(isValidSlug("google-work")).toBe(true);
    expect(isValidSlug("google_work")).toBe(false);
    expect(isValidSlug("")).toBe(false);
    expect(isValidSlug("Has-Caps")).toBe(false);
  });

  it("slugify converts underscores and spaces to dashes", () => {
    expect(slugify("My Google_Work Account")).toBe("my-google-work-account");
    expect(slugify("  GitHub!!  ")).toBe("github");
  });

  it("reserves the switchboard meta-tool prefix", () => {
    expect(isReservedSlug("switchboard")).toBe(true);
    expect(isReservedSlug("switchboard-2")).toBe(false);
  });
});
