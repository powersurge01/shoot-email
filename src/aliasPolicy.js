const SYSTEM_AND_ROLE_NAMES = new Set([
  'abuse',
  'accounts',
  'admin',
  'administrator',
  'billing',
  'help',
  'hostmaster',
  'mail',
  'mailerdaemon',
  'noreply',
  'payments',
  'postmaster',
  'root',
  'security',
  'support',
  'system',
  'webmaster',
]);

const PLATFORM_AND_BRAND_NAMES = new Set([
  'amazon',
  'apple',
  'chatgpt',
  'cfbounce',
  'cloudflare',
  'coinbase',
  'facebook',
  'gmail',
  'google',
  'instagram',
  'meta',
  'microsoft',
  'openai',
  'outlook',
  'paypal',
  'shootemail',
  'stripe',
  'twitter',
  'whatsapp',
  'yoyowza',
]);

const ROLE_SUFFIXES = [
  'account',
  'desk',
  'mail',
  'official',
  'service',
  'services',
  'team',
];

const BRAND_SUFFIXES = [
  'admin',
  'billing',
  'help',
  'mail',
  'official',
  'security',
  'service',
  'support',
  'team',
];

export function normalizeCustomAlias(value, domain) {
  if (typeof value !== 'string') {
    throw aliasError('invalid_alias', 'alias must be a string.');
  }

  const localPart = value.normalize('NFKC').trim().toLowerCase();
  if (localPart.includes('@')) {
    throw aliasError('invalid_alias', 'Enter only the part before the @ sign.');
  }
  if (localPart.length < 3 || localPart.length > 32) {
    throw aliasError('invalid_alias', 'alias must contain 3 to 32 characters.');
  }
  if (!/^[a-z0-9][a-z0-9._-]*[a-z0-9]$/.test(localPart)) {
    throw aliasError(
      'invalid_alias',
      'alias may contain lowercase ASCII letters, numbers, dots, underscores, and hyphens.',
    );
  }
  if (/[._-]{2}/.test(localPart)) {
    throw aliasError('invalid_alias', 'alias cannot contain consecutive separators.');
  }
  if (localPart.startsWith('u_')) {
    throw aliasError(
      'reserved_alias',
      'Aliases beginning with u_ are reserved for generated addresses.',
    );
  }

  const canonical = canonicalizeAlias(localPart);
  if (isReservedCanonicalAlias(canonical)) {
    throw aliasError('reserved_alias', 'That alias is reserved and cannot be claimed.');
  }

  return {
    localPart,
    email: `${localPart}@${domain.toLowerCase()}`,
  };
}

export function isReservedAlias(value) {
  if (typeof value !== 'string') return false;
  const normalized = value.normalize('NFKC').toLowerCase();
  return normalized.startsWith('u_')
    || isReservedCanonicalAlias(canonicalizeAlias(normalized));
}

function isReservedCanonicalAlias(canonical) {
  if (SYSTEM_AND_ROLE_NAMES.has(canonical) || PLATFORM_AND_BRAND_NAMES.has(canonical)) {
    return true;
  }

  for (const role of SYSTEM_AND_ROLE_NAMES) {
    if (canonical.startsWith(role)) {
      const suffix = canonical.slice(role.length);
      if (/^\d+$/.test(suffix) || ROLE_SUFFIXES.includes(suffix)) return true;
    }
  }
  for (const brand of PLATFORM_AND_BRAND_NAMES) {
    if (canonical.startsWith(brand)) {
      const suffix = canonical.slice(brand.length);
      if (/^\d+$/.test(suffix) || BRAND_SUFFIXES.includes(suffix)) return true;
    }
  }
  return false;
}

function canonicalizeAlias(value) {
  return value.replaceAll('.', '').replaceAll('_', '').replaceAll('-', '');
}

function aliasError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
