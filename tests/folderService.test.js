import assert from 'node:assert/strict';
import test from 'node:test';
import { createFolderService } from '../src/folderService.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() {
  for (let count = 0; count < 6; count++) await tick();
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function network() {
  const endpoints = new Map();
  const transmissions = [];
  const held = [];
  let hold = () => false;

  function add(id = crypto.randomUUID()) {
    const actions = new Map();
    const endpoint = { id, actions };
    const room = {
      makeAction(name, initial = {}) {
        assert(Buffer.byteLength(name) <= 12, 'Trystero action names must fit the documented limit');
        if (actions.has(name)) return actions.get(name);
        const action = {
          ...initial,
          async send(data, options = {}) {
            if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
            const transmission = { from: id, action: name, data, options };
            transmissions.push(transmission);
            const targets = [...endpoints.values()].filter(peer => peer !== endpoint
              && (!options.target || (Array.isArray(options.target) ? options.target.includes(peer.id) : options.target === peer.id)));
            for (const target of targets) {
              const deliver = async () => {
                if (options.signal?.aborted) return;
                const recipient = target.actions.get(name);
                if (!recipient) return;
                let payload;
                if (data instanceof Blob) payload = new Uint8Array(await data.arrayBuffer());
                else if (data instanceof ArrayBuffer) payload = new Uint8Array(data.slice(0));
                else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
                else payload = structuredClone(data);
                const metadata = structuredClone(options.metadata);
                const context = {
                  peerId: id,
                  metadata,
                  byteLength: ArrayBuffer.isView(payload) ? payload.byteLength : Buffer.byteLength(JSON.stringify(payload)),
                  kind: 'message',
                  signal: new AbortController().signal,
                };
                if (recipient.onReceive && !await recipient.onReceive(context)) return;
                // Trystero's send resolves after sending, not after the receiver's
                // asynchronous application work (for example reading a disk file).
                recipient.onMessage?.(payload, context);
              };
              if (hold({ ...transmission, to: target.id })) held.push({ ...transmission, to: target.id, deliver });
              else await deliver();
            }
          },
        };
        actions.set(name, action);
        return action;
      },
    };
    endpoint.room = room;
    endpoints.set(id, endpoint);
    return endpoint;
  }
  return {
    add, endpoints, transmissions, held,
    setHold(predicate) { hold = predicate; },
    async release() {
      hold = () => false;
      for (const item of held.splice(0)) await item.deliver();
    },
  };
}

function fixtureModel(overrides = {}) {
  const id = crypto.randomUUID();
  const directoryId = crypto.randomUUID();
  const fileId = crypto.randomUUID();
  const imageId = crypto.randomUUID();
  const calls = { list: [], getFile: [], read: 0, disposed: 0 };
  const file = new File(['Hello from Erasmus!'], 'notes.txt', { type: 'text/plain', lastModified: 1700000000000 });
  const read = file.arrayBuffer.bind(file);
  file.arrayBuffer = async () => { calls.read++; return read(); };
  const model = {
    id,
    name: 'Erasmus memories',
    async list(nodeId) {
      calls.list.push(nodeId);
      if (nodeId === 'root') return {
        id: 'root', name: 'Erasmus memories', entries: [
          { id: directoryId, name: 'Photos', kind: 'directory' },
          { id: fileId, name: 'notes.txt', kind: 'file', size: file.size, lastModified: file.lastModified },
        ],
      };
      if (nodeId === directoryId) return {
        id: directoryId, name: 'Photos', entries: [{ id: imageId, name: 'friends.png', kind: 'file', size: 8 }],
      };
      throw Object.assign(new Error('folder_unavailable'), { code: 'folder_unavailable' });
    },
    async getFile(nodeId) {
      calls.getFile.push(nodeId);
      if (nodeId !== fileId) throw Object.assign(new Error('folder_unavailable'), { code: 'folder_unavailable' });
      return file;
    },
    dispose() { calls.disposed++; },
    ...overrides,
  };
  return { model, calls, file, directoryId, fileId, imageId };
}

function setup(count = 2, options = {}) {
  const wire = network();
  const clients = [];
  for (let index = 0; index < count; index++) {
    const endpoint = wire.add();
    const user = { id: endpoint.id, nickname: ['Alice', 'Boris', 'Carla'][index], nicknameConflict: false };
    const events = [];
    const client = { endpoint, user, events };
    client.service = createFolderService({
      room: endpoint.room,
      getUser: () => user,
      getPeers: () => clients.filter(other => other !== client).map(other => other.user),
      canPeer: peerId => clients.some(other => other !== client && other.user.id === peerId && !other.user.nicknameConflict),
      emit: (event, payload) => events.push({ event, payload }),
      requestTimeoutMs: 2000,
      ...options,
    });
    clients.push(client);
  }
  return { wire, clients, owner: clients[0], viewer: clients[1], dispose: () => Promise.all(clients.map(client => client.service.dispose())) };
}

async function share(fixture, model = fixtureModel()) {
  const result = await fixture.owner.service.shareFolder(model.model);
  await settle();
  const descriptor = fixture.viewer.service.sharedFolders[0];
  assert(descriptor, 'a connected peer should receive the folder announcement');
  return { ...model, descriptor, result };
}

function requestFor(descriptor, owner, extra = {}) {
  return { ownerId: owner.user.id, shareId: descriptor.id ?? descriptor.shareId, ...extra };
}

test('folders remain private until sharing consent and only metadata is read while browsing', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const model = fixtureModel();
  assert.equal(fixture.wire.transmissions.length, 0);
  assert.deepEqual(fixture.owner.service.localSharedFolders, []);
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  assert.deepEqual(model.calls, { list: [], getFile: [], read: 0, disposed: 0 });
  const { descriptor } = await share(fixture, model);
  assert.equal(descriptor.name, model.model.name);
  assert.equal(model.calls.getFile.length, 0);
  assert.equal(model.calls.read, 0);
  const root = await fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' }));
  assert.equal(root.name, 'Erasmus memories');
  assert.deepEqual(root.entries.map(entry => entry.name), ['Photos', 'notes.txt']);
  const directory = await fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: model.directoryId }));
  assert.equal(directory.name, 'Photos');
  assert.equal(directory.entries[0].name, 'friends.png');
  assert.equal(model.calls.getFile.length, 0, 'listing must not read any file contents');
  assert.equal(model.calls.read, 0);
});

test('an explicit download reads only the selected file and returns a revocable generic download URL', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const { descriptor, fileId, calls } = await share(fixture);
  const download = await fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId }));
  assert.equal(download.name, 'notes.txt');
  assert(download.url.startsWith('blob:'));
  const response = await fetch(download.url);
  assert.equal(response.headers.get('content-type'), 'application/octet-stream');
  assert.equal(await response.text(), 'Hello from Erasmus!');
  assert.deepEqual(calls.getFile, [fileId]);
  assert.equal(calls.read, 1);
  fixture.viewer.service.releaseSharedFile(download.url);
  await assert.rejects(fetch(download.url));
});

test('paths, unknown IDs, and outsiders cannot cause file reads', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const { descriptor, calls } = await share(fixture);
  for (const id of ['../secrets.txt', '/etc/passwd', 'root/notes.txt']) {
    await assert.rejects(fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: id })), /invalid_request/);
    await assert.rejects(fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId: id })), /invalid_request/);
  }
  await assert.rejects(fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId: crypto.randomUUID() })), /folder_unavailable/);
  assert.equal(calls.read, 0);
  const outsider = fixture.wire.add();
  const requestAction = fixture.owner.endpoint.actions.get('fs-request');
  const validRequest = fixture.wire.transmissions.filter(entry => entry.action === 'fs-request').at(-1);
  assert.equal(await requestAction.onReceive({
    byteLength: Buffer.byteLength(JSON.stringify(validRequest.data)), peerId: outsider.id, metadata: validRequest.options.metadata,
  }), false);
  const requestsBefore = calls.list.length + calls.getFile.length;
  await requestAction.onMessage(validRequest.data, { peerId: outsider.id, metadata: validRequest.options.metadata });
  assert.equal(calls.list.length + calls.getFile.length, requestsBefore);
});

test('a response copied by another connected peer cannot satisfy a pending folder request', async (t) => {
  const fixture = setup(3);
  t.after(fixture.dispose);
  const { descriptor } = await share(fixture);
  fixture.wire.setHold(entry => entry.from === fixture.owner.user.id && entry.action === 'fs-response');
  let completed = false;
  const pending = fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' }));
  pending.then(() => { completed = true; }, () => { completed = true; });
  await settle();
  const held = fixture.wire.held.find(entry => entry.to === fixture.viewer.user.id);
  assert(held, 'the legitimate owner response should be waiting in the transport');
  const responseAction = fixture.viewer.endpoint.actions.get('fs-response');
  const context = { peerId: fixture.owner.user.id, byteLength: Buffer.byteLength(JSON.stringify(held.data)), metadata: held.options.metadata };
  assert.equal(await responseAction.onReceive(context), true);
  assert.equal(await responseAction.onReceive({ ...context, byteLength: 256 * 1024 + 1 }), false);
  assert.equal(await responseAction.onReceive({ ...context, metadata: { ...held.options.metadata, id: crypto.randomUUID() } }), false);
  assert.equal(await responseAction.onReceive({ ...context, peerId: fixture.clients[2].user.id }), false);
  await responseAction.onMessage(held.data, { peerId: fixture.owner.user.id, metadata: { ...held.options.metadata, nodeId: crypto.randomUUID() } });
  await fixture.clients[2].endpoint.room.makeAction('fs-response').send(held.data, { target: fixture.viewer.user.id, metadata: held.options.metadata });
  await settle();
  assert.equal(completed, false, 'matching request IDs are insufficient without matching peer identity');
  await fixture.wire.release();
  const result = await pending;
  assert.equal(result.entries.length, 2);
});

test('revocation while awaiting getFile prevents content reads and cancels the download', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const waiting = deferred();
  const model = fixtureModel();
  model.model.getFile = async id => { model.calls.getFile.push(id); return waiting.promise; };
  const { descriptor } = await share(fixture, model);
  const pending = fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId: model.fileId }));
  const rejected = assert.rejects(pending, /folder_revoked/);
  await settle();
  assert.deepEqual(model.calls.getFile, [model.fileId]);
  await fixture.owner.service.stopSharingFolder(model.model.id);
  waiting.resolve(model.file);
  await rejected;
  await settle();
  assert.equal(model.calls.read, 0, 'a file handle returned after revocation must never be read');
  assert.equal(fixture.wire.transmissions.filter(entry => entry.action === 'fs-download').length, 0);
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  assert.equal(model.calls.disposed, 1);
});

test('revocation during arrayBuffer prevents bytes being transmitted after the read completes', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const waiting = deferred();
  const model = fixtureModel();
  model.file.arrayBuffer = async () => { model.calls.read++; return waiting.promise; };
  const { descriptor } = await share(fixture, model);
  const pending = fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId: model.fileId }));
  const rejected = assert.rejects(pending, /folder_revoked/);
  await settle();
  assert.equal(model.calls.read, 1);
  await fixture.owner.service.stopSharingFolder(model.model.id);
  waiting.resolve(new TextEncoder().encode('Hello from Erasmus!').buffer);
  await rejected;
  await settle();
  assert.equal(fixture.wire.transmissions.filter(entry => entry.action === 'fs-download').length, 0);
});

test('declared and actual file limits are enforced without releasing oversized contents', async (t) => {
  const fixture = setup(2, { maxFileSize: 8 });
  t.after(fixture.dispose);
  const model = fixtureModel();
  const { descriptor } = await share(fixture, model);
  await assert.rejects(fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId: model.fileId })), /file_too_large/);
  assert.equal(model.calls.read, 0, 'an oversized file is rejected before reading its contents');
  await fixture.owner.service.stopSharingFolder(model.model.id);
  const misleading = fixtureModel();
  const tinyFile = new File(['tiny'], 'small.txt', { type: 'text/plain' });
  tinyFile.arrayBuffer = async () => { misleading.calls.read++; return new Uint8Array(9).buffer; };
  misleading.model.getFile = async id => { misleading.calls.getFile.push(id); return tinyFile; };
  const second = await share(fixture, misleading);
  await assert.rejects(fixture.viewer.service.downloadSharedFile(requestFor(second.descriptor, fixture.owner, { fileId: misleading.fileId })), /file_too_large/);
  assert.equal(misleading.calls.read, 1);
  assert.equal(fixture.wire.transmissions.filter(entry => entry.action === 'fs-download').length, 0);
});

test('a revoked advertisement invalidates previously issued download URLs', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const { descriptor, fileId, model } = await share(fixture);
  const downloaded = await fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId }));
  assert.equal(await (await fetch(downloaded.url)).text(), 'Hello from Erasmus!');
  await fixture.owner.service.stopSharingFolder(model.id);
  await settle();
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  await assert.rejects(fetch(downloaded.url));
  await assert.rejects(fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' })), /folder_(not_shared|revoked|unavailable)/);
});

test('suspend revokes local consent, pending requests, and remote URLs without resharing on resume', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const { descriptor, fileId, calls } = await share(fixture);
  const downloaded = await fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId }));
  fixture.viewer.service.suspend();
  await assert.rejects(fetch(downloaded.url));
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  fixture.owner.service.suspend();
  await settle();
  assert.equal(calls.disposed, 1);
  assert.deepEqual(fixture.owner.service.localSharedFolders, []);
  fixture.viewer.service.resume();
  fixture.owner.service.resume();
  fixture.owner.service.peerJoined(fixture.viewer.user.id);
  fixture.viewer.service.peerJoined(fixture.owner.user.id);
  await settle();
  assert.deepEqual(fixture.owner.service.localSharedFolders, []);
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
});

test('peer departure clears its advertisements and URLs and pending requests time out', async (t) => {
  const fixture = setup(2, { requestTimeoutMs: 30 });
  t.after(fixture.dispose);
  const { descriptor, fileId } = await share(fixture);
  const downloaded = await fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId }));
  fixture.wire.setHold(entry => entry.from === fixture.viewer.user.id && entry.action === 'fs-request');
  const request = fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' }));
  const keepAlive = setTimeout(() => {}, 3000);
  try {
    await assert.rejects(request, /folder_request_timeout/);
  } finally {
    clearTimeout(keepAlive);
  }
  fixture.viewer.service.peerLeft(fixture.owner.user.id);
  await settle();
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  await assert.rejects(fetch(downloaded.url));
});

test('binary download metadata must match the pending owner, request, file, and generation', async (t) => {
  const fixture = setup(3);
  t.after(fixture.dispose);
  const { descriptor, fileId } = await share(fixture);
  fixture.wire.setHold(entry => entry.from === fixture.owner.user.id && entry.action === 'fs-download');
  let completed = false;
  const request = fixture.viewer.service.downloadSharedFile(requestFor(descriptor, fixture.owner, { fileId }));
  request.then(() => { completed = true; }, () => { completed = true; });
  await settle();
  const held = fixture.wire.held.find(entry => entry.to === fixture.viewer.user.id);
  assert(held);
  const action = fixture.viewer.endpoint.actions.get('fs-download');
  const metadata = held.options.metadata;
  const valid = { peerId: fixture.owner.user.id, byteLength: metadata.size, metadata };
  assert.equal(await action.onReceive(valid), true);
  for (const update of [
    { peerId: fixture.clients[2].user.id },
    { byteLength: metadata.size + 1 },
    { byteLength: 25 * 1024 * 1024 + 1 },
    { metadata: { ...metadata, id: crypto.randomUUID() } },
    { metadata: { ...metadata, shareId: crypto.randomUUID() } },
    { metadata: { ...metadata, generation: crypto.randomUUID() } },
    { metadata: { ...metadata, nodeId: crypto.randomUUID() } },
    { metadata: { ...metadata, name: 'x'.repeat(201) } },
    { metadata: { ...metadata, ok: false } },
  ]) assert.equal(await action.onReceive({ ...valid, ...update }), false);
  await action.onMessage(new Uint8Array(held.data), { peerId: fixture.clients[2].user.id, metadata });
  await action.onMessage(new Uint8Array(1), { peerId: fixture.owner.user.id, metadata });
  await settle();
  assert.equal(completed, false, 'spoofed metadata and byte counts must not finish the pending download');
  await fixture.wire.release();
  const result = await request;
  assert.equal(await (await fetch(result.url)).text(), 'Hello from Erasmus!');
  assert.equal(await action.onReceive(valid), false, 'a completed request cannot be replayed');
});

test('revoked announcements cannot reactivate access and resharing creates a fresh generation', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const first = await share(fixture);
  await fixture.viewer.service.browseFolder(requestFor(first.descriptor, fixture.owner, { nodeId: 'root' }));
  const oldRequest = fixture.wire.transmissions.filter(entry => entry.action === 'fs-request').at(-1);
  const announced = fixture.wire.transmissions.find(entry => entry.action === 'fs-announce').data;
  const generation = announced.folders[0].generation;
  await fixture.owner.service.stopSharingFolder(first.model.id);
  await fixture.owner.endpoint.room.makeAction('fs-announce').send(announced, { target: fixture.viewer.user.id });
  await settle();
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  const replacement = fixtureModel();
  replacement.model.id = first.model.id;
  await share(fixture, replacement);
  const latest = fixture.wire.transmissions.filter(entry => entry.action === 'fs-announce').at(-1).data;
  assert.notEqual(latest.folders[0].generation, generation);
  assert.equal(fixture.viewer.service.sharedFolders[0].id, first.model.id);
  const requestAction = fixture.owner.endpoint.actions.get('fs-request');
  assert.equal(await requestAction.onReceive({
    byteLength: Buffer.byteLength(JSON.stringify(oldRequest.data)), peerId: fixture.viewer.user.id, metadata: oldRequest.options.metadata,
  }), false);
  await requestAction.onMessage(oldRequest.data, { peerId: fixture.viewer.user.id, metadata: oldRequest.options.metadata });
  assert.deepEqual(replacement.calls.list, [], 'a request from an older consent generation must not reach the new model');
});

test('only one local folder can be shared and oversized directory listings are rejected', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const model = fixtureModel();
  const { descriptor } = await share(fixture, model);
  await assert.rejects(fixture.owner.service.shareFolder(fixtureModel().model), /folder_busy/);
  assert.equal(fixture.owner.service.localSharedFolders.length, 1);
  model.model.list = async () => ({
    id: 'root', name: model.model.name,
    entries: Array.from({ length: 1001 }, (_, index) => ({ id: crypto.randomUUID(), name: `File ${index}`, kind: 'file', size: 0 })),
  });
  await assert.rejects(fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' })), /folder_too_large/);
  model.model.list = async () => ({
    id: 'root', name: model.model.name,
    entries: Array.from({ length: 1000 }, () => ({ id: crypto.randomUUID(), name: '友'.repeat(100), kind: 'file', size: 0 })),
  });
  await assert.rejects(fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' })), /folder_too_large/);
  assert.equal(model.calls.getFile.length, 0);
  assert.equal(model.calls.read, 0);
});

test('suspending an owner notifies connected viewers and cancels their pending operations', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const waiting = deferred();
  const model = fixtureModel();
  const { descriptor } = await share(fixture, model);
  model.model.list = async () => waiting.promise;
  const pending = fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' }));
  const rejected = assert.rejects(pending, /folder_(revoked|unavailable)/);
  await settle();
  fixture.owner.service.suspend();
  await settle();
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  waiting.resolve({ id: 'root', name: model.model.name, entries: [] });
  await rejected;
  assert.deepEqual(fixture.owner.service.localSharedFolders, []);
});

test('losing filesystem permission revokes the advertisement and exposes only a safe error code', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const model = fixtureModel();
  const { descriptor } = await share(fixture, model);
  model.model.list = async () => { throw new DOMException('private filesystem path must not leave the device', 'NotAllowedError'); };
  await assert.rejects(
    fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' })),
    /folder_(revoked|permission_denied)/,
  );
  await settle();
  assert.deepEqual(fixture.owner.service.localSharedFolders, []);
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
  assert.equal(model.calls.disposed, 1);
  const errors = fixture.owner.events.filter(entry => entry.event === 'error');
  assert.deepEqual(errors.at(-1).payload, { code: 'folder_permission_denied' });
  const wire = JSON.stringify(fixture.wire.transmissions.filter(entry => entry.action === 'fs-response').map(entry => entry.data));
  assert(!wire.includes('private filesystem path'));
});

test('concurrent listing work is bounded and excess requests fail without reading the folder', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const waiting = deferred();
  const model = fixtureModel();
  const { descriptor } = await share(fixture, model);
  model.model.list = async id => { model.calls.list.push(id); return waiting.promise; };
  const request = requestFor(descriptor, fixture.owner, { nodeId: 'root' });
  const first = Array.from({ length: 4 }, () => fixture.viewer.service.browseFolder(request));
  await settle();
  assert.equal(model.calls.list.length, 4);
  await assert.rejects(fixture.viewer.service.browseFolder(request), /folder_busy/);
  assert.equal(model.calls.list.length, 4);
  waiting.resolve({ id: 'root', name: model.model.name, entries: [] });
  const results = await Promise.all(first);
  assert(results.every(result => result.id === 'root' && result.entries.length === 0));
});

test('pending requests are bounded and all are cancelled when the viewer suspends', async (t) => {
  const fixture = setup();
  t.after(fixture.dispose);
  const { descriptor } = await share(fixture);
  fixture.wire.setHold(entry => entry.action === 'fs-request');
  const request = requestFor(descriptor, fixture.owner, { nodeId: 'root' });
  const rejections = Array.from({ length: 16 }, () => assert.rejects(fixture.viewer.service.browseFolder(request), /folder_unavailable/));
  await assert.rejects(fixture.viewer.service.browseFolder(request), /folder_busy/);
  fixture.viewer.service.suspend();
  await Promise.all(rejections);
  assert.deepEqual(fixture.viewer.service.sharedFolders, []);
});

for (const cancellation of ['stop', 'suspend', 'peer-left']) {
  test(`a listing already waiting in transport is aborted on ${cancellation}`, async (t) => {
    const fixture = setup();
    const gate = deferred();
    const enteredTransport = deferred();
    t.after(async () => { gate.resolve(); await fixture.dispose(); });
    const { descriptor, model } = await share(fixture);
    const response = fixture.owner.endpoint.actions.get('fs-response');
    const send = response.send.bind(response);
    let delivered = false;
    response.send = async (data, options = {}) => {
      if (data.ok !== true || data.op !== 'list') return send(data, options);
      enteredTransport.resolve(options.signal);
      await gate.promise;
      if (options.signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      delivered = true;
      return send(data, options);
    };
    const pending = fixture.viewer.service.browseFolder(requestFor(descriptor, fixture.owner, { nodeId: 'root' }));
    const rejection = assert.rejects(pending, /folder_(revoked|unavailable)/);
    const signal = await enteredTransport.promise;
    assert(signal instanceof AbortSignal, 'in-flight directory data must be sent through an abortable transport');
    assert.equal(signal.aborted, false);
    if (cancellation === 'stop') await fixture.owner.service.stopSharingFolder(model.id);
    else if (cancellation === 'suspend') fixture.owner.service.suspend();
    else {
      fixture.owner.service.peerLeft(fixture.viewer.user.id);
      fixture.viewer.service.peerLeft(fixture.owner.user.id);
    }
    await settle();
    assert.equal(signal.aborted, true, 'revoking access must cancel data which has not finished sending');
    await rejection;
    gate.resolve();
    await settle();
    assert.equal(delivered, false);
    assert.equal(fixture.wire.transmissions.filter(entry => entry.action === 'fs-response' && entry.data.ok === true).length, 0);
  });
}
