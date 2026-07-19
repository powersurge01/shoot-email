import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const endpoint = process.env.REMOTE_MCP_URL
  || 'https://shoot-email-backend.powersurge.workers.dev/mcp';
const token = process.env.SHOOT_EMAIL_DEMO_TOKEN;

if (!token) {
  throw new Error('SHOOT_EMAIL_DEMO_TOKEN is required.');
}

const client = new Client({ name: 'shoot-email-remote-smoke', version: '1.0.0' });
const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const tools = await client.listTools();
  const initialized = await client.callTool({ name: 'initialize_mailbox', arguments: {} });
  const status = await client.callTool({ name: 'get_service_status', arguments: {} });
  const inbox = await client.callTool({ name: 'list_pending_messages', arguments: {} });
  console.log(JSON.stringify({
    ok: initialized.structuredContent?.ok === true
      && status.structuredContent?.ok === true
      && inbox.structuredContent?.ok === true,
    endpoint,
    toolCount: tools.tools.length,
    mailbox: initialized.structuredContent?.mailbox?.address,
    providerMode: status.structuredContent?.provider?.mode,
    outboundEnabled: status.structuredContent?.outbound?.enabled,
    pendingCount: inbox.structuredContent?.messages?.length,
    subjects: inbox.structuredContent?.messages?.map((message) => message.subject),
  }, null, 2));
} finally {
  await client.close();
}
