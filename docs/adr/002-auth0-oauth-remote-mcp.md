# ADR 002: Auth0 OAuth for Remote MCP

## Status

Accepted for the post-hackathon OAuth staging deployment.

## Context

The Build Week deployment uses a restricted static bearer credential, an
isolated synthetic mailbox, the mock provider, and a real-delivery kill switch.
That boundary is suitable only for judge testing. A remote MCP endpoint needs a
standards-based authorization flow before it can represent real users.

## Decision

Use Auth0 as the OAuth authorization server and keep the Cloudflare Worker as
the OAuth resource server. Deploy this work as the separate
`shoot-email-auth-staging` Worker so the submitted judge endpoint remains
unchanged.

The Auth0 API identifier and MCP resource URI are both:

```text
https://shoot-email-auth-staging.powersurge.workers.dev/mcp
```

Auth0 issues one-hour, RS256-signed RFC 9068 access tokens. The Worker validates
the signature through the tenant JWKS endpoint and verifies issuer, audience,
expiration, and scopes on every MCP request. It publishes RFC 9728 protected
resource metadata at both discovery paths:

```text
/.well-known/oauth-protected-resource
/.well-known/oauth-protected-resource/mcp
```

The Auth0 tenant has Client ID Metadata Document registration enabled and uses
the `compatibility` resource-parameter profile. This lets MCP clients present a
metadata-document URL as their client ID and lets Auth0 interpret the OAuth
`resource` parameter as the API audience when `audience` is absent.

The initial scopes are:

| Scope | Capability |
| --- | --- |
| `mailbox:read` | Connect, initialize a mailbox, and retrieve mailbox data |
| `mailbox:send` | Call `send_text_email` |
| `mailbox:acknowledge` | Call `acknowledge_messages` |

All MCP requests require `mailbox:read`. Send and acknowledgement calls also
require their operation-specific scope. Missing or invalid tokens return 401
with a protected-resource challenge; insufficient scopes return 403.

The trusted identity is derived only from validated token claims. The Auth0
`sub` maps to `user_identities.provider_subject`, while the provider includes
the Auth0 tenant hostname. An optional `org_id` maps to
`provider_organization`. Tool arguments and OpenAI metadata cannot override
this identity. Auth0 token values and client secrets are never stored in the
database or returned through MCP.

## Consequences

- Auth0 owns login, consent, PKCE, token issuance, and refresh-token policy.
- The Worker remains stateless and stores no Auth0 client secret.
- Existing OpenAI Apps, local CLI, and judge-demo identities continue to use
  the same internal user and mailbox services without sharing identity keys.
- Client registration compatibility still needs an end-to-end test with the
  target ChatGPT or Codex OAuth client. Auth0 Client ID Metadata Document and
  resource-parameter settings may need tenant-level configuration for that
  client.
- Real outbound delivery remains disabled in OAuth staging until authentication
  and abuse-control tests pass.
