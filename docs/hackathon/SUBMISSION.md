# Shoot Email Devpost Submission Draft

## Submission Details

- **Project name:** Shoot Email
- **Track:** Developer Tools
- **Tagline:** A persistent email inbox built for AI agents.
- **Repository:** https://github.com/powersurge01/shoot-email
- **Demo video:** https://youtu.be/TXODrUYFxyM
- **Hosted MCP:** https://shoot-email-backend.powersurge.workers.dev/mcp
- **Primary Codex Session ID:** `019f3f17-7a7f-7c01-87e6-4506263733ad`
- **Model:** GPT-5.6 Sol

## Elevator Pitch

Shoot Email gives ChatGPT a real email inbox, allowing an AI agent to send and
receive text messages, preserve message history, process replies, and continue
real-world communication through a structured MCP interface.

## Inspiration

Current AI assistants can read connected email and help draft a response, but
many workflows still stop at the draft. A person must send the message, watch
for replies, decide what to do next, and keep the conversation moving.

Shoot Email explores what email would look like if it were designed from the
ground up for AI agents rather than around a human inbox interface. The goal is
to make email a durable capability that an agent can operate safely, not merely
a source of text it can summarize.

## What It Does

Shoot Email assigns an agent a stable mailbox identity and exposes ten MCP
tools for initializing the mailbox, inspecting identity and service state,
sending text email, retrieving pending messages, reading individual messages,
acknowledging completed work, inspecting processed history, and checking
outbound delivery state.

The contract is LLM-first:

- Inbox retrieval returns bounded batches with complete message text.
- Retrieval never silently marks messages handled.
- Inbound email is explicitly labeled as untrusted external data.
- Outbound sends require caller-generated idempotency keys.
- Repeated or concurrent retries cannot accidentally send duplicate messages.
- Stable structured responses expose pagination, partial success, simulated
  delivery, and retry state.

The video demonstrates an apartment search. GPT-5.6 Sol sends three simulated
tour inquiries, reads three landlord replies, compares the available times and
appointment requirements, and proposes a conflict-free weekend schedule.

## How It Was Built

The CLI and MCP adapter share one Node.js service layer and versioned contract.
Cloudflare Email Routing invokes an Email Worker for real inbound messages.
The durable backend runs on Cloudflare Workers and reaches Neon Postgres through
Hyperdrive. PostgreSQL stores users, external identities, sessions, messages,
delivery state, abuse-control state, and future pgvector embeddings. Real
outbound delivery uses Cloudflare Email Sending.

The public judge environment uses the same hosted MCP, service, database, and
idempotency paths, but forces outbound delivery through a mock provider. Each
private credential suffix receives an isolated synthetic mailbox. Demo
principals are rejected in code if the deployment is ever switched to a real
provider.

## How Codex and GPT-5.6 Were Used

Codex with GPT-5.6 Sol was the engineering collaborator for the Build Week
extension. It inspected and tested the pre-existing codebase, researched MCP,
Cloudflare, Neon, and OpenAI platform behavior, implemented the authenticated
remote MCP transport, extended contract tests, deployed the Worker, and ran
fresh-session black-box evaluations. Those evaluations exposed tool-discovery,
acknowledgement, identity, and simulated-send issues that were then hardened in
the implementation.

GPT-5.6 Sol is also the runtime reasoning layer shown in the demo. It converts
a high-level goal into MCP calls, generates unique request IDs, composes
property-specific inquiries, interprets untrusted email replies, and recommends
the next action. Shoot Email remains responsible for durable state, identity,
provider boundaries, and retry guarantees.

The project existed before Build Week. The pre-existing baseline is checkpointed
at commit `7701077`; `docs/hackathon/BUILD_LOG.md` documents the meaningful
extension added during the submission period.

## Challenges

The main challenge was designing email operations for probabilistic callers.
An LLM may retry after a timeout, lose context after reading a message, or treat
hostile email text as instructions. The service therefore separates retrieval
from acknowledgement, persists outbound requests before provider calls, returns
unknown status for ambiguous provider outcomes, and never accepts identity or
mail headers as ordinary tool arguments.

Remote identity was another important boundary. The hackathon demo uses a
restricted bearer principal supplied by the server and ignores caller-provided
OpenAI metadata. This provides an isolated judge sandbox without pretending to
be the final production authentication design.

## Accomplishments

- A working hosted Streamable HTTP MCP service with ten structured tools.
- Real Cloudflare inbound routing and outbound provider integration.
- Neon Postgres persistence through Cloudflare Hyperdrive.
- Idempotent inbound ingestion and outbound send behavior.
- Explicit pending, processed, and delivery-state contracts for agents.
- Configurable abuse controls and a real-delivery kill switch.
- A safe, isolated judge demo that requires no local rebuild.
- Forty-nine automated unit and database-backed integration tests.

## What We Learned

An agent-native email system needs different primitives from a conventional
mail client. Reliable retries, bounded context, explicit acknowledgement, and
clear trust labels matter more than folders or visual read/unread state. MCP
metadata is also part of the product interface: tool names, schemas, and
descriptions materially affect whether an agent discovers and uses a capability
correctly.

## What's Next

The next production milestone is OAuth 2.1 for remote MCP authentication,
replacing the temporary judge bearer transport without changing the service or
tool contracts. Later milestones include registered accounts, production
custom aliases, delivery-event ingestion, semantic search with pgvector, and
carefully bounded autonomous follow-up workflows.

## Judge Testing Instructions

The private Devpost testing field must include the base demo secret. Do not
commit it to this repository.

```text
SHOOT_EMAIL_DEMO_SECRET=<provide privately in Devpost testing instructions>
```

Judges can append any random suffix to create an isolated mailbox and follow
the exact setup and prompts in `docs/hackathon/TESTING.md`. The demo uses only
synthetic addresses and simulated outbound delivery.
