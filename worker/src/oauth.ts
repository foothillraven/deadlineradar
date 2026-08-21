/**
 * OAuth 2.0 / OpenID Connect sign-in for firm admins (2026-07-30, auth suite).
 *
 * Authorization Code flow with PKCE. Google is the only provider configured
 * today -- Microsoft was deliberately deferred (Devin's call 2026-07-30:
 * Microsoft deprecated directory-less app registration, so it now requires
 * either an expiring M365 dev-sandbox tenant or a card-on-file Azure
 * signup, neither justified before revenue). NOTHING here is
 * Google-specific by structure: adding a provider is one entry in
 * PROVIDERS plus its two secrets. See worker/AUTH_SSO_SETUP.md.
 *
 * ## Why the ID token's signature is not verified here
 *
 * We never accept an ID token from the browser. It is fetched by THIS
 * worker, over TLS, directly from the provider's token endpoint, in
 * exchange for a single-use code bound to our client secret and PKCE
 * verifier. OpenID Connect Core 1.0 section 3.1.3.7 item 6 addresses this
 * case explicitly: when the ID token is received via direct communication
 * between the client and the token endpoint, TLS server validation MAY be
 * used in place of checking the token signature.
 *
 * That is a deliberate choice, not a shortcut: hand-rolling JWKS fetching,
 * key-ID selection, caching, rotation and RSA verification is a large
 * amount of security-critical code whose failure modes (accepting `alg:
 * none`, trusting an attacker-supplied `jku`, verifying against a stale or
 * attacker-chosen key) are far more dangerous than the risk it removes
 * here. The claims that actually carry authority -- iss, aud, exp, nonce
 * -- ARE all validated below.
 *
 * If an ID token ever arrives by any other route (an implicit flow, a
 * client-side hand-off, a token posted to us), this reasoning collapses
 * and full signature verification becomes mandatory. Do not reuse
 * parseAndValidateIdToken() for that case.
 */

import type { Env } from "./env";

export interface OauthProvider {
  id: string;
  displayName: string;
  authorizeUrl: string;
  tokenUrl: string;
  /** Accepted `iss` values. Google documents BOTH the bare host and the
   * https form, and has issued each historically, so both are allowed --
   * an exact-match list, never a suffix/substring test (which
   * "accounts.google.com.evil.com" would pass). */
  issuers: string[];
  scopes: string;
  clientIdVar: keyof Env;
  clientSecretVar: keyof Env;
}

export const PROVIDERS: Record<string, OauthProvider> = {
  google: {
    id: "google",
    displayName: "Google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    issuers: ["https://accounts.google.com", "accounts.google.com"],
    // Identity only. Anything broader drags the app into Google's
    // verification review and annual security assessment for no benefit --
    // we only need to know who signed in.
    //
    // AuditLab OAUTH-1 (LOW, 2026-08-05): `profile` was requested but never
    // used -- the claims type this file actually reads is {sub, email,
    // emailVerified}, and linkOauthIdentity() stores only providerSubject +
    // providerEmail. Worse than unused: it made the Google consent screen
    // list more than the privacy policy claims we receive ("basic sign-in
    // identity", not name/picture/locale), a real discrepancy for a
    // skeptical evaluator comparing the two. Dropped -- costs nothing since
    // the code never touched it.
    scopes: "openid email",
    clientIdVar: "GOOGLE_OAUTH_CLIENT_ID",
    clientSecretVar: "GOOGLE_OAUTH_CLIENT_SECRET",
  },
};

export interface ConfiguredProvider extends OauthProvider {
  clientId: string;
  clientSecret: string;
}

/**
 * Resolves a provider ONLY if both of its secrets are present.
 *
 * An unconfigured provider's ROUTES 404, matching how TURNSTILE_SECRET_KEY
 * and SENDGRID_API_KEY already degrade in this codebase. This is what lets
 * the SSO code ship and be reviewed before any app registration exists.
 *
 * AuditLab SSO-E (LOW, 2026-08-21): this docstring used to also claim "and
 * its button is not rendered" -- that half was never true. The login
 * page's SSO button is static markup, gated at BUILD time by generate.py's
 * own `SSO_PROVIDERS`/`DR_SSO_PROVIDERS` (see that file's 2026-07-30
 * comment): a provider's default there is meant to be flipped once its
 * credentials are confirmed live, and flipped back if they're ever
 * rotated out. That is a manual, documented convention, not something
 * this function drives -- there is no live connection between the two.
 * A previously-planned `configuredProviderIds()` helper that WOULD have
 * connected them was deleted here: it had zero callers, its own docstring
 * claimed it "drives which buttons the login page renders," and it never
 * did. If dynamic button-hiding is ever wanted, it needs a real
 * client-side check against a runtime endpoint -- this function alone
 * can't do it, since generate.py's static output has no access to Worker
 * secrets at build time.
 */
export function getConfiguredProvider(env: Env, providerId: string): ConfiguredProvider | null {
  const provider = PROVIDERS[providerId];
  if (!provider) return null;
  const clientId = env[provider.clientIdVar] as string | undefined;
  const clientSecret = env[provider.clientSecretVar] as string | undefined;
  if (!clientId || !clientSecret) return null;
  return { ...provider, clientId, clientSecret };
}

/**
 * The redirect_uri, which must match what is registered with the provider
 * CHARACTER-EXACTLY or the provider rejects the request before our code
 * runs.
 *
 * Derived from ACTION_BASE_URL (the same base every emailed action link
 * already uses) rather than from the incoming request's Host header --
 * deliberately. A Host header is attacker-controllable in some proxy
 * setups, and letting it shape the redirect_uri is a classic way to turn
 * an OAuth callback into an open redirect / code-leak. This value depends
 * only on server configuration.
 *
 * Trailing slashes on the base are stripped so a stray "/" in the env var
 * cannot produce a double slash that silently fails to match.
 */
export function buildRedirectUri(actionBase: string, providerId: string): string {
  return `${actionBase.replace(/\/+$/, "")}/firm/auth/${providerId}/callback`;
}

function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** PKCE S256 challenge (RFC 7636): BASE64URL(SHA256(ASCII(verifier))). */
export async function pkceChallengeS256(codeVerifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier));
  return base64UrlEncode(new Uint8Array(digest));
}

/** The provider URL to send the browser to. `state` and `nonce` come from
 * store.createOauthState() and are single-use + short-lived there. */
export async function buildAuthorizeUrl(input: {
  provider: ConfiguredProvider;
  redirectUri: string;
  state: string;
  nonce: string;
  codeVerifier: string;
}): Promise<string> {
  const url = new URL(input.provider.authorizeUrl);
  url.searchParams.set("client_id", input.provider.clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("scope", input.provider.scopes);
  url.searchParams.set("state", input.state);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("code_challenge", await pkceChallengeS256(input.codeVerifier));
  url.searchParams.set("code_challenge_method", "S256");
  // Always show the account chooser. Without it a user already signed into
  // a personal Google account is silently authenticated as that account,
  // with no obvious way to switch to their firm address -- and they end up
  // linking the wrong identity to the firm.
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}

export interface TokenResponse {
  id_token?: string;
  access_token?: string;
  token_type?: string;
  expires_in?: number;
}

/**
 * Redeems the authorization code. Sends client_secret + PKCE code_verifier
 * over TLS to the provider's token endpoint.
 *
 * Returns null on ANY failure (network, non-2xx, unparseable body) rather
 * than surfacing the provider's error text: those bodies routinely echo
 * request parameters back, and forwarding them to the browser is a way to
 * leak configuration. The caller renders one generic failure.
 */
export async function exchangeCodeForTokens(input: {
  provider: ConfiguredProvider;
  code: string;
  redirectUri: string;
  codeVerifier: string;
}): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: input.redirectUri,
    client_id: input.provider.clientId,
    client_secret: input.provider.clientSecret,
    code_verifier: input.codeVerifier,
  });

  let resp: Response;
  try {
    resp = await fetch(input.provider.tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: body.toString(),
    });
  } catch {
    return null;
  }
  if (!resp.ok) return null;
  try {
    return (await resp.json()) as TokenResponse;
  } catch {
    return null;
  }
}

export interface IdTokenClaims {
  sub: string;
  email: string | null;
  emailVerified: boolean;
}

function decodeJwtPayload(idToken: string): Record<string, unknown> | null {
  const parts = idToken.split(".");
  if (parts.length !== 3) return null;
  const payloadPart = parts[1];
  if (!payloadPart) return null;
  try {
    const b64 = payloadPart.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const json = atob(padded);
    // atob yields latin1; re-decode as UTF-8 so non-ASCII names/emails
    // aren't mangled.
    const bytes = new Uint8Array(json.length);
    for (let i = 0; i < json.length; i++) bytes[i] = json.charCodeAt(i);
    const parsed = JSON.parse(new TextDecoder().decode(bytes));
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Small tolerance for clock skew between us and the provider, applied ONLY
 * to expiry. 60s is the conventional allowance. */
const CLOCK_SKEW_SECONDS = 60;

/**
 * Validates the claims that actually carry authority, then returns the
 * identity. Returns null if ANY check fails -- callers must treat null as
 * "authentication failed", never as "proceed with partial data".
 *
 * Checks, and what each stops:
 *   iss    -- a token minted by some other provider being replayed at us.
 *             Exact match against an allow-list, never a substring test.
 *   aud    -- a token issued for a DIFFERENT application being replayed at
 *             ours. Without this, any token from any Google app for the
 *             same user would be accepted.
 *   exp    -- an old captured token being reused indefinitely.
 *   nonce  -- replay of a token from an earlier, unrelated handshake; ties
 *             this token to the specific /start we issued.
 *   sub    -- must be a non-empty string; it is the account's primary key.
 *
 * See this module's header for why the signature itself is not verified.
 */
export function parseAndValidateIdToken(input: {
  idToken: string;
  provider: ConfiguredProvider;
  expectedNonce: string;
}): IdTokenClaims | null {
  const claims = decodeJwtPayload(input.idToken);
  if (!claims) return null;

  const iss = typeof claims.iss === "string" ? claims.iss : null;
  if (!iss || !input.provider.issuers.includes(iss)) return null;

  // `aud` may be a string or an array of strings per the JWT spec.
  const aud = claims.aud;
  const audOk =
    (typeof aud === "string" && aud === input.provider.clientId) ||
    (Array.isArray(aud) && aud.some((a) => a === input.provider.clientId));
  if (!audOk) return null;

  const exp = typeof claims.exp === "number" ? claims.exp : null;
  if (exp === null) return null;
  if (exp + CLOCK_SKEW_SECONDS <= Math.floor(Date.now() / 1000)) return null;

  // Compared even though the value came back inside a token we just
  // fetched: it is what binds this token to OUR /start request rather than
  // to a handshake an attacker began.
  const nonce = typeof claims.nonce === "string" ? claims.nonce : null;
  if (!nonce || nonce !== input.expectedNonce) return null;

  const sub = typeof claims.sub === "string" ? claims.sub : null;
  if (!sub) return null;

  const email = typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null;
  // Google sends this as a real boolean, but some providers send the
  // string "true" -- accept both, and treat anything else as NOT verified.
  // Defaulting to false is the safe direction: an unverified email must
  // never be allowed to auto-link to an existing firm account.
  const rawVerified = claims.email_verified;
  const emailVerified = rawVerified === true || rawVerified === "true";

  return { sub, email, emailVerified };
}
