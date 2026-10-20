import { decode } from 'html-entities';

const languages = new Set(['en', 'ru', 'es', 'uk', 'it']);
const encoder = new TextEncoder();
const cache = new Map();
const pending = [];
let running = 0;

function unavailable(code = 'translation_unavailable') {
  const error = new Error(code);
  error.code = code;
  return error;
}

export function splitText(text, maxBytes = 450) {
  if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new Error('invalid_chunk_size');
  const result = [];
  let chunk = '', size = 0;
  for (const token of text.match(/\s+|\S+/gu) || []) {
    const bytes = encoder.encode(token).byteLength;
    if (size && size + bytes > maxBytes) { result.push(chunk); chunk = ''; size = 0; }
    if (bytes <= maxBytes) { chunk += token; size += bytes; continue; }
    for (const character of token) {
      const length = encoder.encode(character).byteLength;
      if (size + length > maxBytes) { result.push(chunk); chunk = ''; size = 0; }
      chunk += character; size += length;
    }
  }
  if (chunk) result.push(chunk);
  return result;
}

function drain() {
  while (running < 3 && pending.length) {
    running++;
    const next = pending.shift();
    next().finally(() => { running--; drain(); });
  }
}

async function requestTranslation(text, source, target, signal) {
  let output = '';
  for (const chunk of splitText(text)) {
    signal?.throwIfAborted();
    const leading = chunk.match(/^\s*/u)[0];
    const trailing = chunk.match(/\s*$/u)[0];
    const content = chunk.slice(leading.length, chunk.length - trailing.length || undefined);
    if (!content.trim()) { output += chunk; continue; }
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const onAbort = () => controller.abort();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const url = new URL('https://api.mymemory.translated.net/get');
      url.searchParams.set('q', content);
      url.searchParams.set('langpair', `${source}|${target}`);
      const response = await fetch(url, { signal: controller.signal, referrerPolicy: 'no-referrer', headers: { Accept: 'application/json' } });
      if (!response.ok) throw unavailable();
      const data = await response.json();
      const translated = data?.responseData?.translatedText;
      if (Number(data?.responseStatus) !== 200 || typeof translated !== 'string' || !translated.trim() || /^MYMEMORY\s+(WARNING|ERROR)\s*:/i.test(translated)) throw unavailable();
      output += leading + decode(translated).trim() + trailing;
    } catch (error) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw unavailable();
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
    }
  }
  return output;
}

export async function translateMessage(text, source, target, { signal } = {}) {
  if (typeof text !== 'string' || !languages.has(source) || !languages.has(target) || text.length > 8000) throw unavailable();
  signal?.throwIfAborted();
  if (!text.trim() || source === target) return text;
  // Only completed translations are cached: cancellation in one view must not
  // cancel another view's request. This bounded cache lives only in RAM.
  const key = JSON.stringify([text, source, target]);
  if (cache.has(key)) return cache.get(key);
  return new Promise((resolve, reject) => {
    pending.push(async () => {
      try {
        const translated = await requestTranslation(text, source, target, signal);
        cache.set(key, translated);
        if (cache.size > 200) cache.delete(cache.keys().next().value);
        resolve(translated);
      } catch (error) { reject(error); }
    });
    drain();
  });
}
