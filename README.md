# Shoot Email

Terminal-first email client/service prototype for sending text emails and reading received text emails.

## Current Milestone

This implements the first milestone:

- local mailbox initialization
- stable generated inbound alias
- Postgres schema with pgvector enabled for future embeddings
- mock outbound mail provider
- optional Cloudflare Email Sending outbound provider
- Cloudflare Email Routing Worker payload ingestion
- hosted Cloudflare backend Worker connected to Neon through Hyperdrive
- restricted hosted Streamable HTTP MCP judge demo
- CLI commands for address, send, inbox, and read

## Setup

Install dependencies:

```bash
npm install
```

Create environment config:

```bash
cp .env.example .env
```

Start Postgres with pgvector:

```bash
docker compose up -d postgres
```

If your Docker install does not include Compose, run an equivalent container:

```bash
docker run --name shoot-email-postgres \
  -e POSTGRES_USER=shoot_email \
  -e POSTGRES_PASSWORD=shoot_email \
  -e POSTGRES_DB=shoot_email \
  -p 5432:5432 \
  -d pgvector/pgvector:pg16
```

Apply migrations:

```bash
npm run db:migrate
```

Reset the local database and reapply all migrations:

```bash
npm run db:reset
```

This drops and recreates the local `public` schema, so only use it for local development data.

## Hosted Backend

The selected hosted architecture is Cloudflare Workers plus Neon Postgres,
connected through Cloudflare Hyperdrive. See
`docs/adr/001-cloudflare-workers-neon-hyperdrive.md` for the decision and
tradeoffs.

The backend Worker currently exposes:

```text
GET  /health
GET  /ready
POST /webhooks/email/inbound
POST /mcp
```

`/health` verifies the Worker is running. `/ready` also verifies the Hyperdrive
database path. The local-only `/apps/openai/context` route is hidden on the
Worker unless `ENABLE_UNAUTHENTICATED_OPENAI_CONTEXT=true`; never enable that
flag in a public environment.

Build the Worker bundle without deploying:

```bash
npm run backend:build
```

Before deployment, create Neon Postgres, run `npm run db:migrate` with its
direct `DATABASE_URL`, and create a Hyperdrive configuration with SQL query
caching disabled. Add the resulting binding to
`workers/backend/wrangler.jsonc` as `HYPERDRIVE`. Store the webhook token with
`wrangler secret put INBOUND_WEBHOOK_TOKEN`; do not add it to the Wrangler
configuration file.

The application reads its least-privilege Email Sending token from
`CLOUDFLARE_EMAIL_API_TOKEN`. Do not name that application secret
`CLOUDFLARE_API_TOKEN`, because Wrangler reserves the generic name for its own
deployment authentication.

The staging backend is deployed at:

```text
https://shoot-email-backend.powersurge.workers.dev
```

It uses the `shoot-email` Neon project in AWS Oregon through the
`shoot-email-neon` Hyperdrive configuration. Hyperdrive query caching is
disabled and its origin connection limit is five. Staging keeps
`MAIL_PROVIDER=mock` and `OUTBOUND_SENDING_ENABLED=false`.

The `/mcp` route is a restricted Build Week judge demo protected by a bearer
credential. It maps each credential suffix to an isolated, server-controlled
principal and seeds eight synthetic messages on first initialization. It never
trusts caller-supplied `_meta` identity. This is not the production ChatGPT
authentication design; OAuth 2.1 remains the required follow-up. Complete judge
instructions are in `docs/hackathon/TESTING.md`.

Demo principals are also rejected directly by `send_text_email`, independently
of the environment-level outbound kill switch.

The production Email Routing Worker now posts inbound messages to this hosted
backend. Both a synthetic webhook smoke test and a real Gmail-to-Email-Routing
test have passed. The latter stored and acknowledged the marker
`HOSTED-ROUTING-001` in Neon.

Run the hosted synthetic smoke test with a direct Neon migration connection:

```bash
DATABASE_URL="$NEON_DATABASE_URL" \
HOSTED_BACKEND_URL="https://shoot-email-backend.powersurge.workers.dev" \
npm run smoke:hosted
```

## CLI Usage

Create or reuse a local mailbox:

```bash
npx shoot-email init
```

All non-compact user commands return a versioned JSON envelope with
`contractVersion`, `ok`, and `error`. Successful operations return
`"error": null`; failures return a stable error code, `retryable`, and
`retryAt` when a later retry is appropriate. The current contract version is
`2.0`.

Show the current address:

```bash
npx shoot-email address
```

Inspect the active provider before any side effect:

```bash
npx shoot-email status
```

`status` identifies the environment and server time, simulation versus
production mode, sender identity, outbound availability, account tier, current
quota usage and reset times, and the enforced request and retrieval limits.
When invoked through MCP with a conversation identity, it also reports that
session's hourly quota. Internal user UUIDs are not exposed. The mock provider
is explicitly reported as simulated and does not consume abuse-control quotas.

Show or configure the structured sender identity:

```bash
npx shoot-email identity show
npx shoot-email identity set --display-name "Serguei"
npx shoot-email identity clear
npx shoot-email identity alias set --alias serguei
```

Configured names are sent as `Serguei via Shoot Email
<u_example@yoyowza.com>`. Without one, the default is `Shoot Email
<u_example@yoyowza.com>`.

Custom aliases require a registered account. They use lowercase ASCII local
parts between 3 and 32 characters, reject reserved system/role/brand names, and
have a configurable 30-day change cooldown. Previously used addresses remain
valid for inbound delivery and can never be assigned to another user.

Send a text email with the mock provider:

```bash
npx shoot-email send \
  --request-id 550e8400-e29b-41d4-a716-446655440000 \
  --to someone@example.com \
  --subject "Hi" \
  --text "Hello"
```

`send` returns structured JSON. Reusing the same request ID with identical
content returns the existing result without contacting the provider again.
Reusing it with different content returns an `idempotency_key_reused` error.
Requests with an ambiguous provider outcome are stored as `unknown` and are not
retried automatically.

The response fields distinguish the current attempt from an existing request:

- `providerCalled` says whether this invocation contacted the provider.
- `idempotentReplay` is true only for an identical retry.
- `existingRequest` says the request ID was already reserved.
- A conflicting retry returns `message: null` and puts the unchanged original
  record in `existingMessage`.
- `simulated` is true for mock outcomes; mock delivery details also carry
  `simulated: true`.

Outbound timestamps have fixed meanings: `createdAt` is local reservation
time, `providerAttemptedAt` is the first provider-attempt time, and
`providerResultAt` is when a known provider result was persisted.

Query prior sends or a single persisted result without resending:

```bash
npx shoot-email outbound list
npx shoot-email outbound status --request-id <request-id>
npx shoot-email outbound status --message-id <message-id>
```

The sender name and address are persisted with each outbound message and are
part of its idempotent content. Changing the sender identity requires a new
request ID.

### Outbound Abuse Controls

Outbound sending enforces configurable guest, registered-user, session, and
global quotas before contacting the provider. The defaults are intentionally
conservative for a new sending domain: guests receive 3 sends/hour and 10/day;
registered users receive 10/hour and 50/day; the application is capped at
20/hour and 100/day. New-recipient and minimum-interval limits also apply.
Hourly and daily counters use fixed UTC calendar buckets.
The built-in mock provider is exempt because it does not send external mail.

Show the current mailbox policy and usage:

```bash
npx shoot-email abuse status
```

Administer a user by internal ID:

```bash
npx shoot-email abuse tier <user-id> --tier registered
npx shoot-email abuse suspend <user-id> --reason "Repeated abusive sends"
npx shoot-email abuse reactivate <user-id>
```

Set `OUTBOUND_SENDING_ENABLED=false` as the global emergency kill switch. All
policy rejections are persisted by request ID and returned as structured JSON;
retrying a rejected request neither reevaluates it nor consumes quota.

Return up to 50 oldest pending messages with full text bodies as structured JSON:

```bash
npx shoot-email inbox
```

The default batch is bounded by 100,000 total body characters and 16,000
characters per message. Continue a partial result with the returned cursor:

```bash
npx shoot-email inbox --cursor <next-cursor>
```

Pending and processed inbound batches are ordered by `createdAt`, then `id`,
oldest first. Outbound history uses the same keys newest first. The response
`page` object states the exact order, defaults, maxima, and cursor behavior.
Cursors are opaque, versioned, scoped to one resource/state, do not expire, and
are not snapshots. New messages can therefore appear on a later page. Passing
an inbox cursor to history or outbound history returns `invalid_cursor`.

Print a compact human-readable list when debugging:

```bash
npx shoot-email inbox --compact
```

Acknowledge messages only after an LLM has processed them successfully:

```bash
npx shoot-email acknowledge <message-id> [message-id...]
```

Acknowledgement is idempotent and uses partial-by-ID semantics: valid IDs are
processed while unknown IDs are reported in the same response. Malformed UUIDs
fail validation before any message is changed. Each ID receives an explicit
`acknowledged`, `already_processed`, or `not_found` outcome.

Query acknowledged messages:

```bash
npx shoot-email history
```

Read a message:

```bash
npx shoot-email read <message-id>
```

`read` returns structured JSON and never acknowledges or otherwise changes the
message. Use `--compact` only for human-readable debugging output. Inbound
sender, subject, text, and provider identifiers are untrusted external data;
`contentTrust: "untrusted_external"` marks that boundary in retrieval results.

## Webhook

Start the inbound webhook server:

```bash
npm run start:webhook
```

For Cloudflare Email Routing local development, also start the named tunnel in a second terminal:

```bash
npm run start:tunnel
```

The legacy local-development tunnel URL is:

```text
https://webhook.yoyowza.com
```

The inbound endpoint is:

```text
POST http://localhost:3000/webhooks/email/inbound
```

Example local webhook test:

```bash
curl -X POST http://localhost:3000/webhooks/email/inbound \
  -H 'Content-Type: application/json' \
  -d '{
    "provider": "cloudflare",
    "from": "sender@example.com",
    "to": "u_example@in.localhost",
    "subject": "Hello",
    "text": "Plain text body",
    "messageId": "<cloudflare-message-id@example.com>",
    "date": "Tue, 07 Jul 2026 17:00:00 -0700"
  }'
```

Use the address returned by `npx shoot-email address` as the `To` value.

The inbound endpoint requires `INBOUND_WEBHOOK_TOKEN`. Generate a secret and
store the same value in the backend environment and the Worker secret:

```bash
openssl rand -hex 32
cd workers/email-router
npx wrangler secret put INBOUND_WEBHOOK_TOKEN
```

Include it as a bearer token when testing the endpoint directly:

```bash
curl -X POST http://localhost:3000/webhooks/email/inbound \
  -H 'Content-Type: application/json' \
  -H "Authorization: Bearer $INBOUND_WEBHOOK_TOKEN" \
  -d '{ "provider": "cloudflare", "from": "sender@example.com", "to": "u_example@in.localhost", "text": "Hello" }'
```

Inbound ingestion is idempotent per mailbox and provider message ID. Email
Worker deliveries without a `Message-ID` use a SHA-256 digest of the raw email
as a stable fallback identifier, so retrying the same delivery does not create
another inbox message.

## Cloudflare Email Service

The project is Cloudflare-first:

- Cloudflare Email Routing receives inbound mail.
- `workers/email-router` parses inbound mail in a Cloudflare Worker and posts normalized JSON to the backend.
- Cloudflare Email Sending can be used for outbound mail with `MAIL_PROVIDER=cloudflare`.
- The `mock` provider remains the default for local tests and development.

To use real Cloudflare outbound sending:

```bash
MAIL_PROVIDER=cloudflare
CLOUDFLARE_ACCOUNT_ID=...
CLOUDFLARE_EMAIL_API_TOKEN=...
CLOUDFLARE_FROM_EMAIL=optional-default-sender@example.com
```

Keep `MAIL_PROVIDER=mock` until intentionally running a real delivery test.

By default, outbound mail uses the generated alias as `from`. Set `CLOUDFLARE_FROM_EMAIL` only when you want to force a single default sender. The sender domain must be onboarded for Cloudflare Email Sending.

To work on the inbound Worker:

```bash
cd workers/email-router
npm install
npm run dev
```

The deployed `BACKEND_INBOUND_WEBHOOK_URL` in
`workers/email-router/wrangler.jsonc` points at the hosted backend:

```text
https://shoot-email-backend.powersurge.workers.dev/webhooks/email/inbound
```

The named tunnel remains available for isolated local testing, but changing the
deployed routing Worker back to it is an explicit temporary override.

## OpenAI Apps Context

The service includes a small endpoint for resolving OpenAI Apps identity context:

```text
POST http://localhost:3000/apps/openai/context
```

It accepts the Apps SDK `_meta` shape:

```json
{
  "_meta": {
    "openai/subject": "anonymized-user-id",
    "openai/session": "anonymized-conversation-id",
    "openai/organization": "anonymized-org-id"
  }
}
```

The endpoint creates or reuses an internal `users` row through `user_identities`, and creates or reuses a `chat_sessions` row when `openai/session` is present.

## Local MCP Server

The project includes a local stdio MCP server built with the stable MCP
TypeScript SDK. It is a thin adapter over the same services used by the CLI:

```bash
npm run start:mcp
```

The server writes MCP protocol messages to stdout, so it normally appears
silent when started without an MCP client. For a local Codex test, register it
with a development-only OpenAI identity fallback:

```bash
codex mcp add shoot-email \
  --env MAIL_PROVIDER=mock \
  --env MCP_ALLOW_DEV_IDENTITY=true \
  --env MCP_DEV_OPENAI_SUBJECT=local-codex-test \
  --env MCP_DEV_OPENAI_SESSION=local-codex-session \
  -- node /Users/powersurge/Documents/OpenAI/ChatGPT-APPs/shoot-email/src/mcpStdio.js
```

Start a fresh Codex task after adding the server. Call `initialize_mailbox`
before other mailbox tools. The local development subject produces a stable
mailbox through `user_identities`; changing the subject produces a different
mailbox. Do not set `MCP_ALLOW_DEV_IDENTITY` in production.

The user-facing MCP surface contains only:

```text
initialize_mailbox
get_service_status
get_mailbox_identity
send_text_email
list_pending_messages
acknowledge_messages
get_message
list_processed_messages
list_outbound_messages
get_outbound_message_status
```

Migration, account-tier, suspension, and abuse-administration operations are
intentionally absent. Tool results carry both MCP text content and the same
versioned structured contract used by the CLI. Tool descriptions and message
objects explicitly label inbound email as untrusted external content. Every
tool advertises a concrete MCP `outputSchema`; schemas include the common error
envelope because MCP validates both successful and failed tool results.

Outbound status lookup uses a discovery-visible discriminator instead of two
optional mutually exclusive fields:

```json
{
  "lookupBy": "requestId",
  "id": "a0000000-0000-4000-8000-000000000001"
}
```

Batch responses identify their cursor as `live_keyset` and explicitly state
that it is not a snapshot. Acknowledgement responses include `allSucceeded`,
requested and successful counts, and per-ID outcomes so partial success cannot
be mistaken for complete success.

For ChatGPT, identity comes from request metadata keys `openai/subject`,
`openai/session`, and optionally `openai/organization`; callers cannot provide
identity as tool arguments. A future remote MCP deployment must authenticate
the ChatGPT connection before trusting that metadata. The development fallback
is only for local stdio clients that do not supply ChatGPT Apps metadata.

## Remote MCP Demo

The hosted Build Week demo uses the same tool and output contracts over
stateless Streamable HTTP. The bearer secret is supplied privately in the
submission testing instructions. Append a random suffix to receive an isolated
mailbox, then register it with Codex:

```bash
export SHOOT_EMAIL_DEMO_TOKEN="${SHOOT_EMAIL_DEMO_SECRET}.$(openssl rand -hex 8)"
codex mcp add shoot-email-demo \
  --url https://shoot-email-backend.powersurge.workers.dev/mcp \
  --bearer-token-env-var SHOOT_EMAIL_DEMO_TOKEN
```

Run a protocol and seeded-inbox smoke test with:

```bash
npm run smoke:remote-mcp
```

The hosted demo keeps real outbound delivery disabled. See
`docs/hackathon/TESTING.md` for judge prompts and the security boundary.

## Built With Codex

Codex was used as the engineering collaborator throughout the project: reading
and testing the repository, researching current provider and Apps SDK behavior,
implementing migrations and service boundaries, deploying Cloudflare Workers,
and running black-box CLI and MCP evaluations. Product decisions remained
explicitly user-directed, including the LLM-first inbox semantics,
acknowledgement lifecycle, Cloudflare-first architecture, abuse limits, and the
choice to ship a restricted hackathon transport before the OAuth production
milestone.

Codex accelerated repetitive verification and cross-layer changes, especially
the database-backed contract tests, Cloudflare/Neon deployment checks, and the
trusted-principal transport seam. The key engineering decision for this
submission is that the demo bearer credential produces a request principal
outside tool arguments; replacing it with OAuth later does not require rewriting
the mailbox service or MCP tool contracts.

Because this project predates Build Week, `docs/hackathon/BUILD_LOG.md` clearly
separates the pre-existing baseline from the work added for the submission. The
two preserved black-box transcripts also show how fresh Codex sessions exposed
contract problems that were then hardened in code.

## Tests

The default test suite includes database-backed integration tests, so Postgres must be running:

```bash
docker compose up -d postgres
npm test
```

Integration tests use `TEST_DATABASE_URL`, defaulting to a database named
`shoot_email_test`. The runner creates that database when needed and resets
only its schema. Test resets refuse to operate on a database whose name does
not end in `_test`, protecting the development mailbox and messages.

Run only the pure unit tests:

```bash
npm run test:unit
```

Run only the integration tests:

```bash
npm run test:integration
```
