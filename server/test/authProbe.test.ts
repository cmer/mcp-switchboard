import { describe, expect, it } from "vitest";
import { headerIndicatesOAuth, probeAuth, wellKnownUrls } from "../src/lib/authProbe.js";

function fakeFetch(routes: Record<string, { status: number; headers?: Record<string, string>; json?: unknown }>) {
  return (async (input: RequestInfo | URL) => {
    const url = String(input);
    const match = routes[url];
    if (!match) throw new Error(`network error: ${url}`);
    return new Response(match.json !== undefined ? JSON.stringify(match.json) : "{}", {
      status: match.status,
      headers: match.headers,
    });
  }) as typeof fetch;
}

describe("wellKnownUrls", () => {
  it("derives path-specific then root locations (RFC 9728)", () => {
    expect(wellKnownUrls("https://mcp.linear.app/mcp")).toEqual([
      "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp",
      "https://mcp.linear.app/.well-known/oauth-protected-resource",
    ]);
    expect(wellKnownUrls("https://example.com/")).toEqual(["https://example.com/.well-known/oauth-protected-resource"]);
  });
});

describe("headerIndicatesOAuth", () => {
  it("detects resource_metadata in WWW-Authenticate", () => {
    expect(
      headerIndicatesOAuth('Bearer resource_metadata="https://x.com/.well-known/oauth-protected-resource"'),
    ).toBe(true);
    expect(headerIndicatesOAuth("Basic realm=x")).toBe(false);
    expect(headerIndicatesOAuth(null)).toBe(false);
  });
});

describe("probeAuth", () => {
  const URL_ = "https://mcp.example.com/mcp";

  it("returns none when the server answers without auth", async () => {
    expect(await probeAuth(URL_, fakeFetch({ [URL_]: { status: 200 } }))).toBe("none");
  });

  it("returns oauth on 401 with resource_metadata in WWW-Authenticate", async () => {
    const fetch_ = fakeFetch({
      [URL_]: { status: 401, headers: { "WWW-Authenticate": 'Bearer resource_metadata="https://x"' } },
    });
    expect(await probeAuth(URL_, fetch_)).toBe("oauth");
  });

  it("returns oauth on 401 when a well-known metadata document exists", async () => {
    const fetch_ = fakeFetch({
      [URL_]: { status: 401 },
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": {
        status: 200,
        json: { resource: URL_ },
      },
    });
    expect(await probeAuth(URL_, fetch_)).toBe("oauth");
  });

  it("returns auth_required on bare 401 with no OAuth metadata anywhere", async () => {
    const fetch_ = fakeFetch({
      [URL_]: { status: 401 },
      "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": { status: 404 },
      "https://mcp.example.com/.well-known/oauth-protected-resource": { status: 404 },
    });
    expect(await probeAuth(URL_, fetch_)).toBe("auth_required");
  });

  it("returns unknown on network errors and odd statuses", async () => {
    expect(await probeAuth(URL_, fakeFetch({}))).toBe("unknown");
    expect(await probeAuth(URL_, fakeFetch({ [URL_]: { status: 500 } }))).toBe("unknown");
  });
});
