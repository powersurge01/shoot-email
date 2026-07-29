# Safari OAuth Account Isolation

Use this runbook when testing Shoot Email OAuth with multiple Google accounts
on a Mac where Safari is the default browser.

## Why Account Switching Is Difficult

The login flow has three independent session layers:

1. Codex stores OAuth access and refresh credentials locally.
2. Auth0 stores a single sign-on session in the browser.
3. Google stores its own identity-provider session in the browser.

`codex mcp logout` clears only the first layer. Auth0's `/v2/logout` clears the
Auth0 session but normally leaves the Google session intact. On the next login,
Google may silently select its most recently active account, making it appear
that Auth0 did not log out.

The Google connection should use Shoot Email's dedicated Google OAuth client.
Auth0 development credentials are suitable only for early testing: they expose
Auth0 branding and do not provide normal production social-login behavior.

## Create Isolated Safari Profiles

Safari 17 and later keeps history, cookies, and website data separate per
profile. Create two profiles:

1. Open **Safari > Settings > Profiles**.
2. Create a profile named `Shoot Email A`.
3. Create a profile named `Shoot Email B`.
4. Open each with **File > New Shoot Email A/B Window**.
5. In Profile A, sign in to Google Account A.
6. In Profile B, sign in to Google Account B.

Do not use a private window as a substitute for these profiles. Do not move an
in-progress Auth0 URL between profiles because Auth0 binds the transaction to
cookies in the browser context where it began.

## Log In With A Specific Profile

Before starting:

1. Close every Auth0 tab in both Safari profiles.
2. Close or minimize the profile that should not receive the login.
3. Make the desired profile window the last active Safari window.
4. Leave that window on an empty page or the Safari start page.

Run the login command exactly once:

```bash
codex mcp login shoot-email-production \
  --scopes mailbox:read,mailbox:send,mailbox:acknowledge
```

Use `shoot-email-oauth` instead only when deliberately testing the staging
Worker. Confirm the selected connection with `get_service_status`: production
must report `environment: production`, `provider.mode: production`, and
`simulated: false`.

Safari opens links from external applications in the most recently used
profile. Complete the entire Google and Auth0 flow in that same profile. Before
accepting consent, verify that both screens identify the intended Google
account.

Do not add `--oauth-resource`. The protected-resource metadata already
advertises the resource URI, and sending it again results in duplicate
`resource` parameters that Auth0 rejects.

## Switch Accounts

To switch from Account A to Account B:

```bash
codex mcp logout shoot-email-production
```

Then:

1. Close Auth0 tabs in Profile A.
2. Open and activate a blank Profile B window.
3. Run the scoped login command once.
4. Complete the entire flow in Profile B.

Repeat the process in the opposite direction to return to Account A.

Avoid relying on these endpoints for routine account switching:

```text
https://dev-3ltbe81kduigsjty.us.auth0.com/v2/logout
https://dev-3ltbe81kduigsjty.us.auth0.com/v2/logout?federated
```

They operate on different session layers and can appear inconsistent when
Google silently authenticates an existing account. Safari profiles provide a
deterministic test boundary without repeatedly clearing unrelated browser data.

## Verify Identity Isolation

After logging in with a profile, open a fresh Codex task and use:

```text
Use shoot-email-oauth to initialize my Shoot Email mailbox. Show its address
and whether it was newly created.
```

For production acceptance, replace `shoot-email-oauth` with
`shoot-email-production`.

Expected behavior:

- Account A always returns Account A's mailbox.
- Account B always returns Account B's mailbox.
- The accounts have different mailbox addresses.
- The first initialization for an account returns `created: true`.
- Later initializations for that account return `created: false`.
- Switching back to Account A recovers its original mailbox.

Never identify or merge users by matching their email addresses. The validated
Auth0 `sub` claim and provider namespace define the external identity.

## Prevent DCR Entity Exhaustion

Each `codex mcp login` attempt can dynamically register a new Auth0 third-party
client with a `tpc_` client ID and a callback URL containing a new localhost
port. Auth0 retains that client even if the browser flow is canceled or fails.
Repeated attempts can exhaust the tenant's application entity limit and cause:

```text
HTTP 403 Forbidden
errorCode: too_many_entities
```

Do not repeatedly rerun the login command after a browser error. First inspect
the registered clients:

```bash
auth0 apps list --number 1000 --json |
  jq -r '.[] | select(.client_id | startswith("tpc_")) |
  [.name, .client_id, (.callbacks[0] // "")] | @tsv'
```

Only delete test DCR clients when Codex is logged out:

```bash
codex mcp list
```

The connection being tested (`shoot-email-production` or
`shoot-email-oauth`) must report `Not logged in`. Deleting the active client
can invalidate a working refresh token and force another registration.

Delete confirmed abandoned clients individually:

```bash
auth0 apps delete <tpc_client_id> --force
```

Preserve first-party applications, including `Default App` and
`Shoot Email MCP API`. After cleanup, perform one login attempt and confirm that
only one new Codex DCR client was created.

## Production Follow-Up

Open DCR allows unauthenticated client registration. Before production:

- Configure Auth0 DCR traffic controls and monitoring.
- Decide how abandoned client registrations will be detected and removed.
- Monitor application entity usage and registration failures.
- Keep strict third-party client controls, PKCE, explicit mailbox scopes, and
  user consent enabled.
- Complete Google OAuth brand verification before moving the Google app from
  testing to production.

Treat DCR entity exhaustion as an availability and abuse risk, not only a test
cleanup inconvenience.
