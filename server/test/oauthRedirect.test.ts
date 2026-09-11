import { describe, expect, it } from "vitest";
import { clientInfoMatchesRedirect } from "../src/oauth/dbOAuthProvider.js";

const CALLBACK = "http://localhost:8787/oauth/callback";

describe("clientInfoMatchesRedirect", () => {
  it("keeps a registration whose redirect URI is still current", () => {
    expect(clientInfoMatchesRedirect({ redirect_uris: [CALLBACK] }, CALLBACK)).toBe(true);
  });

  it("rejects a registration made under a different PUBLIC_URL", () => {
    // The case behind Linear's "redirect URI does not match any registered URI for this client".
    expect(clientInfoMatchesRedirect({ redirect_uris: [CALLBACK] }, "https://sb.example.com/oauth/callback")).toBe(
      false,
    );
  });

  it("matches exactly — a trailing-slash or scheme variant is a different URI", () => {
    expect(clientInfoMatchesRedirect({ redirect_uris: [CALLBACK] }, "http://127.0.0.1:8787/oauth/callback")).toBe(
      false,
    );
  });

  it("accepts a registration that lists several URIs, one of them current", () => {
    expect(
      clientInfoMatchesRedirect({ redirect_uris: ["https://other/oauth/callback", CALLBACK] }, CALLBACK),
    ).toBe(true);
  });

  it("takes a registration without redirect_uris at face value", () => {
    expect(clientInfoMatchesRedirect({}, CALLBACK)).toBe(true);
    expect(clientInfoMatchesRedirect({ redirect_uris: [] }, CALLBACK)).toBe(true);
  });
});

