# Hackathon Testing

The hosted judge demo is a stateless Streamable HTTP MCP server backed by Neon
Postgres. It is intentionally restricted: outbound sends are simulated by the
`mock` provider, real delivery is disabled, and every new demo identity
receives three synthetic landlord replies for the apartment-hunting scenario.

`send_text_email` permits demo principals only while `MAIL_PROVIDER=mock`. It
rejects them in code if the deployment is ever switched to a real provider,
independently of the deployment-level outbound flag.

The submission testing instructions provide `SHOOT_EMAIL_DEMO_SECRET`
separately. It is not committed to the repository. Create an isolated mailbox
credential by appending a random client key:

```bash
export SHOOT_EMAIL_DEMO_TOKEN="${SHOOT_EMAIL_DEMO_SECRET}.$(openssl rand -hex 8)"
```

Keep that environment variable available when launching Codex. Register the
remote server:

```bash
codex mcp remove shoot-email-demo 2>/dev/null || true
codex mcp add shoot-email-demo \
  --url https://shoot-email-backend.powersurge.workers.dev/mcp \
  --bearer-token-env-var SHOOT_EMAIL_DEMO_TOKEN
codex
```

Suggested black-box prompts for a fresh Codex task:

1. `Initialize my Shoot Email mailbox, then inspect service status and confirm that outbound delivery is simulated.`
2. `Send three simulated tour requests with unique request IDs: "Tour request: Launch in Alameda" to launch-leasing@example.com, "Tour request: 930 Pacific Avenue, Unit 4D" to pacific-manager@example.org, and "Tour request: Alameda Park Apartments" to alameda-park-leasing@example.net. Ask what showing times are available July 25 or 26, 2026. Sign each message Serguei.`
3. `Check my Shoot Email inbox for landlord replies. Compare all available showing times, identify anything I need to bring, and propose a conflict-free tour schedule. Cite each message ID and do not acknowledge anything yet.`
4. `Draft concise confirmation replies for the recommended appointments, but do not send them.`
5. `Acknowledge the three landlord replies, then verify that the pending inbox is empty and the messages appear in processed history.`
6. `List the outbound tour requests and verify that every result used the mock provider with simulated set to true.`

Each random credential suffix maps to a separate server-controlled demo
principal. Reusing the same complete credential returns the same mailbox.
Changing the suffix creates a fresh mailbox and seeds a fresh synthetic inbox.

This bearer scheme is a time-limited hackathon testing boundary, not production
end-user authentication. The production follow-up is OAuth 2.1 with verified
issuer, audience, expiry, and scopes. Caller-provided `_meta` identity is
ignored by the hosted demo transport.

## Local Verification

With Docker Desktop running:

```bash
npm install
docker compose up -d postgres
npm test
npm run backend:build
```

The default suite covers the CLI, stdio MCP adapter, Streamable HTTP transport,
trusted-principal isolation, inbox processing, idempotency, abuse controls,
Cloudflare Worker handlers, and Postgres migrations.
