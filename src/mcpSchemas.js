import { z } from 'zod';
import {
  CONTRACT_VERSION,
  MESSAGE_BATCH_DEFAULTS,
  MESSAGE_BATCH_MAXIMUMS,
  OUTBOUND_CONSTRAINTS,
} from './contract.js';

const isoDateTime = z.iso.datetime();
const nullableDateTime = isoDateTime.nullable();
const contractError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retryAt: isoDateTime.optional(),
  limitType: z.string().optional(),
  guidance: z.string().optional(),
});
const toolEnvelope = {
  contractVersion: z.literal(CONTRACT_VERSION),
  ok: z.boolean(),
  error: contractError.nullable(),
};

const senderIdentity = z.object({
  address: z.email(),
  displayName: z.string().nullable(),
  senderName: z.string(),
  formatted: z.string(),
});

const deliveryError = z.object({
  code: z.string(),
  message: z.string(),
  retryable: z.boolean(),
  retryAt: isoDateTime.optional(),
  limitType: z.string().optional(),
  guidance: z.string().optional(),
}).nullable();

const outboundMessage = z.object({
  id: z.uuid(),
  direction: z.literal('outbound'),
  requestId: z.uuid(),
  provider: z.string(),
  simulated: z.boolean(),
  providerMessageId: z.string().nullable(),
  from: z.object({
    address: z.email(),
    name: z.string().nullable(),
  }),
  to: z.array(z.email()).length(1),
  subject: z.string(),
  text: z.string().optional(),
  deliveryStatus: z.enum([
    'submitting',
    'queued',
    'delivered',
    'permanent_bounce',
    'failed',
    'unknown',
    'rejected',
  ]),
  deliveryDetails: z.record(z.string(), z.unknown()),
  deliveryError,
  createdAt: isoDateTime,
  providerAttemptedAt: nullableDateTime,
  providerResultAt: nullableDateTime,
});

const inboundBatchMessage = z.object({
  id: z.uuid(),
  from: z.email(),
  fromName: z.string().nullable(),
  to: z.array(z.email()).length(1),
  subject: z.string(),
  text: z.string(),
  receivedAt: nullableDateTime,
  createdAt: isoDateTime,
  processingStatus: z.enum(['pending', 'leased', 'processed']),
  providerMessageId: z.string().nullable(),
  contentTrust: z.literal('untrusted_external'),
  bodyTruncated: z.boolean(),
  originalBodyChars: z.number().int().nonnegative(),
  returnedBodyChars: z.number().int().nonnegative(),
});

const outboundBatchMessage = outboundMessage.extend({
  text: z.string(),
  bodyTruncated: z.boolean(),
  originalBodyChars: z.number().int().nonnegative(),
  returnedBodyChars: z.number().int().nonnegative(),
});

const inboundStoredMessage = z.object({
  id: z.uuid(),
  direction: z.literal('inbound'),
  from: z.object({
    address: z.email(),
    name: z.string().nullable(),
  }),
  to: z.array(z.email()).length(1),
  subject: z.string(),
  text: z.string(),
  providerMessageId: z.string().nullable(),
  receivedAt: nullableDateTime,
  createdAt: isoDateTime,
  processingStatus: z.enum(['pending', 'leased', 'processed']),
  processedAt: nullableDateTime,
  contentTrust: z.literal('untrusted_external'),
});

const batchLimits = z.object({
  limit: z.number().int().positive(),
  maxChars: z.number().int().positive(),
  maxMessageChars: z.number().int().positive(),
});

const batchPage = z.object({
  order: z.array(z.object({
    field: z.enum(['createdAt', 'id']),
    direction: z.enum(['ascending', 'descending']),
  })).length(2),
  cursorVersion: z.literal(1),
  snapshot: z.literal(false),
  cursorExpiresAt: z.null(),
  retrievalChangesProcessingState: z.literal(false),
  consistency: z.object({
    mode: z.literal('live_keyset'),
    guarantee: z.string(),
    duplicateRiskFromNewArrivals: z.literal(false),
    omissionRiskFromStateChanges: z.literal(true),
  }),
  defaults: batchLimits,
  maximums: batchLimits,
});

function batchOutput(messageSchema) {
  return z.object({
    ...toolEnvelope,
    messages: z.array(messageSchema).optional(),
    returnedCount: z.number().int().nonnegative().optional(),
    returnedChars: z.number().int().nonnegative().optional(),
    hasMore: z.boolean().optional(),
    nextCursor: z.string().nullable().optional(),
    page: batchPage.optional(),
  });
}

const quota = z.object({
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
  resetAt: isoDateTime,
});

export const mcpOutputSchemas = {
  initializeMailbox: z.object({
    ...toolEnvelope,
    created: z.boolean().optional(),
    mailbox: senderIdentity.optional(),
  }),
  serviceStatus: z.object({
    ...toolEnvelope,
    service: z.object({
      name: z.literal('shoot-email'),
      version: z.string(),
      contractVersion: z.literal(CONTRACT_VERSION),
      environment: z.enum(['development', 'test', 'staging', 'production']),
      serverTime: isoDateTime,
    }).optional(),
    provider: z.object({
      name: z.string(),
      mode: z.enum(['simulation', 'production']),
      simulated: z.boolean(),
      configured: z.boolean(),
    }).optional(),
    outbound: z.object({
      enabled: z.boolean(),
      available: z.boolean(),
      abuseControlsEnforced: z.boolean(),
      sendingStatus: z.enum(['active', 'suspended']),
      suspensionReason: z.string().nullable(),
      latestAttemptAt: nullableDateTime,
    }).optional(),
    identity: senderIdentity.optional(),
    account: z.object({ tier: z.enum(['guest', 'registered']) }).optional(),
    quotas: z.object({
      globalHourly: quota,
      globalDaily: quota,
      userHourly: quota,
      userDaily: quota,
      newRecipientsDaily: quota,
      sessionHourly: quota.nullable(),
      minimumIntervalSeconds: z.number().int().positive(),
    }).optional(),
    constraints: z.object({
      outbound: z.object({
        recipientsPerMessage: z.literal(OUTBOUND_CONSTRAINTS.recipientsPerMessage),
        subjectMaxChars: z.literal(OUTBOUND_CONSTRAINTS.subjectMaxChars),
        textMaxChars: z.literal(OUTBOUND_CONSTRAINTS.textMaxChars),
      }),
      retrieval: z.object({
        defaults: z.object({
          limit: z.literal(MESSAGE_BATCH_DEFAULTS.limit),
          maxChars: z.literal(MESSAGE_BATCH_DEFAULTS.maxChars),
          maxMessageChars: z.literal(MESSAGE_BATCH_DEFAULTS.maxMessageChars),
        }),
        maximums: z.object({
          limit: z.literal(MESSAGE_BATCH_MAXIMUMS.limit),
          maxChars: z.literal(MESSAGE_BATCH_MAXIMUMS.maxChars),
          maxMessageChars: z.literal(MESSAGE_BATCH_MAXIMUMS.maxMessageChars),
        }),
      }),
    }).optional(),
  }),
  mailboxIdentity: z.object({
    ...toolEnvelope,
    identity: senderIdentity.optional(),
  }),
  sendTextEmail: z.object({
    ...toolEnvelope,
    idempotentReplay: z.boolean().optional(),
    existingRequest: z.boolean().optional(),
    providerCalled: z.boolean().optional(),
    simulated: z.boolean().optional(),
    message: outboundMessage.extend({ text: z.string() }).nullable().optional(),
    existingMessage: outboundMessage.extend({ text: z.string() }).optional(),
  }),
  inboundBatch: batchOutput(inboundBatchMessage),
  outboundBatch: batchOutput(outboundBatchMessage),
  acknowledgeMessages: z.object({
    ...toolEnvelope,
    idempotent: z.literal(true).optional(),
    batchSemantics: z.literal('partial_by_id').optional(),
    allSucceeded: z.boolean().optional(),
    requestedCount: z.number().int().positive().optional(),
    successfulCount: z.number().int().nonnegative().optional(),
    acknowledged: z.array(z.uuid()).optional(),
    alreadyProcessed: z.array(z.uuid()).optional(),
    notFound: z.array(z.uuid()).optional(),
    outcomes: z.array(z.object({
      id: z.uuid(),
      outcome: z.enum(['acknowledged', 'already_processed', 'not_found']),
    })).optional(),
  }),
  getMessage: z.object({
    ...toolEnvelope,
    retrievalChangedProcessingState: z.literal(false).optional(),
    message: z.union([
      inboundStoredMessage,
      outboundMessage.extend({ text: z.string() }),
    ]).optional(),
  }),
  outboundStatus: z.object({
    ...toolEnvelope,
    statusLookup: z.literal(true).optional(),
    providerCalled: z.literal(false).optional(),
    simulated: z.boolean().optional(),
    message: outboundMessage.extend({ text: z.string() }).optional(),
    deliveryError: deliveryError.optional(),
  }),
};
