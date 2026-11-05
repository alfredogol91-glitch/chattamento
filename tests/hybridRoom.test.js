import assert from 'node:assert/strict';
import test from 'node:test';
import { createHybridRoom } from '../src/hybridRoom.js';

const purpose = 'chattamento-media-binding-v1';
const fingerprint = byte => `sha-256 ${Array(32).fill(byte).join(':')}`;
const localFingerprint = fingerprint('AA');
const remoteFingerprint = fingerprint('BB');
const sdp = value => ({ type: 'offer', sdp: `v=0\r\na=fingerprint:${value}\r\n` });
const tick = () => new Promise(resolve => setImmediate(resolve));

function fixture({ canonicalPeers = ['bob'], directPeers = ['rtc-bob'], loadError = false } = {}) {
  const actions = new Map();
  const directActions = new Map();
  const dataPeers = new Set(canonicalPeers);
  const connections = Object.fromEntries(directPeers.map(id => [id, { localDescription: sdp(localFingerprint), remoteDescription: sdp(remoteFingerprint) }]));
  const sent = [];
  const media = [];
  const signedContexts = [];
  const verifications = [];
  let relayLeaveCount = 0;
  let rtcLeaveCount = 0;
  let rtcJoins = 0;
  let relayJoinHandler;
  let relayLeaveHandler;
  let connectionHandler;
  let rtcJoinHandler;
  let rtcLeaveHandler;
  let rtcCallbacks;
  let relayConfig;
  const action = (collection, name) => {
    if (!collection.has(name)) collection.set(name, {
      onReceive: null, onMessage: null,
      async send(data, options) { sent.push({ transport: collection === actions ? 'relay' : 'rtc', name, data, options }); },
    });
    return collection.get(name);
  };
  const relayRoom = {
    makeAction: name => action(actions, name),
    getPeers: () => Object.fromEntries([...dataPeers].map(id => [id, {}])),
    set onPeerJoin(handler) { relayJoinHandler = handler; }, get onPeerJoin() { return relayJoinHandler; },
    set onPeerLeave(handler) { relayLeaveHandler = handler; }, get onPeerLeave() { return relayLeaveHandler; },
    set onConnectionState(handler) { connectionHandler = handler; }, get onConnectionState() { return connectionHandler; },
    async leave() { relayLeaveCount++; },
  };
  const rtcRoom = {
    makeAction: name => action(directActions, name),
    getPeers: () => connections,
    set onPeerJoin(handler) { rtcJoinHandler = handler; if (handler) for (const id of Object.keys(connections)) handler(id); },
    get onPeerJoin() { return rtcJoinHandler; },
    set onPeerLeave(handler) { rtcLeaveHandler = handler; }, get onPeerLeave() { return rtcLeaveHandler; },
    onPeerStream: null, onPeerTrack: null,
    async leave() { rtcLeaveCount++; },
  };
  for (const method of ['addStream', 'removeStream', 'addTrack', 'removeTrack', 'replaceTrack']) {
    rtcRoom[method] = (...args) => { media.push({ method, args }); return [Promise.resolve('sent')]; };
  }
  const dependencies = {
    async createRelayTransport(config) {
      relayConfig = config;
      return {
        selfId: 'alice', room: relayRoom,
        async createMediaBinding(rtcId, context) {
          signedContexts.push({ rtcId, context });
          return { purpose, relayId: 'alice', rtcId, ...context, signature: 'valid' };
        },
        async verifyMediaBinding(proof, expectedRtcId) {
          verifications.push({ proof, expectedRtcId });
          return proof.signature === 'valid' && proof.rtcId === expectedRtcId ? proof.relayId : null;
        },
      };
    },
    async loadRtc() {
      if (loadError) throw new Error('No optional WebRTC capability');
      return { selfId: 'rtc-alice', joinRoom(_config, _roomId, callbacks) { rtcJoins++; rtcCallbacks = callbacks; return rtcRoom; } };
    },
  };
  return {
    dependencies, relayRoom, rtcRoom, sent, media, signedContexts, verifications,
    get relayConfig() { return relayConfig; },
    get rtcCallbacks() { return rtcCallbacks; },
    get relayLeaveCount() { return relayLeaveCount; }, get rtcLeaveCount() { return rtcLeaveCount; }, get rtcJoins() { return rtcJoins; },
    joinRelay(id) { dataPeers.add(id); relayJoinHandler?.(id); },
    leaveRelay(id) { dataPeers.delete(id); relayLeaveHandler?.(id); },
    leaveRtc(id) { delete connections[id]; rtcLeaveHandler?.(id); },
    state(status) { connectionHandler?.(status); },
    challenge(id = 'rtc-bob') { return sent.filter(message => message.transport === 'rtc' && message.data.type === 'challenge' && message.options.target === id).at(-1)?.data.nonce; },
    async receive(message, id = 'rtc-bob') { await directActions.get('relay-id').onMessage(message, { peerId: id }); },
    proof(overrides = {}) {
      return { type: 'proof', proof: { purpose, rtcId: 'rtc-bob', relayId: 'bob', peerRtcId: 'rtc-alice', nonce: this.challenge(), localFingerprints: [remoteFingerprint], remoteFingerprints: [localFingerprint], signature: 'valid', ...overrides } };
    },
  };
}

async function open(network, callbacks = {}) {
  const transport = await createHybridRoom({ appId: 'chat', password: 'secret' }, 'room-one', callbacks, network.dependencies);
  await transport.mediaReady;
  return transport;
}

test('encrypted relay actions remain usable when optional RTC setup fails', async t => {
  const network = fixture({ loadError: true });
  let appError = false;
  const { room, selfId } = await open(network, { onJoinError() { appError = true; } });
  t.after(() => room.leave());
  assert.equal(selfId, 'alice');
  assert.equal(network.relayConfig.roomId, 'room-one');
  assert.equal(room.makeAction('message'), network.relayRoom.makeAction('message'));
  await room.makeAction('message').send('Hello', { target: 'bob' });
  assert.equal(network.sent[0].transport, 'relay');
  assert.deepEqual(room.getPeers(), {});
  await assert.rejects(room.addStream({}, { target: 'bob' }), { code: 'call_connection_failed' });
  assert.deepEqual(await room.removeStream({}, { target: 'bob' }), []);
  assert.equal(appError, false);
});

test('only fresh, verified, DTLS-channel-bound identities can route media', async t => {
  const network = fixture();
  const { room } = await open(network);
  t.after(() => room.leave());
  const joins = [];
  room.onMediaPeerJoin = id => joins.push(id);
  assert.deepEqual(room.getPeers(), {});
  await network.receive(network.proof({ nonce: 'replayedchallenge00000' }));
  await network.receive(network.proof({ signature: 'forged' }));
  await network.receive(network.proof({ peerRtcId: 'another-recipient' }));
  await network.receive(network.proof({ localFingerprints: [fingerprint('CC')] }));
  await network.receive(network.proof({ remoteFingerprints: [fingerprint('CC')] }));
  assert.deepEqual(room.getPeers(), {});
  assert.equal(network.verifications.length, 1, 'nonce and DTLS mismatches are rejected before signature verification');
  await network.receive(network.proof());
  assert.deepEqual(joins, ['bob']);
  assert.deepEqual(Object.keys(room.getPeers()), ['bob']);
  const stream = { id: 'my-stream' };
  await room.addStream(stream, { target: 'bob', metadata: { kind: 'call' } });
  assert.deepEqual(network.media.at(-1), { method: 'addStream', args: [stream, { target: 'rtc-bob', metadata: { kind: 'call' } }] });
  await room.addTrack({ id: 'camera' }, stream, { target: ['bob'] });
  assert.deepEqual(network.media.at(-1).args.at(-1), { target: ['rtc-bob'] });
  await room.replaceTrack({ id: 'old' }, { id: 'new' }, { target: 'bob' });
  assert.equal(network.media.at(-1).method, 'replaceTrack');
  await assert.rejects(room.addStream(stream, { target: ['bob', 'unknown'] }), { code: 'call_connection_failed' });
});

test('binding responses sign both DTLS fingerprints and the requesting peer', async t => {
  const network = fixture();
  const { room } = await open(network);
  t.after(() => room.leave());
  await network.receive({ type: 'challenge', nonce: 'remoteFreshChallenge123456' });
  assert.deepEqual(network.signedContexts.at(-1), {
    rtcId: 'rtc-alice', context: {
      nonce: 'remoteFreshChallenge123456', peerRtcId: 'rtc-bob',
      localFingerprints: [localFingerprint], remoteFingerprints: [remoteFingerprint],
    },
  });
  assert.equal(network.sent.at(-1).data.type, 'proof');
  assert.equal(network.sent.at(-1).options.target, 'rtc-bob');
});

test('incoming media waits for identity verification and RTC loss preserves relay presence', async t => {
  const network = fixture();
  let applicationErrors = 0;
  const { room } = await open(network, { onJoinError() { applicationErrors++; } });
  t.after(() => room.leave());
  const streams = [], tracks = [], mediaLeaves = [], chatLeaves = [];
  room.onPeerStream = (...args) => streams.push(args);
  room.onPeerTrack = (...args) => tracks.push(args);
  room.onMediaPeerLeave = id => mediaLeaves.push(id);
  room.onPeerLeave = id => chatLeaves.push(id);
  const stream = { id: 'remote' }, track = { id: 'remote-camera' };
  network.rtcRoom.onPeerStream(stream, 'rtc-bob', { kind: 'video' });
  network.rtcRoom.onPeerTrack(track, stream, 'rtc-bob');
  assert.deepEqual(streams, []);
  await network.receive(network.proof());
  assert.deepEqual(streams, [[stream, 'bob', { kind: 'video' }]]);
  assert.deepEqual(tracks, [[track, stream, 'bob', undefined]]);
  network.rtcCallbacks.onJoinError(new Error('ICE failed'));
  assert.equal(applicationErrors, 0);
  network.leaveRtc('rtc-bob');
  assert.deepEqual(mediaLeaves, ['bob']);
  assert.deepEqual(chatLeaves, []);
  assert.deepEqual(room.getPeers(), {});
  await room.makeAction('message').send('Chat still works', { target: 'bob' });
  assert.equal(network.sent.at(-1).transport, 'relay');
});

test('verified RTC IDs require current relay membership and fresh proof after broker loss', async t => {
  const network = fixture({ canonicalPeers: [] });
  const { room } = await open(network);
  t.after(() => room.leave());
  const joins = [], mediaJoins = [], states = [];
  room.onPeerJoin = id => joins.push(id);
  room.onMediaPeerJoin = id => mediaJoins.push(id);
  room.onConnectionState = state => states.push(state);
  await network.receive(network.proof());
  assert.deepEqual(room.getPeers(), {});
  network.joinRelay('bob');
  assert.deepEqual(joins, ['bob']);
  assert.deepEqual(mediaJoins, ['bob']);
  const previous = network.proof();
  network.state('offline');
  assert.deepEqual(room.getPeers(), {});
  await assert.rejects(room.addStream({}, { target: 'bob' }), { code: 'call_connection_failed' });
  network.state('waiting');
  assert.notEqual(network.challenge(), previous.proof.nonce);
  await network.receive(previous);
  assert.deepEqual(room.getPeers(), {});
  await network.receive(network.proof());
  assert.deepEqual(Object.keys(room.getPeers()), ['bob']);
  assert.deepEqual(mediaJoins, ['bob', 'bob']);
  assert.deepEqual(joins, ['bob'], 'media reconnection does not duplicate authoritative chat joins');
  assert.deepEqual(states, ['waiting', 'offline', 'waiting']);
});

test('media promise-array failures propagate and disposal clears both transports once', async () => {
  const network = fixture();
  const { room } = await open(network);
  await network.receive(network.proof());
  network.rtcRoom.addStream = () => [Promise.reject(new Error('native media failed'))];
  await assert.rejects(room.addStream({}, { target: 'bob' }), { code: 'call_connection_failed' });
  await room.leave();
  await room.leave();
  assert.equal(network.relayLeaveCount, 1);
  assert.equal(network.rtcLeaveCount, 1);
  assert.equal(network.rtcRoom.onPeerJoin, null);
  assert.equal(network.rtcRoom.onPeerStream, null);
  assert.equal(network.relayRoom.onPeerJoin, null);
  assert.equal(network.relayRoom.onConnectionState, null);
  assert.deepEqual(room.getPeers(), {});
});

test('leaving before lazy RTC initialization finishes never opens a stale media room', async () => {
  const network = fixture();
  let release;
  network.dependencies.loadRtc = () => new Promise(resolve => { release = resolve; });
  const transport = await createHybridRoom({ appId: 'chat', password: 'secret' }, 'room-one', {}, network.dependencies);
  await tick();
  await transport.room.leave();
  release({ selfId: 'rtc-alice', joinRoom() { throw new Error('must not open after leave'); } });
  assert.equal(await transport.mediaReady, false);
  assert.equal(network.relayLeaveCount, 1);
});
