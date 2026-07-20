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
  const initialized = await client.callTool({
    name: 'shoot_email.initialize_mailbox',
    arguments: {},
  });
  const status = await client.callTool({ name: 'get_service_status', arguments: {} });
  const inbox = await client.callTool({
    name: 'shoot_email.check_inbox',
    arguments: {},
  });
  let simulatedSend = null;
  if (process.env.REMOTE_MCP_SMOKE_SEND === 'true') {
    const requestId = crypto.randomUUID();
    const send = await client.callTool({
      name: 'send_text_email',
      arguments: {
        requestId,
        to: 'demo-recipient@example.com',
        subject: 'MailBridge remote MCP smoke test',
        text: 'This is a simulated message. No external email should be delivered.',
      },
    });
    const replay = await client.callTool({
      name: 'send_text_email',
      arguments: {
        requestId,
        to: 'demo-recipient@example.com',
        subject: 'MailBridge remote MCP smoke test',
        text: 'This is a simulated message. No external email should be delivered.',
      },
    });
    const outboundStatus = await client.callTool({
      name: 'get_outbound_message_status',
      arguments: { lookupBy: 'requestId', id: requestId },
    });
    simulatedSend = {
      ok: send.structuredContent?.ok === true,
      simulated: send.structuredContent?.simulated === true,
      provider: send.structuredContent?.message?.provider,
      providerCalled: send.structuredContent?.providerCalled,
      replayed: replay.structuredContent?.idempotentReplay === true,
      replayProviderCalled: replay.structuredContent?.providerCalled,
      status: outboundStatus.structuredContent?.message?.deliveryStatus,
    };
  }
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
    simulatedSend,
  }, null, 2));
} finally {
  await client.close();
}
