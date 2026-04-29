import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

const FILE_PATH = 'data/settings.json';
mkdirSync(dirname(FILE_PATH), { recursive: true });

const DEFAULTS = {
  mode: 'manual',          // 'auto' | 'manual' | 'off'
  max_seconds: 300,
  language: 'pl',          // null = auto-wykrywanie, np. 'pl' = polski
  allowed_role_id: null,   // null = wszyscy
  reply_ephemeral: 0,      // 0 publicznie, 1 prywatnie
  short_auto_enabled: 0,   // 0 = off (domyslnie), 1 = on
  short_auto_interval_hours: 4,
  short_auto_channel_id: null,
  short_auto_min_messages: 30,
  short_auto_last_run_at: 0,
  short_topic_min_messages: 7,
};

function load() {
  if (!existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FILE_PATH, 'utf8')) || {};
  } catch (err) {
    console.error('Nie udało się wczytać settings.json — używam pustej konfiguracji:', err.message);
    return {};
  }
}

const cache = load();

function persist() {
  const tmp = FILE_PATH + '.tmp';
  writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
  renameSync(tmp, FILE_PATH); // atomowy zapis
}

export function getSettings(guildId) {
  const stored = cache[guildId] ?? {};
  return { guild_id: guildId, ...DEFAULTS, ...stored };
}

export function updateSettings(guildId, partial) {
  const current = getSettings(guildId);
  const merged = { ...current, ...partial };
  const { guild_id, ...rest } = merged;
  cache[guildId] = rest;
  persist();
  return merged;
}
