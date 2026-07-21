/**
 * Probe a remote MCP server URL to discover its auth requirement before saving it.
 * Mirrors what a client discovers at connect time: an unauthenticated `initialize`
 * POST, then — on 401/403 — RFC 9728 protected-resource-metadata discovery.
 */

export type ProbeResult =
  | "none" // answered without auth
  | "oauth" // 401 + OAuth discovery metadata present → speaks the MCP OAuth flow
  | "auth_required" // 401 but no OAuth metadata → likely wants a static token/header
  | "unknown"; // unreachable, timed out, or ambiguous

const PROBE_TIMEOUT_MS = 2_500;

/** RFC 9728 well-known locations for a resource URL, most specific first. */
export function wellKnownUrls(serverUrl: string): string[] {
  const u = new URL(serverUrl);
  const path = u.pathname.replace(/\/+$/, "");
  const urls: string[] = [];
  if (path && path !== "/") urls.push(`${u.origin}/.well-known/oauth-protected-resource${path}`);
  urls.push(`${u.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/** A WWW-Authenticate header advertising resource metadata implies the OAuth flow. */
export function headerIndicatesOAuth(wwwAuthenticate: string | null): boolean {
  return wwwAuthenticate !== null && /resource_metadata/i.test(wwwAuthenticate);
}

export async function probeAuth(serverUrl: string, fetchFn: typeof fetch = fetch): Promise<ProbeResult> {
  try {
    const res = await fetchFn(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "mcp-switchboard-probe", version: "1.0.0" },
        },
      }),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });

    if (res.status === 401 || res.status === 403) {
      if (headerIndicatesOAuth(res.headers.get("www-authenticate"))) return "oauth";
      for (const wk of wellKnownUrls(serverUrl)) {
        try {
          const meta = await fetchFn(wk, {
            headers: { Accept: "application/json" },
            signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
          });
          if (meta.ok) {
            const body: unknown = await meta.json().catch(() => null);
            if (body && typeof body === "object") return "oauth";
          }
        } catch {
          // try the next well-known location
        }
      }
      return "auth_required";
    }

    if (res.ok) return "none";
    return "unknown";
  } catch {
    return "unknown";
  }
}
