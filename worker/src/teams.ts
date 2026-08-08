/**
 * Roadmap #21 (2026-08-08): Microsoft Teams integration for deadline
 * alerts. Unlike Slack (slack.ts), there is no OAuth flow -- Office 365
 * Connectors (the old one-click "Incoming Webhook" add flow) are retired
 * as of 2026, and the current mechanism (the Workflows app, backed by
 * Power Automate) requires a firm admin to manually create a Workflow
 * inside their own Teams client (channel -> More options -> Workflows ->
 * "Send webhook alerts to a channel" template) and paste the resulting
 * webhook URL into DeadlineRadar themselves. Confirmed against Microsoft's
 * own current docs (learn.microsoft.com/.../webhooks-and-connectors/how-to/
 * add-incoming-webhook, checked 2026-08-08) -- the minimal payload is
 * plain JSON, no Adaptive Card envelope required:
 *   POST <WEBHOOK_URL>
 *   Content-Type: application/json
 *   {"text": "..."}
 */

/**
 * SSRF guard. Slack's webhook URL comes from Slack's own OAuth token-
 * exchange response (server-to-server, trusted); this one is raw,
 * unvalidated firm-admin input pasted into a text field -- without this
 * check, the worker would POST to whatever host an admin (or a compromised
 * admin session) types in, including a private/internal address. Requires
 * https:// AND a hostname ending in a known Microsoft webhook domain.
 * `.logic.azure.com` is included defensively in case a Power-Automate-
 * backed Workflow URL ever differs from the `.webhook.office.com` pattern
 * Microsoft's own current Workflows code samples still show.
 */
const ALLOWED_TEAMS_WEBHOOK_HOST_SUFFIXES = [".webhook.office.com", ".logic.azure.com"];

export function isTeamsWebhookUrl(v: string): boolean {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  const host = u.hostname.toLowerCase();
  return ALLOWED_TEAMS_WEBHOOK_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix));
}

const SEND_TIMEOUT_MS = 10_000;

/** Posts one message to a firm's Teams webhook. Identical
 * AbortController/timeout/2xx-only/never-throws contract to slack.ts's
 * sendToSlack(), so it drops into runTeamsAlertPass()'s injectable `send`
 * option the same way. */
export async function sendToTeams(webhookUrl: string, text: string): Promise<boolean> {
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
