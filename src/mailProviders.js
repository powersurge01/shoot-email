import crypto from 'node:crypto';
import { getConfig } from './config.js';

export function createMailProvider() {
  const config = getConfig();

  if (config.mailProvider === 'cloudflare') {
    return new CloudflareMailProvider(config);
  }

  return new MockMailProvider();
}

export class MockMailProvider {
  name = 'mock';
  isTestProvider = true;

  resolveSender({ fromEmail, fromName }) {
    return { email: fromEmail, name: fromName };
  }

  async send({ fromEmail, fromName, toEmail, subject, textBody }) {
    return {
      provider: 'mock',
      providerMessageId: `mock-${crypto.randomUUID()}`,
      deliveryStatus: 'delivered',
      deliveryDetails: {
        simulated: true,
        delivered: [toEmail],
        queued: [],
        permanentBounces: [],
      },
      submittedAt: new Date(),
      fromEmail,
      fromName,
      toEmail,
      subject,
      textBody,
    };
  }
}

export class CloudflareMailProvider {
  name = 'cloudflare';

  constructor(config) {
    this.config = config;
  }

  resolveSender({ fromEmail, fromName }) {
    return {
      email: this.config.cloudflareFromEmail || fromEmail,
      name: fromName,
    };
  }

  async send({ fromEmail, fromName, toEmail, subject, textBody }) {
    if (!this.config.cloudflareAccountId) {
      throw new Error('CLOUDFLARE_ACCOUNT_ID is required when MAIL_PROVIDER=cloudflare');
    }

    if (!this.config.cloudflareApiToken) {
      throw new Error(
        'CLOUDFLARE_EMAIL_API_TOKEN is required when MAIL_PROVIDER=cloudflare',
      );
    }

    const sender = this.resolveSender({ fromEmail, fromName });

    let response;
    try {
      response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${this.config.cloudflareAccountId}/email/sending/send`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.config.cloudflareApiToken}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: sender.name
              ? { address: sender.email, name: sender.name }
              : sender.email,
            to: toEmail,
            subject,
            text: textBody,
          }),
        },
      );
    } catch (error) {
      throw new MailProviderError('Cloudflare send outcome is unknown.', {
        code: 'network_error',
        outcomeKnown: false,
        cause: error,
      });
    }

    const body = await response.json().catch(() => ({}));

    if (!response.ok || body.success === false) {
      const providerError = body.errors?.[0];
      throw new MailProviderError(
        providerError?.message || `Cloudflare send failed with HTTP ${response.status}.`,
        {
          code: providerError?.code?.toString() || `http_${response.status}`,
          outcomeKnown: response.status < 500,
        },
      );
    }

    const deliveryDetails = {
      delivered: body.result?.delivered || [],
      queued: body.result?.queued || [],
      permanentBounces: body.result?.permanent_bounces || [],
    };
    const providerMessageId = body.result?.message_id || null;
    const deliveryStatus = getDeliveryStatus(
      deliveryDetails,
      toEmail,
      providerMessageId,
    );

    return {
      provider: 'cloudflare',
      providerMessageId,
      deliveryStatus,
      deliveryDetails,
      submittedAt: new Date(),
      fromEmail: sender.email,
      fromName: sender.name,
      toEmail,
      subject,
      textBody,
    };
  }
}

export class MailProviderError extends Error {
  constructor(message, { code, outcomeKnown, cause } = {}) {
    super(message, { cause });
    this.name = 'MailProviderError';
    this.code = code || 'provider_error';
    this.outcomeKnown = outcomeKnown === true;
  }
}

function getDeliveryStatus(details, recipient, providerMessageId) {
  if (details.permanentBounces.includes(recipient)) {
    return 'permanent_bounce';
  }
  if (details.delivered.includes(recipient)) {
    return 'delivered';
  }
  if (details.queued.includes(recipient)) {
    return 'queued';
  }
  if (providerMessageId) {
    return 'queued';
  }
  return 'unknown';
}
