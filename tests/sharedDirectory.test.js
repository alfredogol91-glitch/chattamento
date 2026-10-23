import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createDirectoryShareFromHandle, createDirectoryShareFromFiles } from '../src/sharedDirectory.js';

function chosenFile(path, contents = 'hello') {
  const file = new File([contents], path.split('/').at(-1), { type: 'text/plain', lastModified: 1700000000000 });
  Object.defineProperty(file, 'webkitRelativePath', { value: path });
  return file;
}

test('folder fallback is a readonly rooted tree and never reads file bytes during browsing', async () => {
  const file = chosenFile('Holiday/photos/plan.txt');
  file.arrayBuffer = () => { throw new Error('contents read without download'); };
  const share = await createDirectoryShareFromFiles([file, chosenFile('Holiday/notes.txt')]);
  const root = await share.list();
  assert.equal(root.name, 'Holiday');
  assert.deepEqual(root.entries.map(entry => entry.kind), ['directory', 'file']);
  const photos = await share.list(root.entries[0].id);
  assert.equal(photos.entries[0].name, 'plan.txt');
  assert.equal(await share.getFile(photos.entries[0].id), file);
  await assert.rejects(share.list('../'), { code: 'folder_not_found' });
  await assert.rejects(share.getFile('root'), { code: 'folder_not_found' });
  share.dispose();
  await assert.rejects(share.list(), { code: 'folder_revoked' });
  await assert.rejects(share.getFile(photos.entries[0].id), { code: 'folder_revoked' });
});

test('fallback rejects traversal, mixed roots and unsupported file selections', async () => {
  for (const files of [[chosenFile('Root/../private.txt')], [chosenFile('Root/a.txt'), chosenFile('Other/b.txt')], [chosenFile('Root//a.txt')], [chosenFile('file.txt')]]) {
    await assert.rejects(createDirectoryShareFromFiles(files), { code: 'folder_selection_invalid' });
  }
  await assert.rejects(createDirectoryShareFromFiles([]), { code: 'folder_selection_invalid' });
});

test('native picker model is lazy and blocks moved-out handles and revoked permissions', async () => {
  let enumerations = 0, fileRequests = 0, permission = 'granted', inside = true;
  const fileHandle = { name: 'plan.txt', kind: 'file', getFile: async () => { fileRequests++; return chosenFile('Trip/plan.txt'); } };
  const rootHandle = {
    name: 'Trip', kind: 'directory',
    queryPermission: async options => { assert.equal(options.mode, 'read'); return permission; },
    resolve: async () => inside ? ['plan.txt'] : null,
    async *entries() { enumerations++; yield ['plan.txt', fileHandle]; },
  };
  const share = await createDirectoryShareFromHandle(rootHandle);
  assert.equal(enumerations, 0);
  const listing = await share.list();
  assert.equal(fileRequests, 0);
  await share.getFile(listing.entries[0].id);
  assert.equal(fileRequests, 1);
  inside = false;
  await assert.rejects(share.getFile(listing.entries[0].id), { code: 'folder_not_found' });
  inside = true; permission = 'prompt';
  await assert.rejects(share.list(), { code: 'folder_permission_denied' });
  assert.equal(fileRequests, 1);
});

test('revoking an in-flight native directory scan prevents delivery of its listing', async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const root = { name: 'Trip', kind: 'directory', async *entries() { await gate; yield ['private.txt', { kind: 'file', name: 'private.txt' }]; } };
  const share = await createDirectoryShareFromHandle(root);
  const pending = share.list();
  share.dispose(); release();
  await assert.rejects(pending, { code: 'folder_revoked' });
});

test('native browsing bounds the total indexed tree without reading file contents', async () => {
  const directories = Array.from({ length: 6 }, (_, index) => ({
    name: `Folder${index}`, kind: 'directory',
    async *entries() { for (let n = 0; n < 999; n++) yield [`file${n}.txt`, { kind: 'file', name: `file${n}.txt` }]; },
  }));
  const root = {
    name: 'Trip', kind: 'directory', resolve: async handle => [handle.name],
    async *entries() { for (const directory of directories) yield [directory.name, directory]; },
  };
  const share = await createDirectoryShareFromHandle(root);
  const listing = await share.list();
  for (const entry of listing.entries.slice(0, 4)) assert.equal((await share.list(entry.id)).entries.length, 999);
  await assert.rejects(share.list(listing.entries[4].id), { code: 'folder_too_large' });
  assert.equal((await share.list(listing.entries[0].id)).entries.length, 999);
  share.dispose();
});

test('replacing or removing a directory invalidates every previously issued descendant id', async () => {
  let replacement = false;
  const directory = { kind: 'directory', name: 'Photos', async *entries() { yield ['old.txt', { kind: 'file', name: 'old.txt' }]; } };
  const root = {
    name: 'Trip', kind: 'directory',
    async *entries() { yield ['Photos', replacement ? { kind: 'file', name: 'Photos' } : directory]; },
  };
  const share = await createDirectoryShareFromHandle(root);
  const oldDirectory = (await share.list()).entries[0];
  const oldFile = (await share.list(oldDirectory.id)).entries[0];
  replacement = true;
  assert.equal((await share.list()).entries[0].kind, 'file');
  await assert.rejects(share.list(oldDirectory.id), { code: 'folder_not_found' });
  await assert.rejects(share.getFile(oldFile.id), { code: 'folder_not_found' });
  share.dispose();
});

test('concurrent native scans keep replacement IDs stable and preserve the global node budget', async () => {
  let releaseComparison;
  const comparisonGate = new Promise(resolve => { releaseComparison = resolve; });
  let comparisonStarted;
  const firstComparison = new Promise(resolve => { comparisonStarted = resolve; });
  let replacing = false;
  const makeFile = name => {
    const handle = { kind: 'file', name, isSameEntry: async other => handle === other };
    return handle;
  };
  const originals = Array.from({ length: 1000 }, (_, index) => makeFile(`file${index}.txt`));
  const replacements = originals.map(file => makeFile(file.name));
  originals[0].isSameEntry = async other => {
    if (replacing) { comparisonStarted(); await comparisonGate; }
    return originals[0] === other;
  };
  const directories = Array.from({ length: 5 }, (_, index) => {
    const files = index === 0 ? originals : Array.from({ length: index === 4 ? 995 : 1000 }, (_, n) => makeFile(`file${n}.txt`));
    return {
      name: `Folder${index}`, kind: 'directory',
      async *entries() { for (const file of index === 0 && replacing ? replacements : files) yield [file.name, file]; },
    };
  });
  const root = {
    name: 'Trip', kind: 'directory', resolve: async handle => [handle.name],
    async *entries() { for (const directory of directories) yield [directory.name, directory]; },
  };
  const share = await createDirectoryShareFromHandle(root);
  try {
    const listing = await share.list();
    // Root + five directories + 4,995 files fills the 5,001-node budget exactly.
    for (const directory of listing.entries) await share.list(directory.id);
    replacing = true;
    const first = share.list(listing.entries[0].id);
    const second = share.list(listing.entries[0].id);
    await firstComparison;
    releaseComparison();
    const results = await Promise.all([first, second]);
    assert.deepEqual(results[0].entries, results[1].entries, 'overlapping scans must not allocate orphan IDs for the same replacement handles');
    assert.equal((await share.list(listing.entries[1].id)).entries.length, 1000, 'replacements must leave the global budget available for unchanged listings');
  } finally {
    releaseComparison();
    share.dispose();
  }
});
