import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword, PBKDF2_ITERATIONS } from "../src/pro_auth";
import { buildProVerifyEmail, buildProPasswordResetEmail } from "../src/pro_emails";
import { MAILING_ADDRESS } from "../src/emails";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

function extractSessionCookie(response: Response): string | null {
  const setCookie = response.headers.get("set-cookie");
  if (!setCookie) return null;
  const match = /dr_session=([^;]+)/.exec(setCookie);
  return match?.[1] ?? null;
}

// Each test gets its own source IP by default -- RATE_LIMIT_SIGNUP/LOGIN
// are per-IP, and reusing one fixed IP across many independent tests in the
// same file would trip the rate limiter as a test-ordering artifact, not
// because anything under test is actually wrong. Tests that specifically
// exercise rate limiting should pass an explicit, deliberately-shared IP.
let nextTestIp = 1;
function freshIp(): string {
  nextTestIp += 1;
  return `203.0.113.${nextTestIp}`;
}

async function signup(fields: Record<string, string>, ip = freshIp()): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/pro/signup", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function login(fields: Record<string, string>, ip = freshIp()): Promise<Response> {
  return SELF.fetch("https://deadline-radar.com/pro/login", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form(fields),
  });
}

async function withSession(
  path: string,
  sessionId: string,
  init: { method?: string; body?: Record<string, string> } = {}
): Promise<Response> {
  return SELF.fetch(`https://deadline-radar.com${path}`, {
    method: init.method ?? "GET",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": "203.0.113.10",
      cookie: `dr_session=${sessionId}`,
    },
    body: init.body ? form(init.body) : undefined,
  });
}

describe("pro_auth password hashing", () => {
  it("verifies a correct password and rejects a wrong one", async () => {
    const { hash, salt, iterations } = await hashPassword("correct horse battery staple");
    expect(iterations).toBe(PBKDF2_ITERATIONS);
    expect(await verifyPassword("correct horse battery staple", hash, salt, iterations)).toBe(true);
    expect(await verifyPassword("wrong password", hash, salt, iterations)).toBe(false);
  });

  it("produces a different hash for the same password (random salt)", async () => {
    const a = await hashPassword("same password twice");
    const b = await hashPassword("same password twice");
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe("POST /pro/signup", () => {
  it("creates an account and sets a session cookie", async () => {
    const res = await signup({ email: "new-user-1@example.com", password: "a-long-enough-password" });
    expect(res.status).toBe(201);
    const body = await res.json<{ ok: boolean; email: string; verified: boolean }>();
    expect(body.ok).toBe(true);
    expect(body.email).toBe("new-user-1@example.com");
    expect(body.verified).toBe(false);
    expect(extractSessionCookie(res)).not.toBeNull();
  });

  it("rejects a password shorter than the minimum", async () => {
    const res = await signup({ email: "short-pw@example.com", password: "short1" });
    expect(res.status).toBe(400);
  });

  it("rejects a duplicate email without revealing which case it was via status alone", async () => {
    await signup({ email: "dupe-user@example.com", password: "first-password-here" });
    const res = await signup({ email: "dupe-user@example.com", password: "second-password-here" });
    expect(res.status).toBe(409);
  });

  it("honeypot: looks like success but creates nothing", async () => {
    const res = await signup({ email: "honeypot-user@example.com", password: "irrelevant-pw-value", hp_website: "bot-filled-this" });
    expect(res.status).toBe(200);
    const row = await env.DB.prepare("SELECT * FROM accounts WHERE email = ?1").bind("honeypot-user@example.com").first();
    expect(row).toBeNull();
  });

  it("rejects control characters in any field", async () => {
    const res = await signup({ email: "control-char@example.com", password: "password-with-\x00-null" });
    expect(res.status).toBe(400);
  });
});

describe("POST /pro/login", () => {
  it("logs in with correct credentials and rejects wrong ones with the same generic error", async () => {
    await signup({ email: "login-test@example.com", password: "the-real-password-here" });

    const wrongPw = await login({ email: "login-test@example.com", password: "not-the-password" });
    expect(wrongPw.status).toBe(401);
    const wrongPwBody = await wrongPw.json<{ error: string }>();

    const noSuchUser = await login({ email: "nobody-registered@example.com", password: "anything-goes" });
    expect(noSuchUser.status).toBe(401);
    const noSuchUserBody = await noSuchUser.json<{ error: string }>();

    // Same generic message either way -- doesn't leak whether the account exists.
    expect(wrongPwBody.error).toBe(noSuchUserBody.error);

    const correct = await login({ email: "login-test@example.com", password: "the-real-password-here" });
    expect(correct.status).toBe(200);
    expect(extractSessionCookie(correct)).not.toBeNull();
  });
});

describe("POST /pro/logout", () => {
  it("invalidates the session so it can't be reused", async () => {
    const signupRes = await signup({ email: "logout-test@example.com", password: "a-perfectly-fine-password" });
    const sessionId = extractSessionCookie(signupRes);
    expect(sessionId).not.toBeNull();

    const beforeLogout = await withSession("/pro/cpe-entries", sessionId as string);
    expect(beforeLogout.status).toBe(200);

    const logoutRes = await SELF.fetch("https://deadline-radar.com/pro/logout", {
      method: "POST",
      headers: { cookie: `dr_session=${sessionId}` },
    });
    expect(logoutRes.status).toBe(200);

    const afterLogout = await withSession("/pro/cpe-entries", sessionId as string);
    expect(afterLogout.status).toBe(401);
  });
});

describe("CPE hour entries", () => {
  async function freshSession(email: string): Promise<string> {
    const res = await signup({ email, password: "a-perfectly-reasonable-password" });
    return extractSessionCookie(res) as string;
  }

  it("requires an authenticated session", async () => {
    const res = await SELF.fetch("https://deadline-radar.com/pro/cpe-entries");
    expect(res.status).toBe(401);
  });

  it("creates, lists, and deletes an entry for the logged-in account", async () => {
    const sessionId = await freshSession("cpe-entries-owner@example.com");

    const createRes = await withSession("/pro/cpe-entries", sessionId, {
      method: "POST",
      body: {
        state: "kansas",
        course_name: "Ethics for Kansas CPAs",
        hours: "2",
        is_ethics: "1",
        completed_date: "2026-06-01",
      },
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json<{ entry: { id: string; hours: number; is_ethics: number } }>();
    expect(created.entry.hours).toBe(2);
    expect(created.entry.is_ethics).toBe(1);

    const listRes = await withSession("/pro/cpe-entries", sessionId);
    expect(listRes.status).toBe(200);
    const listed = await listRes.json<{ entries: Array<{ id: string }> }>();
    expect(listed.entries).toHaveLength(1);
    expect(listed.entries[0]?.id).toBe(created.entry.id);

    const deleteRes = await withSession(`/pro/cpe-entries/${created.entry.id}/delete`, sessionId, { method: "POST" });
    expect(deleteRes.status).toBe(200);

    const listAfterDelete = await withSession("/pro/cpe-entries", sessionId);
    const listedAfter = await listAfterDelete.json<{ entries: unknown[] }>();
    expect(listedAfter.entries).toHaveLength(0);
  });

  it("rejects an unsupported state slug", async () => {
    const sessionId = await freshSession("cpe-bad-state@example.com");
    const res = await withSession("/pro/cpe-entries", sessionId, {
      method: "POST",
      body: {
        state: "not-a-real-state",
        course_name: "Some Course",
        hours: "2",
        is_ethics: "0",
        completed_date: "2026-06-01",
      },
    });
    expect(res.status).toBe(400);
  });

  it("rejects a future completed_date", async () => {
    const sessionId = await freshSession("cpe-future-date@example.com");
    const res = await withSession("/pro/cpe-entries", sessionId, {
      method: "POST",
      body: {
        state: "kansas",
        course_name: "Time Travelers' Ethics",
        hours: "2",
        is_ethics: "0",
        completed_date: "2099-01-01",
      },
    });
    expect(res.status).toBe(400);
  });

  it("one account cannot delete another account's entry", async () => {
    const ownerSession = await freshSession("cpe-owner-isolation@example.com");
    const attackerSession = await freshSession("cpe-attacker-isolation@example.com");

    const createRes = await withSession("/pro/cpe-entries", ownerSession, {
      method: "POST",
      body: { state: "kansas", course_name: "Owner's Course", hours: "3", is_ethics: "0", completed_date: "2026-05-01" },
    });
    const created = await createRes.json<{ entry: { id: string } }>();

    const deleteAttempt = await withSession(`/pro/cpe-entries/${created.entry.id}/delete`, attackerSession, { method: "POST" });
    expect(deleteAttempt.status).toBe(404);

    // Confirm it's still there for the real owner.
    const listRes = await withSession("/pro/cpe-entries", ownerSession);
    const listed = await listRes.json<{ entries: unknown[] }>();
    expect(listed.entries).toHaveLength(1);
  });
});

describe("POST /pro/password-reset/request and /confirm", () => {
  it("gives the same response whether or not the email exists", async () => {
    await signup({ email: "reset-flow-user@example.com", password: "the-original-password" });

    const realEmailRes = await SELF.fetch("https://deadline-radar.com/pro/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.20" },
      body: form({ email: "reset-flow-user@example.com" }),
    });
    const noSuchEmailRes = await SELF.fetch("https://deadline-radar.com/pro/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.21" },
      body: form({ email: "definitely-not-registered@example.com" }),
    });
    expect(realEmailRes.status).toBe(noSuchEmailRes.status);
    const realBody = await realEmailRes.json();
    const fakeBody = await noSuchEmailRes.json();
    expect(realBody).toEqual(fakeBody);
  });

  it("lets a real reset token set a new password, and old sessions stop working", async () => {
    const signupRes = await signup({ email: "reset-confirm-user@example.com", password: "the-old-password-here" });
    const oldSessionId = extractSessionCookie(signupRes);

    await SELF.fetch("https://deadline-radar.com/pro/password-reset/request", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.22" },
      body: form({ email: "reset-confirm-user@example.com" }),
    });
    const row = await env.DB.prepare("SELECT password_reset_token FROM accounts WHERE email = ?1")
      .bind("reset-confirm-user@example.com")
      .first<{ password_reset_token: string }>();
    expect(row?.password_reset_token).toBeTruthy();

    const confirmRes = await SELF.fetch("https://deadline-radar.com/pro/password-reset/confirm", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.22" },
      body: form({ token: row?.password_reset_token as string, password: "the-brand-new-password" }),
    });
    expect(confirmRes.status).toBe(200);

    // Old session was invalidated by the reset.
    const oldSessionCheck = await withSession("/pro/cpe-entries", oldSessionId as string);
    expect(oldSessionCheck.status).toBe(401);

    // Old password no longer works, new one does.
    const oldPwLogin = await login({ email: "reset-confirm-user@example.com", password: "the-old-password-here" });
    expect(oldPwLogin.status).toBe(401);
    const newPwLogin = await login({ email: "reset-confirm-user@example.com", password: "the-brand-new-password" });
    expect(newPwLogin.status).toBe(200);
  });
});

describe("GET /pro/verify", () => {
  it("marks the account verified via its verification token", async () => {
    await signup({ email: "verify-flow-user@example.com", password: "a-perfectly-good-password" });
    const row = await env.DB.prepare("SELECT verification_token FROM accounts WHERE email = ?1")
      .bind("verify-flow-user@example.com")
      .first<{ verification_token: string }>();
    expect(row?.verification_token).toBeTruthy();

    const res = await SELF.fetch(
      `https://deadline-radar.com/pro/verify?token=${encodeURIComponent(row?.verification_token as string)}`
    );
    expect(res.status).toBe(200);
    const body = await res.json<{ ok: boolean; verified: boolean }>();
    expect(body.verified).toBe(true);
  });

  it("rejects an invalid token", async () => {
    const res = await SELF.fetch("https://deadline-radar.com/pro/verify?token=not-a-real-token");
    expect(res.status).toBe(404);
  });
});

describe("pro_emails.ts builders", () => {
  it("buildProVerifyEmail includes the link and a real CAN-SPAM address, no unsubscribe language", () => {
    const built = buildProVerifyEmail("https://deadline-radar.com/api/pro/verify?token=abc123");
    expect(built.subject).toContain("Verify");
    expect(built.htmlBody).toContain("https://deadline-radar.com/api/pro/verify?token=abc123");
    expect(built.textBody).toContain("https://deadline-radar.com/api/pro/verify?token=abc123");
    expect(built.htmlBody).toContain(MAILING_ADDRESS);
    // This is an account email, not a renewal-reminder subscription -- it
    // must NOT carry the reminder-flow's "unsubscribe" language, since
    // there's nothing to unsubscribe from here.
    expect(built.textBody.toLowerCase()).not.toContain("unsubscribe");
  });

  it("buildProPasswordResetEmail includes the link, the 1-hour expiry note, and a real address", () => {
    const built = buildProPasswordResetEmail("https://deadline-radar.com/pro/?reset_token=xyz789");
    expect(built.subject).toContain("Reset");
    expect(built.htmlBody).toContain("https://deadline-radar.com/pro/?reset_token=xyz789");
    expect(built.textBody).toContain("1 hour");
    expect(built.htmlBody).toContain(MAILING_ADDRESS);
  });
});

describe("email sending is gated on SENDGRID_API_KEY (unset in this test env)", () => {
  it("signup still succeeds and creates a verification token even though no email is actually sent", async () => {
    // This test environment has no SENDGRID_API_KEY configured (matches
    // production's own safe-degrade behavior when the secret is unset) --
    // confirms sendBestEffort()'s guard doesn't throw or block the request
    // when there's no key to send with.
    const res = await signup({ email: "no-sendgrid-key-test@example.com", password: "a-fine-password-here" });
    expect(res.status).toBe(201);
    const row = await env.DB.prepare("SELECT verification_token FROM accounts WHERE email = ?1")
      .bind("no-sendgrid-key-test@example.com")
      .first<{ verification_token: string }>();
    expect(row?.verification_token).toBeTruthy();
  });
});
