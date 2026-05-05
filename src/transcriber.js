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
export async function summarizeChatMessages(messages, periodHours, topicMinMessages = 4) {
  if (!Array.isArray(messages) || messages.length === 0) {
    return 'Brak wiadomosci do podsumowania.';
  }

  const providerForSummary = getSummaryProvider();
  const indexedLines = [];
  let currentSize = 0;
  const MAX_CHARS = 45000;
  let currentIndex = 1;

  for (const msg of messages) {
    const line = `${msg.content}`.trim();
    if (!line) continue;
    const indexed = `[${currentIndex}] ${line}`;
    if (currentSize + indexed.length + 1 > MAX_CHARS) break;
    indexedLines.push(indexed);
    currentSize += indexed.length + 1;
    currentIndex += 1;
  }

  if (!indexedLines.length) {
    return 'Brak tresci tekstowej do podsumowania.';
  }

  const minTopicMessages = Math.max(2, Math.min(30, Math.floor(topicMinMessages || 4)));
  const targetSentences = Math.max(2, Math.min(10, Math.round(periodHours)));

  const clusters = providerForSummary === 'groq'
    ? await clusterTopicsGroq(indexedLines)
    : await clusterTopicsOpenAI(indexedLines);

  const normalized = (clusters.topics || [])
    .map((t) => {
      const uniqueIndexes = [...new Set((t.messageIndexes || []).filter((n) => Number.isInteger(n) && n > 0))];
      return {
        name: (t.name || '').trim(),
        summary: (t.summary || '').trim(),
        messageIndexes: uniqueIndexes,
        count: uniqueIndexes.length,
      };
    })
    .filter((t) => t.summary && t.count >= 2)
    .sort((a, b) => b.count - a.count);

  const meetingThreshold = normalized.filter((t) => t.count >= minTopicMessages);
  let chosen = meetingThreshold.slice(0, targetSentences);
  let belowThreshold = false;

  if (!chosen.length) {
    chosen = normalized.slice(0, targetSentences);
    belowThreshold = chosen.length > 0;
  }

  if (!chosen.length) {
    return 'Nie udalo sie wyodrebnic zadnych tematow z tej rozmowy.';
  }

  const header = belowThreshold
    ? `(brak tematow z >= ${minTopicMessages} wiadomosci, pokazuje najwieksze)\n`
    : '';
  const lines = chosen.map((t) => `- ${enforceSingleSentence(t.summary)} (${t.count} wiadomosci)`);
  return header + lines.join('\n');
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

function topicClusteringPrompts(indexedLines) {
  const systemPrompt = [
    'Jestes analitykiem rozmow grupowych.',
    'Zadanie: przypisz kazda wiadomosc do tematu, nawet gdy watki sa przeplatane czasowo.',
    'Nie podawaj autorow ani nickow.',
    'Zwroc TYLKO poprawny JSON bez markdown.',
  ].join(' ');

  const userPrompt = [
    'Wejscie to lista wiadomosci z indeksami.',
    'Wymagania klasyfikacji:',
    '- Grupuj wiadomosci semantycznie (ten sam temat), nawet jesli sa porozrzucane.',
    '- Krotkie reakcje, pytania doprecyzowujace i potwierdzenia (np. "tak", "jasne", "hahah") tez naleza do tematu, do ktorego sie odnosza - dolacz je do najblizszego watku.',
    '- Jedna wiadomosc moze nalezec maksymalnie do jednego glownego tematu.',
    '- Pomijaj jedynie wiadomosci kompletnie niezwiazane z zadnym watkiem (czysty offtop pojedynczy).',
    '- Dla kazdego tematu daj jedno zdanie podsumowania po polsku.',
    '- Nie uzywaj informacji kto co napisal.',
    '',
    'Format JSON:',
    '{"topics":[{"name":"...","summary":"...","messageIndexes":[1,4,10]}]}',
    '',
    'Wiadomosci:',
    indexedLines.join('\n'),
  ].join('\n');

  return { systemPrompt, userPrompt };
}

async function clusterTopicsOpenAI(indexedLines) {
  const client = getOpenAI();
  const model = process.env.OPENAI_SUMMARY_MODEL || 'gpt-4o-mini';
  const prompts = topicClusteringPrompts(indexedLines);
  const result = await client.chat.completions.create({
    model,
    temperature: 0.1,
    messages: [
      { role: 'system', content: prompts.systemPrompt },
      { role: 'user', content: prompts.userPrompt },
    ],
  });
  const text = result.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model nie zwrocil danych klasyfikacji tematow.');
  return parseTopicJson(text);
}

async function clusterTopicsGroq(indexedLines) {
  const model = process.env.GROQ_SUMMARY_MODEL || 'llama-3.3-70b-versatile';
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error('Brak GROQ_API_KEY w .env');

  const prompts = topicClusteringPrompts(indexedLines);
  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      messages: [
        { role: 'system', content: prompts.systemPrompt },
        { role: 'user', content: prompts.userPrompt },
      ],
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Groq API ${res.status}: ${errText}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  if (!text) throw new Error('Model nie zwrocil danych klasyfikacji tematow.');
  return parseTopicJson(text);
}

function parseTopicJson(raw) {
  try {
    const parsed = JSON.parse(raw);
    if (parsed && Array.isArray(parsed.topics)) return parsed;
  } catch {}

  const jsonStart = raw.indexOf('{');
  const jsonEnd = raw.lastIndexOf('}');
  if (jsonStart >= 0 && jsonEnd > jsonStart) {
    const fragment = raw.slice(jsonStart, jsonEnd + 1);
    const parsed = JSON.parse(fragment);
    if (parsed && Array.isArray(parsed.topics)) return parsed;
  }

  throw new Error('Nie udalo sie sparsowac klasyfikacji tematow (JSON).');
}

function enforceSingleSentence(text) {
  const cleaned = (text || '').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  const parts = cleaned.split(/[.!?]+/).map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return cleaned;
  return `${parts[0]}.`;
}
