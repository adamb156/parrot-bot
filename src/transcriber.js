import OpenAI from 'openai';
import { fetch } from 'undici';

const provider = (process.env.TRANSCRIBE_PROVIDER || 'openai').toLowerCase();

let openaiClient = null;
function getOpenAI() {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  }
  return openaiClient;
}

/**
 * @param {string} url - URL załącznika z Discorda
 * @param {string} filename
 * @param {string|null} language - kod ISO np. 'pl' lub null = auto
 * @returns {Promise<{text: string, language?: string, durationSec?: number}>}
 */
export async function transcribeFromUrl(url, filename, language = null) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Nie udało się pobrać pliku (${res.status})`);
  const buf = Buffer.from(await res.arrayBuffer());

  // OpenAI SDK akceptuje File (web). Nodowy File jest dostępny od v20.
  const file = new File([buf], filename, { type: 'audio/ogg' });

  if (provider === 'groq') {
    return await transcribeGroq(file, language);
  }
  return await transcribeOpenAI(file, language);
}

async function transcribeOpenAI(file, language) {
  const client = getOpenAI();
  const model = process.env.OPENAI_MODEL || 'whisper-1';
  const result = await client.audio.transcriptions.create({
    file,
    model,
    language: language || undefined,
    response_format: 'verbose_json',
  });
  return {
    text: result.text?.trim() ?? '',
    language: result.language,
    durationSec: result.duration,
  };
}

async function transcribeGroq(file, language) {
  const model = process.env.GROQ_MODEL || 'whisper-large-v3';
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Brak GROQ_API_KEY w .env');

  const form = new FormData();
  form.append('file', file);
  form.append('model', model);
  form.append('response_format', 'verbose_json');
  if (language) form.append('language', language);

  const res = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  return {
    text: (data.text || '').trim(),
    language: data.language,
    durationSec: data.duration,
  };
}
