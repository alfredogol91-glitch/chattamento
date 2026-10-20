import assert from 'node:assert/strict';
import test from 'node:test';
import { createPeerRoom } from '../src/peerRoom.js';

const tick = () => new Promise(resolve => setImmediate(resolve));
async function settle() {
  for (let count = 0; count < 6; count++) await tick();
}

/** In-memory implementation of Trystero's public message and media transport. */
function createNetwork() {
  const endpoints = new Map();
  const transmissions = [];
  let nextId = 0;

  function factory(config, roomId, callbacks = {}) {
    const selfId = `peer-${String(++nextId).padStart(3, '0')}`;
    const scope = `${roomId}:${config.password ?? ''}`;
    let onJoin;
    let onLeave;
    const actions = new Map();
    const endpoint = { selfId, scope, config, roomId, actions, mediaCalls: [], callbacks };
    const peers = () => [...endpoints.values()].filter(peer => peer.scope === scope && peer !== endpoint);
    const targets = target => peers().filter(peer => !target || (Array.isArray(target) ? target.includes(peer.selfId) : peer.selfId === target));
    const room = {
      makeAction(name, initial = {}) {
        if (actions.has(name)) return actions.get(name);
        const action = {
          ...initial,
          async send(data, options = {}) {
            transmissions.push({ from: selfId, action: name, data, options });
            for (const peer of targets(options.target)) {
              const receiving = peer.actions.get(name);
              if (!receiving) continue;
              let payload = data;
              if (data instanceof Blob) payload = new Uint8Array(await data.arrayBuffer());
              else if (data instanceof ArrayBuffer) payload = new Uint8Array(data.slice(0));
              else if (ArrayBuffer.isView(data)) payload = new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength));
              else payload = structuredClone(data);
              const metadata = structuredClone(options.metadata);
              const byteLength = payload instanceof Uint8Array ? payload.byteLength : Buffer.byteLength(JSON.stringify(payload));
              const context = { peerId: selfId, metadata, byteLength, kind: 'message', signal: new AbortController().signal };
              if (receiving.onReceive && !await receiving.onReceive(context)) continue;
              await receiving.onMessage?.(payload, context);
            }
          },
        };
        actions.set(name, action);
        return action;
      },
      getPeers() { return Object.fromEntries(peers().map(peer => [peer.selfId, {}])); },
      leave() {
        endpoints.delete(selfId);
        for (const peer of peers()) queueMicrotask(() => peer.room.onPeerLeave?.(selfId));
      },
      addStream(...args) { endpoint.mediaCalls.push(['addStream', ...args]); },
      removeStream(...args) { endpoint.mediaCalls.push(['removeStream', ...args]); },
      addTrack(...args) { endpoint.mediaCalls.push(['addTrack', ...args]); },
      removeTrack(...args) { endpoint.mediaCalls.push(['removeTrack', ...args]); },
      replaceTrack(...args) { endpoint.mediaCalls.push(['replaceTrack', ...args]); },
      set onPeerJoin(handler) {
        onJoin = handler;
        for (const peer of peers()) queueMicrotask(() => {
          onJoin?.(peer.selfId);
          peer.room.onPeerJoin?.(selfId);
        });
      },
      get onPeerJoin() { return onJoin; },
      set onPeerLeave(handler) { onLeave = handler; },
      get onPeerLeave() { return onLeave; },
      onPeerStream: null,
      onPeerTrack: null,
    };
    endpoint.room = room;
    endpoints.set(selfId, endpoint);
    return { room, selfId };
  }

  return { factory, endpoints, transmissions };
}

function makeClient(network, overrides = {}) {
  return createPeerRoom({
    roomId: 'erasmus-living-room', password: 'room-secret', nickname: 'Alice', language: 'en',
    transportFactory: network.factory, ...overrides,
  });
}

function collect(client, event) {
  const values = [];
  client.on(event, value => values.push(value));
  return values;
}

test('peer room connects users with transport identity and keeps room passwords isolated', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris', language: 'ru' });
  const differentRoom = makeClient(network, { roomId: 'another-room', nickname: 'Carla' });
  const differentPassword = makeClient(network, { password: 'another-password', nickname: 'Daria' });
  t.after(() => [alice, boris, differentRoom, differentPassword].forEach(client => client.leave()));
  const presence = collect(alice, 'presence');
  const joined = await alice.connect();
  await boris.connect();
  await differentRoom.connect();
  await differentPassword.connect();
  await settle();
  assert.equal(joined.user.id, 'peer-001');
  const config = network.endpoints.get(joined.user.id).config;
  assert.equal(config.maxReceiveBytes, 25 * 1024 * 1024);
  assert.deepEqual(config.relayConfig.urls, ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com']);
  assert.equal(alice.user.id, joined.user.id);
  assert.equal(alice.connected, true);
  assert.equal(alice.status, 'connected');
  assert.deepEqual(alice.users.map(user => user.nickname).sort(), ['Alice', 'Boris']);
  assert.equal(presence.at(-1).total, 2);
  assert.equal(differentRoom.users.length, 1);
  assert.equal(differentPassword.users.length, 1);
});

test('messages are delivered once with original language, timestamp, and no history backfill', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris', language: 'uk' });
  const carla = makeClient(network, { nickname: 'Carla', language: 'it' });
  t.after(() => [alice, boris, carla].forEach(client => client.leave()));
  const localMessages = collect(alice, 'message');
  const remoteMessages = collect(boris, 'message');
  const lateMessages = collect(carla, 'message');
  await alice.connect();
  await boris.connect();
  await settle();
  const { message } = await alice.sendMessage({ text: 'Hello Erasmus friends!', clientId: 'first-message' });
  await settle();
  assert.equal(message.text, 'Hello Erasmus friends!');
  assert.equal(message.userId, alice.user.id);
  assert.equal(message.nickname, 'Alice');
  assert.equal(message.sourceLanguage, 'en');
  assert(Number.isFinite(Date.parse(message.createdAt)));
  assert.equal(localMessages.length, 1);
  assert.equal(remoteMessages.length, 1);
  assert.equal(remoteMessages[0].id, message.id);
  const sameSend = await alice.sendMessage({ text: 'Hello Erasmus friends!', clientId: 'first-message' });
  assert.equal(sameSend.message.id, message.id);
  const transmission = network.transmissions.find(entry => entry.action === 'message');
  await network.endpoints.get(alice.user.id).room.makeAction('message').send(transmission.data, { target: boris.user.id });
  await settle();
  assert.equal(remoteMessages.length, 1, 'duplicate transmission must not repeat a displayed message');
  assert.equal(localMessages.length, 1, 'retrying a client message id must not repeat a local message');
  await carla.connect();
  await settle();
  assert.equal(lateMessages.length, 0, 'joining a room must not trigger history synchronization');
  await alice.sendMessage({ text: 'Welcome Carla!' });
  await settle();
  assert.equal(lateMessages.length, 1);
  assert.equal(lateMessages[0].text, 'Welcome Carla!');
});

test('live nickname collisions block sending until renamed and profile changes reach peers', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const duplicate = makeClient(network, { nickname: 'ＡＬＩＣＥ', language: 'it' });
  t.after(() => [alice, duplicate].forEach(client => client.leave()));
  const conflicts = collect(duplicate, 'nickname-conflict');
  await alice.connect();
  await new Promise(resolve => setTimeout(resolve, 3));
  await duplicate.connect();
  await settle();
  assert(conflicts.length > 0);
  assert.equal(conflicts.at(-1).winnerId, alice.user.id);
  await assert.rejects(duplicate.sendMessage({ text: 'Cannot impersonate Alice' }), /nickname_taken/);
  await duplicate.updateProfile({ nickname: 'Boris', language: 'uk' });
  await settle();
  const { message } = await duplicate.sendMessage({ text: 'Привіт!' });
  assert.equal(message.nickname, 'Boris');
  assert.equal(message.sourceLanguage, 'uk');
  assert(alice.users.some(user => user.id === duplicate.user.id && user.nickname === 'Boris' && user.language === 'uk'));
});

test('message and file size limits fail before broadcasting', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => Promise.all([alice.leave(), boris.leave()]));
  await alice.connect();
  assert.equal(alice.status, 'waiting');
  await assert.rejects(alice.sendMessage({ text: 'No friends online yet' }), /no_peers/);
  const messages = collect(alice, 'message');
  await assert.rejects(alice.sendMessage({ text: '' }), /message_required/);
  await assert.rejects(alice.sendMessage({ text: 'a'.repeat(4001) }), /message_too_long/);
  const oversized = new File([new Uint8Array(25 * 1024 * 1024 + 1)], 'large.bin');
  await assert.rejects(alice.sendMessage({ text: '', file: oversized }), /file_too_large/);
  assert.equal(messages.length, 0);
  await boris.connect();
  await settle();
  const { message } = await alice.sendMessage({ text: '😀'.repeat(3000) });
  assert.equal([...message.text].length, 3000, 'message limits count Unicode code points');
});

test('binary attachments pair with their message and claimed executable MIME is downgraded', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => [alice, boris].forEach(client => client.leave()));
  const received = collect(boris, 'message');
  await alice.connect();
  await boris.connect();
  await settle();
  const unsafe = new File(['<svg onload="alert(1)"></svg>'], 'photo.svg', { type: 'image/png' });
  const { message } = await alice.sendMessage({ text: 'An attached file', file: unsafe });
  await settle();
  assert.equal(received.length, 1);
  assert.equal(received[0].id, message.id);
  assert.equal(received[0].text, 'An attached file');
  assert.equal(received[0].attachment.name, 'photo.svg');
  assert.equal(received[0].attachment.mimeType, 'application/octet-stream');
  assert.equal(received[0].attachment.size, unsafe.size);
  assert(received[0].attachment.url.startsWith('blob:'));
  const downloaded = await fetch(received[0].attachment.url);
  assert.equal(await downloaded.text(), '<svg onload="alert(1)"></svg>');
  const binaryTransmissions = network.transmissions.filter(entry => entry.data instanceof Blob || entry.data instanceof ArrayBuffer || ArrayBuffer.isView(entry.data));
  assert.equal(binaryTransmissions.length, 1, 'the file and message travel together in one action');
  assert(binaryTransmissions[0].options.metadata, 'binary actions carry their matching message metadata');
  assert.equal(binaryTransmissions[0].options.metadata.message.id, message.id);
});

test('leaving removes presence, blocks future messages, and revokes attachment object URLs', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => [alice, boris].forEach(client => client.leave()));
  await alice.connect();
  await boris.connect();
  await settle();
  const { message } = await alice.sendMessage({ text: '', file: new File(['notes'], 'notes.txt', { type: 'text/plain' }) });
  const url = message.attachment.url;
  assert.equal(await (await fetch(url)).text(), 'notes');
  alice.leave();
  await settle();
  assert.equal(alice.connected, false);
  assert.equal(boris.users.length, 1);
  await assert.rejects(fetch(url));
  await assert.rejects(alice.sendMessage({ text: 'Cannot send after leaving' }));
});

test('invalid profiles, unknown senders, and malformed or oversized files are not accepted', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => Promise.all([alice.leave(), boris.leave()]));
  await alice.connect();
  await boris.connect();
  await settle();
  const received = collect(boris, 'message');
  const endpoint = network.endpoints.get(boris.user.id);
  const file = endpoint.actions.get('attachment');
  const payload = { id: 'incoming-file', text: 'An incoming file', sourceLanguage: 'en', createdAt: new Date().toISOString() };
  const metadata = { id: 'attachment-id', name: 'file.txt', mimeType: 'text/plain', size: 1, message: payload };
  assert.equal(await file.onReceive({ byteLength: 25 * 1024 * 1024 + 1, peerId: alice.user.id, metadata }), false);
  assert.equal(await file.onReceive({ byteLength: 1, peerId: 'unknown-peer', metadata }), false);
  assert.equal(await file.onReceive({ byteLength: 2, peerId: alice.user.id, metadata }), false);
  assert.equal(await file.onReceive({ byteLength: 1, peerId: alice.user.id, metadata: { ...metadata, message: { ...payload, sourceLanguage: 'xx' } } }), false);
  await file.onMessage(new Uint8Array([1, 2]), { peerId: alice.user.id, metadata });
  await endpoint.actions.get('message').onMessage(payload, { peerId: 'unknown-peer' });
  await endpoint.actions.get('profile').onMessage({ nickname: 'Evil', language: 'it', claimedAt: Date.now() }, { peerId: 'unknown-peer' });
  await endpoint.actions.get('profile').onMessage({ nickname: '<script>', language: 'it', claimedAt: Date.now() }, { peerId: alice.user.id });
  assert.equal(received.length, 0);
  assert.equal(boris.users.find(user => user.id === alice.user.id).nickname, 'Alice');
});

test('media is shown only after both participants opt into calling and methods preserve their targets', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => Promise.all([alice.leave(), boris.leave()]));
  await alice.connect();
  await boris.connect();
  await settle();
  const streams = collect(alice, 'stream');
  const endpoint = network.endpoints.get(alice.user.id);
  const stream = { id: 'test-media-stream' };
  endpoint.room.onPeerStream(stream, boris.user.id);
  await alice.setCallState({ inCall: true, audio: true, video: false });
  await settle();
  endpoint.room.onPeerStream(stream, boris.user.id);
  assert.equal(streams.length, 0);
  await boris.setCallState({ inCall: true, audio: true, video: true });
  await settle();
  endpoint.room.onPeerStream(stream, 'unknown-peer');
  endpoint.room.onPeerStream(stream, boris.user.id);
  assert.deepEqual(streams, [{ stream, peerId: boris.user.id }]);
  assert(alice.users.find(user => user.id === boris.user.id).video);
  const oldTrack = { id: 'old-track' };
  const newTrack = { id: 'new-track' };
  await alice.addStream(stream, boris.user.id);
  await alice.addTrack(oldTrack, stream, boris.user.id);
  await alice.replaceTrack(oldTrack, newTrack, boris.user.id);
  await alice.removeTrack(newTrack, boris.user.id);
  await alice.removeStream(stream, boris.user.id);
  assert.deepEqual(endpoint.mediaCalls, [
    ['addStream', stream, { target: boris.user.id }],
    ['addTrack', oldTrack, stream, { target: boris.user.id }],
    ['replaceTrack', oldTrack, newTrack, { target: boris.user.id }],
    ['removeTrack', newTrack, { target: boris.user.id }],
    ['removeStream', stream, { target: boris.user.id }],
  ]);
  await alice.setCallState({ inCall: false, audio: true, video: true });
  endpoint.room.onPeerStream(stream, boris.user.id);
  assert.equal(streams.length, 1);
  assert.equal(alice.user.audio, false);
  assert.equal(alice.user.video, false);
});

test('event listeners can unsubscribe without affecting other room listeners', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  const boris = makeClient(network, { nickname: 'Boris' });
  t.after(() => Promise.all([alice.leave(), boris.leave()]));
  await alice.connect();
  await boris.connect();
  await settle();
  let first = 0;
  let second = 0;
  const firstHandler = () => first++;
  const stopSecond = alice.on('message', () => second++);
  alice.on('message', firstHandler);
  await boris.sendMessage({ text: 'One' });
  stopSecond();
  await boris.sendMessage({ text: 'Two' });
  alice.off('message', firstHandler);
  await boris.sendMessage({ text: 'Three' });
  assert.equal(first, 2);
  assert.equal(second, 1);
});

test('media methods await every Trystero operation and propagate array promise failures', async (t) => {
  const network = createNetwork();
  const alice = makeClient(network);
  t.after(() => alice.leave());
  await alice.connect();
  const transport = network.endpoints.get(alice.user.id).room;
  let complete;
  transport.addStream = () => [new Promise(resolve => { complete = resolve; })];
  let settled = false;
  const sending = alice.addStream({ id: 'stream' }).then(() => { settled = true; });
  await tick();
  assert.equal(settled, false, 'an unresolved transport operation must keep the adapter pending');
  complete();
  await sending;
  assert.equal(settled, true);
  for (const method of ['addStream', 'addTrack', 'replaceTrack', 'removeStream', 'removeTrack']) {
    transport[method] = () => [Promise.resolve(), Promise.reject(new Error('media negotiation failed'))];
    await assert.rejects(alice[method]({}, {}, 'peer-target'), /media negotiation failed/);
  }
  transport.addStream = () => Promise.resolve('single promise result');
  assert.equal(await alice.addStream({}), 'single promise result');
  transport.removeStream = () => undefined;
  assert.equal(await alice.removeStream({}), undefined);
});
