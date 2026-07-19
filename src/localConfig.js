import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function getConfigDir() {
  return process.env.SHOOT_EMAIL_CONFIG_DIR || path.join(os.homedir(), '.shoot-email');
}

function getConfigPath() {
  return path.join(getConfigDir(), 'config.json');
}

export async function readLocalConfig() {
  try {
    const raw = await fs.readFile(getConfigPath(), 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === 'ENOENT') {
      return {};
    }

    throw error;
  }
}

export async function writeLocalConfig(config) {
  await fs.mkdir(getConfigDir(), { recursive: true, mode: 0o700 });
  await fs.writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
}

export function getLocalConfigPath() {
  return getConfigPath();
}
