import { env, SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import * as store from "../src/store";
import { RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT } from "../src/validation";

const BASE = "https://deadline-radar.com";

function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

async function postLogin(fields: Record<string, string>, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/subscriber/login`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ hp_website: "", ...fields }),
  });
}

async function getVerifyPage(token: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/subscriber/login/verify?token=${encodeURIComponent(token)}`, {
    headers: { "cf-connecting-ip": ip },
    redirect: "manual",
  });
}

/** The real two-step flow a human performs: GET the confirm page (which
 * mints the CSRF nonce into both a hidden field and a cookie), then POST the
 * button with both halves. Anything less is the CSRF attack. */
async function postVerify(token: string, ip: string): Promise<Response> {
  const page = await getVerifyPage(token, ip);
  const html = await page.text();
  const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] ?? "";
  const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;
  return SELF.fetch(`${BASE}/subscriber/login/verify`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "cf-connecting-ip": ip,
      Cookie: cookie,
    },
    body: form({ token, action_csrf: nonce }),
    redirect: "manual",
  });
}

/** Polls for a condition that a ctx.waitUntil() task satisfies. The login
 * email send is deliberately off the response path (it is the timing-oracle
 * fix), so a token row is not guaranteed to exist the instant the response
 * returns. */
async function eventually<T>(fn: () => Promise<T>, ok: (v: T) => boolean, tries = 40): Promise<T> {
  let last = await fn();
  for (let i = 0; i < tries && !ok(last); i++) {
    await new Promise((r) => setTimeout(r, 25));
    last = await fn();
  }
  return last;
}

async function loginTokenCount(email: string): Promise<number> {
  const row = await env.DB
    .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
    .bind(email.toLowerCase())
    .first<{ c: number }>();
  return row?.c ?? 0;
}

async function getLicenses(cookie: string | null, ip: string): Promise<Response> {
  const headers: Record<string, string> = { "cf-connecting-ip": ip };
  if (cookie) headers["Cookie"] = cookie;
  return SELF.fetch(`${BASE}/subscriber/licenses`, { headers });
}

function cookieFrom(resp: Response): string {
  const setCookie = resp.headers.get("Set-Cookie") ?? "";
  return setCookie.split(";")[0] as string;
}

async function seedLicense(email: string, stateSlug: string, firmId?: string) {
  return store.addPending(env.DB, {
    email,
    stateSlug,
    deadlineFields: {},
    firstName: null,
    skipConfirmation: true,
    firmId: firmId ?? null,
  });
}

/** Signs a subscriber in end-to-end and returns the session cookie. */
async function signIn(email: string, ip: string): Promise<string> {
  const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
  const resp = await postVerify(rawToken, ip);
  expect(resp.status).toBe(302);
  return cookieFrom(resp);
}

describe("POST /subscriber/login -- must not be an enumeration oracle", () => {
  it("returns the SAME response for a known and an unknown email", async () => {
    const known = `route-known-${Date.now()}@examplefirm.com`;
    await seedLicense(known, "texas");

    const a = await postLogin({ email: known }, "203.0.113.90");
    const b = await postLogin({ email: `route-unknown-${Date.now()}@examplefirm.com` }, "203.0.113.91");

    expect(a.status).toBe(b.status);
    expect(await a.text()).toBe(await b.text());
    // Headers too -- an identical body under a differing header set is still
    // an oracle. (The equal-WORK half of this property is enforced by the
    // send being deferred via ctx.waitUntil; see handleSubscriberLoginRequest.)
    const strip = (r: Response) =>
      [...r.headers].filter(([k]) => k.toLowerCase() !== "date").sort();
    expect(strip(a)).toEqual(strip(b));
  });

  it("still issues NO token for an address with no subscriptions", async () => {
    // The response is identical, but the side effect must differ -- otherwise
    // anyone could have a sign-in link mailed to a stranger.
    const unknown = `route-notoken-${Date.now()}@examplefirm.com`;
    const resp = await postLogin({ email: unknown }, "203.0.113.92");
    expect(resp.status).toBe(200);
    expect(await loginTokenCount(unknown)).toBe(0);
  });

  it("DOES issue a token when the address really has a subscription", async () => {
    // Positive control for the test above: without this pair, "no token was
    // issued" would also pass if the route were issuing tokens to nobody.
    const known = `route-token-${Date.now()}@examplefirm.com`;
    await seedLicense(known, "ohio");
    await postLogin({ email: known }, "203.0.113.93");
    expect(await eventually(() => loginTokenCount(known), (c) => c === 1)).toBe(1);
  });

  // AuditLab DROP-2 (MEDIUM, 2026-08-21): a failed send here used to be
  // completely invisible -- discarded boolean, swallowed throw, no log. The
  // RESPONSE must stay the generic "check your email" copy regardless (the
  // anti-enumeration property above must not regress), but the failure
  // itself must now reach a log line.
  it("DROP-2: a failed send still returns the generic response, but logs the failure", async () => {
    const worker = (await import("../src/index")).default;
    const known = `route-drop2-fail-${Date.now()}@examplefirm.com`;
    await seedLicense(known, "ohio");

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 500 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      const envWithKey = { ...env, SENDGRID_API_KEY: "test-key-not-real" };
      const request = new Request(`${BASE}/subscriber/login`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.94" },
        body: form({ hp_website: "", email: known }),
      });
      const waited: Promise<unknown>[] = [];
      const ctx = { waitUntil: (p: Promise<unknown>) => waited.push(p) } as unknown as ExecutionContext;
      const resp = await worker.fetch(request, envWithKey, ctx);
      await Promise.all(waited);

      expect(resp.status).toBe(200);
      expect((await resp.text()).toLowerCase()).toContain("check your email");

      const logs = logSpy.mock.calls.map((c) => String(c[0]));
      expect(logs.some((l) => l.includes("[subscriber-login-link] send returned false") && l.includes(known))).toBe(true);
    } finally {
      fetchSpy.mockRestore();
      logSpy.mockRestore();
    }
  });

  it("does NOT mail an address whose only row is still unconfirmed", async () => {
    // Anyone can plant a pending_confirmation row for a stranger via the
    // public signup form. Honouring it here would make this route a mail
    // primitive aimed at that stranger.
    const victim = `route-pending-${Date.now()}@examplefirm.com`;
    await store.addPending(env.DB, {
      email: victim,
      stateSlug: "texas",
      deadlineFields: {},
      firstName: null,
    });
    await postLogin({ email: victim }, "203.0.113.120");
    await new Promise((r) => setTimeout(r, 150));
    expect(await loginTokenCount(victim)).toBe(0);
  });

  it("does NOT mail an address that has permanently unsubscribed", async () => {
    const gone = `route-suppressed-${Date.now()}@examplefirm.com`;
    const row = await seedLicense(gone, "texas");
    // stopped_at must be set AND later than confirmed_at -- that ordering is
    // what isPermanentlySuppressed() reads to distinguish "unsubscribed" from
    // "unsubscribed then re-consented".
    await env.DB
      .prepare("UPDATE subscribers SET status = ?1, stop_reason = ?2, stopped_at = ?3 WHERE id = ?4")
      .bind(store.STATUS_STOPPED, "unsubscribed", new Date(Date.now() + 1000).toISOString(), row.id)
      .run();
    expect(await store.isPermanentlySuppressed(env.DB, gone)).toBe(true);

    await postLogin({ email: gone }, "203.0.113.121");
    await new Promise((r) => setTimeout(r, 150));
    expect(await loginTokenCount(gone)).toBe(0);
  });

  it("throttles PER RECIPIENT, so many IPs cannot mail-bomb one person", async () => {
    // Per-IP throttling alone cannot see a distributed attack aimed at one
    // address -- the security review demonstrated 12 sends from 12 IPs.
    const victim = `route-bomb-${Date.now()}@examplefirm.com`;
    await seedLicense(victim, "texas");
    for (let i = 0; i < 10; i++) {
      await postLogin({ email: victim }, `198.51.100.${i + 1}`);
    }
    await new Promise((r) => setTimeout(r, 200));
    const count = await loginTokenCount(victim);
    expect(count).toBeGreaterThan(0);
    expect(count).toBeLessThanOrEqual(RATE_LIMIT_SUBSCRIBER_LOGIN_ACCOUNT.max);
  });

  it("offers the signup path in the copy, so a non-subscriber is not dead-ended", async () => {
    const body = await (await postLogin({ email: `route-copy-${Date.now()}@examplefirm.com` }, "203.0.113.94")).text();
    expect(body).toMatch(/not signed up yet/i);
    expect(body).toContain('href="/"');
  });

  it("swallows a honeypot hit with the same page, issuing nothing", async () => {
    const email = `route-hp-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "iowa");
    const resp = await postLogin({ email, hp_website: "bot" }, "203.0.113.95");
    expect(resp.status).toBe(200);
    await new Promise((r) => setTimeout(r, 150));
    expect(await loginTokenCount(email)).toBe(0);
  });

  it("rejects a malformed email", async () => {
    expect((await postLogin({ email: "not-an-email" }, "203.0.113.96")).status).toBe(400);
  });
});

describe("/subscriber/login/verify -- prefetch-safe, single-use", () => {
  it("GET only RENDERS and does not consume the token", async () => {
    // A mail-security scanner fetching the link must not burn it.
    const email = `route-prefetch-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);

    const get = await getVerifyPage(rawToken, "203.0.113.97");
    expect(get.status).toBe(200);
    // It DOES set the CSRF nonce cookie (that is the point of the render
    // step) -- what it must never set is a session.
    expect(get.headers.get("Set-Cookie") ?? "").not.toContain("dr_sub_session");

    // the human's click still works afterwards
    expect((await postVerify(rawToken, "203.0.113.97")).status).toBe(302);
  });

  it("POST signs in, sets an HttpOnly cookie, and redirects to /my/", async () => {
    const email = `route-signin-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const resp = await postVerify(rawToken, "203.0.113.98");

    expect(resp.status).toBe(302);
    expect(resp.headers.get("Location")).toBe("/my/");
    const setCookie = resp.headers.get("Set-Cookie") ?? "";
    expect(setCookie).toContain("dr_sub_session=");
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("Secure");
  });

  it("sets the SUBSCRIBER cookie, never the firm one", async () => {
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `route-ck-${Date.now()}@examplefirm.com`);
    const setCookie = (await postVerify(rawToken, "203.0.113.99")).headers.get("Set-Cookie") ?? "";
    // Both halves: "no firm cookie" alone would pass if NO cookie were set.
    expect(setCookie).toContain("dr_sub_session=");
    expect(setCookie).not.toContain("dr_firm_session");
  });

  it("refuses a replayed token", async () => {
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, `route-replay-${Date.now()}@examplefirm.com`);
    expect((await postVerify(rawToken, "203.0.113.100")).status).toBe(302);
    expect((await postVerify(rawToken, "203.0.113.100")).status).toBe(400);
  });
});

describe("GET /subscriber/licenses -- scoping", () => {
  it("401s with no cookie", async () => {
    expect((await getLicenses(null, "203.0.113.101")).status).toBe(401);
  });

  it("401s on a garbage cookie", async () => {
    expect((await getLicenses("dr_sub_session=nope", "203.0.113.102")).status).toBe(401);
  });

  it("returns only the signed-in person's licences", async () => {
    const mine = `route-mine-${Date.now()}@examplefirm.com`;
    const theirs = `route-theirs-${Date.now()}@examplefirm.com`;
    await seedLicense(mine, "texas");
    await seedLicense(mine, "california");
    await seedLicense(theirs, "florida");

    const cookie = await signIn(mine, "203.0.113.103");
    const body = (await (await getLicenses(cookie, "203.0.113.103")).json()) as {
      email: string;
      licenses: Array<Record<string, unknown>>;
    };

    expect(body.email).toBe(mine.toLowerCase());
    expect(body.licenses.map((l) => l.state_slug).sort()).toEqual(["california", "texas"]);
    // and nothing at all from the other person
    expect(JSON.stringify(body)).not.toContain("florida");
  });

  it("NEVER serialises a bearer token or the firm's internal columns", async () => {
    const email = `route-leak-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Leak Check LLP",
      adminEmail: `leakadmin-${Date.now()}@examplefirm.com`,
    });
    const row = await seedLicense(email, "georgia", firmId);

    const cookie = await signIn(email, "203.0.113.104");
    const text = await (await getLicenses(cookie, "203.0.113.104")).text();

    // the actual secret VALUES, not just the key names -- a renamed field
    // would still be a leak
    expect(text).not.toContain(row.unsubscribe_token);
    expect(text).not.toContain(row.confirm_token);
    expect(text).not.toContain(row.renewed_token);
    expect(text).not.toContain(firmId);
    expect(text).not.toContain("staff_label");
    expect(text).not.toContain("cooldown_key");
  });

  it("shows firm-managed rows FLAGGED, so the view is complete but read-only", async () => {
    const email = `route-managed-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Managing Firm LLP",
      adminEmail: `managing-${Date.now()}@examplefirm.com`,
    });
    await seedLicense(email, "utah", firmId);
    await seedLicense(email, "nevada");

    const cookie = await signIn(email, "203.0.113.105");
    const body = (await (await getLicenses(cookie, "203.0.113.105")).json()) as {
      licenses: Array<{ state_slug: string; managed_by_firm: boolean }>;
    };

    const utah = body.licenses.find((l) => l.state_slug === "utah");
    const nevada = body.licenses.find((l) => l.state_slug === "nevada");
    expect(utah?.managed_by_firm).toBe(true);
    expect(nevada?.managed_by_firm).toBe(false);
  });

  // CPE-4 (HIGH, 2026-08-21): /my/'s own CPE progress bar was comparing a
  // LIFETIME hours sum against a PER-CYCLE requirement -- the fix reuses the
  // firm dashboard's carryover-aware cycle logic client-side, which needs
  // carryover_hours actually reaching this endpoint's response. This is the
  // one new field the fix depends on; a regression here would silently
  // revert /my/ back to an unbounded lifetime figure with no error anywhere.
  it("carries carryover_hours through for firm-managed rows (CPE-4)", async () => {
    const email = `route-carryover-${Date.now()}@examplefirm.com`;
    const { id: firmId } = await store.createFirm(env.DB, {
      name: "Carryover Route LLP",
      adminEmail: `carryoverroute-${Date.now()}@examplefirm.com`,
    });
    const row = await seedLicense(email, "georgia", firmId);
    const { rawSessionToken } = await store.createSession(env.DB, firmId);
    const firmCookie = `dr_firm_session=${rawSessionToken}`;
    const patchResp = await SELF.fetch(`${BASE}/firm/licenses/${row.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", Cookie: firmCookie },
      body: JSON.stringify({ carryover_hours: "8.5" }),
    });
    expect(patchResp.status).toBe(200);

    const cookie = await signIn(email, "203.0.113.107");
    const body = (await (await getLicenses(cookie, "203.0.113.107")).json()) as {
      licenses: Array<{ state_slug: string; carryover_hours: number | null }>;
    };

    const georgia = body.licenses.find((l) => l.state_slug === "georgia");
    expect(georgia?.carryover_hours).toBe(8.5);
  });

  it("sorts soonest deadline first, undated last", async () => {
    const email = `route-sort-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "texas");
    await seedLicense(email, "california");

    const cookie = await signIn(email, "203.0.113.106");
    const body = (await (await getLicenses(cookie, "203.0.113.106")).json()) as {
      licenses: Array<{ next_deadline: string | null }>;
    };
    const dated = body.licenses.filter((l) => l.next_deadline !== null).map((l) => l.next_deadline as string);
    expect([...dated].sort()).toEqual(dated);
    // any undated rows must come after every dated one
    const firstNull = body.licenses.findIndex((l) => l.next_deadline === null);
    if (firstNull !== -1) {
      expect(body.licenses.slice(firstNull).every((l) => l.next_deadline === null)).toBe(true);
    }
  });
});

describe("cross-principal isolation at the HTTP layer", () => {
  it("a subscriber cookie cannot read the FIRM roster", async () => {
    // The single most important test here: the free tier must not be a way
    // into paid, multi-tenant data.
    const email = `route-cross-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "texas");
    const cookie = await signIn(email, "203.0.113.107");

    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.107" },
    });
    expect(resp.status).toBe(401);
  });

  it("a subscriber cookie value REPLAYED under the firm cookie name still fails", async () => {
    // Guards the case where the isolation rested only on the cookie NAME.
    const email = `route-cross2-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "texas");
    const raw = (await signIn(email, "203.0.113.108")).split("=").slice(1).join("=");

    const resp = await SELF.fetch(`${BASE}/firm/licenses`, {
      headers: { Cookie: `dr_firm_session=${raw}`, "cf-connecting-ip": "203.0.113.108" },
    });
    expect(resp.status).toBe(401);
  });

  it("a FIRM session cannot read /subscriber/licenses", async () => {
    const { id } = await store.createFirm(env.DB, {
      name: "Reverse Cross LLP",
      adminEmail: `revcross-${Date.now()}@examplefirm.com`,
    });
    const { rawSessionToken } = await store.createSession(env.DB, id);
    const resp = await getLicenses(`dr_sub_session=${rawSessionToken}`, "203.0.113.109");
    expect(resp.status).toBe(401);
  });
});

describe("POST /subscriber/logout", () => {
  it("kills the session so the cookie stops working", async () => {
    const email = `route-logout-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "texas");
    const cookie = await signIn(email, "203.0.113.110");
    expect((await getLicenses(cookie, "203.0.113.110")).status).toBe(200);

    const out = await SELF.fetch(`${BASE}/subscriber/logout`, {
      method: "POST",
      headers: { Cookie: cookie, "cf-connecting-ip": "203.0.113.110" },
      redirect: "manual",
    });
    expect(out.status).toBe(302);
    expect(out.headers.get("Set-Cookie")).toContain("Max-Age=0");

    expect((await getLicenses(cookie, "203.0.113.110")).status).toBe(401);
  });

  it("succeeds with no cookie at all rather than erroring", async () => {
    const resp = await SELF.fetch(`${BASE}/subscriber/logout`, {
      method: "POST",
      headers: { "cf-connecting-ip": "203.0.113.111" },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
  });

  // AuditLab cookie/CSRF posture re-verify (2026-08-21): same consistency
  // fix as the firm-side logout route -- originAllowed() now guards this
  // route too, matching every other authenticated state-changing handler.
  it("SEC (logout CSRF consistency): rejected when the Origin header doesn't match any allowed origin, and the session survives", async () => {
    const email = `sublogoutcsrf-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email.toLowerCase());

    const resp = await SELF.fetch(`${BASE}/subscriber/logout`, {
      method: "POST",
      headers: { Cookie: `dr_sub_session=${rawSessionToken}`, "cf-connecting-ip": "203.0.113.112", Origin: "https://attacker.example" },
      redirect: "manual",
    });
    expect(resp.status).toBe(400);

    const after = await store.verifySubscriberSession(env.DB, rawSessionToken);
    expect(after).not.toBeNull(); // NOT logged out -- the forged request was refused, not honored
  });

  it("SEC (logout CSRF consistency): still succeeds with a real, matching Origin header", async () => {
    const email = `sublogoutorigin-${Date.now()}@examplefirm.com`;
    const { rawSessionToken } = await store.createSubscriberSession(env.DB, email.toLowerCase());

    const resp = await SELF.fetch(`${BASE}/subscriber/logout`, {
      method: "POST",
      headers: { Cookie: `dr_sub_session=${rawSessionToken}`, "cf-connecting-ip": "203.0.113.113", Origin: "https://deadline-radar.com" },
      redirect: "manual",
    });
    expect(resp.status).toBe(302);
    const after = await store.verifySubscriberSession(env.DB, rawSessionToken);
    expect(after).toBeNull();
  });
});

describe("login CSRF / session fixation -- the attack the review demonstrated", () => {
  // An attacker requests a link for THEIR OWN address, never clicks it, and
  // auto-submits it from their own site. Without the nonce the victim's
  // browser silently becomes signed in AS THE ATTACKER, and is shown the
  // attacker's renewal dates on our domain.
  it("refuses a bare cross-site POST carrying a valid token and no nonce", async () => {
    const attacker = `csrf-attacker-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, attacker);

    const resp = await SELF.fetch(`${BASE}/subscriber/login/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.130",
        Origin: "https://evil.example",
      },
      body: form({ token: rawToken }),
      redirect: "manual",
    });

    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses the token in the QUERY STRING, which needs no body at all", async () => {
    const attacker = `csrf-query-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, attacker);

    const resp = await SELF.fetch(
      `${BASE}/subscriber/login/verify?token=${encodeURIComponent(rawToken)}`,
      {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.131", Origin: "https://evil.example" },
        redirect: "manual",
      }
    );

    expect(resp.status).toBe(400);
    expect(resp.headers.get("Set-Cookie")).toBeNull();
  });

  it("refuses a nonce with no matching cookie, and a cookie with no nonce", async () => {
    const email = `csrf-halves-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const page = await getVerifyPage(rawToken, "203.0.113.132");
    const html = await page.text();
    const nonce = /name="action_csrf" value="([^"]+)"/.exec(html)?.[1] as string;
    const cookie = (page.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    // form half only
    const noCookie = await SELF.fetch(`${BASE}/subscriber/login/verify`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.132" },
      body: form({ token: rawToken, action_csrf: nonce }),
      redirect: "manual",
    });
    expect(noCookie.status).toBe(400);

    // cookie half only
    const noField = await SELF.fetch(`${BASE}/subscriber/login/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.132",
        Cookie: cookie,
      },
      body: form({ token: rawToken }),
      redirect: "manual",
    });
    expect(noField.status).toBe(400);

    // and the honest flow still works afterwards -- the failed attempts must
    // not have burned the victim's token
    expect((await postVerify(rawToken, "203.0.113.132")).status).toBe(302);
  });

  it("refuses a nonce from a DIFFERENT handshake", async () => {
    const email = `csrf-mixed-${Date.now()}@examplefirm.com`;
    const { rawToken } = await store.createSubscriberLoginToken(env.DB, email);
    const mine = await getVerifyPage(rawToken, "203.0.113.133");
    const myNonce = /name="action_csrf" value="([^"]+)"/.exec(await mine.text())?.[1] as string;

    const other = await store.createSubscriberLoginToken(env.DB, `csrf-other-${Date.now()}@examplefirm.com`);
    const theirs = await getVerifyPage(other.rawToken, "203.0.113.134");
    const theirCookie = (theirs.headers.get("Set-Cookie") ?? "").split(";")[0] as string;

    const resp = await SELF.fetch(`${BASE}/subscriber/login/verify`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "cf-connecting-ip": "203.0.113.133",
        Cookie: theirCookie,
      },
      body: form({ token: rawToken, action_csrf: myNonce }),
      redirect: "manual",
    });
    expect(resp.status).toBe(400);
  });

  it("does NOT require a nonce for one-click unsubscribe, which mail clients POST directly", async () => {
    // RFC 8058 List-Unsubscribe is a POST from the MAIL CLIENT, which never
    // renders our page and so can never carry a nonce. Requiring one there
    // would break a CAN-SPAM obligation.
    const email = `csrf-unsub-${Date.now()}@examplefirm.com`;
    const row = await seedLicense(email, "texas");
    const resp = await SELF.fetch(
      `${BASE}/unsubscribe?token=${encodeURIComponent(row.unsubscribe_token)}`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": "203.0.113.135" },
        body: "List-Unsubscribe=One-Click",
      }
    );
    expect(resp.status).toBe(200);
    const after = await env.DB
      .prepare("SELECT status FROM subscribers WHERE id = ?1")
      .bind(row.id)
      .first<{ status: string }>();
    expect(after?.status).toBe(store.STATUS_STOPPED);
  });
});

describe("session rotation", () => {
  it("signing in again revokes the previous session -- the only sign-out-everywhere this tier has", async () => {
    const email = `rotate-${Date.now()}@examplefirm.com`;
    await seedLicense(email, "texas");

    const older = await signIn(email, "203.0.113.140");
    expect((await getLicenses(older, "203.0.113.140")).status).toBe(200);

    const newer = await signIn(email, "203.0.113.141");
    expect((await getLicenses(newer, "203.0.113.141")).status).toBe(200);
    // the link opened on the hotel PC is now dead
    expect((await getLicenses(older, "203.0.113.140")).status).toBe(401);
  });

  it("does not touch ANOTHER person's session", async () => {
    const a = `rotate-a-${Date.now()}@examplefirm.com`;
    const b = `rotate-b-${Date.now()}@examplefirm.com`;
    await seedLicense(a, "texas");
    await seedLicense(b, "ohio");

    const aCookie = await signIn(a, "203.0.113.142");
    await signIn(b, "203.0.113.143");
    expect((await getLicenses(aCookie, "203.0.113.142")).status).toBe(200);
  });
});
