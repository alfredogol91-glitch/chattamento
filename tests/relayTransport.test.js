import assert from 'node:assert/strict';
import test from 'node:test';
import { createRelayTransport, createMqttDecoder, encodeMqttPacket } from '../src/relayTransport.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const brokers = ['wss://relay-one.test/mqtt', 'wss://relay-two.test/mqtt'];
const options = { appId: 'relay-test', roomId: 'private-erasmus-room', password: 'secret-random-invitation-password' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const copy = value => new Uint8Array(value.buffer ?? value, value.byteOffset ?? 0, value.byteLength).slice();
const combine = (...parts) => {
  const bytes = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let offset = 0;
  for (const part of parts) { bytes.set(part, offset); offset += part.length; }
  return bytes;
};
const field = value => { const bytes = enc.encode(value); return combine(new Uint8Array([bytes.length >>> 8, bytes.length & 255]), bytes); };
async function until(predicate, message = 'condition', timeout = 4000) {
  const end = Date.now() + timeout;
  while (!predicate()) { if (Date.now() > end) assert.fail(`Timed out: ${message}`); await sleep(5); }
}

/** A minimal broker simulation which preserves real binary MQTT framing. */
function network({ fragment = false } = {}) {
  const sockets = new Set(), publishes = [], connections = [];
  let filter = null;
  function deliver(socket, packet) {
    if (socket.readyState !== 1) return;
    const chunks = fragment ? [packet.slice(0, 1), packet.slice(1, 3), packet.slice(3)] : [packet];
    for (const bytes of chunks) if (bytes.length) queueMicrotask(() => {
      if (socket.readyState === 1) socket.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
    });
  }
  function inject(topic, payload, { retained = false, url } = {}) {
    const packet = encodeMqttPacket(retained ? 0x31 : 0x30, combine(field(topic), payload));
    for (const socket of sockets) if (socket.topic === topic && (!url || socket.url === url)) deliver(socket, packet);
  }
  function webSocketFactory(url, protocols) {
    assert.deepEqual(protocols, ['mqtt']);
    const socket = {
      url, readyState: 0, bufferedAmount: 0, topic: null,
      send(value) {
        assert.equal(socket.readyState, 1);
        parser.push(copy(value));
      },
      close() {
        if (socket.readyState === 3) return;
        socket.readyState = 3;
        sockets.delete(socket);
        queueMicrotask(() => socket.onclose?.());
      },
    };
    const parser = createMqttDecoder(({ header, body }) => {
      const type = header >>> 4;
      if (type === 1) {
        assert.equal(dec.decode(body.subarray(2, 6)), 'MQTT');
        assert.equal(body[6], 4, 'MQTT 3.1.1');
        assert.equal(body[7], 2, 'clean session, no credentials or retained will');
        connections.push({ url, cleanSession: true });
        deliver(socket, encodeMqttPacket(0x20, new Uint8Array([0, 0])));
      } else if (type === 8) {
        const length = (body[2] << 8) | body[3];
        socket.topic = dec.decode(body.subarray(4, 4 + length));
        assert.equal(body[body.length - 1], 0, 'QoS 0 subscription');
        deliver(socket, encodeMqttPacket(0x90, new Uint8Array([body[0], body[1], 0])));
      } else if (type === 3) {
        assert.equal(header, 0x30, 'no retained messages');
        const length = (body[0] << 8) | body[1];
        const topic = dec.decode(body.subarray(2, 2 + length));
        const publication = { socket, url, topic, payload: body.slice(2 + length) };
        publishes.push(publication);
        void (async () => {
          if (!filter || await filter(publication)) inject(topic, publication.payload, { url });
        })();
      } else if (type === 12) deliver(socket, encodeMqttPacket(0xd0));
    });
    sockets.add(socket);
    queueMicrotask(() => { if (socket.readyState !== 3) { socket.readyState = 1; socket.onopen?.(); } });
    return socket;
  }
  return { webSocketFactory, sockets, publishes, connections, inject, setFilter(value) { filter = value; }, disconnect(url) {
    for (const socket of [...sockets]) if (!url || socket.url === url) socket.close();
  } };
}

async function pair(t, net = network(), overrides = {}) {
  const first = await createRelayTransport({ ...options, brokers, webSocketFactory: net.webSocketFactory, ...overrides });
  const second = await createRelayTransport({ ...options, brokers, webSocketFactory: net.webSocketFactory, ...overrides });
  t.after(async () => { await Promise.allSettled([first.room.leave(), second.room.leave()]); });
  await until(() => first.room.getPeers()[second.selfId] && second.room.getPeers()[first.selfId], 'mutual verified presence');
  return { first, second, net };
}

async function plaintext(publication, config = options) {
  const context = enc.encode(JSON.stringify(['chattamento-relay-v1', config.appId, config.roomId, config.password]));
  const digest = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const key = await crypto.subtle.importKey('raw', await digest(combine(enc.encode('encryption:'), context)), 'AES-GCM', false, ['decrypt']);
  const scope = await digest(combine(enc.encode('topic:'), context));
  const header = publication.payload.subarray(0, 94);
  const value = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.subarray(82), additionalData: combine(scope, header) }, key, publication.payload.subarray(94, -64)));
  const length = new DataView(value.buffer).getUint32(0);
  return { control: JSON.parse(dec.decode(value.subarray(4, 4 + length))), data: value.subarray(4 + length) };
}

test('MQTT decoder handles split length prefixes, fragmented payloads and coalesced packets', () => {
  const found = [];
  const parser = createMqttDecoder(packet => found.push({ header: packet.header, body: packet.body.slice() }));
  const large = encodeMqttPacket(0x30, new Uint8Array(17000).fill(77));
  const ping = encodeMqttPacket(0xd0);
  const data = combine(large, ping, encodeMqttPacket(0x20, new Uint8Array([0, 0])));
  for (let at = 0; at < data.length; at += 7) parser.push(data.subarray(at, at + 7));
  assert.deepEqual(found.map(value => value.header), [0x30, 0xd0, 0x20]);
  assert.equal(found[0].body.length, 17000);
  assert(found[0].body.every(byte => byte === 77));
  assert.throws(() => createMqttDecoder(() => {}).push(new Uint8Array([0x30, 255, 255, 255, 255])), /packet_too_large/);
  assert.throws(() => createMqttDecoder(() => {}, 100).push(new Uint8Array([0x30, 127])), /packet_too_large/);
});

test('dual broker transport discovers canonical identities, replays join setters and encrypts all content', async t => {
  const { first, second, net } = await pair(t, network({ fragment: true }));
  assert.match(first.selfId, /^[a-zA-Z0-9_-]{43}$/);
  assert.notEqual(first.selfId, second.selfId);
  assert.equal(Object.keys(first.room.getPeers()).includes(first.selfId), false);
  const joined = [];
  first.room.onPeerJoin = id => joined.push(id);
  await until(() => joined.includes(second.selfId), 'late join callback replay');
  const received = [];
  const action = second.room.makeAction('message');
  action.onReceive = context => context.peerId === first.selfId && context.byteLength < 1000;
  action.onMessage = (data, context) => received.push({ data, context });
  await first.room.makeAction('message').send({ text: 'Привіт Erasmus friends', nickname: 'Alice' }, { metadata: { approved: true } });
  assert.equal(received.length, 1, 'two broker deliveries are deduplicated');
  assert.equal(received[0].data.text, 'Привіт Erasmus friends');
  assert.equal(received[0].context.peerId, first.selfId);
  assert.deepEqual(received[0].context.metadata, { approved: true });
  assert.equal(received[0].context.kind, 'message');
  assert.equal(net.connections.length, 4);
  for (const publication of net.publishes) {
    assert(!publication.topic.includes(options.password));
    assert(!publication.topic.includes(options.roomId));
    assert(!dec.decode(publication.payload).includes('Alice'));
    assert(!dec.decode(publication.payload).includes('Erasmus friends'));
  }
  const nonces = new Map();
  for (const publication of net.publishes) {
    const seq = [...publication.payload.subarray(66, 74)].join(',');
    const sender = [...publication.payload.subarray(1, 66)].join(',');
    const nonce = [...publication.payload.subarray(82, 94)].join(',');
    const identitySequence = `${sender}:${seq}`;
    if (nonces.has(nonce)) assert.equal(nonces.get(nonce), identitySequence, 'only the same packet may be duplicated between brokers');
    nonces.set(nonce, identitySequence);
  }
});

test('room secrets isolate discovery and copied, tampered, retained and replayed packets cannot redeliver', async t => {
  const { first, second, net } = await pair(t);
  const other = await createRelayTransport({ ...options, password: 'different-secret', brokers, webSocketFactory: net.webSocketFactory });
  t.after(() => other.room.leave());
  await sleep(20);
  assert.equal(Object.keys(other.room.getPeers()).length, 0);
  const received = [];
  const action = second.room.makeAction('secure');
  action.onMessage = data => received.push(data);
  await first.room.makeAction('secure').send('message exactly once', { target: second.selfId });
  assert.deepEqual(received, ['message exactly once']);
  const captured = [...net.publishes];
  for (const publication of captured) {
    net.inject(publication.topic, publication.payload);
    const altered = publication.payload.slice();
    altered[100] ^= 1;
    net.inject(publication.topic, altered);
    const changedIdentity = publication.payload.slice();
    changedIdentity[25] ^= 1;
    net.inject(publication.topic, changedIdentity);
    net.inject(publication.topic, publication.payload, { retained: true });
  }
  const otherTopic = [...net.sockets].find(socket => socket.topic && socket.topic !== captured[0].topic).topic;
  for (const publication of captured) net.inject(otherTopic, publication.payload);
  await sleep(80);
  assert.deepEqual(received, ['message exactly once']);
  assert.equal(Object.keys(other.room.getPeers()).length, 0, 'copied packets fail scope-bound signatures and AES authentication');
});

test('approval sees authenticated metadata before any chunks and rejection prevents binary transmission', async t => {
  const { first, second, net } = await pair(t);
  const contexts = [], received = [];
  const action = second.room.makeAction('attachment');
  action.onReceive = context => { contexts.push(context); return false; };
  action.onMessage = data => received.push(data);
  const before = net.publishes.length;
  await assert.rejects(first.room.makeAction('attachment').send(new Uint8Array(100000), { target: second.selfId, metadata: { name: 'private.txt' } }), /receive_rejected/);
  assert.equal(contexts.length, 1);
  assert.equal(contexts[0].peerId, first.selfId);
  assert.equal(contexts[0].byteLength, 100000);
  assert.deepEqual(contexts[0].metadata, { name: 'private.txt' });
  assert.equal(received.length, 0);
  const sent = await Promise.all(net.publishes.slice(before).map(value => plaintext(value)));
  assert(!sent.some(value => value.control.t === 'chunk'), 'rejected transfers never allocate/send the file chunks');
});

test('large binary transfers preserve bytes and metadata, retry lost chunks and final receipts', async t => {
  const { first, second, net } = await pair(t, network(), { brokers: [brokers[0]] });
  const received = [];
  let droppedChunk = false, droppedDone = false;
  net.setFilter(async publication => {
    const { control } = await plaintext(publication);
    if (control.t === 'chunk' && control.index === 2 && !droppedChunk) { droppedChunk = true; return false; }
    if (control.t === 'receipt' && control.phase === 'done' && !droppedDone) { droppedDone = true; return false; }
    return true;
  });
  const action = second.room.makeAction('file');
  action.onReceive = ({ peerId, metadata, byteLength }) => peerId === first.selfId && metadata.name === 'notes.bin' && byteLength === 1024 * 1024;
  action.onMessage = (data, context) => received.push({ data: data.slice(), metadata: context.metadata });
  const bytes = new Uint8Array(1024 * 1024);
  for (let index = 0; index < bytes.length; index++) bytes[index] = index % 251;
  await first.room.makeAction('file').send(new Blob([bytes]), { target: second.selfId, metadata: { name: 'notes.bin', caption: '😀'.repeat(4000) } });
  assert(droppedChunk && droppedDone);
  assert.equal(received.length, 1);
  assert.deepEqual(received[0].data, bytes);
  assert.equal(received[0].metadata.caption.length, 8000);
});

test('AbortSignal stops remaining chunks and pending approval is aborted by peer departure', async t => {
  const { first, second, net } = await pair(t, network(), { brokers: [brokers[0]] });
  const controller = new AbortController();
  let chunksAfterAbort = 0, stopped = false, delivered = false;
  net.setFilter(async publication => {
    const { control } = await plaintext(publication);
    if (control.t === 'chunk') {
      if (stopped) chunksAfterAbort++;
      if (!stopped) { stopped = true; controller.abort(); }
    }
    return true;
  });
  const action = second.room.makeAction('cancel-file');
  action.onReceive = () => true;
  action.onMessage = () => { delivered = true; };
  await assert.rejects(first.room.makeAction('cancel-file').send(new Uint8Array(3 * 1024 * 1024), { target: second.selfId, signal: controller.signal }), /aborted/);
  await sleep(30);
  assert(chunksAfterAbort < 16, 'a complete file is never queued after cancellation');
  assert.equal(delivered, false);
  const alreadyAborted = new AbortController(); alreadyAborted.abort();
  await assert.rejects(first.room.makeAction('cancel-file').send('no', { signal: alreadyAborted.signal }), /aborted/);
  let context;
  const pending = second.room.makeAction('pending');
  pending.onReceive = receivedContext => { context = receivedContext; return new Promise(() => {}); };
  const sending = first.room.makeAction('pending').send('waiting', { target: second.selfId }).catch(error => error);
  await until(() => context, 'pending approval');
  await first.room.leave();
  await until(() => context.signal.aborted, 'approval cancellation after signed leave');
  assert.equal((await sending).code, 'offline');
});

test('buffer and concurrent transfer limits reserve capacity before asynchronous Blob reads', async t => {
  const { first, second } = await pair(t);
  const action = first.room.makeAction('capacity');
  await assert.rejects(action.send(new Blob([new Uint8Array(25 * 1024 * 1024 + 1)]), { target: second.selfId }), /file_too_large/);
  const releases = [], controllers = [];
  class DeferredBlob extends Blob {
    arrayBuffer() { return new Promise(resolve => releases.push(resolve)); }
  }
  const sends = Array.from({ length: 16 }, () => {
    const controller = new AbortController(); controllers.push(controller);
    return action.send(new DeferredBlob(), { target: second.selfId, signal: controller.signal }).catch(error => error);
  });
  await assert.rejects(action.send(new DeferredBlob(), { target: second.selfId }), /transfer_busy/);
  assert.equal(releases.length, 16);
  controllers.forEach(controller => controller.abort());
  releases.forEach(resolve => resolve(new ArrayBuffer(0)));
  assert((await Promise.all(sends)).every(error => error.code === 'aborted'));
  const largeReleases = [], aborts = [];
  class LargeDeferredBlob extends Blob {
    get size() { return 25 * 1024 * 1024; }
    arrayBuffer() { return new Promise(resolve => largeReleases.push(resolve)); }
  }
  const largeSends = Array.from({ length: 2 }, () => {
    const controller = new AbortController(); aborts.push(controller);
    return action.send(new LargeDeferredBlob(), { target: second.selfId, signal: controller.signal }).catch(error => error);
  });
  await assert.rejects(action.send(new LargeDeferredBlob(), { target: second.selfId }), /transfer_busy/);
  aborts.forEach(controller => controller.abort());
  largeReleases.forEach(resolve => resolve(new ArrayBuffer(0)));
  await Promise.all(largeSends);
});

test('media identity proofs bind challenge, both RTC identities and both DTLS fingerprints to this room', async t => {
  const { first, second, net } = await pair(t);
  const local = `sha-256 ${Array(32).fill('AB').join(':')}`;
  const remote = `sha-256 ${Array(32).fill('CD').join(':')}`;
  const proof = await first.createMediaBinding('rtc-alice', { nonce: 'fresh-connection-challenge', peerRtcId: 'rtc-boris', localFingerprints: [local], remoteFingerprints: [remote] });
  assert.equal(await second.verifyMediaBinding(proof, 'rtc-alice'), first.selfId);
  assert.equal(await second.room.verifyMediaBinding(proof, 'rtc-somebody-else'), null);
  for (const mutation of [
    { nonce: 'changed-connection-challenge' }, { relayId: second.selfId }, { peerRtcId: 'rtc-eve' },
    { localFingerprints: [remote] }, { remoteFingerprints: [local] }, { issuedAt: Date.now() - 301000 },
  ]) assert.equal(await second.verifyMediaBinding({ ...proof, ...mutation }, 'rtc-alice'), null);
  const other = await createRelayTransport({ ...options, roomId: 'another-room', brokers, webSocketFactory: net.webSocketFactory });
  t.after(() => other.room.leave());
  assert.equal(await other.verifyMediaBinding(proof, 'rtc-alice'), null);
  await assert.rejects(first.createMediaBinding('rtc-alice'), /invalid_request/);
});

test('last broker loss clears peers and reports offline while one remaining broker preserves presence', async t => {
  const { first, second, net } = await pair(t);
  const statuses = [], left = [];
  first.room.onConnectionState = state => statuses.push(state);
  first.room.onPeerLeave = id => left.push(id);
  await until(() => statuses.includes('waiting'), 'connection setter replay');
  net.disconnect(brokers[0]);
  await sleep(20);
  assert(first.room.getPeers()[second.selfId]);
  assert(!statuses.includes('offline'));
  net.disconnect(brokers[1]);
  await until(() => statuses.includes('offline'), 'offline after both relays lost');
  assert.deepEqual(Object.keys(first.room.getPeers()), []);
  assert(left.includes(second.selfId));
  await assert.rejects(first.room.makeAction('message').send('offline'), /offline/);
});

test('a congested broker cannot stall delivery through the other subscribed broker', async t => {
  const { first, second, net } = await pair(t);
  const firstSockets = [...net.sockets].slice(0, 2);
  firstSockets.find(socket => socket.url === brokers[0]).bufferedAmount = 10 * 1024 * 1024;
  let received;
  second.room.makeAction('healthy-relay').onMessage = value => { received = value; };
  const started = Date.now();
  await first.room.makeAction('healthy-relay').send('still connected', { target: second.selfId });
  assert.equal(received, 'still connected');
  assert(Date.now() - started < 1000, 'one blocked socket must not impose its backpressure delay on both brokers');
});

test('leave aborts a blocked transfer immediately and bounds departure publishing', async t => {
  const { first, second, net } = await pair(t);
  for (const socket of [...net.sockets].slice(0, 2)) socket.bufferedAmount = 10 * 1024 * 1024;
  const sending = first.room.makeAction('blocked-file').send(new Uint8Array(1024 * 1024), { target: second.selfId }).catch(error => error);
  await sleep(15);
  const started = Date.now();
  const leaving = first.room.leave();
  assert.equal((await sending).code, 'offline');
  assert(Date.now() - started < 100, 'file revocation happens before the best-effort leave publish');
  await leaving;
  assert(Date.now() - started < 500, 'closing congested relay sockets is bounded');
  await assert.rejects(first.room.makeAction('blocked-file').send('after leave'), /offline/);
});
