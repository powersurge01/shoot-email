# Authenticated Production Cutover

This runbook promotes Shoot Email from the OAuth staging demonstration to a
controlled production email loop. Production MCP access is limited to active
database beta grants derived from validated Auth0 identities. Real outbound
delivery additionally requires the grant's outbound permission.

## Production Topology

```text
Codex or another MCP client
  -> Auth0 OAuth
  -> https://mcp.shoot-email.yoyowza.com/mcp
  -> shoot-email-production Worker
  -> production-only Hyperdrive
  -> production-only Neon database

Cloudflare Email Routing
  -> shoot-email-router
  -> https://mcp.shoot-email.yoyowza.com/webhooks/email/inbound
  -> production Neon database
```

The production Worker must not share its database or Hyperdrive configuration
with the hackathon demo or OAuth staging Workers.

## Current Status

Provisioned on 2026-07-27:

- Production Worker: `shoot-email-production`
- MCP hostname: `https://mcp.shoot-email.yoyowza.com/mcp`
- Neon database: `shoot_email_production`
- Hyperdrive: `shoot-email-neon-production`, caching disabled, five origin
  connections
- Database migrations: 15 applied, including private-beta access and account
  lifecycle controls
- Cloudflare Email Sending credentials: installed as Worker secrets
- Global outbound delivery: enabled behind database quotas and the emergency
  kill switch
- OAuth rollout mode: database allowlist, with two production acceptance
  identities preserved by the beta-grant backfill

The production Worker passes health, database readiness, protected-resource
metadata, unauthenticated OAuth challenge, real inbound routing, and guarded
real outbound acceptance checks at Cloudflare's edge.

## Safety Layers

Real delivery is protected by independent controls:

1. `OAUTH_BETA_ACCESS_MODE=enforced` blocks all production MCP access unless
   the validated Auth0 identity has an active database beta grant.
2. `OAUTH_OUTBOUND_ROLLOUT_MODE=database_allowlist` blocks `send_text_email`
   unless that active grant also enables outbound delivery.
3. `OUTBOUND_SENDING_ENABLED=false` is the global emergency kill switch.
4. Database-backed hourly, daily, new-recipient, session, and minimum-interval
   limits are reserved transactionally before the provider call.
5. Account disablement blocks MCP access, inbound ingestion, and provider
   calls. Sending suspension remains available as a narrower outbound-only
   control.

## Provisioning Order

1. Create a clean production database in Neon.
2. Run all SQL migrations directly against its connection string:

   ```bash
   DATABASE_URL="$PRODUCTION_DATABASE_URL" npm run db:migrate
   ```

3. Create a dedicated Hyperdrive configuration with caching disabled and an
   origin connection limit of five.
4. Create the Auth0 production API with identifier:

   ```text
   https://mcp.shoot-email.yoyowza.com/mcp
   ```

   Configure RS256, one-hour tokens, refresh tokens, strict third-party client
   controls, and only:

   ```text
   mailbox:read
   mailbox:send
   mailbox:acknowledge
   ```

5. Put these production Worker secrets:

   ```text
   INBOUND_WEBHOOK_TOKEN
   CLOUDFLARE_EMAIL_API_TOKEN
   ```

   When loading the Email Sending credential from `.env`, reject an empty
   value before updating the Worker:

   ```bash
   EMAIL_TOKEN="$(node --input-type=module -e \
     "import 'dotenv/config'; process.stdout.write(process.env.CLOUDFLARE_EMAIL_API_TOKEN || '')")"
   test -n "$EMAIL_TOKEN" || {
     echo "CLOUDFLARE_EMAIL_API_TOKEN is empty" >&2
     exit 1
   }
   printf '%s' "$EMAIL_TOKEN" |
     npx wrangler secret put CLOUDFLARE_EMAIL_API_TOKEN \
       --config workers/backend/wrangler.production.jsonc
   unset EMAIL_TOKEN
   ```

   `CLOUDFLARE_FROM_EMAIL` may remain empty. In that case, outbound messages
   use the user's current Shoot Email alias as the sender address.

6. Deploy initially with `MAIL_PROVIDER=cloudflare`,
   `OUTBOUND_SENDING_ENABLED=false`, `OAUTH_BETA_ACCESS_MODE=enforced`, and
   rollout mode `database_allowlist`.
7. Run:

   ```bash
   npm run smoke:production
   ```

8. Point the Email Routing Worker at the production webhook, deploy it, and
   confirm a real inbound message reaches the intended OAuth mailbox.
9. Add one database beta grant with outbound enabled, change only
   `OUTBOUND_SENDING_ENABLED` to `true`, redeploy, and send one acceptance
   message.

## Acceptance Test

For two different OAuth identities:

- Initialize each mailbox twice and confirm stable, distinct addresses.
- Confirm neither identity can retrieve the other mailbox's messages.
- Send a real message from an outbound-enabled beta identity and retry the same request
  ID; only one provider call may occur.
- Reply from the recipient and retrieve the complete pending message.
- Retrieve again before acknowledgement and confirm the message remains
  pending.
- Acknowledge it and confirm it no longer appears in the pending inbox.
- Confirm an identity without a beta grant receives an HTTP 403 OAuth resource
  denial before any mailbox tool executes.
- Confirm an active read-only grant can use mailbox tools but receives
  `outbound_rollout_not_allowed` from `send_text_email`.

Inspect the delivered message headers for SPF, DKIM, and DMARC pass results.

## Production Acceptance Record

The former static-allowlist production path passed its first complete
acceptance test on
2026-07-27:

- OAuth mailbox: `u_978fee62@yoyowza.com`
- Outbound request: `10ff4d51-2c64-40c3-8f2c-7a8a17dab3e0`
- Outbound message: `3593cdc8-a862-4d52-9359-e96172167ca6`
- Cloudflare accepted the real message as `queued`.
- An identical retry returned `idempotentReplay: true` and
  `providerCalled: false`.
- Gmail delivered the message to the Inbox with SPF, both DKIM signatures, and
  DMARC passing.
- A Gmail reply returned through Email Routing as inbound message
  `af6560bb-98d6-4a4b-855a-93a21548cb78`.
- The reply remained pending across two retrievals, then disappeared from the
  pending inbox only after explicit acknowledgement.

At that time, the production OAuth rollout was restricted by a static Auth0
subject secret. On 2026-07-27, a live non-allowlisted production identity attempted
request `5c8070b3-96cc-4ede-83a7-f3f5ec1e779e` and received the versioned MCP
error `outbound_rollout_not_allowed`. The response returned through the normal
tool contract rather than a pre-tool HTTP rejection, and a direct production
database query confirmed that zero messages were persisted for the denied
request. The approved-subject static allowlist was restored immediately
afterward. This paragraph is a historical acceptance record, not the current
onboarding procedure.

The two-mailbox isolation check completed on 2026-07-28:

- Account A initialized `u_c0b755a4@yoyowza.com` with `created: true`, then
  recovered the same mailbox with `created: false`.
- Account A returned no messages from Account B's existing pending, processed,
  or outbound collections.
- Account B recovered its original `u_978fee62@yoyowza.com` mailbox after an
  OAuth logout and login through its isolated Safari profile.
- A Gmail message with subject `OAUTH-ISOLATION-A-20260728` traversed the real
  Email Routing path into Account A as message
  `db5ccba7-846a-490e-a831-2f426bee033a`.
- Account B did not return that marker in any message collection. A direct
  `get_message` call using Account A's message ID returned
  `message_not_found`.

All initial production cutover acceptance items are complete. Keep beta access
enforced and rollout mode on `database_allowlist` throughout the private beta.
Use `docs/operations/PRIVATE_BETA.md` for current onboarding procedures.

## Emergency Rollback

Disable all provider calls immediately by setting
`OUTBOUND_SENDING_ENABLED` to `false` in
`workers/backend/wrangler.production.jsonc` and redeploy. Do not delete the
production database, aliases, Email Routing records, or Auth0 API during an
incident.

If the production Worker itself is unhealthy, point the Email Routing Worker
back to the previous authenticated webhook only long enough to avoid rejecting
mail, then diagnose the production deployment. Never route production inbound
mail to the synthetic demo principal.

## Post-Cutover Operations

- Keep Cloudflare Worker observability enabled.
- Alert on provider failures, `unknown` send outcomes, webhook authentication
  failures, and global quota rejection.
- Monitor Auth0 `tpc_` Dynamic Client Registration applications and remove only
  abandoned registrations.
- Keep beta access enforced and rollout mode on `database_allowlist` until the
  private-beta exit criteria have passed.
- Record deployment version, Hyperdrive ID, migration result, test message IDs,
  and rollback result after every cutover rehearsal.
