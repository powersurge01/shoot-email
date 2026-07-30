# Private Beta Operations

This runbook turns the controlled production deployment into a three-to-five
person private beta. Beta membership is keyed only by the validated Auth0
provider and subject. Email addresses are used to locate Auth0 users during
onboarding, but they are not accepted by Shoot Email as authorization.

## Participant Information

Collect these items from each participant:

- The Google account email they will use with Auth0.
- Confirmation that they understand this is an experimental private beta.
- A real address they control for one send-and-reply acceptance test.
- Permission to retain their test messages until the beta ends or they request
  anonymization.

Do not ask participants for passwords, Google tokens, Auth0 tokens, or Codex
session files.

## Prerequisites

Load the production database only for the operator command:

```bash
export DATABASE_URL="$(npx neonctl@latest connection-string \
  --project-id muddy-morning-72614451 \
  --database-name shoot_email_production \
  --ssl verify-full)"
```

Refresh Auth0 and verify DCR capacity:

```bash
auth0 login
npm run ops:auth0:dcr-audit -- --warn-at 5 --fail-at 8
```

Do not expand the cohort while the DCR result is warning or critical.

## Invite A Participant

1. Ask the participant to connect the production MCP server and complete Google
   sign-in once. Their first MCP request may return
   `beta_access_not_allowed`; this is expected before the grant exists.
2. Resolve the resulting Auth0 subject:

```bash
auth0 users search \
  --query 'email:"participant@example.com"' \
  --number 10 \
  --json \
  --no-input
```

Confirm exactly one expected Auth0 user and use its `user_id`. Never infer a
subject from an email address.

3. Add the grant. Omit `--outbound` for read-only onboarding:

```bash
npx shoot-email ops beta grant \
  --provider "auth0:dev-3ltbe81kduigsjty.us.auth0.com" \
  --subject "<validated-auth0-user-id>" \
  --outbound \
  --actor "operator@example.com"
```

4. Ask the participant to retry:

```text
Initialize Shoot Email and show my mailbox address.
```

5. Confirm the linked mailbox:

```bash
npx shoot-email ops beta list
npx shoot-email ops report
```

## Participant Acceptance Script

Run these prompts in a fresh Codex session connected to
`https://mcp.shoot-email.yoyowza.com/mcp`:

```text
Initialize Shoot Email and show my mailbox address.
```

```text
Show Shoot Email service status. Do not send anything.
```

```text
Send a plain-text email to <participant-controlled-address> with subject
"Shoot Email private beta test" and body "Please reply to confirm this mailbox
can receive your response." Generate a new UUID request ID and report the exact
delivery result.
```

After replying from the destination account:

```text
Check Shoot Email for new messages and summarize the complete reply. Do not
acknowledge it.
```

Then explicitly test acknowledgement:

```text
Acknowledge the reply you just summarized, then confirm it appears in processed
message history.
```

Finally, retry the original send using the same request ID and identical
content. It must return an idempotent replay and must not call the provider.

Record pass/fail for initialization, real send, inbound reply, acknowledgement,
idempotent retry, and mailbox isolation. Never store OAuth tokens in the
acceptance record.

## Revoke Or Disable

Revoke one Auth0 identity without deleting its audit record:

```bash
npx shoot-email ops beta revoke \
  --provider "auth0:dev-3ltbe81kduigsjty.us.auth0.com" \
  --subject "<validated-auth0-user-id>" \
  --reason "Private beta access ended" \
  --actor "operator@example.com"
```

Disable the entire internal account when all linked identities must lose
mailbox access:

```bash
npx shoot-email ops user disable <user-id> \
  --reason "Incident or user request" \
  --actor "operator@example.com"
```

Re-enable only a disabled, non-anonymized account:

```bash
npx shoot-email ops user enable <user-id> \
  --actor "operator@example.com"
```

## Anonymization

Anonymization is irreversible. First resolve and review the user:

```bash
npx shoot-email ops user lookup --alias <mailbox-address>
```

Then require the exact current alias as confirmation:

```bash
npx shoot-email ops user anonymize <user-id> \
  --confirm-alias <mailbox-address> \
  --reason "User requested data deletion" \
  --actor "operator@example.com"
```

This disables matching beta grants, removes external identities, sessions,
embeddings, recipient relationships, and user quota rows, and redacts stored
message content and addresses. It retains the internal user and alias rows as
disabled tombstones so previously used aliases cannot be reassigned. Global
send counters remain intact and are not refunded.

## Release Gate

After Google branding approval and a healthy Auth0 DCR audit:

```bash
BETA_GOOGLE_BRANDING_APPROVED=true \
BETA_AUTH0_DCR_AUDIT_OK=true \
npm run ops:beta:readiness
```

The command also checks production health, database readiness, OAuth metadata,
runtime outbound state, and a cohort size between three and five active grants.
Missing manual attestations are blockers, not warnings.

## Initial Deployment Record

On 2026-07-30:

- Migration `015_controlled_beta_access.sql` was applied to the production
  database.
- The migration backfilled exactly two active, outbound-enabled grants, each
  linked to one existing active OAuth mailbox.
- Production Worker version `f79dd1e9-6311-4763-a866-42c0b4f3f536` deployed
  with beta access enforced and database-backed outbound authorization.
- Public site version `db017abe-a445-4358-a582-eff8e04d8601` deployed the
  updated account access and anonymization notice.
- Public production smoke checks passed, and an existing granted mailbox
  completed authenticated initialization and service-status retrieval without
  sending email.
- The release gate remained blocked as expected on a third participant, Google
  branding approval, and a fresh Auth0 DCR audit.

Unset the production database when finished:

```bash
unset DATABASE_URL
```
