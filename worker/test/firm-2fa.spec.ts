/**
 * Roadmap #53 (2026-08-07): the pending-token 2FA gate end-to-end. totp.ts's
 * own crypto/RFC-vector correctness lives in totp.spec.ts -- this file is
 * about the GATE: does an enrolled member actually get stopped before a
 * session/side-effect happens, for every purpose a login token can carry,
 * and does POST /firm/2fa/verify enforce brute-force limits correctly.
 *
 * New file, not an addition to worker.spec.ts -- that file's size alone has
 * triggered a vitest-pool-workers internal stack overflow before (see
 * map1-mobility-scope.spec.ts's own header), so new feature suites get their
 * own file as a standing practice now.
 *
 * TOTP tests use workerFetch() (a direct worker.fetch() call with env
 * overrides), not SELF.fetch(), because TOTP_ENCRYPTION_KEY is a real deploy
 * secret this test env's wrangler.toml deliberately does not set -- same
 * reasoning billing.spec.ts's own workerFetch() gives for STRIPE_SECRET_KEY.
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";
import { hashPassword } from "../src/password";
import { generateTotpSecretBase32, generateTotp, encryptTotpSecret, decryptTotpSecret, generateBackupCodes, hashBackupCode } from "../src/totp";
import { RATE_LIMIT_FIRM_2FA_VERIFY, RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT } from "../src/validation";

const BASE = "https://deadline-radar.com";
const KEY = randomKeyBase64();

function randomKeyBase64(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function testExecutionContext(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function workerFetch(request: Request, envOverrides: Record<string, unknown> = {}): Promise<Response> {
  const worker = (await import("../src/index")).default;
  return worker.fetch(request, { ...env, ...envOverrides } as never, testExecutionContext());
}

/** Creates a firm + primary member with a real password AND TOTP enrolled. */
async function newEnrolledFirm(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const password = "correct horse battery staple 42";
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: "2FA Test LLP", adminEmail: email });
  await store.setFirmMemberPassword(env.DB, memberId, await hashPassword(password));
  const secret = generateTotpSecretBase32();
  const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, memberId, KEY);
  // confirmedTimestep=0: a real current counter (Unix-epoch/30s) is always
  // far larger, so this never collides with a genuinely-generated code in
  // these tests -- it just seeds the replay floor at "nothing accepted yet".
  await store.setFirmMemberTotpSecret(env.DB, memberId, ciphertextBase64, ivBase64, 0);
  return { firmId, memberId, email, password, secret };
}

async function newPlainFirm(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const password = "correct horse battery staple 42";
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: "2FA Test LLP", adminEmail: email });
  await store.setFirmMemberPassword(env.DB, memberId, await hashPassword(password));
  return { firmId, memberId, email, password };
}

/** A magic-link-only member -- no password ever set. Exercises the
 * exemption AuditLab 2FA-2's fix mirrors from handleFirmChangeEmailRequest:
 * the step-up gate is skipped (not enforced-and-failing) when there is no
 * password to prove, same reasoning as every sibling step-up check. */
async function newPasswordlessFirm(label: string) {
  const email = `${label}-${Date.now()}-${Math.floor(performance.now())}@examplefirm.com`;
  const { id: firmId, memberId } = await store.createFirm(env.DB, { name: "2FA Test LLP", adminEmail: email });
  return { firmId, memberId, email };
}

function pendingTokenFromLocation(resp: Response): string {
  const location = resp.headers.get("Location") ?? "";
  const match = /[?&]pending=([^&]+)/.exec(location);
  return decodeURIComponent(match?.[1] ?? "");
}

async function sessionCookieFor(firmId: string, memberId: string): Promise<string> {
  const { rawSessionToken } = await store.createSession(env.DB, firmId, memberId);
  return `dr_firm_session=${rawSessionToken}`;
}

describe("password login is gated the same way for an enrolled member", () => {
  it("redirects to the 2FA entry page instead of signing in, no session cookie set", async () => {
    const { email, password } = await newEnrolledFirm("pw-gate");
    const resp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.200" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toMatch(/^\/firm-login\/2fa\/\?pending=/);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("control: a member with no 2FA enrolled signs straight in", async () => {
    const { email, password } = await newPlainFirm("pw-no-2fa");
    const resp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.201" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });
});

describe("the magic-link verify gate closes the password_reset and email_change bypass holes", () => {
  async function redeem(rawToken: string, ip: string): Promise<Response> {
    const page = await SELF.fetch(`${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": ip },
      redirect: "manual",
    });
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
    return SELF.fetch(`${BASE}/firm/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip, Cookie: cookie },
      body: form({ token: rawToken, action_csrf: nonce }),
      redirect: "manual",
    });
  }

  it("an ordinary login-token click is gated, not signed straight in", async () => {
    const { firmId, memberId } = await newEnrolledFirm("link-login-gate");
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "login", null, memberId);
    const resp = await redeem(rawToken, "203.0.113.202");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toMatch(/^\/firm-login\/2fa\/\?pending=/);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("a password_reset click is gated too -- losing password access alone cannot bypass 2FA", async () => {
    const { firmId, memberId } = await newEnrolledFirm("link-reset-gate");
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "password_reset", null, memberId);
    const resp = await redeem(rawToken, "203.0.113.203");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toMatch(/^\/firm-login\/2fa\/\?pending=/);
    expect(resp.headers.get("Location")).not.toBe("/set-password/");
  });

  it("an email_change click is gated -- a stolen session cannot complete a takeover with the confirm click alone", async () => {
    const { firmId, memberId, email } = await newEnrolledFirm("link-email-gate");
    const newEmail = `hijacked-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", newEmail, memberId);
    const resp = await redeem(rawToken, "203.0.113.204");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toMatch(/^\/firm-login\/2fa\/\?pending=/);
    // The email must NOT have been applied yet -- only the TOTP-verified
    // continuation is allowed to apply it.
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.email).toBe(email);
  });
});

describe("POST /firm/2fa/verify", () => {
  it("a correct TOTP code completes sign-in with a session cookie", async () => {
    const { firmId, memberId, email, password, secret } = await newEnrolledFirm("verify-totp-ok");
    const loginResp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.210" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(loginResp);
    expect(pending).not.toBe("");

    const code = await generateTotp(secret);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.210" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");

    const memberAfter = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(memberAfter?.joined_at).toBeTruthy();
  });

  it("replays the password_reset destination through the SAME continuation once TOTP succeeds", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("verify-reset-replay");
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "password_reset", null, memberId);
    const page = await SELF.fetch(`${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": "203.0.113.211" },
      redirect: "manual",
    });
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
    const gateResp = await SELF.fetch(`${BASE}/firm/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.211", Cookie: cookie },
      body: form({ token: rawToken, action_csrf: nonce }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(gateResp);

    const code = await generateTotp(secret);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.211" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/set-password/");
    expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });

  it("replays a deferred email_change ONLY once TOTP succeeds, and applies the pending address", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("verify-email-replay");
    const newEmail = `verified-new-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createLoginToken(env.DB, firmId, "email_change", newEmail, memberId);
    const page = await SELF.fetch(`${BASE}/firm/login/verify?token=${encodeURIComponent(rawToken)}`, {
      headers: { "cf-connecting-ip": "203.0.113.212" },
      redirect: "manual",
    });
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
    const gateResp = await SELF.fetch(`${BASE}/firm/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.212", Cookie: cookie },
      body: form({ token: rawToken, action_csrf: nonce }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(gateResp);

    const code = await generateTotp(secret);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.212" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/firm-dashboard/#account?email_changed=1");
    const memberAfter = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(memberAfter?.email).toBe(newEmail);
  });

  it("a wrong code is refused and increments the pending token's attempts, without burning it outright", async () => {
    const { firmId, email, password } = await newEnrolledFirm("verify-wrong-code");
    const loginResp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.213" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(loginResp);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.213" },
        body: form({ pending, code: "000000" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();

    const row = await env.DB
      .prepare("SELECT attempts, used_at FROM firm_2fa_pending_tokens WHERE firm_id = ?1 ORDER BY created_at DESC LIMIT 1")
      .bind(firmId)
      .first<{ attempts: number; used_at: string | null }>();
    expect(row?.attempts).toBe(1);
    expect(row?.used_at).toBeNull();
  });

  it("6 wrong attempts burns the pending token -- the 7th attempt fails even with the CORRECT code", async () => {
    const { email, password, secret } = await newEnrolledFirm("verify-attempts-cap");
    const loginResp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.214" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(loginResp);

    for (let i = 0; i < 6; i++) {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/2fa/verify`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.214" },
          body: form({ pending, code: "000000" }),
        }),
        { TOTP_ENCRYPTION_KEY: KEY }
      );
      expect(resp.status).toBe(400);
    }

    const code = await generateTotp(secret);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.214" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("a backup code signs in and is single-use -- the same code fails on a second attempt", async () => {
    const { memberId, email, password } = await newEnrolledFirm("verify-backup-code");
    const codes = generateBackupCodes();
    await store.createFirmMemberBackupCodes(env.DB, memberId, await Promise.all(codes.map(hashBackupCode)));

    const loginResp1 = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.215" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending1 = pendingTokenFromLocation(loginResp1);
    const usedCode = codes[0] as string;
    const resp1 = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.215" },
        body: form({ pending: pending1, code: usedCode }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp1.status).toBe(302);
    expect(resp1.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");

    // Fresh pending token (the first is already consumed) -- reuse of the
    // SAME backup code must fail even against a brand-new login attempt.
    const loginResp2 = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.216" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending2 = pendingTokenFromLocation(loginResp2);
    const resp2 = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.216" },
        body: form({ pending: pending2, code: usedCode }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp2.status).toBe(400);
    expect(resp2.headers.get("Set-Cookie")).toBeNull();
  });

  it("a used pending token cannot be redeemed twice, even with the correct code (two-tab race)", async () => {
    const { email, password, secret } = await newEnrolledFirm("verify-race");
    const loginResp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.217" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(loginResp);
    const code = await generateTotp(secret);

    const first = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.217" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(first.status).toBe(302);

    const second = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.218" },
        body: form({ pending, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(second.status).toBe(400);
    expect(second.headers.get("Set-Cookie")).toBeNull();
  });

  // AuditLab 2FA-1 (MEDIUM, 2026-08-07): the SAME code submitted against a
  // SECOND, INDEPENDENT pending token -- not a reuse of the first token
  // (that's the two-tab-race test above, and pending-token single-use
  // doesn't cover this case at all). This is the actual attack RFC 6238
  // Section 5.2 requires refusing: a real-time phishing proxy relays the
  // victim's password AND code to the real site as the victim types them,
  // then starts its OWN login with the captured password to get its own
  // fresh pending token, and submits the captured code into THAT token
  // within its ~90s validity window. Without replay prevention this
  // succeeds; with it, the second attempt must fail even though the code
  // is still inside its own step window.
  it("REPLAY: the same code cannot be accepted twice across two INDEPENDENT pending tokens (phishing-proxy scenario)", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("verify-replay-cross-token");
    const code = await generateTotp(secret);

    const pendingA = (await store.createFirm2faPendingToken(env.DB, memberId, firmId, "login", null)).rawToken;
    const respA = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.219" },
        body: form({ pending: pendingA, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(respA.status).toBe(302);
    expect(respA.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");

    // A brand-new pending token -- the attacker's own login attempt, not a
    // resubmission of pendingA. The SAME code, still well inside its +/-1
    // step window (generated and used within the same test, milliseconds
    // apart), must now be refused.
    const pendingB = (await store.createFirm2faPendingToken(env.DB, memberId, firmId, "login", null)).rawToken;
    const respB = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.220" },
        body: form({ pending: pendingB, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(respB.status).toBe(400);
    expect(respB.headers.get("Set-Cookie")).toBeNull();
  });

  it("REPLAY: a LATER, freshly-generated code still works normally after an earlier one was accepted", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("verify-replay-later-code-ok");
    const now = new Date();
    const later = new Date(now.getTime() + 30_000); // one step later -- a genuinely new code
    const codeNow = await generateTotp(secret, now);
    const codeLater = await generateTotp(secret, later);

    const pendingA = (await store.createFirm2faPendingToken(env.DB, memberId, firmId, "login", null)).rawToken;
    const respA = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.221" },
        body: form({ pending: pendingA, code: codeNow }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(respA.status).toBe(302);

    const pendingB = (await store.createFirm2faPendingToken(env.DB, memberId, firmId, "login", null)).rawToken;
    const respB = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.222" },
        body: form({ pending: pendingB, code: codeLater }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(respB.status).toBe(302);
    expect(respB.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
  });

  it("missing pending or code is a plain 400, not a crash", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.219" },
        body: form({ pending: "", code: "" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("an unknown pending token is refused, not distinguishable from an expired one", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.220" },
        body: form({ pending: "not-a-real-pending-token", code: "123456" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("a cross-site POST (mismatched Origin) is refused -- same login-CSRF posture as the password route", async () => {
    const { email, password } = await newEnrolledFirm("verify-csrf");
    const loginResp = await SELF.fetch(`${BASE}/firm/login/password`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.221" },
      body: form({ hp_website: "", admin_email: email, password }),
      redirect: "manual",
    });
    const pending = pendingTokenFromLocation(loginResp);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/verify`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          "cf-connecting-ip": "203.0.113.221",
          Origin: "https://evil.example",
        },
        body: form({ pending, code: "123456" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });
});

describe("rate limiting on /firm/2fa/verify -- both buckets", () => {
  it("the per-IP bucket trips after its max, independent of which account is targeted", async () => {
    const ip = "203.0.113.230";
    let last: Response | null = null;
    for (let i = 0; i < RATE_LIMIT_FIRM_2FA_VERIFY.max + 1; i++) {
      last = await workerFetch(
        new Request(`${BASE}/firm/2fa/verify`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
          body: form({ pending: `nonexistent-${i}`, code: "123456" }),
        }),
        { TOTP_ENCRYPTION_KEY: KEY }
      );
    }
    expect(last?.status).toBe(429);
  });

  it("the per-account bucket trips from DIFFERENT IPs across DIFFERENT pending tokens for the same account", async () => {
    const { firmId, memberId } = await newEnrolledFirm("verify-account-bucket");

    let last: Response | null = null;
    // A fresh pending token per attempt (via createFirm2faPendingToken
    // directly, same call the login handlers themselves make) -- each stays
    // WELL under its own 6-attempt DB-level cap (one wrong guess each), so
    // that cap can't be what trips this. Only the ACCOUNT-keyed rate-limit
    // bucket accumulates across distinct pending tokens for the same
    // member_id, which is the real-world shape this bucket defends against:
    // an attacker who keeps re-triggering fresh logins from many IPs rather
    // than grinding one pending token.
    for (let i = 0; i < RATE_LIMIT_FIRM_2FA_VERIFY_ACCOUNT.max + 1; i++) {
      const { rawToken: pending } = await store.createFirm2faPendingToken(env.DB, memberId, firmId, "login", null);
      last = await workerFetch(
        new Request(`${BASE}/firm/2fa/verify`, {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": `203.0.113.${241 + i}` },
          body: form({ pending, code: "000000" }),
        }),
        { TOTP_ENCRYPTION_KEY: KEY }
      );
    }
    expect(last?.status).toBe(429);
  });
});

describe("Google SSO is NOT gated by TOTP -- a documented scope decision, not an oversight", () => {
  const SSO_CLIENT_ID = "test-client-id.apps.googleusercontent.com";

  /** Same unsigned-JWT construction oauth.spec.ts's own makeIdToken() uses --
   * the signature is never checked (see oauth.ts's own header: the token
   * endpoint is fetched over TLS directly, which is the trust boundary), so
   * an unsigned token with a correct payload exercises the real claim-
   * validation path exactly as a genuine one would. */
  function makeIdToken(payload: Record<string, unknown>): string {
    const b64url = (o: unknown) => {
      const bytes = new TextEncoder().encode(JSON.stringify(o));
      let bin = "";
      for (const b of bytes) bin += String.fromCharCode(b);
      return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    };
    return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url(payload)}.fake-signature`;
  }

  it("an enrolled primary member's Google sign-in mints a session directly, with no /firm-login/2fa/ redirect", async () => {
    const email = `sso-2fa-bypass-${Date.now()}@examplefirm.com`;
    const { id: firmId, memberId } = await store.createFirm(env.DB, { name: "SSO 2FA Test LLP", adminEmail: email });
    const secret = generateTotpSecretBase32();
    const { ciphertextBase64, ivBase64 } = await encryptTotpSecret(secret, memberId, KEY);
    await store.setFirmMemberTotpSecret(env.DB, memberId, ciphertextBase64, ivBase64, 0);

    const { rawState, nonce, rawBrowserBinding } = await store.createOauthState(env.DB, "google");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      const idToken = makeIdToken({
        iss: "https://accounts.google.com",
        aud: SSO_CLIENT_ID,
        exp: Math.floor(Date.now() / 1000) + 3600,
        nonce,
        sub: `google-subject-${memberId}`,
        email,
        email_verified: true,
      });
      return new Response(JSON.stringify({ id_token: idToken, access_token: "unused" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });

    try {
      const resp = await workerFetch(
        new Request(`${BASE}/firm/auth/google/callback?code=fake-code&state=${encodeURIComponent(rawState)}`, {
          headers: {
            "cf-connecting-ip": "203.0.113.250",
            Cookie: `dr_oauth_handshake=${rawBrowserBinding}`,
          },
          redirect: "manual",
        }),
        { GOOGLE_OAUTH_CLIENT_ID: SSO_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET: "test-client-secret" }
      );
      expect(resp.status).toBe(302);
      expect(resp.headers.get("Location")).toBe("/firm-dashboard/");
      expect(resp.headers.get("Set-Cookie") ?? "").toContain("dr_firm_session=");
    } finally {
      fetchSpy.mockRestore();
    }

    // Confirms this member really is the totp-enrolled one this test set up,
    // not a false pass from the callback silently no-op'ing.
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeTruthy();
  });
});

describe("GET /firm/2fa/status", () => {
  it("reports disabled with zero backup codes for a plain member", async () => {
    const { firmId, memberId } = await newPlainFirm("status-disabled");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await SELF.fetch(`${BASE}/firm/2fa/status`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { enabled: boolean; backup_codes_remaining: number };
    expect(json.enabled).toBe(false);
    expect(json.backup_codes_remaining).toBe(0);
  });

  it("reports enabled with the live unused-backup-code count for an enrolled member", async () => {
    const { firmId, memberId } = await newEnrolledFirm("status-enabled");
    const codes = generateBackupCodes();
    await store.createFirmMemberBackupCodes(env.DB, memberId, await Promise.all(codes.map(hashBackupCode)));
    await store.consumeFirmMemberBackupCode(env.DB, memberId, await hashBackupCode(codes[0] as string));
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await SELF.fetch(`${BASE}/firm/2fa/status`, { headers: { Cookie: cookie } });
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { enabled: boolean; backup_codes_remaining: number };
    expect(json.enabled).toBe(true);
    expect(json.backup_codes_remaining).toBe(7);
  });

  it("401s with no session", async () => {
    const resp = await SELF.fetch(`${BASE}/firm/2fa/status`);
    expect(resp.status).toBe(401);
  });
});

describe("POST /firm/2fa/enroll", () => {
  it("returns a secret + otpauth URI and persists NOTHING yet", async () => {
    const { firmId, memberId, password } = await newPlainFirm("enroll-nothing-persisted");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.260", Cookie: cookie },
        body: JSON.stringify({ current_password: password }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { secret: string; otpauth_uri: string };
    expect(json.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(json.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);

    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeNull();
    expect(member?.totp_secret_encrypted).toBeNull();
  });

  it("401s with no session", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.261" },
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(401);
  });

  it("refuses to re-enroll a member who already has 2FA", async () => {
    const { firmId, memberId } = await newEnrolledFirm("enroll-already-on");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.262", Cookie: cookie },
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("refuses for a demo_locked (shared demo) firm -- 2FA would lock out everyone else sharing it", async () => {
    const { firmId, memberId } = await newPlainFirm("enroll-demo-locked");
    await env.DB.prepare("UPDATE firms SET demo_locked = 1 WHERE id = ?1").bind(firmId).run();
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.263", Cookie: cookie },
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("503s when TOTP_ENCRYPTION_KEY isn't configured (the real state of this test env by default)", async () => {
    const { firmId, memberId } = await newPlainFirm("enroll-no-key");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await SELF.fetch(`${BASE}/firm/2fa/enroll`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.264", Cookie: cookie },
    });
    expect(resp.status).toBe(503);
  });

  // AuditLab 2FA-2 (MEDIUM, 2026-08-07): a stolen session alone must not be
  // enough to enroll 2FA -- without step-up, an attacker holding just a
  // session cookie could enroll with a secret THEY control, receive the 8
  // backup codes, and lock the real owner out permanently (disable itself
  // requires a code the attacker now holds -- worse than the email-change
  // hijack EMAILCHG-1 already closed the same way).
  it("refuses without current_password when the member already has a password", async () => {
    const { firmId, memberId } = await newPlainFirm("enroll-stepup-missing");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.265", Cookie: cookie },
        body: JSON.stringify({}),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("refuses with the WRONG current_password", async () => {
    const { firmId, memberId } = await newPlainFirm("enroll-stepup-wrong");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.266", Cookie: cookie },
        body: JSON.stringify({ current_password: "definitely-not-it" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("a stolen session alone (no password) cannot obtain a secret -- the attacker never reaches enroll/confirm", async () => {
    const { firmId, memberId } = await newPlainFirm("enroll-stepup-no-secret-leak");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.267", Cookie: cookie },
        body: JSON.stringify({ current_password: "wrong" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    const json = (await resp.json()) as Record<string, unknown>;
    expect(json.secret).toBeUndefined();
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeNull();
  });

  it("succeeds without current_password for a magic-link-only member (no password to prove) -- same exemption as handleFirmChangeEmailRequest", async () => {
    const { firmId, memberId } = await newPasswordlessFirm("enroll-stepup-no-password-member");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.268", Cookie: cookie },
        body: JSON.stringify({}),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { secret: string };
    expect(json.secret).toMatch(/^[A-Z2-7]{32}$/);
  });
});

describe("POST /firm/2fa/enroll/confirm", () => {
  async function enroll(cookie: string, ip: string, password: string): Promise<{ secret: string }> {
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip, Cookie: cookie },
        body: JSON.stringify({ current_password: password }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    const json = (await resp.json()) as { secret: string };
    return { secret: json.secret };
  }

  it("a correct code completes enrollment and returns 8 one-time backup codes", async () => {
    const { firmId, memberId, password } = await newPlainFirm("confirm-ok");
    const cookie = await sessionCookieFor(firmId, memberId);
    const { secret } = await enroll(cookie, "203.0.113.270", password);
    const code = await generateTotp(secret);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.270", Cookie: cookie },
        body: JSON.stringify({ secret, code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
    const json = (await resp.json()) as { ok: boolean; backup_codes: string[] };
    expect(json.ok).toBe(true);
    expect(json.backup_codes.length).toBe(8);
    expect(new Set(json.backup_codes).size).toBe(8);

    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeTruthy();
    expect(member?.totp_secret_encrypted).toBeTruthy();

    const unused = await store.countUnusedFirmMemberBackupCodes(env.DB, memberId);
    expect(unused).toBe(8);
  });

  it("a wrong code refuses and leaves the member unenrolled", async () => {
    const { firmId, memberId, password } = await newPlainFirm("confirm-wrong-code");
    const cookie = await sessionCookieFor(firmId, memberId);
    const { secret } = await enroll(cookie, "203.0.113.271", password);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.271", Cookie: cookie },
        body: JSON.stringify({ secret, code: "000000" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeNull();
  });

  it("refuses to overwrite an already-enrolled member's secret -- closes a stolen-session takeover-via-re-enrollment path", async () => {
    const { firmId, memberId, secret: originalSecret } = await newEnrolledFirm("confirm-no-overwrite");
    const cookie = await sessionCookieFor(firmId, memberId);
    const attackerSecret = generateTotpSecretBase32();
    const attackerCode = await generateTotp(attackerSecret);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/enroll/confirm`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.272", Cookie: cookie },
        body: JSON.stringify({ secret: attackerSecret, code: attackerCode }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);

    // The ORIGINAL secret must still be the one in place, not the attacker's.
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    const stillOriginal = await decryptTotpSecret(member!.totp_secret_encrypted!, member!.totp_secret_iv!, memberId, KEY);
    expect(stillOriginal).toBe(originalSecret);
  });
});

describe("POST /firm/2fa/disable", () => {
  it("a correct TOTP code disables 2FA and deletes all backup codes", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("disable-totp-ok");
    await store.createFirmMemberBackupCodes(env.DB, memberId, await Promise.all(generateBackupCodes().map(hashBackupCode)));
    const cookie = await sessionCookieFor(firmId, memberId);
    const code = await generateTotp(secret);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.280", Cookie: cookie },
        body: JSON.stringify({ code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);

    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeNull();
    expect(member?.totp_secret_encrypted).toBeNull();
    const unused = await store.countUnusedFirmMemberBackupCodes(env.DB, memberId);
    expect(unused).toBe(0);
  });

  it("a valid backup code also disables 2FA", async () => {
    const { firmId, memberId } = await newEnrolledFirm("disable-backup-ok");
    const codes = generateBackupCodes();
    await store.createFirmMemberBackupCodes(env.DB, memberId, await Promise.all(codes.map(hashBackupCode)));
    const cookie = await sessionCookieFor(firmId, memberId);

    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.281", Cookie: cookie },
        body: JSON.stringify({ code: codes[0] }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(200);
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeNull();
  });

  it("a wrong code refuses and leaves 2FA enabled", async () => {
    const { firmId, memberId } = await newEnrolledFirm("disable-wrong-code");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.282", Cookie: cookie },
        body: JSON.stringify({ code: "000000" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeTruthy();
  });

  it("400s on an account with no 2FA enabled", async () => {
    const { firmId, memberId } = await newPlainFirm("disable-none");
    const cookie = await sessionCookieFor(firmId, memberId);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.283", Cookie: cookie },
        body: JSON.stringify({ code: "123456" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
  });

  it("401s with no session", async () => {
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.284" },
        body: JSON.stringify({ code: "123456" }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(401);
  });

  it("a cross-site POST (mismatched Origin) is refused", async () => {
    const { firmId, memberId, secret } = await newEnrolledFirm("disable-csrf");
    const cookie = await sessionCookieFor(firmId, memberId);
    const code = await generateTotp(secret);
    const resp = await workerFetch(
      new Request(`${BASE}/firm/2fa/disable`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "cf-connecting-ip": "203.0.113.285",
          Cookie: cookie,
          Origin: "https://evil.example",
        },
        body: JSON.stringify({ code }),
      }),
      { TOTP_ENCRYPTION_KEY: KEY }
    );
    expect(resp.status).toBe(400);
    const member = await store.getFirmMemberById(env.DB, firmId, memberId);
    expect(member?.totp_enrolled_at).toBeTruthy();
  });
});
