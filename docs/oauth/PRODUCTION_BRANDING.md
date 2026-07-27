# OAuth Production Branding

Shoot Email uses Google only as an upstream identity provider through Auth0.
The authentication flow requests basic identity claims and the three Shoot
Email mailbox scopes. It does not request access to Gmail, Google Contacts,
Google Drive, or other Google application data.

## Public Identity Pages

The Cloudflare-hosted identity site is:

```text
Homepage: https://shoot-email.yoyowza.com
Privacy:  https://shoot-email.yoyowza.com/privacy
Terms:    https://shoot-email.yoyowza.com/terms
Logo:     https://shoot-email.yoyowza.com/assets/shoot-email-logo-512.png
```

Deploy or validate the static Worker with:

```bash
npm run site:build
npm run site:deploy
```

## Google OAuth Application

Use a dedicated Google Cloud project and Web application client:

```text
Application name: Shoot Email
Authorized domain: yoyowza.com
JavaScript origin:
  https://dev-3ltbe81kduigsjty.us.auth0.com
Redirect URI:
  https://dev-3ltbe81kduigsjty.us.auth0.com/login/callback
```

Store its credentials only in local or deployment secrets:

```text
GOOGLE_OAUTH_CLIENT_ID
GOOGLE_OAUTH_CLIENT_SECRET
```

Never commit either value. Replace Auth0's Google development keys with these
credentials while preserving the connection's existing scopes, enabled
clients, and domain-level promotion.

Before changing the Google app from Testing to Production:

1. Verify `yoyowza.com` in Google Search Console.
2. Confirm the homepage, privacy policy, and terms are publicly accessible.
3. Submit the OAuth brand for verification so Google displays the Shoot Email
   name and logo instead of a generic Auth0 identity.
4. Keep the requested Google scopes limited to `openid`, `profile`, and
   `email`.

## Auth0 Tenant Branding

Configure the Auth0 tenant with:

```text
Friendly name: Shoot Email
Logo URL: https://shoot-email.yoyowza.com/assets/shoot-email-logo-512.png
Support URL: https://shoot-email.yoyowza.com
Primary color: #3A8CFF
Page background: #090B10
```

The Shoot Email API should present these consent descriptions:

| Scope | Description |
| --- | --- |
| `mailbox:read` | Read your Shoot Email mailbox |
| `mailbox:send` | Send email from your Shoot Email mailbox |
| `mailbox:acknowledge` | Mark Shoot Email messages as processed |

The Auth0 consent screen is expected in addition to Google authentication.
Google establishes the user's identity; Auth0 asks the user to delegate the
listed mailbox permissions to the MCP client.

## Dynamic Client Registration

Codex uses Dynamic Client Registration and creates `tpc_` Auth0 applications.
Canceled and failed login attempts can leave registrations behind and consume
the tenant's application capacity.

- Run one login attempt at a time.
- Do not delete a DCR client while Codex is logged in with it.
- Monitor application count and failed registration events.
- Remove only confirmed abandoned `tpc_` clients.
- Preserve first-party applications such as `Default App` and
  `Shoot Email MCP API`.
- Keep strict third-party client controls, mandatory PKCE, explicit user
  consent, and mailbox-only default grants.

The exact inspection and cleanup commands are in
[`SAFARI_ACCOUNT_ISOLATION.md`](./SAFARI_ACCOUNT_ISOLATION.md).

## Acceptance Check

After applying the Google and Auth0 settings:

1. Log out of `shoot-email-oauth` in Codex.
2. Activate the intended Safari test profile.
3. Run the scoped login command once.
4. Confirm Google identifies Shoot Email rather than `auth0.com`.
5. Confirm Auth0 displays Shoot Email branding and the three readable mailbox
   permissions.
6. Initialize the mailbox and verify the same Auth0 account recovers its stable
   address.
7. Confirm only one new `tpc_` client was registered for the attempt.

Use [`TESTING.md`](./TESTING.md) for the complete protocol and mailbox checks.

## Verified Result

The 2026-07-26 acceptance run verified:

- The Auth0 tenant displays the Shoot Email friendly name, logo, and colors.
- The Google connection uses the dedicated Shoot Email OAuth client with only
  basic email and profile identity scopes.
- Consent displays readable descriptions for the read, send, and acknowledge
  mailbox scopes.
- A fresh scoped Codex login completed successfully and stored an OAuth
  credential for `shoot-email-oauth`.
- The login created exactly one strict third-party `tpc_` client; no abandoned
  dynamic registrations were present before the test.
- An authenticated fresh Codex process recovered the existing mailbox instead
  of creating a new identity.
