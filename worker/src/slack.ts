/**
 * Roadmap #20 (2026-08-08): Slack integration for deadline alerts.
 *
 * "Add to Slack" OAuth v2 (incoming-webhook scope) so a firm admin can
 * connect a channel; DeadlineRadar posts one daily digest per firm of
 * newly-due reminder thresholds (scheduler.ts's runSlackAlertPass()) --
 * never one message per threshold, which would flood a shared channel.
 *
 * Deliberately reuses store.createOauthState()/consumeOauthState() (already
 * provider-agnostic) for CSRF/replay protection rather than inventing a
 * second state mechanism -- see index.ts's connect/callback handlers for how
 * that ties into an already-authenticated firm session (this is an
 * "add an integration to my account" flow, not an identity sign-in flow like
 * oauth.ts's Google SSO, so no ID token, no issuer/claims validation here).
 */

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_TOKEN_URL = "https://slack.com/api/oauth.v2.access";
const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";
const SEND_TIMEOUT_MS = 10_000;

export function buildSlackAuthorizeUrl(clientId: string, redirectUri: string, state: string): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", "incoming-webhook");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return url.toString();
}

export interface SlackTokenResult {
  ok: true;
  accessToken: string;
  webhookUrl: string;
  channelName: string;
  teamName: string;
}

export interface SlackTokenError {
  ok: false;
  error: string;
}

/**
 * Exchanges an authorization code for a bot access token + incoming webhook.
 * Never throws -- every failure (network error, non-2xx, malformed/incomplete
 * response body) becomes a discriminated `{ok: false}` so the caller can
 * degrade to an honest "connection failed, try again" rather than an
 * unhandled exception mid-OAuth-callback.
 */
export async function exchangeSlackCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<SlackTokenResult | SlackTokenError> {
  const body = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: controller.signal,
    });
  } catch {
    return { ok: false, error: "Couldn't reach Slack. Please try again." };
  } finally {
    clearTimeout(timeoutId);
  }
  if (!(resp.status >= 200 && resp.status < 300)) {
    return { ok: false, error: "Slack returned an unexpected response. Please try again." };
  }

  let data: unknown;
  try {
    data = await resp.json();
  } catch {
    return { ok: false, error: "Slack returned an unreadable response. Please try again." };
  }
  const d = data as Record<string, unknown>;
  if (d.ok !== true) {
    return { ok: false, error: typeof d.error === "string" ? d.error : "Slack declined the connection." };
  }
  const accessToken = typeof d.access_token === "string" ? d.access_token : null;
  const webhook = d.incoming_webhook as Record<string, unknown> | undefined;
  const webhookUrl = webhook && typeof webhook.url === "string" ? webhook.url : null;
  const channelName = webhook && typeof webhook.channel === "string" ? webhook.channel : null;
  const team = d.team as Record<string, unknown> | undefined;
  const teamName = team && typeof team.name === "string" ? team.name : null;
  if (!accessToken || !webhookUrl || !channelName || !teamName) {
    return { ok: false, error: "Slack's response was missing something we needed. Please try again." };
  }
  return { ok: true, accessToken, webhookUrl, channelName, teamName };
}

/**
 * Posts one message to a firm's connected incoming webhook. Mirrors
 * sendViaSendGrid()'s exact contract (sender.ts) -- AbortController +
 * SEND_TIMEOUT_MS timeout, 2xx-only success, never throws -- so it drops
 * into runSlackAlertPass()'s injectable `send` option the same way every
 * other pass's `send` does.
 */
export async function sendToSlack(webhookUrl: string, text: string): Promise<boolean> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    const resp = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: controller.signal,
    });
    return resp.status >= 200 && resp.status < 300;
  } catch {
    return false;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Best-effort token revocation on disconnect. Swallows every failure --
 * disconnect must succeed locally (clearing our own stored webhook/token)
 * even if Slack's revoke call fails or times out; an orphaned-but-revoked-
 * on-our-side integration is a much smaller problem than a disconnect
 * button that doesn't work.
 */
export async function revokeSlackToken(accessToken: string): Promise<void> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  try {
    await fetch(SLACK_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });
  } catch {
    // Best-effort -- see docstring above.
  } finally {
    clearTimeout(timeoutId);
  }
}
