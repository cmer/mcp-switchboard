import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

/**
 * Cloudflare Access login: verifying the application JWT Access puts on a request. Only a token
 * that passes `AccessVerifier.verify` counts as an identity; `Cf-Access-Authenticated-User-Email`
 * is unsigned (anyone on the LAN can send it) and is never read.
 */

export interface AccessConfig {
  /** `https://<team>.cloudflareaccess.com`, normalised: it is also the expected `iss`. */
  teamDomain: string;
  /** The AUD tag of every Access application that fronts this switchboard. */
  audTags: string[];
}

export const ACCESS_JWT_HEADER = "cf-access-jwt-assertion";
export const ACCESS_COOKIE = "CF_Authorization";
export const ACCESS_LOGOUT_PATH = "/cdn-cgi/access/logout";

/**
 * Accepts `<team>`, `<team>.cloudflareaccess.com` or the full URL and returns the canonical
 * `https://<team>.cloudflareaccess.com`, or null if it isn't a Cloudflare Access team domain
 * (which also keeps the JWKS fetch from being pointed at an arbitrary host).
 */
export function normalizeTeamDomain(input: string): string | null {
  let raw = input.trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(raw)) raw = `https://${raw}`;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  let host = url.hostname;
  if (!host.includes(".")) host = `${host}.cloudflareaccess.com`;
  if (!/^[a-z0-9-]+\.cloudflareaccess\.com$/.test(host)) return null;
  return `https://${host}`;
}

export function normalizeAudTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
}

export type AccessVerdict = { ok: true; email: string } | { ok: false };

export interface AccessVerifierOptions {
  /** Test seam: the signing keys to trust for a team domain instead of fetching its certs URL. */
  keysFor?: (teamDomain: string) => JWTVerifyGetKey;
}

export class AccessVerifier {
  private cached: { teamDomain: string; keys: JWTVerifyGetKey } | undefined;

  constructor(private opts: AccessVerifierOptions = {}) {}

  /** One key set per team domain, rebuilt when the Admin points the switchboard at another. */
  private keys(teamDomain: string): JWTVerifyGetKey {
    if (this.cached?.teamDomain !== teamDomain) {
      const keys =
        this.opts.keysFor?.(teamDomain) ??
        createRemoteJWKSet(new URL(`${teamDomain}/cdn-cgi/access/certs`));
      this.cached = { teamDomain, keys };
    }
    return this.cached.keys;
  }

  async verify(token: string, config: AccessConfig): Promise<AccessVerdict> {
    try {
      const { payload } = await jwtVerify(token, this.keys(config.teamDomain), {
        issuer: config.teamDomain,
        audience: config.audTags,
        algorithms: ["RS256"],
        // jose only checks `exp` when it is present; a token that never expires is not an Access token.
        requiredClaims: ["exp"],
      });
      // Service-token JWTs have no email (sub is ""): they are not household members.
      if (typeof payload.email !== "string" || payload.email.trim() === "") return { ok: false };
      return { ok: true, email: payload.email.trim() };
    } catch {
      return { ok: false };
    }
  }
}

/** The Access JWT on a request: the header Cloudflare recommends, else the cookie. */
export function accessTokenFrom(headers: { get(name: string): string | null }, cookie: string | undefined): string | undefined {
  return headers.get(ACCESS_JWT_HEADER)?.trim() || cookie?.trim() || undefined;
}

/** Shared by the instance default; tests build their own to inject keys. */
export const defaultAccessVerifier = new AccessVerifier();
