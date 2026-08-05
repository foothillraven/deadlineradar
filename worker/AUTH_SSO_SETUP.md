# SSO setup — what Devin needs to register (AssetLab cannot do this part)

Registering an OAuth app is an **account-creating action on an external platform**, which is
plan-first/Devin-only per AssetLab's guardrails. Nothing here has been invented or guessed: the values
below are what the code expects, and the code will not work until real values exist. **No credential
has been created, and none should be pasted into any file in this repo.**

Both providers are free to register. Neither requires a paid plan or a card.

---

## 1. Google — Google Cloud Console

1. <https://console.cloud.google.com/> → create (or pick) a project.
2. **APIs & Services → OAuth consent screen**
   - User type: **External**
   - App name: `DeadlineRadar`
   - Support email + developer contact: your address
   - Scopes: `openid`, `email`, `profile` — **nothing more.** We only need identity; asking for
     Gmail/Drive scopes would trigger Google's annual security assessment (a real cost and review
     burden) for zero product benefit.
   - While the app is in "Testing", only accounts you add as test users can sign in. Publishing to
     "In production" with only these three non-sensitive scopes does **not** require verification.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   - Application type: **Web application**
   - Authorized redirect URIs — add **both**, exactly (trailing slashes matter):
     ```
     https://deadline-radar.com/api/firm/auth/google/callback
     https://deadlineradar-api-preview.foothillraven.workers.dev/api/firm/auth/google/callback
     ```
4. Copy the **Client ID** and **Client secret**.

## 2. Microsoft — Entra ID (Azure AD) app registration

1. <https://entra.microsoft.com/> → **Applications → App registrations → New registration**
   - Name: `DeadlineRadar`
   - Supported account types: **Accounts in any organizational directory and personal Microsoft
     accounts** (`common`). CPA firms are overwhelmingly M365 tenants, and this also covers a
     solo practitioner on a personal account. Single-tenant would lock out every firm but ours.
   - Redirect URI: platform **Web**, add **both**:
     ```
     https://deadline-radar.com/api/firm/auth/microsoft/callback
     https://deadlineradar-api-preview.foothillraven.workers.dev/api/firm/auth/microsoft/callback
     ```
2. **Certificates & secrets → New client secret.** Copy the **Value** immediately — Azure shows it
   exactly once. Set the longest expiry offered and put the renewal date in a calendar; an expired
   secret breaks SSO login silently for everyone.
3. **API permissions**: the default `User.Read` (delegated) is sufficient. Do not add more.
4. Copy the **Application (client) ID**.

---


> **Note on the `/api` in the preview URI.** Both environments derive the callback from
> `ACTION_BASE_URL`, and preview's value already ends in `/api` (it is the same base every emailed
> action link uses). So preview sends `.../workers.dev/api/firm/auth/...`, matching production's
> `deadline-radar.com/api/firm/auth/...`. The preview Worker strips a leading `/api` before routing,
> so both the bare and prefixed forms reach the handler -- but the URI **registered with the provider**
> must be the one we actually send, which is the `/api` form. This was caught by live verification on
> 2026-07-30 after the bare form was registered first.

## 3. Where the values go — NOT into this repo

Four values total:

| Secret name | From |
|---|---|
| `GOOGLE_OAUTH_CLIENT_ID` | Google step 4 |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Google step 4 |
| `MICROSOFT_OAUTH_CLIENT_ID` | Microsoft step 4 |
| `MICROSOFT_OAUTH_CLIENT_SECRET` | Microsoft step 2 |

Set them as **wrangler secrets** (encrypted at rest, never in git, never in `wrangler.toml`), once per
environment:

```bash
# preview
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID     --config wrangler.preview.toml
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET --config wrangler.preview.toml
npx wrangler secret put MICROSOFT_OAUTH_CLIENT_ID     --config wrangler.preview.toml
npx wrangler secret put MICROSOFT_OAUTH_CLIENT_SECRET --config wrangler.preview.toml

# production (only after preview is verified and Devin gives the production go)
npx wrangler secret put GOOGLE_OAUTH_CLIENT_ID
npx wrangler secret put GOOGLE_OAUTH_CLIENT_SECRET
npx wrangler secret put MICROSOFT_OAUTH_CLIENT_ID
npx wrangler secret put MICROSOFT_OAUTH_CLIENT_SECRET
```

**Client secrets must never be pasted into a chat message, a commit, `wrangler.toml`, or any file under
this repo.** `wrangler secret put` prompts for the value on stdin so it never lands in shell history
either.

---

## 3.5. One more step this doc originally omitted — the static-site build flag

Setting the wrangler secrets makes the Worker's OAuth routes work, but the "Continue with
Google"/"Continue with Microsoft" **button itself is rendered at STATIC-SITE BUILD TIME**, gated on
`DR_SSO_PROVIDERS` (comma-separated provider ids, e.g. `google` or `google,microsoft`) — NOT on
whether the Worker secrets exist.

**This bit AssetLab within the same session it was first documented**: the original default was
empty (deliberately, so a build never advertised a provider the deployed Worker had no credentials
for), which meant every future `python generate.py` had to remember `DR_SSO_PROVIDERS=google` by
hand — and a plain, unrelated regen dropped the button silently a few hours later. Fixed by flipping
`generate.py`'s own default to `"google"` (2026-08-05) now that Google SSO is live and stable, so a
plain `python generate.py` keeps the button by default. `DR_SSO_PROVIDERS` still exists as an
override (e.g. set it to `""` to build WITHOUT the button, or `"google,microsoft"` once Microsoft
ships) — just don't rely on remembering to pass it for a provider that's already live. When
Microsoft ships, give it the same treatment: flip its own default once its secrets are confirmed
live in both environments, rather than extending the manual-flag pattern.

## 4. How the code behaves before these exist

Each provider is independently gated on its own two secrets being present:

- **Both secrets missing → that provider's button is not rendered and its routes 404.** An unconfigured
  provider is invisible rather than a broken button, mirroring how `TURNSTILE_SECRET_KEY` and
  `SENDGRID_API_KEY` already degrade in this codebase.
- Google and Microsoft are gated **separately**, so one can go live before the other.
- Password and magic-link login are entirely unaffected either way.

This means the SSO code can ship to preview and be reviewed *before* any app registration exists — the
registration is only needed to actually click a provider button end-to-end.

---

## 5. Verifying, once configured

Redirect-URI mismatches are the single most common failure and produce a provider-side error page
before our code ever runs. Confirm the URI in each console is **character-identical** to the list above
— scheme, host, path, no trailing slash. Preview and production are separate URIs; registering only
one and testing the other is the usual way this wastes an afternoon.
