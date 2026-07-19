import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export function getConfig() {
  return {
    environment: readEnvironment(),
    databaseUrl:
      process.env.DATABASE_URL ||
      'postgres://shoot_email:shoot_email@localhost:5432/shoot_email',
    inboundDomain: process.env.INBOUND_DOMAIN || 'in.localhost',
    mailProvider: process.env.MAIL_PROVIDER || 'mock',
    cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    cloudflareApiToken:
      process.env.CLOUDFLARE_EMAIL_API_TOKEN
      || process.env.CLOUDFLARE_API_TOKEN
      || '',
    cloudflareFromEmail: process.env.CLOUDFLARE_FROM_EMAIL || '',
    inboundWebhookToken: process.env.INBOUND_WEBHOOK_TOKEN || '',
    port: Number(process.env.PORT || 3000),
    customAliasChangeCooldownDays: parsePositiveInteger(
      process.env.CUSTOM_ALIAS_CHANGE_COOLDOWN_DAYS,
      30,
    ),
    outboundAbuse: {
      enabled: parseBoolean(process.env.OUTBOUND_SENDING_ENABLED, true),
      global: {
        hourlyLimit: parsePositiveInteger(
          process.env.OUTBOUND_GLOBAL_HOURLY_LIMIT,
          20,
        ),
        dailyLimit: parsePositiveInteger(
          process.env.OUTBOUND_GLOBAL_DAILY_LIMIT,
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
  const value = process.env.SHOOT_EMAIL_ENV
    || (process.env.NODE_ENV === 'test' ? 'test' : null)
    || (process.env.NODE_ENV === 'production' ? 'production' : 'development');
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
      process.env[`OUTBOUND_${tier}_HOURLY_LIMIT`],
      defaults.hourlyLimit,
    ),
    dailyLimit: parsePositiveInteger(
      process.env[`OUTBOUND_${tier}_DAILY_LIMIT`],
      defaults.dailyLimit,
    ),
    newRecipientDailyLimit: parsePositiveInteger(
      process.env[`OUTBOUND_${tier}_NEW_RECIPIENT_DAILY_LIMIT`],
      defaults.newRecipientDailyLimit,
    ),
    minimumIntervalSeconds: parsePositiveInteger(
      process.env[`OUTBOUND_${tier}_MIN_INTERVAL_SECONDS`],
      defaults.minimumIntervalSeconds,
    ),
    sessionHourlyLimit: parsePositiveInteger(
      process.env[`OUTBOUND_${tier}_SESSION_HOURLY_LIMIT`],
      defaults.sessionHourlyLimit,
    ),
  };
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
