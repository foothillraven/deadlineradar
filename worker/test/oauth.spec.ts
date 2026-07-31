import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  getConfiguredProvider,
  configuredProviderIds,
  buildRedirectUri,
  pkceChallengeS256,
  buildAuthorizeUrl,
  parseAndValidateIdToken,
  type ConfiguredProvider,
} from "../src/oauth";
import type { Env } from "../src/env";

const CLIENT_ID = "test-client-id.apps.googleusercontent.com";

const provider: ConfiguredProvider = {
  ...PROVIDERS.google!,
  clientId: CLIENT_ID,
  clientSecret: "test-client-secret",
};

/** Builds an UNSIGNED JWT with the given payload. Signature content is
 * irrelevant by design -- see oauth.ts's header for why the signature is
 * not verified for a token fetched directly from the token endpoint over
 * TLS. These tests exercise the claim validation, which is what carries
 * the authority. */
function makeIdToken(payload: Record<string, unknown>): string {
  // JSON -> UTF-8 bytes -> base64url, which is what a real provider emits.
  // Using btoa(JSON.stringify(x)) directly would encode non-ASCII as
  // latin1 (é -> 0xE9 instead of 0xC3 0xA9), producing a token no provider
  // would ever send and making the UTF-8 test below fail against
  // *correct* production code.
  const b64url = (o: unknown) => {
    const bytes = new TextEncoder().encode(JSON.stringify(o));
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  };
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.fake-signature`;
}

const NONCE = "test-nonce-value";
const futureExp = () => Math.floor(Date.now() / 1000) + 3600;

function validPayload(over: Record<string, unknown> = {}) {
  return {
    iss: "https://accounts.google.com",
    aud: CLIENT_ID,
    exp: futureExp(),
    nonce: NONCE,
    sub: "google-subject-12345",
    email: "admin@examplefirm.com",
    email_verified: true,
    ...over,
  };
}

function validate(payload: Record<string, unknown>, expectedNonce = NONCE) {
  return parseAndValidateIdToken({ idToken: makeIdToken(payload), provider, expectedNonce });
}

describe("provider configuration gating", () => {
  it("returns null when neither secret is set, so the provider stays invisible", () => {
    expect(getConfiguredProvider({} as Env, "google")).toBeNull();
  });

  it("returns null when only ONE of the two secrets is set (a half-configured provider must not go live)", () => {
    expect(getConfiguredProvider({ GOOGLE_OAUTH_CLIENT_ID: "x" } as Env, "google")).toBeNull();
    expect(getConfiguredProvider({ GOOGLE_OAUTH_CLIENT_SECRET: "y" } as Env, "google")).toBeNull();
  });

  it("returns the provider when both secrets are present", () => {
    const p = getConfiguredProvider(
      { GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y" } as Env,
      "google"
    );
    expect(p?.clientId).toBe("x");
    expect(p?.clientSecret).toBe("y");
  });

  it("returns null for an unknown provider id (no route can be conjured by URL)", () => {
    expect(getConfiguredProvider({ GOOGLE_OAUTH_CLIENT_ID: "x" } as Env, "evilprovider")).toBeNull();
    expect(getConfiguredProvider({} as Env, "microsoft")).toBeNull();
  });

  it("configuredProviderIds lists only fully-configured providers", () => {
    expect(configuredProviderIds({} as Env)).toEqual([]);
    expect(
      configuredProviderIds({ GOOGLE_OAUTH_CLIENT_ID: "x", GOOGLE_OAUTH_CLIENT_SECRET: "y" } as Env)
    ).toEqual(["google"]);
  });

  it("requests identity-only scopes (broader scopes would trigger Google's verification review)", () => {
    expect(PROVIDERS.google!.scopes).toBe("openid email profile");
  });
});

describe("redirect URI construction", () => {
  it("matches the production URI that must be registered, character for character", () => {
    expect(buildRedirectUri("https://deadline-radar.com/api", "google")).toBe(
      "https://deadline-radar.com/api/firm/auth/google/callback"
    );
  });

  it("matches the preview URI that must be registered -- note preview's ACTION_BASE_URL ends in /api", () => {
    // Preview's configured base is the workers.dev origin PLUS /api (same
    // base the emailed action links use), so the callback we actually send
    // is the /api form. Registering the bare form instead produced a real
    // redirect_uri_mismatch, caught by live verification 2026-07-30.
    expect(
      buildRedirectUri("https://deadlineradar-api-preview.foothillraven.workers.dev/api", "google")
    ).toBe("https://deadlineradar-api-preview.foothillraven.workers.dev/api/firm/auth/google/callback");
  });

  it("tolerates a trailing slash on the configured base without producing a double slash", () => {
    // A stray slash in ACTION_BASE_URL would otherwise yield '...//firm/auth/...'
    // and fail the provider's exact-match check with a confusing error.
    expect(buildRedirectUri("https://deadline-radar.com/api/", "google")).toBe(
      "https://deadline-radar.com/api/firm/auth/google/callback"
    );
    expect(buildRedirectUri("https://deadline-radar.com/api///", "google")).toBe(
      "https://deadline-radar.com/api/firm/auth/google/callback"
    );
  });
});

describe("PKCE", () => {
  it("matches the RFC 7636 Appendix B reference vector", async () => {
    // Verifies our S256 implementation against the spec's own published
    // example rather than against itself.
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
    expect(await pkceChallengeS256(verifier)).toBe(expected);
  });

  it("produces url-safe base64 with no padding", async () => {
    const challenge = await pkceChallengeS256("some-random-verifier-value-here");
    expect(challenge).toMatch(/^[A-Za-z0-9\-_]+$/);
  });
});

describe("authorize URL", () => {
  it("carries every parameter the flow depends on", async () => {
    const url = new URL(
      await buildAuthorizeUrl({
        provider,
        redirectUri: "https://deadline-radar.com/api/firm/auth/google/callback",
        state: "state-123",
        nonce: NONCE,
        codeVerifier: "verifier-abc",
      })
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("nonce")).toBe(NONCE);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBe(await pkceChallengeS256("verifier-abc"));
    expect(url.searchParams.get("scope")).toBe("openid email profile");
  });

  it("never puts the code_verifier or client_secret in the browser-visible URL", async () => {
    const url = await buildAuthorizeUrl({
      provider,
      redirectUri: "https://deadline-radar.com/api/firm/auth/google/callback",
      state: "state-123",
      nonce: NONCE,
      codeVerifier: "super-secret-verifier",
    });
    expect(url).not.toContain("super-secret-verifier");
    expect(url).not.toContain("test-client-secret");
  });

  it("forces the account chooser so a user is not silently signed in as the wrong Google account", async () => {
    const url = new URL(
      await buildAuthorizeUrl({
        provider,
        redirectUri: "https://x/cb",
        state: "s",
        nonce: NONCE,
        codeVerifier: "v",
      })
    );
    expect(url.searchParams.get("prompt")).toBe("select_account");
  });
});

describe("ID token validation -- the security boundary", () => {
  it("accepts a well-formed token and extracts the identity", () => {
    const claims = validate(validPayload());
    expect(claims).not.toBeNull();
    expect(claims!.sub).toBe("google-subject-12345");
    expect(claims!.email).toBe("admin@examplefirm.com");
    expect(claims!.emailVerified).toBe(true);
  });

  it("accepts the bare-host issuer Google also documents", () => {
    expect(validate(validPayload({ iss: "accounts.google.com" }))).not.toBeNull();
  });

  it("REJECTS a lookalike issuer -- exact match, never substring", () => {
    expect(validate(validPayload({ iss: "https://accounts.google.com.evil.com" }))).toBeNull();
    expect(validate(validPayload({ iss: "https://evil.com/accounts.google.com" }))).toBeNull();
    expect(validate(validPayload({ iss: "https://accounts.google.co" }))).toBeNull();
    expect(validate(validPayload({ iss: "" }))).toBeNull();
  });

  it("REJECTS a token minted for a different application (aud mismatch)", () => {
    // Without this check, ANY Google app's token for this user would be
    // accepted -- a full account-takeover primitive.
    expect(validate(validPayload({ aud: "some-other-app.apps.googleusercontent.com" }))).toBeNull();
  });

  it("accepts an aud ARRAY that contains our client id, and rejects one that does not", () => {
    expect(validate(validPayload({ aud: ["other-app", CLIENT_ID] }))).not.toBeNull();
    expect(validate(validPayload({ aud: ["other-app", "another-app"] }))).toBeNull();
    expect(validate(validPayload({ aud: [] }))).toBeNull();
  });

  it("REJECTS an expired token", () => {
    expect(validate(validPayload({ exp: Math.floor(Date.now() / 1000) - 3600 }))).toBeNull();
  });

  it("allows a small clock skew but not a large one", () => {
    // 30s past expiry -> inside the 60s tolerance
    expect(validate(validPayload({ exp: Math.floor(Date.now() / 1000) - 30 }))).not.toBeNull();
    // 120s past expiry -> outside it
    expect(validate(validPayload({ exp: Math.floor(Date.now() / 1000) - 120 }))).toBeNull();
  });

  it("REJECTS a missing or non-numeric exp rather than treating it as never-expiring", () => {
    expect(validate(validPayload({ exp: undefined }))).toBeNull();
    expect(validate(validPayload({ exp: "9999999999" }))).toBeNull();
  });

  it("REJECTS a nonce mismatch -- this is what blocks replay from another handshake", () => {
    expect(validate(validPayload({ nonce: "some-other-handshakes-nonce" }))).toBeNull();
    expect(validate(validPayload({ nonce: undefined }))).toBeNull();
    expect(validate(validPayload(), "a-different-expected-nonce")).toBeNull();
  });

  it("REJECTS a token with no sub -- sub is the account primary key", () => {
    expect(validate(validPayload({ sub: undefined }))).toBeNull();
    expect(validate(validPayload({ sub: "" }))).toBeNull();
    expect(validate(validPayload({ sub: 12345 }))).toBeNull();
  });

  it("reports emailVerified=false for an unverified email, so auto-linking can refuse it", () => {
    // An unverified provider email must never be able to claim an existing
    // firm account.
    expect(validate(validPayload({ email_verified: false }))!.emailVerified).toBe(false);
    expect(validate(validPayload({ email_verified: undefined }))!.emailVerified).toBe(false);
    expect(validate(validPayload({ email_verified: "yes" }))!.emailVerified).toBe(false);
    expect(validate(validPayload({ email_verified: 1 }))!.emailVerified).toBe(false);
  });

  it('accepts the string "true" some providers send instead of a boolean', () => {
    expect(validate(validPayload({ email_verified: "true" }))!.emailVerified).toBe(true);
  });

  it("tolerates a missing email (identity still valid; linking logic decides what to do)", () => {
    const claims = validate(validPayload({ email: undefined }));
    expect(claims).not.toBeNull();
    expect(claims!.email).toBeNull();
  });

  it("REJECTS structurally malformed tokens instead of throwing", () => {
    for (const bad of ["", "not-a-jwt", "only.two", "a.b.c.d", "!!!.???.***"]) {
      expect(parseAndValidateIdToken({ idToken: bad, provider, expectedNonce: NONCE })).toBeNull();
    }
  });

  it("REJECTS a token whose payload is valid base64 but not a JSON object", () => {
    const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const payload of ['"just a string"', "12345", "null", "[1,2,3]"]) {
      const token = `${b64url('{"alg":"RS256"}')}.${b64url(payload)}.sig`;
      expect(parseAndValidateIdToken({ idToken: token, provider, expectedNonce: NONCE })).toBeNull();
    }
  });

  it("decodes non-ASCII claim values correctly (UTF-8, not latin1)", () => {
    const claims = validate(validPayload({ email: "josé@examplefirm.com" }));
    expect(claims!.email).toBe("josé@examplefirm.com");
  });
});
