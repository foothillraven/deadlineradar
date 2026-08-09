/**
 * Roadmap #12 (2026-08-07): subscriber self-service profile management.
 * Devin's approved scope: name (first_name) and email are self-editable;
 * compliance data (state, license type, deadline) stays firm-admin-only
 * by construction -- these handlers have no path to those fields at all.
 *
 * Split into its own file rather than growing subscriber-session.spec.ts
 * or worker.spec.ts (already large enough to hit real vitest-pool-workers
 * limits per this session's own MAP-1 fix -- see map1-mobility-scope.spec.ts).
 */
import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";

const BASE = "https://deadline-radar.com";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function seed(email: string, stateSlug: string, firmId: string | null = null): Promise<{ id: string }> {
  return store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields: {},
    firstName: null,
    skipConfirmation: true,
    firmId,
  });
}

async function subscriberCookie(email: string): Promise<string> {
  const { rawSessionToken } = await store.createSubscriberSession(env.DB, store.normalizeEmail(email));
  return `dr_sub_session=${rawSessionToken}`;
}

async function getVerifyPage(token: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/subscriber/login/verify?token=${encodeURIComponent(token)}`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
}

/** Same two-step GET-then-POST-with-nonce flow every ACTION_PAGES route
 * requires -- matches subscriber-routes.spec.ts's own postVerify helper. */
async function postVerify(token: string, ip: string): Promise<Response> {
  const page = await getVerifyPage(token, ip);
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  return SELF.fetch(`${BASE}/subscriber/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip, Cookie: cookie },
    body: form({ token, action_csrf: nonce }),
    redirect: "manual",
  });
}

// ---------------------------------------------------------------------------
// Store-level: token purpose plumbing, the two new mutation helpers.
// ---------------------------------------------------------------------------

describe("store: subscriber login token purpose (roadmap #12)", () => {
  it("defaults to 'login' with no pending email, same safe default as the firm side", async () => {
    const email = `sub12-default-${Date.now()}@example.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const result = await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken);
    expect(result?.purpose).toBe("login");
    expect(result?.pendingNewEmail).toBeNull();
  });

  it("carries purpose and pendingNewEmail through to redemption", async () => {
    const email = `sub12-purpose-${Date.now()}@example.com`;
    const newEmail = `sub12-newemail-${Date.now()}@example.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email, "email_change", newEmail);
    const result = await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken);
    expect(result?.purpose).toBe("email_change");
    expect(result?.pendingNewEmail).toBe(newEmail);
  });

  it("an unrecognised purpose string normalises to 'login', never a crash or a privileged branch", async () => {
    const email = `sub12-unrecog-${Date.now()}@example.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    await env.DB.prepare("UPDATE subscriber_login_tokens SET purpose = 'made-up-purpose' WHERE email_normalized = ?1").bind(email).run();
    const result = await store.verifyAndConsumeSubscriberLoginToken(env.DB, rawToken);
    expect(result?.purpose).toBe("login");
  });
});

describe("store: hasAnySubscriberRowForEmail / setSubscriberEmail (roadmap #12)", () => {
  it("finds an existing address, and correctly reports an unknown one as free", async () => {
    const email = `sub12-exists-${Date.now()}@example.com`;
    await seed(email, "texas");
    expect(await store.hasAnySubscriberRowForEmail(env.DB, email)).toBe(true);
    expect(await store.hasAnySubscriberRowForEmail(env.DB, `nobody-${Date.now()}@example.com`)).toBe(false);
  });

  it("updates EVERY row sharing the old email, including a firm-tracked one, and never touches another person's rows", async () => {
    const oldEmail = `sub12-multi-old-${Date.now()}@example.com`;
    const newEmail = `sub12-multi-new-${Date.now()}@example.com`;
    const other = `sub12-multi-other-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Self-Service Test Firm", adminEmail: `sub12-firm-${Date.now()}@example.com` });
    await seed(oldEmail, "texas"); // free-tier row
    await seed(oldEmail, "california", firmId); // firm-tracked row, same person
    await seed(other, "florida"); // unrelated person

    const changed = await store.setSubscriberEmail(env.DB, store.normalizeEmail(oldEmail), newEmail);
    expect(changed).toBe(2);

    expect(await store.listSubscriberLicenses(env.DB, oldEmail)).toEqual([]);
    const moved = await store.listSubscriberLicenses(env.DB, newEmail);
    expect(moved.map((r) => r.state_slug).sort()).toEqual(["california", "texas"]);
    // The firm-tracked row's firm_id survives the move -- only the
    // address changed, the person is still on that firm's roster.
    expect(moved.find((r) => r.state_slug === "california")?.firm_id).toBe(firmId);

    expect((await store.listSubscriberLicenses(env.DB, other)).length).toBe(1);
  });
});

describe("store: setSubscriberFirstName leaves staff_label and compliance fields untouched (roadmap #12)", () => {
  it("updates first_name across every row, never staff_label/state_slug", async () => {
    const email = `sub12-name-${Date.now()}@example.com`;
    const { id: firmId } = await store.createFirm(env.DB, { name: "Name Edit Firm", adminEmail: `sub12-namefirm-${Date.now()}@example.com` });
    const row = await store.addPending(env.DB, {
      email,
      stateSlug: "georgia",
      deadlineFields: {},
      firstName: null,
      skipConfirmation: true,
      firmId,
      staffLabel: "Firm's Own Label",
    });

    const changed = await store.setSubscriberFirstName(env.DB, store.normalizeEmail(email), "Chosen Name");
    expect(changed).toBe(1);

    const updated = await store.getFirmLicense(env.DB, firmId, row.id);
    expect(updated?.first_name).toBe("Chosen Name");
    expect(updated?.staff_label).toBe("Firm's Own Label"); // untouched
    expect(updated?.state_slug).toBe("georgia"); // untouched
  });
});

// ---------------------------------------------------------------------------
// HTTP-level: POST /subscriber/profile
// ---------------------------------------------------------------------------

describe("POST /subscriber/profile", () => {
  it("requires a session", async () => {
    const resp = await SELF.fetch(`${BASE}/subscriber/profile`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ first_name: "Someone" }),
    });
    expect(resp.status).toBe(401);
  });

  it("sets first_name across the caller's own rows, and clears it back to null with an empty string", async () => {
    const email = `sub12-profile-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const cookie = await subscriberCookie(email);

    const setResp = await SELF.fetch(`${BASE}/subscriber/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ first_name: "  Riley  " }),
    });
    expect(setResp.status).toBe(200);
    expect((await store.listSubscriberLicenses(env.DB, email))[0]?.first_name).toBe("Riley");

    const clearResp = await SELF.fetch(`${BASE}/subscriber/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ first_name: "" }),
    });
    expect(clearResp.status).toBe(200);
    expect((await store.listSubscriberLicenses(env.DB, email))[0]?.first_name).toBeNull();
  });

  it("rejects control characters", async () => {
    const email = `sub12-ctrl-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const cookie = await subscriberCookie(email);
    const resp = await SELF.fetch(`${BASE}/subscriber/profile`, {
      method: "POST",
      headers: { "content-type": "application/json", Cookie: cookie },
      body: JSON.stringify({ first_name: "Bad\x00Name" }),
    });
    expect(resp.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// HTTP-level: POST /subscriber/change-email (request phase)
// ---------------------------------------------------------------------------

async function postChangeEmail(cookie: string | null, newEmail: string, ip: string): Promise<Response> {
  const headers: Record<string, string> = { "content-type": "application/json", "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/subscriber/change-email`, {
    method: "POST",
    headers,
    body: JSON.stringify({ new_email: newEmail }),
  });
}

describe("POST /subscriber/change-email -- request phase", () => {
  it("requires a session", async () => {
    expect((await postChangeEmail(null, "new@example.com", "203.0.113.220")).status).toBe(401);
  });

  it("rejects an invalid email format", async () => {
    const email = `sub12-badfmt-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const resp = await postChangeEmail(await subscriberCookie(email), "not-an-email", "203.0.113.221");
    expect(resp.status).toBe(400);
  });

  it("rejects a request to change to the SAME email already on file (case-insensitive)", async () => {
    const email = `sub12-same-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const resp = await postChangeEmail(await subscriberCookie(email), email.toUpperCase(), "203.0.113.222");
    expect(resp.status).toBe(400);
  });

  it("rejects a request to change to an email ANOTHER subscriber already uses", async () => {
    const taken = `sub12-taken-${Date.now()}@example.com`;
    const requester = `sub12-requester-${Date.now()}@example.com`;
    await seed(taken, "ohio");
    await seed(requester, "texas");
    const resp = await postChangeEmail(await subscriberCookie(requester), taken, "203.0.113.223");
    expect(resp.status).toBe(400);
  });

  it("400s when Origin doesn't match -- same CSRF defense-in-depth as every other mutating route", async () => {
    const email = `sub12-csrf-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const resp = await SELF.fetch(`${BASE}/subscriber/change-email`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cf-connecting-ip": "203.0.113.224",
        Cookie: await subscriberCookie(email),
        Origin: "https://attacker.example",
      },
      body: JSON.stringify({ new_email: "new@example.com" }),
    });
    expect(resp.status).toBe(400);
  });

  it("on success, creates an email_change token carrying the exact requested address, and does NOT change the email yet", async () => {
    const email = `sub12-req-${Date.now()}@example.com`;
    const newEmail = `sub12-reqnew-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const resp = await postChangeEmail(await subscriberCookie(email), newEmail, "203.0.113.225");
    expect(resp.status).toBe(200);

    expect((await store.listSubscriberLicenses(env.DB, email)).length).toBe(1); // unchanged
    const row = await env.DB
      .prepare("SELECT purpose, pending_new_email, used_at FROM subscriber_login_tokens WHERE email_normalized = ?1 AND purpose = 'email_change'")
      .bind(store.normalizeEmail(email))
      .first<{ purpose: string; pending_new_email: string; used_at: string | null }>();
    expect(row?.pending_new_email).toBe(newEmail);
    expect(row?.used_at).toBeNull();
  });

  it("sends TWO emails on success -- a confirm link to the NEW address, a notice to the OLD one, notice first", async () => {
    const oldEmail = `sub12-sendold-${Date.now()}@example.com`;
    const newEmail = `sub12-sendnew-${Date.now()}@example.com`;
    await seed(oldEmail, "ohio");
    const cookie = await subscriberCookie(oldEmail);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 202 }));
    try {
      const worker = (await import("../src/index")).default;
      const resp = await worker.fetch(
        new Request(`${BASE}/subscriber/change-email`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.226", Cookie: cookie },
          body: JSON.stringify({ new_email: newEmail }),
        }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" },
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      );
      expect(resp.status).toBe(200);
      expect(fetchSpy).toHaveBeenCalledTimes(2);
      const recipients = fetchSpy.mock.calls.map((call) => {
        const init = call[1] as RequestInit;
        const body = JSON.parse((init.body as string) ?? "{}");
        return body.personalizations?.[0]?.to?.[0]?.email;
      });
      expect(recipients[0]).toBe(oldEmail);
      expect(recipients[1]).toBe(newEmail);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("AuditLab SEC-3: a FAILED notice send (non-2xx from SendGrid) blocks the confirm from going out at all", async () => {
    const oldEmail = `sub12-sec3-${Date.now()}@example.com`;
    const newEmail = `sub12-sec3new-${Date.now()}@example.com`;
    await seed(oldEmail, "ohio");
    const cookie = await subscriberCookie(oldEmail);

    // The first call (the OLD-address notice, per the "notice first"
    // ordering above) fails; SendGrid returning non-2xx is the ordinary
    // case for a suppressed/bounced address -- exactly the victim's
    // address in a stolen-session attack.
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("", { status: 500 }));
    try {
      const worker = (await import("../src/index")).default;
      const resp = await worker.fetch(
        new Request(`${BASE}/subscriber/change-email`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.229", Cookie: cookie },
          body: JSON.stringify({ new_email: newEmail }),
        }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" },
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      );
      expect(resp.status).toBe(200); // the request itself still succeeds -- token exists, just unconfirmed
      // Only the failed notice attempt -- the confirm to the new address
      // must never have been sent once its warning was dropped.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("a second request invalidates the FIRST request's outstanding token", async () => {
    const email = `sub12-super-${Date.now()}@example.com`;
    const firstNew = `sub12-superfirst-${Date.now()}@example.com`;
    const secondNew = `sub12-supersecond-${Date.now()}@example.com`;
    await seed(email, "ohio");
    const cookie = await subscriberCookie(email);

    expect((await postChangeEmail(cookie, firstNew, "203.0.113.227")).status).toBe(200);
    expect((await postChangeEmail(cookie, secondNew, "203.0.113.228")).status).toBe(200);

    const rows = await env.DB
      .prepare("SELECT pending_new_email, used_at FROM subscriber_login_tokens WHERE email_normalized = ?1 AND purpose = 'email_change' ORDER BY created_at ASC")
      .bind(store.normalizeEmail(email))
      .all<{ pending_new_email: string; used_at: string | null }>();
    expect(rows.results.length).toBe(2);
    expect(rows.results[0]!.used_at).not.toBeNull();
    expect(rows.results[1]!.used_at).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// HTTP-level: apply phase, via /subscriber/login/verify
// ---------------------------------------------------------------------------

describe("POST /subscriber/login/verify -- email_change apply phase (roadmap #12)", () => {
  it("applies the pending email across every row, signs in under the NEW address, and redirects with ?email_changed=1", async () => {
    const oldEmail = `sub12-apply-old-${Date.now()}@example.com`;
    const newEmail = `sub12-apply-new-${Date.now()}@example.com`;
    await seed(oldEmail, "texas");
    await seed(oldEmail, "florida");
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, oldEmail, "email_change", newEmail);

    const resp = await postVerify(rawToken, "203.0.113.229");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`/my/?email_changed=1`);
    expect(resp.headers.get("Set-Cookie")).toContain("dr_sub_session=");

    expect(await store.listSubscriberLicenses(env.DB, oldEmail)).toEqual([]);
    expect((await store.listSubscriberLicenses(env.DB, newEmail)).length).toBe(2);
  });

  it("a conflict at redemption time (address claimed in between) still signs in, but does NOT apply the change", async () => {
    const oldEmail = `sub12-conflict-old-${Date.now()}@example.com`;
    const contested = `sub12-contested-${Date.now()}@example.com`;
    await seed(oldEmail, "texas");
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, oldEmail, "email_change", contested);

    // A different person claims the contested address AFTER the token was
    // issued but BEFORE it's redeemed -- the exact race
    // hasAnySubscriberRowForEmail()'s redemption-time recheck exists for.
    await seed(contested, "nevada");

    const resp = await postVerify(rawToken, "203.0.113.230");
    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe(`/my/?email_change_failed=conflict`);
    expect(resp.headers.get("Set-Cookie")).toContain("dr_sub_session=");

    // Unchanged, not silently overwritten or duplicated.
    expect((await store.listSubscriberLicenses(env.DB, oldEmail)).length).toBe(1);
    expect((await store.listSubscriberLicenses(env.DB, contested)).length).toBe(1);
  });

  it("full request-then-redeem round trip via the real emailed confirm link", async () => {
    const oldEmail = `sub12-flow-old-${Date.now()}@example.com`;
    const newEmail = `sub12-flow-new-${Date.now()}@example.com`;
    await seed(oldEmail, "texas");
    const cookie = await subscriberCookie(oldEmail);

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({}), { status: 202 }));
    let capturedConfirmUrl: string | null = null;
    try {
      const worker = (await import("../src/index")).default;
      const changeResp = await worker.fetch(
        new Request(`${BASE}/subscriber/change-email`, {
          method: "POST",
          headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.231", Cookie: cookie },
          body: JSON.stringify({ new_email: newEmail }),
        }),
        { ...env, SENDGRID_API_KEY: "test-key-not-real" },
        { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext
      );
      expect(changeResp.status).toBe(200);

      const confirmCall = fetchSpy.mock.calls.find((call) => {
        const init = call[1] as RequestInit;
        const body = JSON.parse((init.body as string) ?? "{}");
        return body.personalizations?.[0]?.to?.[0]?.email === newEmail;
      });
      const confirmBody = JSON.parse(((confirmCall?.[1] as RequestInit).body as string) ?? "{}");
      const htmlContent = (confirmBody.content ?? []).find((c: { type: string }) => c.type === "text/html")?.value ?? "";
      const match = /href="([^"]*\/subscriber\/login\/verify\?token=[^"]+)"/.exec(htmlContent);
      expect(match).toBeTruthy();
      capturedConfirmUrl = match![1]!.replace(/&amp;/g, "&");
    } finally {
      fetchSpy.mockRestore();
    }

    const token = new URL(capturedConfirmUrl!).searchParams.get("token")!;
    const redeemResp = await postVerify(token, "203.0.113.232");
    expect(redeemResp.status).toBe(302);
    expect(redeemResp.headers.get("Location")).toBe(`/my/?email_changed=1`);

    expect(await store.listSubscriberLicenses(env.DB, oldEmail)).toEqual([]);
    expect((await store.listSubscriberLicenses(env.DB, newEmail)).length).toBe(1);
  });
});
