import { test } from 'node:test';
import assert from 'node:assert/strict';
import { translateMessage, splitText } from '../src/translate.js';

test('browser translation protocol, cancellation and public-provider failures', async t => {
  await t.test('same-language text remains local', async () => {
    const stub = t.mock.method(globalThis, 'fetch', () => { throw new Error('unexpected network'); });
    assert.equal(await translateMessage('Ciao amici', 'it', 'it'), 'Ciao amici');
    assert.equal(await translateMessage('  ', 'it', 'ru'), '  ');
    assert.equal(stub.mock.callCount(), 0);
    stub.mock.restore();
  });
  await t.test('long Unicode messages retain all content within the byte limit', async () => {
    const text = ' Привіт, друзі! 🌍 '.repeat(200);
    const chunks = splitText(text);
    assert.equal(chunks.join(''), text);
    assert.ok(chunks.every(chunk => new TextEncoder().encode(chunk).byteLength <= 450));
    const calls = [];
    const stub = t.mock.method(globalThis, 'fetch', async url => {
      calls.push(new URL(url));
      return Response.json({ responseStatus: 200, responseData: { translatedText: new URL(url).searchParams.get('q') } });
    });
    assert.equal(await translateMessage(text, 'uk', 'it'), text);
    assert.ok(calls.length > 1);
    assert.ok(calls.every(url => url.origin === 'https://api.mymemory.translated.net' && url.searchParams.get('langpair') === 'uk|it'));
    stub.mock.restore();
  });
  await t.test('successful translations are decoded and cached in memory', async () => {
    const stub = t.mock.method(globalThis, 'fetch', async () => Response.json({ responseStatus: 200, responseData: { translatedText: 'Ciao &amp; benvenuti' } }));
    assert.equal(await translateMessage('Welcome cache test', 'en', 'it'), 'Ciao & benvenuti');
    assert.equal(await translateMessage('Welcome cache test', 'en', 'it'), 'Ciao & benvenuti');
    assert.equal(stub.mock.callCount(), 1);
    stub.mock.restore();
  });
  await t.test('all requested destination languages are passed to the provider', async () => {
    const requested = [];
    const stub = t.mock.method(globalThis, 'fetch', async url => {
      requested.push(new URL(url).searchParams.get('langpair'));
      return Response.json({ responseStatus: 200, responseData: { translatedText: 'Translated fixture' } });
    });
    for (const language of ['ru', 'es', 'uk', 'it']) await translateMessage(`Language check ${language}`, 'en', language);
    await translateMessage('Controllo inglese', 'it', 'en');
    assert.deepEqual(requested, ['en|ru', 'en|es', 'en|uk', 'en|it', 'it|en']);
    stub.mock.restore();
  });
  await t.test('quota and malformed provider output are never treated as translations', async () => {
    for (const [index, body] of [
      { responseStatus: 429, responseData: { translatedText: 'QUOTA EXHAUSTED' } },
      { responseStatus: 200, responseData: { translatedText: 'MYMEMORY WARNING: quota' } },
      { responseStatus: 200, responseData: {} },
    ].entries()) {
      const stub = t.mock.method(globalThis, 'fetch', async () => Response.json(body));
      await assert.rejects(translateMessage(`Failure check ${index}`, 'en', 'it'), { code: 'translation_unavailable' });
      stub.mock.restore();
    }
  });
  await t.test('closing a translation view cancels the in-flight request', async () => {
    const stub = t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    const controller = new AbortController();
    const pending = translateMessage('Cancellation check', 'en', 'it', { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    stub.mock.restore();
  });
});
