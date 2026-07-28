import dotenv from 'dotenv';
import { AsyncLocalStorage } from 'node:async_hooks';

dotenv.config({ quiet: true });

const environmentStorage = new AsyncLocalStorage();

export function runWithConfigEnvironment(environment, callback) {
  return environmentStorage.run(environment, callback);
}

export function getConfig() {
  return {
    environment: readEnvironment(),
    databaseUrl:
      readValue('DATABASE_URL') ||
      'postgres://shoot_email:shoot_email@localhost:5432/shoot_email',
    inboundDomain: readValue('INBOUND_DOMAIN') || 'in.localhost',
    mailProvider: readValue('MAIL_PROVIDER') || 'mock',
    cloudflareAccountId: readValue('CLOUDFLARE_ACCOUNT_ID') || '',
    cloudflareApiToken:
      readValue('CLOUDFLARE_EMAIL_API_TOKEN')
      || readValue('CLOUDFLARE_API_TOKEN')
      || '',
    cloudflareFromEmail: readValue('CLOUDFLARE_FROM_EMAIL') || '',
    inboundWebhookToken: readValue('INBOUND_WEBHOOK_TOKEN') || '',
    port: Number(readValue('PORT') || 3000),
    customAliasChangeCooldownDays: parsePositiveInteger(
      readValue('CUSTOM_ALIAS_CHANGE_COOLDOWN_DAYS'),
      30,
    ),
    outboundAbuse: {
      enabled: parseBoolean(readValue('OUTBOUND_SENDING_ENABLED'), true),
      global: {
        hourlyLimit: parsePositiveInteger(
          readValue('OUTBOUND_GLOBAL_HOURLY_LIMIT'),
          20,
        ),
        dailyLimit: parsePositiveInteger(
          readValue('OUTBOUND_GLOBAL_DAILY_LIMIT'),
          100,
        ),
      },
      guest: readTierLimits('GUEST', {
        hourlyLimit: 3,
        dailyLimit: 10,
        newRecipientDailyLimit: 2,
        minimumIntervalSeconds: 15,
        sessionHourlyLimit: 3,
      }),
      registered: readTierLimits('REGISTERED', {
        hourlyLimit: 10,
        dailyLimit: 50,
        newRecipientDailyLimit: 10,
        minimumIntervalSeconds: 5,
        sessionHourlyLimit: 10,
      }),
    },
  };
}

function readEnvironment() {
  const nodeEnvironment = readValue('NODE_ENV');
  const value = readValue('SHOOT_EMAIL_ENV')
    || (nodeEnvironment === 'test' ? 'test' : null)
    || (nodeEnvironment === 'production' ? 'production' : 'development');
  if (!['development', 'test', 'staging', 'production'].includes(value)) {
    throw new Error(
      `SHOOT_EMAIL_ENV must be development, test, staging, or production; received "${value}".`,
    );
  }
  return value;
}

function readTierLimits(tier, defaults) {
  return {
    hourlyLimit: parsePositiveInteger(
      readValue(`OUTBOUND_${tier}_HOURLY_LIMIT`),
      defaults.hourlyLimit,
    ),
    dailyLimit: parsePositiveInteger(
      readValue(`OUTBOUND_${tier}_DAILY_LIMIT`),
      defaults.dailyLimit,
    ),
    newRecipientDailyLimit: parsePositiveInteger(
      readValue(`OUTBOUND_${tier}_NEW_RECIPIENT_DAILY_LIMIT`),
      defaults.newRecipientDailyLimit,
    ),
    minimumIntervalSeconds: parsePositiveInteger(
      readValue(`OUTBOUND_${tier}_MIN_INTERVAL_SECONDS`),
      defaults.minimumIntervalSeconds,
    ),
    sessionHourlyLimit: parsePositiveInteger(
      readValue(`OUTBOUND_${tier}_SESSION_HOURLY_LIMIT`),
      defaults.sessionHourlyLimit,
    ),
  };
}

function readValue(name) {
  const requestEnvironment = environmentStorage.getStore();
  return requestEnvironment?.[name] ?? process.env[name];
}

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Expected a positive integer configuration value; received "${value}".`);
  }
  return parsed;
}

function parseBoolean(value, fallback) {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error(`Expected "true" or "false"; received "${value}".`);
}
