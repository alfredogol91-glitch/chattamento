import { test, expect } from '@playwright/test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join as joinPath } from 'node:path';
import { getT, languages } from '../src/i18n.js';

async function join(page, nickname, language = 'it', url = '/') {
  const t = getT(language);
  await page.goto(url);
  await page.getByRole('radio').filter({ hasText: languages.find(item => item.code === language).nativeName }).click();
  await page.getByRole('button', { name: t('continue'), exact: true }).click();
  await page.getByLabel(t('nicknameLabel'), { exact: true }).fill(nickname);
  await page.getByRole('button', { name: t('joinChat'), exact: true }).click();
  await expect(page.getByRole('heading', { name: t('roomName'), exact: true })).toBeVisible();
}

async function openFolders(page, language = 'it') {
  await page.locator('.folders-open-button').click();
  const dialog = page.getByRole('dialog', { name: getT(language)('foldersTitle'), exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

async function sampleDirectory() {
  const container = await mkdtemp(joinPath(tmpdir(), 'chattamento-folders-'));
  const folder = joinPath(container, 'Erasmus memories');
  const other = joinPath(container, 'Another folder');
  await mkdir(joinPath(folder, 'Photos'), { recursive: true });
  await mkdir(other);
  await writeFile(joinPath(folder, 'notes.txt'), 'Meet at the station at 18:00!');
  await writeFile(joinPath(folder, 'Photos', 'friends.txt'), 'Our Erasmus reunion');
  await writeFile(joinPath(other, 'new-plan.txt'), 'Next summer in Rome');
  await writeFile(joinPath(container, 'private-neighbor.txt'), 'This must never be shared');
  return { container, folder, other };
}

test('folder selection needs confirmation, nested browsing and downloads stop on revocation', async ({ browser }) => {
  const sample = await sampleDirectory();
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  const errors = [];
  try {
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    for (const page of [owner, guest]) page.on('pageerror', error => errors.push(error.message));
    await join(owner, 'Sofia');
    await join(guest, 'Alex', 'en', owner.url());
    await expect(owner.locator('.people-list .person')).toHaveCount(2);
    const ownDialog = await openFolders(owner);
    const guestDialog = await openFolders(guest, 'en');
    await ownDialog.locator('input[webkitdirectory]').setInputFiles(sample.folder);
    await expect(ownDialog.locator('.folder-selection-preview')).toContainText('Erasmus memories');
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
    await ownDialog.getByRole('button', { name: getT('it')('foldersShare'), exact: true }).click();
    await expect(guestDialog.locator('.folder-root')).toHaveCount(1);
    await guestDialog.locator('.folder-root').click();
    await expect(guestDialog.locator('.folder-list')).toContainText('notes.txt');
    await expect(guestDialog.locator('.folder-list')).not.toContainText('private-neighbor.txt');
    await guestDialog.getByRole('button', { name: 'Browse folder: Photos', exact: true }).click();
    await expect(guestDialog.locator('.folder-list')).toContainText('friends.txt');
    const downloadEvent = guest.waitForEvent('download');
    await guestDialog.getByRole('button', { name: 'Download file: friends.txt', exact: true }).click();
    const download = await downloadEvent;
    expect(download.suggestedFilename()).toBe('friends.txt');
    expect(await readFile(await download.path(), 'utf8')).toBe('Our Erasmus reunion');
    await guestDialog.getByRole('button', { name: getT('en')('foldersBack'), exact: true }).click();
    await expect(guestDialog.locator('.folder-list')).toContainText('notes.txt');
    await ownDialog.getByRole('button', { name: getT('it')('foldersStop'), exact: true }).click();
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
    await expect(guestDialog.locator('.folder-list')).toHaveCount(0);
    await expect(guestDialog.getByText(getT('en')('foldersRevoked'), { exact: true })).toBeVisible();
    expect(errors).toEqual([]);
  } finally {
    await ownerContext.close(); await guestContext.close();
    await rm(sample.container, { recursive: true, force: true });
  }
});

test('unconfirmed selections are discarded; replacing a share needs consent and leaving removes it', async ({ browser }) => {
  const sample = await sampleDirectory();
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext();
  try {
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    await join(owner, 'FolderOwner');
    await join(guest, 'FolderGuest', 'uk', owner.url());
    await expect(owner.locator('.people-list .person')).toHaveCount(2);
    let ownDialog = await openFolders(owner);
    const guestDialog = await openFolders(guest, 'uk');
    await ownDialog.locator('input[webkitdirectory]').setInputFiles(sample.folder);
    await ownDialog.getByRole('button', { name: getT('it')('close'), exact: true }).click();
    ownDialog = await openFolders(owner);
    await expect(ownDialog.locator('.folder-selection-preview')).toHaveCount(0);
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
    await ownDialog.locator('input[webkitdirectory]').setInputFiles(sample.folder);
    await ownDialog.getByRole('button', { name: getT('it')('foldersShare'), exact: true }).click();
    await expect(guestDialog.locator('.folder-root')).toContainText('Erasmus memories');
    await ownDialog.locator('input[webkitdirectory]').setInputFiles(sample.other);
    const confirm = ownDialog.getByRole('button', { name: getT('it')('foldersShare'), exact: true });
    await expect(confirm).toBeDisabled();
    await expect(guestDialog.locator('.folder-root')).toContainText('Erasmus memories');
    await ownDialog.getByRole('checkbox').check();
    await confirm.click();
    await expect(guestDialog.locator('.folder-root')).toHaveCount(1);
    await expect(guestDialog.locator('.folder-root')).toContainText('Another folder');
    await ownDialog.getByRole('button', { name: getT('it')('close'), exact: true }).click();
    await expect(owner.locator('.folders-toolbar-live')).toBeVisible();
    await owner.getByRole('button', { name: getT('it')('leaveRoom'), exact: true }).click();
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
  } finally {
    await ownerContext.close(); await guestContext.close();
    await rm(sample.container, { recursive: true, force: true });
  }
});

test('native picker uses read permission, stays lazy until confirmed and revokes after permission loss', async ({ browser }) => {
  const ownerContext = await browser.newContext();
  const guestContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  try {
    await ownerContext.addInitScript(() => {
      window.folderProbe = { picked: 0, enumerated: 0, read: 0, permission: 'granted', mode: null };
      window.showDirectoryPicker = async options => {
        window.folderProbe.picked++; window.folderProbe.mode = options.mode;
        const file = { kind: 'file', name: 'plans.txt', async getFile() { window.folderProbe.read++; return new File(['A shared plan'], 'plans.txt'); } };
        return {
          kind: 'directory', name: 'Selected folder',
          async queryPermission() { return window.folderProbe.permission; },
          async resolve(handle) { return handle === file ? ['plans.txt'] : null; },
          async *entries() { window.folderProbe.enumerated++; yield ['plans.txt', file]; },
        };
      };
    });
    const owner = await ownerContext.newPage();
    const guest = await guestContext.newPage();
    await join(owner, 'NativeOwner');
    await join(guest, 'MobileGuest', 'es', owner.url());
    await expect(owner.locator('.people-list .person')).toHaveCount(2);
    const ownDialog = await openFolders(owner);
    const guestDialog = await openFolders(guest, 'es');
    await ownDialog.locator('.folder-choose').click();
    await expect(ownDialog.locator('.folder-selection-preview')).toBeVisible();
    expect(await owner.evaluate(() => window.folderProbe)).toMatchObject({ picked: 1, mode: 'read', enumerated: 0, read: 0 });
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
    await ownDialog.getByRole('button', { name: getT('it')('foldersShare'), exact: true }).click();
    await guestDialog.locator('.folder-root').click();
    await expect(guestDialog.locator('.folder-list')).toContainText('plans.txt');
    expect(await owner.evaluate(() => window.folderProbe)).toMatchObject({ enumerated: 1, read: 0 });
    expect(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await owner.evaluate(() => { window.folderProbe.permission = 'denied'; });
    await guestDialog.locator('.folder-root').click();
    await expect(guestDialog.locator('.folder-root')).toHaveCount(0);
    await expect(guestDialog.locator('.folder-list')).toHaveCount(0);
    expect(await owner.evaluate(() => window.folderProbe.read)).toBe(0);
  } finally { await ownerContext.close(); await guestContext.close(); }
});
