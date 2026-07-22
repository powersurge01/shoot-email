# Shoot Email CLI Planning Notes

## Product Direction

Build a terminal-first email client/service that lets users send text emails and check received text emails from the command line. Start with a CLI because it is easy to build, inspect, and debug. Later, wrap the same service layer in an MCP server and use it as the backend for a ChatGPT app.

## Recommended Architecture

```text
CLI
  -> local API/service
    -> local database
    -> Cloudflare Email Sending API

Cloudflare Email Routing
  -> Email Worker email() handler
    -> parse inbound email
    -> POST normalized JSON to backend webhook
    -> validate/store message
    -> CLI reads messages from database
```

The CLI should be the user interface, but it should not be the whole system. Receiving mail requires Cloudflare Email Routing plus a Worker email handler. The Worker parses inbound mail and posts normalized JSON to the backend webhook.

## Cloudflare Fit

Cloudflare Email Service is the preferred provider because it supports:

- Receiving inbound mail through Email Routing.
- Running custom inbound logic through an Email Worker.
- Sending outbound mail through Email Sending.
- Keeping DNS, inbound routing, outbound sending, and edge logic on one platform.

For development, use `wrangler dev` to test Email Routing behavior locally. When a deployed Worker needs to reach a local backend, expose the local webhook with a tunnel such as cloudflared or ngrok until the service is moved to a small cloud host.

## Hosting Decision

Host the durable HTTP backend on Cloudflare Workers Paid and use Neon Postgres
with pgvector as the managed database. Connect the Worker to Neon through a
Hyperdrive binding with query caching disabled initially. Worker requests use a
request-scoped `pg.Client`; local CLI, migration, and integration-test paths
continue using pooled Docker Postgres.

Use transaction-scoped lock rows with `SELECT ... FOR UPDATE` for outbound
quota coordination. Do not use PostgreSQL advisory locks through Hyperdrive;
they are not supported.

Run migrations directly against Neon from a trusted local or CI environment,
never from a Worker request. Keep the Email Routing Worker separate until the
hosted backend passes staging verification. Do not expose the OpenAI context or
production remote MCP path publicly before OAuth authentication is implemented.
The temporary Build Week judge demo is the only exception: it uses a restricted
bearer credential, a server-controlled isolated demo principal, synthetic data,
the mock provider, simulated outbound sends, and a disabled real-delivery kill
switch. The complete
rationale is recorded in `docs/adr/001-cloudflare-workers-neon-hyperdrive.md`.

The post-hackathon remote MCP authentication path uses Auth0 as the managed
OAuth authorization server and a separate `shoot-email-auth-staging` Worker as
the resource server. Validate RS256 access tokens through Auth0 JWKS and enforce
issuer, audience, expiration, and operation scopes on every request. Derive the
external identity only from validated `sub` and optional `org_id` claims, using
an Auth0 tenant-specific provider namespace. Publish RFC 9728 protected resource
metadata, support MCP's `resource` parameter, and keep real outbound delivery
disabled until interactive client authorization has passed end-to-end testing.
See `docs/adr/002-auth0-oauth-remote-mcp.md`.

## Identity And Addresses

Anonymous users can receive a stable generated email alias tied to a user ID.

Prefer stable aliases over purely random throwaway addresses:

```text
u_7f3a92@in.example.com
```

The CLI should store a local credential or config file so the same user keeps the same identity and mailbox across sessions.

Keep the generated email alias opaque and stable. Store a user-controlled
sender display name separately. Render an unset name as `Shoot Email
<alias@yoyowza.com>` and a configured name as `<name> via Shoot Email
<alias@yoyowza.com>`. Persist the exact rendered sender name on each outbound
message and include it in idempotency comparisons.

## Initial Scope

Start with text-only email.

Explicitly defer:

- Attachments.
- Rich HTML rendering.
- Complex threading.
- Spam policy automation.
- Multi-device auth.
- Full mailbox sync semantics.

Store enough inbound metadata now to avoid painful migrations later.

## Database Recommendation

Use Postgres from the start if message embeddings are likely.

The main reason is pgvector. It allows message metadata, message text, and embedding vectors to live in the same database, which keeps the architecture simple when semantic search is added later.

Recommended path:

- Use local Postgres via Docker for development.
- Enable pgvector early, even if embeddings are not used in the first milestone.
- Keep embedding generation out of the initial send/receive milestone.
- Later move to a managed Postgres provider that supports pgvector, such as Supabase, Neon, or Render Postgres.

SQLite remains a simpler fallback for a very small prototype, but Postgres is the better default if semantic search, embeddings, or a hosted production path are expected.

## Suggested Data Model

```text
users
  id
  email_alias
  sender_display_name
  created_at

messages
  id
  user_id
  chat_session_id
  direction: inbound | outbound
  from_email
  from_name
  to_email
  subject
  text_body
  provider_message_id
  client_request_id
  delivery_provider
  delivery_status: submitting | queued | delivered | permanent_bounce | failed | unknown
  delivery_details
  delivery_error_code
  delivery_error_message
  last_send_attempt_at
  processing_status: pending | leased | processed
  processed_at
  received_at
  sent_at
  created_at

user_identities
  id
  user_id
  provider
  provider_subject
  provider_organization
  created_at
  last_seen_at

chat_sessions
  id
  user_id
  provider
  provider_session
  provider_subject
  started_at
  last_seen_at

message_embeddings
  message_id
  embedding_model
  embedding vector
  created_at
```

Keep `users.id` as the internal primary key. Do not use OpenAI `_meta["openai/subject"]` or `_meta["openai/session"]` directly as primary keys. The OpenAI subject is an external anonymized user identifier and should be stored in `user_identities.provider_subject`; the OpenAI session is an external anonymized conversation identifier and should be stored in `chat_sessions.provider_session`.

This keeps email `messages.subject` unambiguous as the email subject line, allows the same internal user model to support local CLI identities, OpenAI Apps identities, and future OAuth identities, and lets messages optionally attach to a ChatGPT conversation through `chat_session_id`.

## LLM-First Product Principles

This product is designed for LLM callers, not for humans managing email in a
terminal. Product decisions should optimize for reliable context retrieval,
structured machine consumption, and agent retry behavior rather than imitate a
traditional email client.

Use these principles when designing CLI commands, service APIs, and MCP tools:

- Return stable structured JSON by default. Human-readable formatting may be
  offered as an explicit optional mode, but it should not define the service
  contract.
- Return complete text bodies from `inbox` by default so an LLM can retrieve and
  summarize new messages in one call. A metadata-only or compact mode may remain
  available when bodies are not needed.
- Treat `inbox` as the set of pending inbound messages, not as a folder. Do not
  introduce folders or duplicate human-oriented `read` and `unread` concepts
  unless a future machine workflow requires them.
- Model message lifecycle with processing terms such as `pending`, `leased`, and
  `processed`. Keep acknowledgement separate from retrieval so a failed model
  invocation does not silently remove a message from the next attempt.
- Support batch acknowledgement after successful processing. Keep processed
  messages available through history or search rather than moving them between
  mailbox folders.
- Bound every retrieval by message count and total content size, and provide a
  continuation cursor. An unexpectedly large inbox must not overflow an LLM's
  context window or prevent incremental processing.
- For `inbox`, default to at most 50 pending messages ordered oldest first. Also
  enforce a 100,000-character total text budget and a 16,000-character limit per
  message; whichever limit is reached first determines the batch size. Return
  `hasMore` and `nextCursor`, and explicitly mark any individually truncated
  message body. Allow callers to override the count and character budgets within
  safe server-defined maximums.
- Preserve message IDs and useful metadata with every body so the caller can
  cite, acknowledge, reply to, search for, or deduplicate individual messages.
- Treat all email fields and bodies as untrusted external data. Clearly separate
  them from tool instructions because inbound email can contain prompt-injection
  attempts.
- Prefer idempotent operations and explicit retry semantics. Multiple agents or
  repeated tool calls should not cause messages to be lost, duplicated, or
  acknowledged accidentally.

The intended default flow is: retrieve a bounded batch of full pending messages,
process or summarize them, then acknowledge the successfully handled message
IDs. Previously processed messages remain queryable through history and,
eventually, semantic search.

### Outbound Abuse Controls

Protect the shared sending domain at the application layer even though the
email provider also enforces account quotas and suppression lists. Anonymous
OpenAI subjects are useful pseudonymous identities, but they are not proof of a
durable registered account. OpenAI sessions are conversation identifiers and
must only be used as an additional burst boundary, never as the primary user
quota.

Apply these initial configurable limits:

| Limit | Guest | Registered |
| --- | ---: | ---: |
| Sends per hour | 3 | 10 |
| Sends per 24-hour bucket | 10 | 50 |
| New recipients per 24-hour bucket | 2 | 10 |
| Minimum interval between sends | 15 seconds | 5 seconds |
| Sends per session per hour | 3 | 10 |

Also enforce global limits of 20 sends per hour and 100 sends per day. Keep one
recipient per message, subject text at no more than 200 characters, and body
text at no more than 20,000 characters. Continue to prohibit caller-controlled
mail headers, sender addresses, HTML, and attachments.

- Registration upgrades the existing internal user; it must not create a fresh
  mailbox or reset usage. Multiple identities linked to one account share the
  same user quota.
- A recipient is new only when the user has no prior inbound or outbound
  relationship with that address. Replies do not consume the new-recipient
  allowance, but every first provider attempt consumes normal hourly and daily
  quota.
- Consume quota exactly once immediately before the first provider call. Count
  known failures and ambiguous outcomes. Do not count local validation failures
  or idempotent replays, and do not refund quota after a bounce. The built-in
  mock provider is exempt because it cannot affect domain reputation; custom
  test providers should exercise the normal enforcement path.
- Reserve quota, recipient state, and the idempotent outbound message in one
  database transaction. Persist policy rejections against the request ID so a
  retry returns the same structured result without reevaluating or sending.
- Enforce user suspension and a global outbound kill switch before contacting
  the provider. Return machine-readable rejection details including the limit
  type and retry time when applicable.
- Keep limits configurable, but never disable the global ceiling merely because
  per-user limits exist. Disposable anonymous identities make the global limit
  the final application-level protection.

### Registered Custom Aliases

Only registered users may replace their generated address with a custom alias.
Custom local parts must be 3-32 lowercase ASCII characters using letters,
numbers, dots, underscores, and hyphens, with no leading, trailing, or repeated
separators. Normalize aliases before checking reservations.

- Reserve Internet and system roles such as `postmaster`, `abuse`, `admin`,
  `support`, `security`, `billing`, `payments`, `root`, and `mailer-daemon`.
- Reserve the generated `u_` namespace so custom aliases cannot resemble
  anonymous system-assigned addresses.
- Reserve Shoot Email and infrastructure identities plus a focused list of
  commonly impersonated providers and brands. Reject obvious role or brand
  variants made with separators, numeric suffixes, or terms such as `official`,
  `support`, `security`, `service`, or `team`.
- Keep a configurable 30-day alias-change cooldown. Registration or an alias
  change must never reset outbound usage.
- Never release an alias after use. Retired aliases remain mapped to the same
  internal user for inbound delivery, while only the current alias is used as
  the outbound sender.
- Do not claim that a finite brand blocklist prevents all impersonation. Keep
  the mandatory `Name via Shoot Email` display format and support manual
  reservations or suspensions when abuse is discovered.

### LLM-First Outbound Contract

Outbound sending must be idempotent because an LLM may retry after a timeout.
Require a caller-generated UUID request ID and reserve the outbound message in
Postgres before contacting the provider. Enforce uniqueness on internal user ID
plus request ID.

- The first request creates a `submitting` message and performs one provider call.
- An identical retry returns the existing structured result with
  `idempotentReplay: true` and does not contact the provider.
- Reusing a request ID with different content returns
  `idempotency_key_reused` and never sends the changed message.
- Persist provider outcomes as `queued`, `delivered`, `permanent_bounce`,
  `failed`, or `unknown`.
- Treat network failures and server-side failures with ambiguous acceptance as
  `unknown`. Never retry an `unknown` request automatically because the provider
  may already have accepted it.
- Return stable JSON containing the internal message ID, request ID, provider,
  provider message ID, exact sender, recipients, subject, text, delivery status,
  delivery details, and timestamps. Never return provider credentials or raw
  authenticated requests.

## Suggested CLI Commands

```bash
mailbox init
mailbox address
mailbox identity show
mailbox identity set --display-name "Serguei"
mailbox identity clear
mailbox send --request-id <uuid> --to someone@example.com --subject "Hi" --text "Hello"
mailbox inbox
mailbox inbox --compact
mailbox acknowledge <message-id> [message-id...]
mailbox history
mailbox read <message-id>
```

## Implementation Boundary

Build a small backend/service boundary early rather than placing all behavior directly in CLI command handlers. This will make the later MCP server and ChatGPT app wrappers much easier.

The CLI should call service APIs/functions for:

- User initialization.
- Alias lookup.
- Outbound send.
- Inbox listing.
- Message reading.
- Webhook ingestion.

### MCP Boundary

Keep the MCP server as a thin adapter over the shared service layer. MCP tools
must resolve an internal user from authenticated OpenAI Apps metadata and pass
the internal `user.id` and optional `chat_session.id` into services; they must
never use the CLI local-config identity or accept subject/session as tool
arguments.

- Require the idempotent `shoot_email.initialize_mailbox` tool before any other
  mailbox tool provisions or accesses a mailbox.
- Keep migration, tier changes, suspensions, and abuse administration outside
  the user-facing MCP tool list.
- Return both MCP text content and the versioned structured service contract.
- Advertise a concrete `outputSchema` for every tool, including the common
  error envelope, because clients should be able to plan from discovery rather
  than infer response shapes from trial calls.
- Prefer discovery-visible discriminators for mutually exclusive operations;
  outbound status lookup uses `{ lookupBy, id }` rather than optional
  `messageId` and `requestId` fields with runtime-only XOR validation.
- Expose environment, server time, provider simulation state, and applicable
  session quota in service status, but do not expose internal user UUIDs.
- Describe pagination as live keyset pagination, not a snapshot, and expose
  explicit acknowledgement completion counts plus per-ID outcomes.
- Preserve untrusted-external labeling on every inbound email retrieval tool.
- Allow the environment-based development subject only for local stdio tests;
  never enable that fallback in production.
- Authenticate the future remote ChatGPT connection before trusting OpenAI
  identity metadata.
- Keep the hackathon bearer transport explicitly temporary. It must ignore
  caller-supplied identity metadata, isolate mailboxes by credential, auto-seed
  synthetic messages only, allow outbound contract testing only through the
  mock provider, and keep real outbound delivery disabled.

## Practical First Milestone

The first working milestone should prove:

1. A user can initialize a local mailbox.
2. The system assigns a stable email alias.
3. The user can send a text email through the mock provider, and later through Cloudflare Email Sending.
4. Cloudflare Email Routing can invoke a Worker that POSTs an inbound message to the backend webhook endpoint.
5. The webhook stores the inbound message.
6. The CLI can list and read stored inbound messages.

## Recommended Next Steps

Before adding more product features, add confidence around the current backend:

- Add database-backed integration tests for mailbox initialization, mock outbound send, webhook ingestion, inbox listing, and message reading.
- Add a clean test database workflow so future schema and service changes are safer.
- Add a local reset command or documented reset workflow for faster iteration.

After the current milestone is covered by tests, build the OpenAI Apps identity path:

- Add a service/API path that accepts OpenAI Apps context values: subject, session, and organization.
- Prove that subject maps to a stable internal user through `user_identities`.
- Prove that session maps to a stable conversation through `chat_sessions`.
- Add tests confirming repeated subject/session values reuse the same user and chat session.

After the identity path is tested, connect real Cloudflare Email Service:

- Configure Email Routing for the inbound domain.
- Deploy the `workers/email-router` Worker and route inbound aliases to it.
- Configure a verified sender or sending domain for Cloudflare Email Sending.
- Add webhook security checks between the Worker and backend.
- Test real outbound and inbound messages.
