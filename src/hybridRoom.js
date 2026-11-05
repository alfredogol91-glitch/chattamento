import { createRelayTransport } from './relayTransport.js';

const bindingPurpose = 'chattamento-media-binding-v1';
const bindingActionName = 'relay-id';
const validNonce = value => typeof value === 'string' && /^[A-Za-z0-9_-]{16,128}$/.test(value);
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const mediaError = () => Object.assign(new Error('call_connection_failed'), { code: 'call_connection_failed' });
const nonce = () => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(24)))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/u, '');
const fingerprints = description => {
  if (typeof description?.sdp !== 'string') return [];
  const values = new Set();
  for (const line of description.sdp.split(/\r?\n/u)) {
    const match = /^a=fingerprint:(sha-(?:256|384|512)) ([A-Fa-f0-9:]+)$/u.exec(line.trim());
    if (!match) continue;
    const expectedBytes = Number(match[1].slice(4)) / 8;
    if (new RegExp(`^(?:[A-Fa-f0-9]{2}:){${expectedBytes - 1}}[A-Fa-f0-9]{2}$`, 'u').test(match[2])) values.add(`${match[1]} ${match[2].toUpperCase()}`);
  }
  return [...values].sort();
};
const sameFingerprints = (first, second) => Array.isArray(first) && first.length > 0
  && first.length === second.length && first.every((value, index) => value === second[index]);

/**
 * Application messages use the encrypted relay. Optional direct WebRTC media
 * is addressed only after the relay identity signs a fresh channel challenge.
 * The fourth argument is a dependency seam for isolated transport tests.
 */
export async function createHybridRoom(config, roomId, callbacks = {}, dependencies = {}) {
  const relay = await (dependencies.createRelayTransport || createRelayTransport)({ ...config, roomId });
  const relayRoom = relay.room || relay;
  const selfId = relay.selfId || relayRoom.selfId;
  const createBinding = relay.createMediaBinding || relayRoom.createMediaBinding;
  const verifyBinding = relay.verifyMediaBinding || relayRoom.verifyMediaBinding;
  const relayPeers = new Set(Object.keys(relayRoom.getPeers?.() || {}).filter(id => id !== selfId));
  const rtcPeers = new Set();
  const canonicalToRtc = new Map();
  const rtcToCanonical = new Map();
  const challenges = new Map();
  const pendingBindings = new Map();
  const pendingMedia = new Map();
  let closed = false;
  let rtcRoom = null;
  let rtcSelfId;
  let identityAction;
  let relayAvailable = true;
  let connectionState = 'waiting';
  const listeners = { onPeerJoin: null, onPeerLeave: null, onPeerStream: null, onPeerTrack: null, onMediaPeerJoin: null, onMediaPeerLeave: null, onConnectionState: null };

  const notify = (name, ...args) => { if (!closed) listeners[name]?.(...args); };
  const liveRtc = rtcId => rtcPeers.has(rtcId) && Object.hasOwn(rtcRoom?.getPeers?.() || {}, rtcId);
  const canonicalFor = rtcId => {
    const id = rtcToCanonical.get(rtcId);
    return relayAvailable && id && relayPeers.has(id) && liveRtc(rtcId) ? id : null;
  };
  const unbindRtc = rtcId => {
    const canonicalId = rtcToCanonical.get(rtcId);
    rtcToCanonical.delete(rtcId);
    if (canonicalToRtc.get(canonicalId) === rtcId) canonicalToRtc.delete(canonicalId);
    if (canonicalId) notify('onMediaPeerLeave', canonicalId);
  };
  const emitMedia = (kind, args, rtcId) => {
    const canonicalId = canonicalFor(rtcId);
    if (!canonicalId) return;
    if (kind === 'stream') notify('onPeerStream', args[0], canonicalId, args[1]);
    else notify('onPeerTrack', args[0], args[1], canonicalId, args[2]);
  };
  const receiveMedia = (kind, args, rtcId) => {
    if (closed || !relayAvailable || !rtcPeers.has(rtcId)) return;
    if (canonicalFor(rtcId)) return emitMedia(kind, args, rtcId);
    // Media may race the asynchronous signature verification. Keep a bounded,
    // unplayed queue and expose it only after the channel is authenticated.
    const queue = pendingMedia.get(rtcId) || [];
    if (queue.length < 16) queue.push({ kind, args });
    pendingMedia.set(rtcId, queue);
  };
  const acceptBinding = (rtcId, canonicalId) => {
    if (closed || !relayAvailable || !liveRtc(rtcId) || !relayPeers.has(canonicalId) || canonicalId === selfId) return false;
    const previousRtc = canonicalToRtc.get(canonicalId);
    const previousCanonical = rtcToCanonical.get(rtcId);
    if ((previousRtc && previousRtc !== rtcId) || (previousCanonical && previousCanonical !== canonicalId)) return false;
    const isNew = !previousCanonical;
    canonicalToRtc.set(canonicalId, rtcId);
    rtcToCanonical.set(rtcId, canonicalId);
    pendingBindings.delete(rtcId);
    challenges.delete(rtcId);
    if (isNew) notify('onMediaPeerJoin', canonicalId);
    for (const item of pendingMedia.get(rtcId) || []) emitMedia(item.kind, item.args, rtcId);
    pendingMedia.delete(rtcId);
    return true;
  };
  const challengePeer = rtcId => {
    if (closed || !relayAvailable || !identityAction || !liveRtc(rtcId) || rtcToCanonical.has(rtcId)) return;
    const challenge = nonce();
    challenges.set(rtcId, challenge);
    identityAction.send({ type: 'challenge', nonce: challenge }, { target: rtcId }).catch(() => {});
  };

  relayRoom.onPeerJoin = canonicalId => {
    if (closed || canonicalId === selfId) return;
    const isNew = !relayPeers.has(canonicalId);
    relayPeers.add(canonicalId);
    for (const [rtcId, pending] of pendingBindings) {
      if (pending.canonicalId === canonicalId && Date.now() - pending.verifiedAt <= 300_000) acceptBinding(rtcId, canonicalId);
    }
    if (isNew) notify('onPeerJoin', canonicalId);
    for (const rtcId of rtcPeers) {
      if (!rtcToCanonical.has(rtcId) && !pendingBindings.has(rtcId)) challengePeer(rtcId);
    }
  };
  relayRoom.onPeerLeave = canonicalId => {
    if (closed) return;
    const existed = relayPeers.delete(canonicalId);
    const rtcId = canonicalToRtc.get(canonicalId);
    if (rtcId) unbindRtc(rtcId);
    for (const [peerId, pending] of pendingBindings) if (pending.canonicalId === canonicalId) pendingBindings.delete(peerId);
    if (existed) notify('onPeerLeave', canonicalId);
  };
  relayRoom.onConnectionState = state => {
    if (closed) return;
    connectionState = state;
    relayAvailable = state !== 'offline';
    if (!relayAvailable) {
      for (const rtcId of [...rtcToCanonical.keys()]) unbindRtc(rtcId);
      challenges.clear(); pendingBindings.clear(); pendingMedia.clear();
    } else {
      for (const rtcId of rtcPeers) challengePeer(rtcId);
    }
    notify('onConnectionState', state);
  };

  const initializeMedia = async () => {
    try {
      const rtc = await (dependencies.loadRtc || (() => import('@trystero-p2p/torrent')))();
      if (closed || typeof createBinding !== 'function' || typeof verifyBinding !== 'function') return false;
      rtcSelfId = rtc.selfId;
      rtcRoom = rtc.joinRoom(config, roomId, {
        ...callbacks,
        // Tracker/ICE failures must not turn a working relay chat into an error.
        onJoinError: () => { if (!closed) callbacks.onMediaError?.({ code: 'call_connection_failed' }); },
      });
      identityAction = rtcRoom.makeAction(bindingActionName);
      identityAction.onReceive = ({ peerId, byteLength }) => !closed && rtcPeers.has(peerId) && byteLength <= 4096;
      identityAction.onMessage = async (message, { peerId } = {}) => {
        if (closed || !relayAvailable || !rtcPeers.has(peerId) || !plainObject(message)) return;
        if (message.type === 'challenge' && validNonce(message.nonce)) {
          try {
            const connection = rtcRoom.getPeers()[peerId];
            const localFingerprints = fingerprints(connection?.localDescription);
            const remoteFingerprints = fingerprints(connection?.remoteDescription);
            if (!localFingerprints.length || !remoteFingerprints.length) return;
            const proof = await createBinding(rtcSelfId, { nonce: message.nonce, peerRtcId: peerId, localFingerprints, remoteFingerprints });
            if (!closed && liveRtc(peerId)) await identityAction.send({ type: 'proof', proof }, { target: peerId });
          } catch { /* Data chat remains available if the optional media binding fails. */ }
          return;
        }
        if (message.type !== 'proof' || !plainObject(message.proof) || message.proof.purpose !== bindingPurpose) return;
        const challenge = challenges.get(peerId);
        if (!challenge || message.proof.nonce !== challenge) return;
        const connection = rtcRoom.getPeers()[peerId];
        if (message.proof.peerRtcId !== rtcSelfId
          || !sameFingerprints(message.proof.localFingerprints, fingerprints(connection?.remoteDescription))
          || !sameFingerprints(message.proof.remoteFingerprints, fingerprints(connection?.localDescription))) return;
        try {
          const canonicalId = await verifyBinding(message.proof, peerId);
          if (closed || !canonicalId || !liveRtc(peerId) || challenges.get(peerId) !== challenge) return;
          if (!acceptBinding(peerId, canonicalId)) {
            if (!relayPeers.has(canonicalId)) pendingBindings.set(peerId, { canonicalId, verifiedAt: Date.now() });
          }
        } catch { /* Invalid signatures and replayed proofs never establish an identity. */ }
      };
      rtcRoom.onPeerStream = (stream, peerId, metadata) => receiveMedia('stream', [stream, metadata], peerId);
      rtcRoom.onPeerTrack = (track, stream, peerId, metadata) => receiveMedia('track', [track, stream, metadata], peerId);
      rtcRoom.onPeerLeave = rtcId => {
        if (closed) return;
        rtcPeers.delete(rtcId);
        challenges.delete(rtcId); pendingBindings.delete(rtcId); pendingMedia.delete(rtcId);
        unbindRtc(rtcId);
      };
      rtcRoom.onPeerJoin = rtcId => {
        if (closed || rtcId === rtcSelfId) return;
        if (rtcPeers.has(rtcId)) unbindRtc(rtcId);
        rtcPeers.add(rtcId);
        challengePeer(rtcId);
      };
      return true;
    } catch {
      if (rtcRoom) {
        try { await rtcRoom.leave(); } catch {}
        rtcRoom = null;
      }
      return false;
    }
  };

  const mappedTargets = (options = {}, required = true) => {
    if (closed || !relayAvailable || !rtcRoom) {
      if (required) throw mediaError();
      return [];
    }
    const targets = options.target === undefined ? [...relayPeers] : Array.isArray(options.target) ? options.target : [options.target];
    const mapped = [];
    for (const canonicalId of targets) {
      const rtcId = canonicalToRtc.get(canonicalId);
      if (!rtcId || canonicalFor(rtcId) !== canonicalId) {
        if (required) throw mediaError();
        continue;
      }
      mapped.push(rtcId);
    }
    return mapped;
  };
  const mediaOperation = async (method, args, options = {}, required = true) => {
    const targets = mappedTargets(options, required);
    if (!targets.length) return [];
    try {
      const result = await rtcRoom[method](...args, { ...options, target: typeof options.target === 'string' ? targets[0] : targets });
      return Array.isArray(result) ? await Promise.all(result) : result;
    } catch { throw mediaError(); }
  };

  const room = {
    selfId,
    makeAction: (...args) => relayRoom.makeAction(...args),
    // Canonical IDs remain stable while their optional RTC connection changes.
    getPeers() {
      const peers = {};
      for (const [canonicalId, rtcId] of canonicalToRtc) if (canonicalFor(rtcId)) peers[canonicalId] = rtcRoom.getPeers()[rtcId];
      return peers;
    },
    addStream: (stream, options) => mediaOperation('addStream', [stream], options),
    removeStream: (stream, options) => mediaOperation('removeStream', [stream], options, false),
    addTrack: (track, stream, options) => mediaOperation('addTrack', [track, stream], options),
    removeTrack: (track, options) => mediaOperation('removeTrack', [track], options, false),
    replaceTrack: (oldTrack, newTrack, options) => mediaOperation('replaceTrack', [oldTrack, newTrack], options),
    async leave() {
      if (closed) return;
      closed = true;
      relayRoom.onPeerJoin = null; relayRoom.onPeerLeave = null; relayRoom.onConnectionState = null;
      for (const name of Object.keys(listeners)) listeners[name] = null;
      challenges.clear(); pendingBindings.clear(); pendingMedia.clear();
      canonicalToRtc.clear(); rtcToCanonical.clear(); relayPeers.clear(); rtcPeers.clear();
      if (identityAction) { identityAction.onMessage = null; identityAction.onReceive = null; }
      if (rtcRoom) {
        rtcRoom.onPeerJoin = null; rtcRoom.onPeerLeave = null;
        rtcRoom.onPeerStream = null; rtcRoom.onPeerTrack = null;
      }
      await Promise.allSettled([Promise.resolve().then(() => relayRoom.leave()), Promise.resolve().then(() => rtcRoom?.leave())]);
    },
  };
  for (const name of Object.keys(listeners)) {
    Object.defineProperty(room, name, {
      enumerable: true,
      get: () => listeners[name],
      set(handler) {
        listeners[name] = typeof handler === 'function' ? handler : null;
        if (!listeners[name] || closed) return;
        if (name === 'onPeerJoin') {
          for (const id of relayPeers) notify(name, id);
        } else if (name === 'onMediaPeerJoin') {
          for (const [id, rtcId] of canonicalToRtc) if (canonicalFor(rtcId)) notify(name, id);
        } else if (name === 'onConnectionState') {
          notify(name, connectionState);
        }
      },
    });
  }
  const mediaReady = initializeMedia();
  return { room, selfId, mediaReady };
}
