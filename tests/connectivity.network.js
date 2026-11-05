import { test, expect } from '@playwright/test';
import { createHash } from 'node:crypto';
import { getT, languages } from '../src/i18n.js';

const t = getT('it');

function invitationHash(url) {
  try { return new URL(url).hash; }
  catch { throw new Error('The app returned an invalid invitation URL.'); }
}

async function instrumentConnectivity(context, disableRtc) {
  await context.addInitScript(({ disableRtc }) => {
    const connections = [];
    const sockets = { created: 0, opened: 0, closed: 0, errors: 0 };
    const externalSockets = { created: 0, opened: 0, closed: 0, errors: 0 };
    let blockedPeerConnections = 0;
    let pageErrors = 0;
    addEventListener('error', () => { pageErrors++; });
    addEventListener('unhandledrejection', () => { pageErrors++; });
    const NativePeerConnection = globalThis.RTCPeerConnection;
    if (disableRtc) {
      globalThis.RTCPeerConnection = class {
        constructor() {
          blockedPeerConnections++;
          throw new DOMException('WebRTC is unavailable in this network regression.', 'NotSupportedError');
        }
      };
    } else if (NativePeerConnection) {
      globalThis.RTCPeerConnection = class extends NativePeerConnection {
        constructor(...args) {
          super(...args);
          const record = { connection: this, candidates: { host: 0, srflx: 0, prflx: 0, relay: 0 } };
          connections.push(record);
          this.addEventListener('icecandidate', ({ candidate }) => {
            if (candidate && Object.hasOwn(record.candidates, candidate.type)) record.candidates[candidate.type]++;
          });
        }
      };
    }
    const NativeWebSocket = globalThis.WebSocket;
    globalThis.WebSocket = class extends NativeWebSocket {
      constructor(...args) {
        super(...args);
        let external = false;
        try { external = new URL(args[0], location.href).host !== location.host; } catch { /* Native WebSocket validates the URL. */ }
        const counters = external ? [sockets, externalSockets] : [sockets];
        for (const counter of counters) counter.created++;
        this.addEventListener('open', () => { for (const counter of counters) counter.opened++; });
        this.addEventListener('close', () => { for (const counter of counters) counter.closed++; });
        this.addEventListener('error', () => { for (const counter of counters) counter.errors++; });
      }
    };
    // Return counts and states only: never record URLs, candidates, SDP, or credentials.
    globalThis.__connectivitySummary = () => ({
      peerConnectionAvailable: Boolean(NativePeerConnection),
      blockedPeerConnections,
      webSockets: { ...sockets },
      externalWebSockets: { ...externalSockets },
      pageErrors,
      peers: connections.map(({ connection, candidates }) => ({
        connectionState: connection.connectionState,
        iceConnectionState: connection.iceConnectionState,
        iceGatheringState: connection.iceGatheringState,
        candidates: { ...candidates },
      })),
    });
  }, { disableRtc });
}

async function join(page, nickname, url) {
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch {
    // Playwright's default navigation error includes the complete invitation URL.
    throw new Error('The network-test page could not be loaded.');
  }
  await page.getByRole('radio').filter({ hasText: languages.find(language => language.code === 'it').nativeName }).click();
  await page.getByRole('button', { name: t('continue'), exact: true }).click();
  await page.getByLabel(t('nicknameLabel'), { exact: true }).fill(nickname);
  await page.getByRole('button', { name: t('joinChat'), exact: true }).click();
  await expect(page.getByRole('heading', { name: t('roomName'), exact: true })).toBeVisible();
}

async function send(page, text) {
  await page.getByRole('textbox', { name: t('sendMessage'), exact: true }).fill(text);
  await page.getByRole('button', { name: t('send'), exact: true }).click();
}

async function verifyFolderShare(owner, guest) {
  await owner.locator('.folders-open-button').click();
  await guest.locator('.folders-open-button').click();
  const ownDialog = owner.getByRole('dialog', { name: t('foldersTitle'), exact: true });
  const guestDialog = guest.getByRole('dialog', { name: t('foldersTitle'), exact: true });
  const contents = 'Piano condiviso tramite il trasporto di rete reale.';
  await ownDialog.locator('input[webkitdirectory]').evaluate((input, contents) => {
    const file = new File([contents], 'network-plan.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'webkitRelativePath', { value: 'Network folder/Plans/network-plan.txt' });
    const selection = new DataTransfer();
    selection.items.add(file);
    input.files = selection.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, contents);
  await expect(ownDialog.locator('.folder-selection-preview')).toContainText('Network folder');
  await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
  await ownDialog.getByRole('button', { name: t('foldersShare'), exact: true }).click();
  await expect(guestDialog.locator('.folder-root')).toHaveCount(1);
  await guestDialog.locator('.folder-root').click();
  await guestDialog.getByRole('button', { name: `${t('foldersBrowse')}: Plans`, exact: true }).click();
  await expect(guestDialog.locator('.folder-list')).toContainText('network-plan.txt');
  const downloadEvent = guest.waitForEvent('download', { timeout: 20_000 });
  await guestDialog.getByRole('button', { name: `${t('foldersDownload')}: network-plan.txt`, exact: true }).click();
  const downloaded = await downloadEvent;
  const stream = await downloaded.createReadStream();
  expect(Boolean(stream), 'The shared-folder download must provide a readable result.').toBe(true);
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString('utf8')).toBe(contents);
  await ownDialog.getByRole('button', { name: t('foldersStop'), exact: true }).click();
  await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
  await expect(guestDialog.locator('.folder-list')).toHaveCount(0);
  await expect(guestDialog.getByText(t('foldersRevoked'), { exact: true })).toBeVisible();
}

async function verifyExternalConversation(browser, testInfo, disableRtc) {
  const startedAt = Date.now();
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  let first;
  let second;
  let completed = false;
  let lastSummaries = [{ summaryUnavailable: true }, { summaryUnavailable: true }];
  try {
    await Promise.all([instrumentConnectivity(firstContext, disableRtc), instrumentConnectivity(secondContext, disableRtc)]);
    first = await firstContext.newPage();
    second = await secondContext.newPage();
    await join(first, 'NetworkOne', testInfo.project.use.baseURL);
    await first.locator('.invite-header-button').click();
    const invitation = await first.locator('#invitation-url').inputValue();
    const hash = invitationHash(invitation);
    expect(/^#room=[a-f0-9]{32}&key=[a-f0-9]{64}$/iu.test(hash), 'The invitation must contain a room and its key.').toBe(true);
    await first.getByRole('button', { name: t('close'), exact: true }).last().click();
    await join(second, 'NetworkTwo', invitation);
    expect(invitationHash(first.url()) === hash && invitationHash(second.url()) === hash, 'Both browsers must retain the same invitation.').toBe(true);
    await expect.poll(async () => {
      const results = await Promise.all([first, second].map(async page => ({
        count: await page.locator('.people-list .person').count(),
        summary: await page.evaluate(() => globalThis.__connectivitySummary()),
      })));
      lastSummaries = results.map(result => result.summary);
      return results.map(result => result.count);
    }, {
      message: 'Both invited browsers must discover each other.',
      intervals: [500, 1000, 2000],
      // Leave time to collect safe diagnostics even with a shorter CLI timeout.
      timeout: Math.min(120_000, Math.max(1000, testInfo.timeout - (Date.now() - startedAt) - 15_000)),
    }).toEqual([2, 2]);
    expect(lastSummaries.map(summary => summary.externalWebSockets.opened > 0),
      'Each browser must open a real external WebSocket.').toEqual([true, true]);
    // Both participants use Italian, so this exercises no translation provider.
    await send(first, 'Messaggio di rete dal primo partecipante.');
    await expect(second.getByRole('log').getByText('Messaggio di rete dal primo partecipante.', { exact: true })).toBeVisible({ timeout: 15_000 });
    await send(second, 'Risposta di rete dal secondo partecipante.');
    await expect(first.getByRole('log').getByText('Risposta di rete dal secondo partecipante.', { exact: true })).toBeVisible({ timeout: 15_000 });
    if (!disableRtc) {
      const payload = Buffer.alloc(1024 * 1024, 61);
      await first.locator('input[type=file]').setInputFiles({ name: 'network-payload.bin', mimeType: 'application/octet-stream', buffer: payload });
      await first.getByRole('button', { name: t('send'), exact: true }).click();
      const download = second.getByRole('link', { name: `${t('downloadFile')}: network-payload.bin`, exact: true });
      await expect(download).toBeVisible({ timeout: 30_000 });
      const received = await download.evaluate(async element => {
        const bytes = await (await fetch(element.href)).arrayBuffer();
        const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
        return { size: bytes.byteLength, sha256: [...digest].map(byte => byte.toString(16).padStart(2, '0')).join('') };
      });
      expect(received).toEqual({ size: payload.length, sha256: createHash('sha256').update(payload).digest('hex') });

      await firstContext.setOffline(true);
      const retry = first.getByRole('button', { name: t('retryConnection'), exact: true });
      await expect(retry).toBeVisible({ timeout: 10_000 });
      await retry.click();
      await firstContext.setOffline(false);
      await Promise.all([
        expect(first.locator('.people-list .person')).toHaveCount(2),
        expect(second.locator('.people-list .person')).toHaveCount(2),
        expect(first.getByRole('textbox', { name: t('sendMessage'), exact: true })).toBeEnabled(),
      ]);
      expect(invitationHash(first.url()) === hash && invitationHash(second.url()) === hash,
        'A retry must preserve the original invitation in both browsers.').toBe(true);
      await send(first, 'Messaggio dopo il ripristino della connessione.');
      await expect(second.getByRole('log').getByText('Messaggio dopo il ripristino della connessione.', { exact: true })).toBeVisible({ timeout: 15_000 });
      await verifyFolderShare(first, second);
    }
    completed = true;
  } finally {
    if (!completed) {
      const summaries = await Promise.allSettled([first, second].map(async page => page && !page.isClosed()
        ? page.evaluate(() => globalThis.__connectivitySummary?.() || { summaryUnavailable: true })
        : { summaryUnavailable: true }));
      const diagnostics = JSON.stringify(summaries.map((result, index) => result.status === 'fulfilled' ? result.value : lastSummaries[index]), null, 2);
      console.error('Network connectivity counts and states:', diagnostics);
      await testInfo.attach('connectivity-summary', {
        body: diagnostics,
        contentType: 'application/json',
      });
    }
    await Promise.allSettled([firstContext.close(), secondContext.close()]);
  }
}

test('real external transport connects an invitation and exchanges messages in both directions', async ({ browser }, testInfo) => {
  await verifyExternalConversation(browser, testInfo, false);
});

test('real external transport exchanges messages when WebRTC is unavailable', async ({ browser }, testInfo) => {
  await verifyExternalConversation(browser, testInfo, true);
});
