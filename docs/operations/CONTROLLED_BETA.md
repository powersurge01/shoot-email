# Controlled Beta Operations

This runbook covers the minimum operational controls required before inviting
users beyond the production acceptance accounts. Operator commands connect
directly to Postgres and are intentionally not exposed through MCP.

## Trusted Operator Environment

Load the production Neon connection string only for the command being run:

```bash
DATABASE_URL="$(npx neonctl@latest connection-string \
  --project-id muddy-morning-72614451 \
  --database-name shoot_email_production \
  --ssl verify-full)"
export DATABASE_URL
```

Do not put the production connection string in a committed file or MCP client
configuration. Unset it when the operation is complete:

```bash
unset DATABASE_URL
```

## Emergency Outbound Control

The deployment switch and database runtime switch are independent and combined
with logical AND. Either one can stop real provider calls.

Inspect the current state:

```bash
npx shoot-email ops outbound status
```

Disable provider sends without redeploying:

```bash
npx shoot-email ops outbound disable \
  --actor "operator@example.com" \
  --reason "Incident reference and concise reason"
```

Re-enable the runtime layer after the incident is resolved:

```bash
npx shoot-email ops outbound enable \
  --actor "operator@example.com"
```

The runtime update acquires the same global database lock as outbound
reservations. A send already inside its provider call cannot be recalled, but
new reservations wait for the control update and are rejected afterward.
Rejected request IDs remain idempotently rejected after re-enable.

For defense in depth, set `OUTBOUND_SENDING_ENABLED=false` and redeploy during
a prolonged incident. The runtime command cannot override that deployment
switch.

## User Administration

Resolve an internal user from a current or retired alias:

```bash
npx shoot-email ops user lookup --alias user@yoyowza.com
```

Resolve by validated external identity:

```bash
npx shoot-email ops user lookup \
  --provider "auth0:dev-3ltbe81kduigsjty.us.auth0.com" \
  --subject "google-oauth2|..."
```

Then use the existing trusted controls:

```bash
npx shoot-email abuse status <user-id>
npx shoot-email abuse suspend <user-id> --reason "Incident reference"
npx shoot-email abuse reactivate <user-id>
npx shoot-email abuse tier <user-id> --tier registered
```

Never accept an internal user ID, Auth0 subject, tier, or suspension instruction
from an MCP tool argument or inbound email.

## Operational Snapshot

```bash
npx shoot-email ops report
```

The report includes effective runtime controls, user and suspension counts,
24-hour message counts by state, and pending-inbox age. It intentionally omits
message bodies, recipients, provider credentials, and OAuth tokens.

## Cloudflare Signals

Worker observability is enabled. Create dashboard alerts or review logs for:

- `backend.request.failed`
- `mcp.authorization.misconfigured`
- sustained increases in `mcp.authorization.rejected`
- `inbound.webhook.rejected`
- `outbound.provider.failed`
- `outbound.reservation.completed` with a non-null `rejectionCode`

Logs contain event metadata only. Do not add message bodies, addresses, Auth0
subjects, bearer tokens, or provider request payloads.

The GitHub Actions workflow `.github/workflows/production-canary.yml` runs every
six hours and can also be dispatched manually. It verifies production health,
database readiness, protected-resource metadata, and the unauthenticated OAuth
challenge. It never authenticates a mailbox or sends email.

## Auth0 DCR Capacity

Refresh the Auth0 CLI session, then run:

```bash
auth0 login
npm run ops:auth0:dcr-audit
```

Override thresholds when the tenant's application capacity is known:

```bash
npm run ops:auth0:dcr-audit -- --warn-at 5 --fail-at 8
```

The audit is read-only. Repeated callback families are review candidates, not
proof that a client is abandoned. Before deleting any `tpc_` client, confirm
that its MCP connection is logged out and that the client ID is not currently
active. The command fails after 15 seconds instead of waiting indefinitely when
the Auth0 CLI session is stale. It can also inspect a prior JSON export with
`--file <apps.json>`.

## Secret Rotation

Keep separate values for:

- Worker inbound webhook authentication.
- Email Routing Worker webhook authentication.
- Cloudflare Email Sending API access.
- OAuth and Auth0 management automation.

The two inbound Workers must share the same production webhook credential, but
a local `.env` value is not authoritative and may intentionally differ. Verify
both deployed secrets during rotation, deploy the receiving backend first with
an overlap strategy when possible, then update the sender.

Never print secret values during verification. Test only success/failure and
rotate immediately if a credential appears in terminal history, logs, source
control, or conversation content.

## Neon Recovery Drill

Create an expiring Neon branch from the production branch:

```bash
npx neonctl@latest branches create \
  --project-id muddy-morning-72614451 \
  --name "restore-drill-$(date -u +%Y%m%d)" \
  --expires-at "$(node -e 'console.log(new Date(Date.now() + 86400000).toISOString())')" \
  --output json
```

Obtain that branch's connection string and verify it without writing data:

```bash
PRODUCTION_DATABASE_URL="<production-connection-string>" \
RECOVERY_DATABASE_URL="<recovery-branch-connection-string>" \
  npm run db:verify-recovery
```

The verifier checks every repository migration, required tables, the runtime
control singleton, and basic row counts. It requires the production URL as a
safety reference and rejects the same canonical database target even when SSL
query parameters differ. Delete the branch after recording the result. Never
point `RECOVERY_DATABASE_URL` at production.

## Acceptance Record

On 2026-07-29:

- Production Worker version `76fb9d14-c6ef-49bd-bdd5-73c57be90661` passed
  public health, database readiness, OAuth metadata, and unauthenticated
  challenge checks.
- The production runtime outbound switch was disabled and exercised through
  the authenticated MCP transport. The attempted send was persisted as
  `sending_disabled` with no provider message ID or provider-attempt timestamp,
  then the switch was re-enabled.
- An expiring Neon branch restored all 14 migrations, 2 users, 2 identities,
  and 5 messages. Read-only recovery verification passed and the branch was
  deleted.
- The Auth0 DCR audit command correctly failed fast on a stale CLI session.
  Refresh Auth0 login and obtain a capacity result before expanding the beta.

## Beta Exit Criteria

- Google OAuth branding is approved and the intended audience is configured.
- The production canary is green.
- DCR usage is below the warning threshold.
- Runtime disable and re-enable have been rehearsed.
- A Neon recovery branch passes `db:verify-recovery`.
- Three to five allowlisted users complete mailbox initialization, send,
  receive, idempotent retry, and account-isolation checks.
