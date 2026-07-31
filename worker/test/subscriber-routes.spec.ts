import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import * as store from "../src/store";

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

async function postVerify(token: string, ip: string): Promise<Response> {
  return SELF.fetch(`${BASE}/subscriber/login/verify`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "cf-connecting-ip": ip },
    body: form({ token }),
    redirect: "manual",
  });
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
  });

  it("still issues NO token for an address with no subscriptions", async () => {
    // The response is identical, but the side effect must differ -- otherwise
    // anyone could have a sign-in link mailed to a stranger.
    const unknown = `route-notoken-${Date.now()}@examplefirm.com`;
    const resp = await postLogin({ email: unknown }, "203.0.113.92");
    expect(resp.status).toBe(200);

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
      .bind(unknown.toLowerCase())
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
  });

  it("DOES issue a token when the address really has a subscription", async () => {
    const known = `route-token-${Date.now()}@examplefirm.com`;
    await seedLicense(known, "ohio");
    await postLogin({ email: known }, "203.0.113.93");

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
      .bind(known.toLowerCase())
      .first<{ c: number }>();
    expect(row?.c).toBe(1);
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

    const row = await env.DB
      .prepare("SELECT COUNT(*) AS c FROM subscriber_login_tokens WHERE email_normalized = ?1")
      .bind(email.toLowerCase())
      .first<{ c: number }>();
    expect(row?.c).toBe(0);
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
    expect(get.headers.get("Set-Cookie")).toBeNull();

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
});
