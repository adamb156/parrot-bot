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

function getSummaryProvider() {
  if (process.env.OPENAI_API_KEY) return 'openai';
  if (process.env.GROQ_API_KEY) return 'groq';
  throw new Error('Brak klucza do podsumowan. Ustaw OPENAI_API_KEY albo GROQ_API_KEY w .env');
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

/**
 * @param {Array<{author: string, content: string}>} messages
 * @param {number} periodHours
 * @param {number} topicMinMessages
 * @returns {Promise<string>}
 */
export async function summarizeChatMessages(messages, periodHours, topicMinMessages = 7) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Brak wiadomosci do podsumowania.';
  }

  const providerForSummary = getSummaryProvider();
  const lines = [];
  let currentSize = 0;
  const MAX_CHARS = 45000;

  for (const msg of messages) {
    const line = `${msg.content}`.trim();
    if (!line) continue;
    if (currentSize + line.length + 1 > MAX_CHARS) break;
    lines.push(line);
    currentSize += line.length + 1;
  }

  if (!lines.length) {
    return 'Brak tresci tekstowej do podsumowania.';
  }

  const systemPrompt =
    'Jestes analitykiem rozmow Discord. Tworzysz tylko najwazniejsze tematy rozmowy, bez drobnych ciekawostek. '
    + 'Kazdy temat opisujesz JEDNYM zdaniem i nigdy nie piszesz kto cos napisal.';

  const targetSentences = Math.max(2, Math.min(10, Math.round(periodHours)));
  const minTopicMessages = Math.max(2, Math.min(30, Math.floor(topicMinMessages || 7)));
  const userPrompt = [
    `Okres rozmowy: ostatnie ${periodHours}h.`,
    `Masz zwrocic ${targetSentences} najwazniejszych tematow w punktach.`,
    'Wymagania:',
    '- Jedno zdanie = jeden temat.',
    `- Uwzgledniaj tylko tematy, w ktorych pojawilo sie minimum ${minTopicMessages} wiadomosci.`,
    '- Wybieraj tematy, ktore mialy wyraznie wiecej wiadomosci.',
    '- Pomijaj malo istotne detale i pojedyncze wzmianki.',
    '- Nie podawaj autorow, nickow ani informacji kto cos napisal.',
    '- Odpowiedz po polsku.',
    `- Jesli zaden temat nie spelnia progu ${minTopicMessages} wiadomosci, odpowiedz dokladnie: "Brak tematow spelniajacych prog ${minTopicMessages} wiadomosci."`,
    '',
    'Wiadomosci:',
    lines.join('\n'),
  ].join('\n');

  if (providerForSummary === 'groq') {
    return await summarizeGroq(systemPrompt, userPrompt);
  }
  return await summarizeOpenAI(systemPrompt, userPrompt);
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

async function summarizeOpenAI(systemPrompt, userPrompt) {
  const client = getOpenAI();
  const model = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini';
  const result = await client.chat.completions.create({
    model,
    temperature: 0.2,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
  });

  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model nie zwrocil tresci podsumowania.');
  return text;
}

async function summarizeGroq(systemPrompt, userPrompt) {
  const model = process.env.GROQ_SUMMARY_MODEL || 'llama-3.3-70b-versatile';
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Brak GROQ_API_KEY w .env');

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API ${res.status}: ${errText}`);
  }
  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model nie zwrocil tresci podsumowania.');
  return text;
}
