# Authenticated Production Cutover

This runbook promotes Shoot Email from the OAuth staging demonstration to a
controlled production email loop. Production remains closed to outbound sends
except for explicitly allowlisted Auth0 subjects until the rollout mode is
intentionally changed.

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
- Database migrations: 13 applied, zero users and zero messages at provisioning
- Cloudflare Email Sending credentials: installed as Worker secrets
- Global outbound delivery: enabled behind database quotas and the emergency
  kill switch
- OAuth rollout mode: allowlist, with two production acceptance identities

The production Worker passes health, database readiness, protected-resource
metadata, unauthenticated OAuth challenge, real inbound routing, and guarded
real outbound acceptance checks at Cloudflare's edge.

## Safety Layers

Real delivery is protected by independent controls:

1. `OAUTH_OUTBOUND_ROLLOUT_MODE=allowlist` blocks `send_text_email` unless the
   validated Auth0 `sub` claim appears in `OAUTH_OUTBOUND_ALLOWED_SUBJECTS`.
2. `OUTBOUND_SENDING_ENABLED=false` is the global emergency kill switch.
3. Database-backed hourly, daily, new-recipient, session, and minimum-interval
   limits are reserved transactionally before the provider call.
4. Per-user suspension can block an individual mailbox without affecting
   inbound delivery.

`OAUTH_OUTBOUND_ALLOWED_SUBJECTS` is a Worker secret. Do not commit Auth0
subjects to the Wrangler configuration.

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
   OAUTH_OUTBOUND_ALLOWED_SUBJECTS
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

6. Deploy with `MAIL_PROVIDER=cloudflare`,
   `OUTBOUND_SENDING_ENABLED=false`, and rollout mode `allowlist`.
7. Run:

   ```bash
   npm run smoke:production
   ```

8. Point the Email Routing Worker at the production webhook, deploy it, and
   confirm a real inbound message reaches the intended OAuth mailbox.
9. Change only `OUTBOUND_SENDING_ENABLED` to `true`, redeploy, and send one
   allowlisted message.

## Acceptance Test

For two different OAuth identities:

- Initialize each mailbox twice and confirm stable, distinct addresses.
- Confirm neither identity can retrieve the other mailbox's messages.
- Send a real message from the allowlisted identity and retry the same request
  ID; only one provider call may occur.
- Reply from the recipient and retrieve the complete pending message.
- Retrieve again before acknowledgement and confirm the message remains
  pending.
- Acknowledge it and confirm it no longer appears in the pending inbox.
- Confirm the non-allowlisted identity receives
  `outbound_rollout_not_allowed`.

Inspect the delivered message headers for SPF, DKIM, and DMARC pass results.

## Production Acceptance Record

The allowlisted production path passed its first complete acceptance test on
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

The production OAuth rollout remains restricted to explicitly configured Auth0
subjects. On 2026-07-27, a live non-allowlisted production identity attempted
request `5c8070b3-96cc-4ede-83a7-f3f5ec1e779e` and received the versioned MCP
error `outbound_rollout_not_allowed`. The response returned through the normal
tool contract rather than a pre-tool HTTP rejection, and a direct production
database query confirmed that zero messages were persisted for the denied
request. The approved-subject allowlist was restored immediately afterward.

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

All production cutover acceptance items are complete. Keep rollout mode on
`allowlist` until operational monitoring and broader user onboarding are ready.

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
- Keep rollout mode on `allowlist` until multiple real-user acceptance runs
  have passed.
- Record deployment version, Hyperdrive ID, migration result, test message IDs,
  and rollback result after every cutover rehearsal.
