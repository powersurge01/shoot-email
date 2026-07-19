# ADR 001: Cloudflare Workers, Neon Postgres, and Hyperdrive

- Status: Accepted
- Date: 2026-07-19

## Context

Shoot Email already uses Cloudflare Email Routing and Email Sending, and the
account has a Workers Paid plan. The backend needs a stable HTTPS endpoint for
inbound webhooks and, later, authenticated remote MCP transport. The existing
data model depends on Postgres transactions, atomic quota locking, and pgvector.

## Decision

Use the following hosted architecture:

```text
Cloudflare Email Routing Worker
  -> Cloudflare backend Worker
    -> Cloudflare Hyperdrive (query caching disabled)
      -> Neon Postgres with pgvector

Cloudflare backend Worker
  -> Cloudflare Email Sending
  -> future authenticated remote MCP endpoint
```

- Run HTTP backend code on Cloudflare Workers Paid.
- Host Postgres on Neon and retain the existing SQL migrations and pgvector.
- Connect Workers to Neon through a Hyperdrive binding.
- Disable Hyperdrive query caching initially. Mailbox retrieval,
  acknowledgement, idempotency, and quota enforcement require read-after-write
  consistency.
- Create one `pg.Client` per Worker request and let Hyperdrive own connection
  pooling. Do not use a process-global `pg.Pool` in the Worker runtime.
- Use lock rows with `SELECT ... FOR UPDATE` for atomic outbound policy checks.
  Hyperdrive does not support PostgreSQL advisory locks.
- Continue using Docker Postgres and the pooled Node adapter for local CLI,
  migration, and integration-test workflows.
- Run schema migrations directly against Neon from a trusted local or CI
  environment. Never run migrations in request handlers.
- Keep the existing Email Routing Worker separate during the first deployment
  and update its webhook URL only after staging verification.
- Keep unauthenticated OpenAI context provisioning disabled on the hosted
  Worker. Remote MCP will be exposed only after its authentication milestone.
- Start staging with `MAIL_PROVIDER=mock` and outbound disabled. Enable real
  sending only during an intentional production cutover.

## Consequences

The service avoids another fixed compute-hosting charge and gains a stable edge
endpoint. Postgres remains an external dependency and must be provisioned and
backed up independently. The HTTP and database entry points require small
Worker adapters, but repositories and services remain shared with the CLI.

The deployment must fail readiness when Hyperdrive is absent or Neon is
unreachable. Liveness remains database-independent so platform health and
database health can be distinguished.

## Rejected Alternatives

- Render for both compute and Postgres: simpler runtime compatibility, but adds
  a second fixed hosting bill and duplicates capabilities already included in
  Workers Paid.
- Cloudflare D1 plus Vectorize: fully Cloudflare-native, but would replace
  Postgres transactions, lock-row quota coordination, migrations, and the
  pgvector roadmap.
- Direct Worker-to-Neon connections without Hyperdrive: workable, but gives up
  Cloudflare-managed pooling and connection reuse for globally distributed
  Worker invocations.
