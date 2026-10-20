import { test, expect } from '@playwright/test';
import { getT, languages } from '../src/i18n.js';

async function mockTranslations(context) {
  await context.route('https://api.mymemory.translated.net/**', async route => {
    const url = new URL(route.request().url());
    const text = url.searchParams.get('q');
    const target = url.searchParams.get('langpair').split('|')[1];
    if (text === 'provider unavailable') return route.fulfill({ json: { responseStatus: 429, responseData: { translatedText: 'Quota exceeded' } } });
    const hello = { en: 'Hello Erasmus friends!', es: '¡Hola, amigos de Erasmus!', ru: 'Привет, друзья по Эразмусу!', uk: 'Привіт, друзі з Еразмусу!', it: 'Ciao amici Erasmus!' };
    await route.fulfill({ json: { responseStatus: 200, responseData: { translatedText: text === hello.it ? hello[target] : `[${target}] ${text}` } } });
  });
}
async function join(page, nickname, language = 'it', url = '/') {
  const t = getT(language);
  await page.goto(url);
  await page.getByRole('radio').filter({ hasText: languages.find(l => l.code === language).nativeName }).click();
  await page.getByRole('button', { name: t('continue'), exact: true }).click();
  await page.getByLabel(t('nicknameLabel'), { exact: true }).fill(nickname);
  await page.getByRole('button', { name: t('joinChat'), exact: true }).click();
  await expect(page.getByRole('heading', { name: t('roomName'), exact: true })).toBeVisible();
}
async function send(page, language, text) {
  const t = getT(language);
  await page.getByRole('textbox', { name: t('sendMessage'), exact: true }).fill(text);
  await page.getByRole('button', { name: t('send'), exact: true }).click();
}

test('all five languages localize onboarding; malformed invitations cannot join', async ({ page }) => {
  await page.goto('/');
  for (const language of languages) {
    const t = getT(language.code);
    await page.getByRole('radio').filter({ hasText: language.nativeName }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', language.code);
    await expect(page.getByRole('heading', { name: t('chooseLanguage'), exact: true })).toBeVisible();
  }
  await page.goto('/#room=broken');
  await expect(page.getByRole('heading', { name: getT('it')('invalidInviteTitle'), exact: true })).toBeVisible();
});

test('private invite, per-person translations, original text and live-only delivery', async ({ browser }) => {
  const aliceContext = await browser.newContext();
  const bobContext = await browser.newContext();
  const carolContext = await browser.newContext();
  await Promise.all([aliceContext, bobContext, carolContext].map(mockTranslations));
  const errors = [];
  try {
    const alice = await aliceContext.newPage();
    const bob = await bobContext.newPage();
    const carol = await carolContext.newPage();
    for (const page of [alice, bob, carol]) page.on('pageerror', e => errors.push(e.message));
    await join(alice, 'Sofia', 'it');
    await alice.getByRole('textbox', { name: getT('it')('sendMessage'), exact: true }).fill('Cannot send alone');
    await expect(alice.getByRole('button', { name: getT('it')('send'), exact: true })).toBeDisabled();
    await alice.locator('.invite-header-button').click();
    const invitation = await alice.locator('#invitation-url').inputValue();
    expect(invitation).toMatch(/#room=[a-f0-9]{32}&key=[a-f0-9]{64}/);
    await alice.getByRole('button', { name: getT('it')('close'), exact: true }).last().click();
    await join(bob, 'Alex', 'en', invitation);
    await expect(alice.locator('.people-list .person')).toHaveCount(2);
    await send(alice, 'it', 'Ciao amici Erasmus!');
    await expect(bob.getByRole('log').getByText('Hello Erasmus friends!', { exact: true })).toBeVisible();
    const messageId = await bob.locator('.message-row').filter({ hasText: 'Hello Erasmus friends!' }).getAttribute('data-message-id');
    const message = bob.locator(`[data-message-id="${messageId}"]`);
    await expect(message.locator('time')).toHaveAttribute('datetime', /\d{4}-\d{2}-\d{2}T/);
    await message.getByRole('button', { name: 'Show original', exact: true }).click();
    await expect(message.getByText('Ciao amici Erasmus!', { exact: true })).toBeVisible();
    await message.getByRole('button', { name: 'Hide original', exact: true }).click();
    for (const [target, expected] of [['es', '¡Hola, amigos de Erasmus!'], ['ru', 'Привет, друзья по Эразмусу!'], ['uk', 'Привіт, друзі з Еразмусу!']]) {
      await bob.locator('#chat-language').selectOption(target);
      await expect(bob.getByRole('log').getByText(expected, { exact: true })).toBeVisible();
      await expect(bob.locator('html')).toHaveAttribute('lang', target);
      await expect(alice.locator('html')).toHaveAttribute('lang', 'it');
    }
    await join(carol, 'Olena', 'uk');
    await expect(carol.locator('.people-list .person')).toHaveCount(1);
    await expect(carol.getByRole('log').locator('.message-row')).toHaveCount(0);
    expect(carol.url()).not.toBe(invitation);
    await send(alice, 'it', 'provider unavailable');
    await expect(bob.getByRole('log').getByText(getT('uk')('translationUnavailable'), { exact: true })).toBeVisible();
    await bob.reload();
    await join(bob, 'AlexAgain', 'en', invitation);
    await expect(bob.getByRole('log').locator('.message-row')).toHaveCount(0);
    await send(alice, 'it', 'Only people here receive this');
    await expect(bob.getByRole('log').getByText('[en] Only people here receive this', { exact: true })).toBeVisible();
    expect(await alice.evaluate(() => Object.keys(localStorage))).toEqual(['chattamento.language']);
    expect(errors).toEqual([]);
  } finally { await aliceContext.close(); await bobContext.close(); await carolContext.close(); }
});

test('nickname collision requires a unique name among room participants', async ({ browser }) => {
  const owner = await browser.newContext();
  const visitor = await browser.newContext();
  try {
    const first = await owner.newPage();
    await join(first, 'ReservedName', 'it');
    const second = await visitor.newPage();
    await join(second, 'RESERVEDNAME', 'en', first.url());
    const dialog = second.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByLabel(getT('en')('nicknameLabel'), { exact: true }).fill('AlexUnique');
    await dialog.getByRole('button', { name: getT('en')('save'), exact: true }).click();
    await expect(dialog).not.toBeVisible();
    await expect(first.locator('.people-list')).toContainText('AlexUnique');
  } finally { await owner.close(); await visitor.close(); }
});

test('images and files transfer live; blob downloads work without a server', async ({ browser }) => {
  const firstContext = await browser.newContext();
  const secondContext = await browser.newContext();
  try {
    const first = await firstContext.newPage();
    const second = await secondContext.newPage();
    await join(first, 'FilesOne', 'it');
    await join(second, 'FilesTwo', 'en', first.url());
    await expect(first.locator('.people-list .person')).toHaveCount(2);
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aBVsAAAAASUVORK5CYII=', 'base64');
    await first.locator('input[type=file]').setInputFiles({ name: 'reunion.png', mimeType: 'image/png', buffer: png });
    await first.getByRole('button', { name: getT('it')('send'), exact: true }).click();
    await expect(second.getByRole('img', { name: 'reunion.png', exact: true })).toBeVisible();
    await first.locator('input[type=file]').setInputFiles({ name: 'travel-plan.txt', mimeType: 'text/plain', buffer: Buffer.from('See you at the station!') });
    await first.getByRole('button', { name: getT('it')('send'), exact: true }).click();
    const link = second.getByRole('link', { name: 'Download file: travel-plan.txt', exact: true });
    await expect(link).toBeVisible();
    expect(await link.evaluate(async element => (await fetch(element.href)).text())).toBe('See you at the station!');
    await first.getByRole('button', { name: getT('it')('leaveRoom'), exact: true }).click();
    await expect(first.locator('.chat-app')).toHaveCount(0);
    expect(new URL(first.url()).hash).toBe('');
  } finally { await firstContext.close(); await secondContext.close(); }
});

test('mobile room and invitation dialog fit a narrow display', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await join(page, 'MobileFriend', 'uk');
    await page.locator('.invite-header-button').click();
    await expect(page.locator('#invitation-url')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.getByRole('button', { name: getT('uk')('close'), exact: true }).last().click();
    await page.getByRole('button', { name: getT('uk')('participants'), exact: true }).click();
    await expect(page.locator('#chat-language')).toBeVisible();
    await page.locator('#chat-language').selectOption('ru');
    await expect(page.getByRole('heading', { name: getT('ru')('roomName'), exact: true })).toBeVisible();
  } finally { await context.close(); }
});
