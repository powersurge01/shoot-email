# Auth0 OAuth Staging Test

## Endpoint

```text
https://shoot-email-auth-staging.powersurge.workers.dev/mcp
```

This is separate from the preserved hackathon judge endpoint. It uses the mock
mail provider and keeps real outbound delivery disabled.

## Auth0 Configuration

The staging tenant uses:

- Strict Dynamic Client Registration for public MCP clients.
- Authorization Code with mandatory PKCE and refresh-token support.
- A default user-delegated third-party grant limited to `mailbox:read`,
  `mailbox:send`, and `mailbox:acknowledge` for the Shoot Email API.
- Google as the current domain-level login connection.
- The `compatibility` resource-parameter profile.
- One-hour RS256 access tokens validated through Auth0 JWKS.

DCR permits unauthenticated client registration, but registered clients are
third-party clients with Auth0's strict controls. Users must still authenticate
and consent, and the default grant applies only to the three Shoot Email scopes.

## Connect Codex

Add the server without an explicit `--oauth-resource`. The server advertises its
resource URI through protected-resource metadata; specifying it again can cause
some Auth0 versions to reject the repeated `resource` parameter.

```bash
codex mcp add shoot-email-oauth \
  --url https://shoot-email-auth-staging.powersurge.workers.dev/mcp
```

The current Codex build may start an automatic flow with Auth0's generic profile
scopes instead of the resource scopes. Cancel that browser/terminal attempt and
run the explicit scoped login command:

```bash
codex mcp login shoot-email-oauth \
  --scopes mailbox:read,mailbox:send,mailbox:acknowledge
```

Complete Google login and consent in the browser. Confirm the stored connection:

```bash
codex mcp list
```

The `shoot-email-oauth` row should report `Auth: OAuth`.

Do not add `--oauth-resource` to either command. Protected-resource discovery
already supplies it, and providing it again produces two `resource` parameters.

## Acceptance Prompts

In a fresh Codex task:

```text
Use the shoot-email-oauth MCP server. Initialize my Shoot Email mailbox and show its address.
```

Start another fresh task and repeat the prompt. The first call should report
`created: true`; later calls must report `created: false` and return the same
mailbox address.

Then verify ordinary reads:

```text
Use shoot-email-oauth to get service status and check my pending inbox. Do not acknowledge anything.
```

## Logout And Revocation Check

Logout removes Codex's locally stored OAuth credentials:

```bash
codex mcp logout shoot-email-oauth
```

After logout, an MCP call must require authentication again. Re-run the login
command to reconnect; the same Google/Auth0 subject must recover the existing
mailbox rather than create a new one.

Auth0 tenant logs should show successful authorization-code exchange events for
a strict `tpc_` Codex client. Remove abandoned DCR clients created by interrupted
login attempts so they do not accumulate.

## Verified Result

The initial 2026-07-21 staging run verified:

- Google login, consent, PKCE exchange, and stored Codex OAuth credentials.
- One strict DCR client remained after interrupted clients were removed.
- First mailbox initialization returned `created: true`.
- A fresh Codex process returned `created: false` with the same mailbox address.
- `mailbox:read` and `mailbox:acknowledge` calls succeeded.
- `mailbox:send` accepted a simulated mock-provider message after Codex write-tool
  approval; no external email was delivered.
