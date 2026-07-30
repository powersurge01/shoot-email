#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const execFileAsync = promisify(execFile);
const AUTH0_CLI_TIMEOUT_MS = 15_000;

export function auditDcrApplications(applications, {
  warnAt = 5,
  failAt = 8,
} = {}) {
  if (!Array.isArray(applications)) {
    throw new Error('Auth0 application input must be a JSON array.');
  }
  if (!Number.isInteger(warnAt) || !Number.isInteger(failAt) || warnAt < 1 || failAt <= warnAt) {
    throw new Error('DCR thresholds must be positive integers with failAt greater than warnAt.');
  }

  const clients = applications
    .filter((application) => (
      typeof application?.client_id === 'string'
      && application.client_id.startsWith('tpc_')
    ))
    .map((application) => ({
      name: application.name || 'Unnamed client',
      clientId: application.client_id,
      callbacks: Array.isArray(application.callbacks) ? application.callbacks : [],
      updatedAt: application.updated_at || null,
    }));
  const callbackGroups = new Map();
  for (const client of clients) {
    for (const callback of client.callbacks) {
      const fingerprint = callbackFingerprint(callback);
      if (!fingerprint) continue;
      const group = callbackGroups.get(fingerprint) || [];
      group.push(client.clientId);
      callbackGroups.set(fingerprint, group);
    }
  }
  const repeatedCallbackFamilies = [...callbackGroups.entries()]
    .filter(([, clientIds]) => clientIds.length > 1)
    .map(([fingerprint, clientIds]) => ({ fingerprint, clientIds }))
    .sort((left, right) => left.fingerprint.localeCompare(right.fingerprint));
  const level = clients.length >= failAt
    ? 'critical'
    : clients.length >= warnAt
      ? 'warning'
      : 'ok';

  return {
    ok: level !== 'critical',
    level,
    totalApplications: applications.length,
    dynamicClientRegistrations: clients.length,
    thresholds: { warnAt, failAt },
    clients,
    repeatedCallbackFamilies,
    guidance: [
      'This audit never deletes Auth0 applications.',
      'Confirm the corresponding MCP connection is logged out before deleting a tpc_ client.',
      'Treat repeated callback families as review candidates, not proof that a client is abandoned.',
    ],
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const applications = options.file
    ? JSON.parse(await fs.readFile(options.file, 'utf8'))
    : await readAuth0Applications();
  const result = auditDcrApplications(applications, options);
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 2;
}

async function readAuth0Applications() {
  try {
    const { stdout } = await execFileAsync(
      'auth0',
      ['apps', 'list', '--number', '1000', '--json'],
      {
        maxBuffer: 10_000_000,
        timeout: AUTH0_CLI_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    return JSON.parse(stdout);
  } catch (error) {
    const timedOut = error?.killed && error?.signal === 'SIGTERM';
    const wrapped = new Error(
      timedOut
        ? 'Auth0 CLI did not respond within 15 seconds. Refresh `auth0 login`, then retry, or pass --file <apps.json>.'
        : 'Unable to read Auth0 applications. Run `auth0 login`, then retry, or pass --file <apps.json>.',
    );
    wrapped.cause = error;
    throw wrapped;
  }
}

function parseArgs(args) {
  const options = { warnAt: 5, failAt: 8, file: null };
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === '--file') options.file = requiredValue(args, ++index, argument);
    else if (argument === '--warn-at') {
      options.warnAt = parseThreshold(requiredValue(args, ++index, argument), argument);
    } else if (argument === '--fail-at') {
      options.failAt = parseThreshold(requiredValue(args, ++index, argument), argument);
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function requiredValue(args, index, flag) {
  if (!args[index]) throw new Error(`${flag} requires a value.`);
  return args[index];
}

function parseThreshold(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${flag} must be a positive integer.`);
  }
  return parsed;
}

function callbackFingerprint(callback) {
  try {
    const url = new URL(callback);
    const marker = '/callback/';
    const offset = url.pathname.indexOf(marker);
    return offset >= 0 ? url.pathname.slice(offset + marker.length) : url.pathname;
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch((error) => {
    console.error(JSON.stringify({
      ok: false,
      error: {
        code: 'auth0_dcr_audit_failed',
        message: error.message,
      },
    }, null, 2));
    process.exitCode = 1;
  });
}
