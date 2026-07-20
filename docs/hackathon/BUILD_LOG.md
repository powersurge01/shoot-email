# Hackathon Build Log

## Pre-existing baseline

Shoot Email existed before the OpenAI Build Week submission period. The root
commit `7701077` is an explicit checkpoint of that pre-existing baseline, not a
claim that all files in it were created during the hackathon.

That baseline already included:

- The terminal CLI and versioned LLM-first service contract.
- Local stdio MCP tools and two recorded black-box evaluations.
- PostgreSQL migrations, pgvector readiness, idempotent inbound/outbound data
  handling, and outbound abuse controls.
- Cloudflare Email Routing and Email Sending integrations.
- A Cloudflare backend Worker connected to Neon through Hyperdrive.

Supporting pre-existing evidence is preserved in:

- `shoot-email-cli-black-box-evaluation.md`
- `shoot-email-mcp-conversation.md`
- `docs/adr/001-cloudflare-workers-neon-hyperdrive.md`

## Build Week extension

The hackathon extension is developed on `feat/remote-mcp-demo` after the
baseline checkpoint. It adds:

- A stateless Streamable HTTP MCP endpoint for Cloudflare Workers.
- Bearer authentication that resolves a server-controlled request principal.
- Per-credential isolated demo mailboxes that ignore spoofed `_meta` identity.
- Automatic one-time seeding of three synthetic landlord replies for the
  apartment-hunting demo.
- A deliberate prompt-injection email demonstrating that message content is
  untrusted data.
- Worker-level auth and protocol tests plus database-backed identity and seeding
  tests.
- Judge instructions, a hosted demo, and a documented OAuth 2.1 production
  follow-up.

The resulting hackathon demo release is version `0.2.0`.

Commit timestamps and the branch diff from `7701077` provide the authoritative
record of work added during the submission period.

## Codex evidence

The repository records product decisions in `AGENTS.md` and preserves prior
black-box sessions listed above. The Devpost submission must also include the
actual `/feedback` Codex Session ID for the task where the majority of the
hackathon extension was built. Record the model shown by Codex in the
submission materials; do not infer or substitute a model name in this file.
