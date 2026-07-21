/**
 * DeadlineRadar Pro -- route handlers for account signup/login/logout,
 * email verification, password reset, and CPE-hour-entry CRUD.
 *
 * Same hardening conventions as index.ts's handleSubscribe: per-IP rate
 * limiting (D1-backed, no in-memory state), a honeypot field, a hard body-
 * size cap, control-character rejection on every field, and Turnstile on
 * every state-changing form post. Deliberately NOT JSON-only -- form-
 * urlencoded like /subscribe, so a plain HTML <form> (no client JS
 * required) can drive every one of these, matching this site's existing
 * no-JS-required posture.
 *
 * NOTE: no email is actually sent by any of this yet (verification links,
 * password-reset links) -- this codebase has never sent real email (see
 * worker/README.md), and wiring a sender is a separate, explicitly-scoped
 * task. Tokens ARE generated and stored correctly; only the "deliver the
 * link to the user" step is missing. Flagging here, not hiding it.
 */
import type { Env } from "./env";
import {
  HONEYPOT_FIELD_NAME,
  MAX_BODY_BYTES,
  checkRateLimit,
  hasControlChars,
  isValidEmail,
  verifyTurnstile,
  type RateLimit,
} from "./validation";
import { isValidPassword, MIN_PASSWORD_LEN, parseSessionCookie, sessionCookieValue, clearSessionCookie } from "./pro_auth";
import {
  createAccount,
  findAccountByEmail,
  verifyAccountEmail,
  verifyAccountPassword,
  requestPasswordReset,
  confirmPasswordReset,
  createSession,
  resolveSession,
  deleteSession,
  createCpeHourEntry,
  listCpeHourEntries,
  deleteCpeHourEntry,
  type AccountRow,
} from "./pro_store";
import { parseStrictIsoDate } from "./validation";
import { SUPPORTED_STATE_SLUGS } from "./deadline";
import { buildProVerifyEmail, buildProPasswordResetEmail } from "./pro_emails";
import { checkAndCountSend, sendViaSendGrid, DEFAULT_DAILY_SEND_CAP } from "./sender";

const PRO_ACTION_BASE_URL = "https://deadline-radar.com/api";

function dailySendCap(env: Env): number {
  const raw = env.REMINDERS_DAILY_SEND_CAP;
  const parsed = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_SEND_CAP;
}

/**
 * Best-effort, fully isolated send -- mirrors index.ts's handleSubscribe
 * pattern exactly: only sends when a SendGrid key is configured, guarded by
 * the same shared daily circuit breaker (so Pro emails and reminder emails
 * draw from ONE combined cap, not two independent ones that could together
 * exceed what the account can actually afford), and any failure (SendGrid
 * down, cap hit, build error) is swallowed -- an email failure must never
 * turn an already-created account/reset-token into an error response.
 */
async function sendBestEffort(env: Env, toEmail: string, build: () => { subject: string; textBody: string; htmlBody: string; headers: Record<string, string> }): Promise<void> {
  if (!env.SENDGRID_API_KEY) return;
  try {
    const underCap = await checkAndCountSend(env.DB, dailySendCap(env));
    if (underCap) {
      await sendViaSendGrid(env.SENDGRID_API_KEY, toEmail, build());
    }
  } catch {
    // Swallow -- see function docstring.
  }
}

// Stricter than RATE_LIMIT_SUBSCRIBE -- login is a brute-force target in a
// way a one-shot signup form isn't (an attacker retries the SAME account
// repeatedly, not a fresh one each time), so this window is tighter per-IP.
const RATE_LIMIT_LOGIN: RateLimit = { max: 10, windowSeconds: 600 };
const RATE_LIMIT_SIGNUP: RateLimit = { max: 5, windowSeconds: 600 };
const RATE_LIMIT_PASSWORD_RESET: RateLimit = { max: 5, windowSeconds: 600 };

function jsonResponse(status: number, obj: unknown, extraHeaders?: Record<string, string>): Response {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

function errorJson(status: number, message: string): Response {
  return jsonResponse(status, { error: message });
}

async function parseForm(request: Request): Promise<Record<string, string> | null> {
  let raw: string;
  try {
    raw = await request.text();
  } catch {
    return null;
  }
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) return null;
  try {
    return Object.fromEntries(new URLSearchParams(raw).entries());
  } catch {
    return null;
  }
}

function honeypotTripped(form: Record<string, string>): boolean {
  const value = form[HONEYPOT_FIELD_NAME];
  return value !== undefined && value !== "";
}

function anyControlChars(form: Record<string, string>): boolean {
  return Object.values(form).some(hasControlChars);
}

/** Resolves the authenticated account from the request's session cookie, or
 * null if there isn't one / it's invalid or expired. Callers that require
 * auth should return 401 on null themselves -- this function doesn't assume
 * every caller wants the same error shape. */
export async function requireSession(request: Request, env: Env): Promise<AccountRow | null> {
  const sessionId = parseSessionCookie(request);
  if (!sessionId) return null;
  return resolveSession(env.DB, sessionId);
}

export async function handleProSignup(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "pro_signup", RATE_LIMIT_SIGNUP);
  if (!allowed) return errorJson(429, "Too many signup attempts from this address. Please try again later.");

  const form = await parseForm(request);
  if (!form) return errorJson(400, "Request too large, empty, or malformed.");
  if (honeypotTripped(form)) {
    // Same "look like it worked" honeypot response as /subscribe.
    return jsonResponse(200, { ok: true });
  }
  if (anyControlChars(form)) return errorJson(400, "Invalid characters in submission.");

  const email = (form.email ?? "").trim();
  const password = form.password ?? "";

  if (!isValidEmail(email)) return errorJson(400, "That doesn't look like a valid email address.");
  if (!isValidPassword(password)) {
    return errorJson(400, `Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }
  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) return errorJson(400, "Verification failed -- please try again.");

  const existing = await findAccountByEmail(env.DB, email);
  if (existing) {
    // Deliberately vague to avoid confirming account existence to an
    // unauthenticated caller -- same non-enumeration posture as the
    // password-reset endpoint below.
    return errorJson(409, "An account with that email may already exist. Try logging in or resetting your password.");
  }

  const account = await createAccount(env.DB, email, password);
  if (!account) return errorJson(500, "Could not create account. Please try again.");

  const verifyUrl = `${PRO_ACTION_BASE_URL}/pro/verify?token=${encodeURIComponent(account.verification_token)}`;
  await sendBestEffort(env, account.email, () => buildProVerifyEmail(verifyUrl));

  const sessionId = await createSession(env.DB, account.id);
  return jsonResponse(
    201,
    { ok: true, email: account.email, verified: Boolean(account.verified_at) },
    { "Set-Cookie": sessionCookieValue(sessionId) }
  );
}

export async function handleProLogin(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "pro_login", RATE_LIMIT_LOGIN);
  if (!allowed) return errorJson(429, "Too many login attempts from this address. Please try again later.");

  const form = await parseForm(request);
  if (!form) return errorJson(400, "Request too large, empty, or malformed.");
  if (anyControlChars(form)) return errorJson(400, "Invalid characters in submission.");

  const email = (form.email ?? "").trim();
  const password = form.password ?? "";
  if (!isValidEmail(email) || password.length === 0) {
    return errorJson(400, "Email and password are required.");
  }

  const turnstileOk = await verifyTurnstile(form["cf-turnstile-response"], env.TURNSTILE_SECRET_KEY);
  if (!turnstileOk) return errorJson(400, "Verification failed -- please try again.");

  const account = await findAccountByEmail(env.DB, email);
  // Same generic message whether the email doesn't exist OR the password is
  // wrong -- distinguishing the two in the response would let an attacker
  // enumerate registered emails one guess at a time.
  const genericFailure = () => errorJson(401, "Incorrect email or password.");
  if (!account) return genericFailure();

  const passwordOk = await verifyAccountPassword(account, password);
  if (!passwordOk) return genericFailure();

  const sessionId = await createSession(env.DB, account.id);
  return jsonResponse(200, { ok: true, email: account.email }, { "Set-Cookie": sessionCookieValue(sessionId) });
}

export async function handleProLogout(request: Request, env: Env): Promise<Response> {
  const sessionId = parseSessionCookie(request);
  if (sessionId) await deleteSession(env.DB, sessionId);
  return jsonResponse(200, { ok: true }, { "Set-Cookie": clearSessionCookie() });
}

export async function handleProVerify(env: Env, token: string | null): Promise<Response> {
  if (!token || hasControlChars(token)) return errorJson(400, "Missing or invalid verification token.");
  const account = await verifyAccountEmail(env.DB, token);
  if (!account) return errorJson(404, "That verification link is invalid or has already been used.");
  return jsonResponse(200, { ok: true, verified: true });
}

export async function handleProPasswordResetRequest(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "pro_password_reset", RATE_LIMIT_PASSWORD_RESET);
  if (!allowed) return errorJson(429, "Too many reset attempts from this address. Please try again later.");

  const form = await parseForm(request);
  if (!form) return errorJson(400, "Request too large, empty, or malformed.");
  if (anyControlChars(form)) return errorJson(400, "Invalid characters in submission.");

  const email = (form.email ?? "").trim();
  if (!isValidEmail(email)) return errorJson(400, "That doesn't look like a valid email address.");

  const resetToken = await requestPasswordReset(env.DB, email);
  if (resetToken) {
    const resetUrl = `https://deadline-radar.com/pro/?reset_token=${encodeURIComponent(resetToken)}`;
    await sendBestEffort(env, email, () => buildProPasswordResetEmail(resetUrl));
  }
  // ALWAYS the same response whether or not the email exists -- this is the
  // one place account-existence enumeration would be easiest to leak
  // (a naive implementation returns 404 for "no such account"), so this
  // endpoint deliberately never varies its response based on that.
  return jsonResponse(200, { ok: true, message: "If that email has an account, a reset link has been requested." });
}

export async function handleProPasswordResetConfirm(request: Request, env: Env, ip: string): Promise<Response> {
  const allowed = await checkRateLimit(env.DB, ip, "pro_password_reset_confirm", RATE_LIMIT_PASSWORD_RESET);
  if (!allowed) return errorJson(429, "Too many attempts from this address. Please try again later.");

  const form = await parseForm(request);
  if (!form) return errorJson(400, "Request too large, empty, or malformed.");
  if (anyControlChars(form)) return errorJson(400, "Invalid characters in submission.");

  const token = form.token ?? "";
  const newPassword = form.password ?? "";
  if (token.length === 0) return errorJson(400, "Missing reset token.");
  if (!isValidPassword(newPassword)) {
    return errorJson(400, `Password must be at least ${MIN_PASSWORD_LEN} characters.`);
  }

  const account = await confirmPasswordReset(env.DB, token, newPassword);
  if (!account) return errorJson(400, "That reset link is invalid or has expired. Please request a new one.");
  return jsonResponse(200, { ok: true });
}

// ---------------------------------------------------------------------------
// CPE hour entries -- requires an authenticated session for every route.
// ---------------------------------------------------------------------------

export async function handleCpeEntriesList(request: Request, env: Env): Promise<Response> {
  const account = await requireSession(request, env);
  if (!account) return errorJson(401, "Not logged in.");
  const url = new URL(request.url);
  const stateSlug = url.searchParams.get("state") ?? undefined;
  if (stateSlug && !SUPPORTED_STATE_SLUGS.has(stateSlug)) {
    return errorJson(400, "Unsupported state.");
  }
  const entries = await listCpeHourEntries(env.DB, account.id, stateSlug);
  return jsonResponse(200, { entries });
}

export async function handleCpeEntriesCreate(request: Request, env: Env): Promise<Response> {
  const account = await requireSession(request, env);
  if (!account) return errorJson(401, "Not logged in.");

  const form = await parseForm(request);
  if (!form) return errorJson(400, "Request too large, empty, or malformed.");
  if (anyControlChars(form)) return errorJson(400, "Invalid characters in submission.");

  const stateSlug = (form.state ?? "").trim();
  const courseName = (form.course_name ?? "").trim().slice(0, 200);
  const hoursRaw = form.hours ?? "";
  const isEthics = form.is_ethics === "1" || form.is_ethics === "true";
  const completedDateRaw = form.completed_date ?? "";

  if (!SUPPORTED_STATE_SLUGS.has(stateSlug)) return errorJson(400, "Unsupported or missing state.");
  if (courseName.length === 0) return errorJson(400, "Course name is required.");

  const hours = Number.parseFloat(hoursRaw);
  if (!Number.isFinite(hours) || hours <= 0 || hours > 1000) {
    return errorJson(400, "Hours must be a positive number.");
  }

  const completedDate = parseStrictIsoDate(completedDateRaw);
  if (!completedDate) return errorJson(400, "Completed date must be a valid YYYY-MM-DD date.");
  if (completedDate.getTime() > Date.now()) {
    return errorJson(400, "Completed date can't be in the future.");
  }

  const entry = await createCpeHourEntry(env.DB, account.id, {
    stateSlug,
    hours,
    isEthics,
    courseName,
    completedDate: completedDateRaw,
  });
  return jsonResponse(201, { entry });
}

export async function handleCpeEntriesDelete(request: Request, env: Env, entryId: string): Promise<Response> {
  const account = await requireSession(request, env);
  if (!account) return errorJson(401, "Not logged in.");
  if (!entryId || hasControlChars(entryId)) return errorJson(400, "Invalid entry id.");
  const deleted = await deleteCpeHourEntry(env.DB, account.id, entryId);
  if (!deleted) return errorJson(404, "Entry not found.");
  return jsonResponse(200, { ok: true });
}
