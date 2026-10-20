export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
export const SUPPORTED_LANGUAGES = ['en', 'ru', 'es', 'uk', 'it'];
export const SIGNALING_RELAYS = ['wss://tracker.webtorrent.dev', 'wss://tracker.openwebtorrent.com'];
const APP_ID = 'chattamento-live-v1';
const MAX_MESSAGE_LENGTH = 4000;
const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const codeError = code => Object.assign(new Error(code), { code });
const normalizeNickname = value => typeof value === 'string' ? value.normalize('NFKC').trim().replace(/\s+/gu, ' ') : '';
const nicknameKey = value => normalizeNickname(value).toLocaleLowerCase('en-US');
const validNickname = value => [...value].length >= 2 && [...value].length <= 24 && /^[\p{L}\p{N} _-]+$/u.test(value);
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const safeName = value => String(value || 'file').split(/[\\/]/u).pop().normalize('NFC').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, 200) || 'file';
const settleMedia = result => Array.isArray(result)
  ? Promise.all(result)
  : Promise.resolve(result).then(value => Array.isArray(value) ? Promise.all(value) : value);

function detectedMime(bytes, claimedType = '') {
  const ascii = (start, length) => String.fromCharCode(...bytes.slice(start, start + length));
  if (bytes.length >= 8 && bytes[0] === 137 && ascii(1, 3) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) return 'image/gif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WEBP') return 'image/webp';
  if (ascii(4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(8, 4))) return 'image/avif';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 4) === 'WAVE') return 'audio/wav';
  if (ascii(0, 4) === 'fLaC') return 'audio/flac';
  if (ascii(0, 4) === 'OggS') return claimedType === 'video/ogg' ? 'video/ogg' : 'audio/ogg';
  if (ascii(0, 3) === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224)) return 'audio/mpeg';
  if (ascii(4, 4) === 'ftyp') return claimedType === 'audio/mp4' || ascii(8, 3) === 'M4A' ? 'audio/mp4' : 'video/mp4';
  if (bytes[0] === 26 && bytes[1] === 69 && bytes[2] === 223 && bytes[3] === 163) return claimedType === 'audio/webm' ? 'audio/webm' : 'video/webm';
  return 'application/octet-stream';
}

function bytesOf(value) {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return null;
}

/** A live, invitation-scoped room. It deliberately stores no history on disk. */
export function createPeerRoom({ roomId, password, nickname, language, transportFactory } = {}) {
  nickname = normalizeNickname(nickname);
  if (!validNickname(nickname)) throw codeError('invalid_nickname');
  if (!SUPPORTED_LANGUAGES.includes(language)) throw codeError('invalid_language');
  if (typeof roomId !== 'string' || !roomId || roomId.length > 256 || typeof password !== 'string' || !password || password.length > 256) throw codeError('invalid_invite');

  const handlers = new Map();
  const profiles = new Map();
  const peerIds = new Set();
  const objectUrls = new Set();
  const seen = new Set();
  const localMessages = new Map();
  let user = { id: crypto.randomUUID(), nickname, language, inCall: false, audio: false, video: false, claimedAt: Date.now(), nicknameConflict: false };
  let status = 'offline';
  let room;
  let profileAction, messageAction, fileAction;
  let connecting;
  let left = false;
  let conflictWinner = null;
  let removeNetworkListeners = () => {};

  const emit = (event, value) => {
    for (const listener of [...(handlers.get(event) || [])]) {
      try { listener(value); } catch (error) { console.error('Room listener failed', error?.name || 'Error'); }
    }
  };
  const setStatus = next => {
    if (status === next) return;
    status = next;
    if (['offline', 'error'].includes(next) && user.inCall) {
      user = { ...user, inCall: false, audio: false, video: false };
      emit('profile', { ...user });
      emit('presence', { users: users(), total: profiles.size + 1 });
      profileAction?.send({ ...user }).catch(() => {});
    }
    emit('status', next);
  };
  const emitError = code => emit('error', { code });
  const users = () => [user, ...profiles.values()].map(profile => ({ ...profile, nicknameConflict: winnerFor(profile.nickname)?.id !== profile.id }));
  const winnerFor = name => [user, ...profiles.values()]
    .filter(profile => nicknameKey(profile.nickname) === nicknameKey(name))
    .sort((a, b) => a.claimedAt - b.claimedAt || a.id.localeCompare(b.id))[0];
  const isConflicted = profile => winnerFor(profile.nickname)?.id !== profile.id;
  const presence = () => {
    const winner = winnerFor(user.nickname);
    const conflict = winner && winner.id !== user.id;
    if (conflict && conflictWinner !== winner.id) emit('nickname-conflict', { nickname: user.nickname, winnerId: winner.id });
    conflictWinner = conflict ? winner.id : null;
    user = { ...user, nicknameConflict: !!conflict };
    if (conflict && user.inCall) user = { ...user, inCall: false, audio: false, video: false };
    emit('profile', { ...user });
    const current = users();
    emit('presence', { users: current, total: current.length });
    if (room && !left && status !== 'error') setStatus(globalThis.navigator?.onLine === false ? 'offline' : profiles.size ? 'connected' : 'waiting');
  };
  const broadcastProfile = target => profileAction.send({ ...user }, target ? { target } : undefined);
  const ensureRoom = (allowConflict = false) => {
    if (!room || left) throw codeError('offline');
    if (user.nicknameConflict && !allowConflict) throw codeError('nickname_taken');
  };
  const remember = key => {
    if (seen.has(key)) return false;
    seen.add(key);
    if (seen.size > 10_000) seen.delete(seen.values().next().value);
    return true;
  };
  const attachment = (bytes, metadata) => {
    const mimeType = detectedMime(bytes, metadata.mimeType);
    const url = URL.createObjectURL(new Blob([bytes], { type: mimeType }));
    objectUrls.add(url);
    return { id: metadata.id, name: safeName(metadata.name), mimeType, size: bytes.byteLength, url };
  };
  const validMessage = value => plainObject(value) && validId(value.id) && typeof value.text === 'string'
    && [...value.text].length <= MAX_MESSAGE_LENGTH && SUPPORTED_LANGUAGES.includes(value.sourceLanguage)
    && typeof value.createdAt === 'string' && value.createdAt.length <= 64 && Number.isFinite(Date.parse(value.createdAt));
  const receiveMessage = (payload, peerId, receivedAttachment = null) => {
    const sender = profiles.get(peerId);
    if (left || !sender || isConflicted(sender) || !validMessage(payload) || (!payload.text.trim() && !receivedAttachment)) return;
    if (!remember(`${peerId}:${payload.id}`)) {
      if (receivedAttachment) { URL.revokeObjectURL(receivedAttachment.url); objectUrls.delete(receivedAttachment.url); }
      return;
    }
    emit('message', {
      id: payload.id, userId: peerId, nickname: sender.nickname, sourceLanguage: payload.sourceLanguage,
      text: payload.text, createdAt: new Date(payload.createdAt).toISOString(), attachment: receivedAttachment,
    });
  };
  const receiveStream = (stream, peerId) => {
    const sender = profiles.get(peerId);
    if (!left && user.inCall && !user.nicknameConflict && sender?.inCall && !isConflicted(sender)) emit('stream', { stream, peerId });
  };

  const client = {
    get user() { return { ...user }; },
    get users() { return users(); },
    get status() { return status; },
    get connected() { return !!room && !left && !['offline', 'error'].includes(status); },
    on(event, listener) {
      if (typeof listener !== 'function') return () => {};
      if (!handlers.has(event)) handlers.set(event, new Set());
      handlers.get(event).add(listener);
      return () => client.off(event, listener);
    },
    off(event, listener) { handlers.get(event)?.delete(listener); },
    async connect() {
      if (left) throw codeError('offline');
      if (connecting) return connecting;
      if (room) return { user: { ...user } };
      setStatus('connecting');
      connecting = (async () => {
        try {
          const callbacks = { onJoinError: () => { if (!left) { emitError('connection_failed'); if (!profiles.size) setStatus('error'); } } };
          let transport;
          const config = { appId: APP_ID, password, maxReceiveBytes: MAX_ATTACHMENT_BYTES, relayConfig: { urls: [...SIGNALING_RELAYS] } };
          if (transportFactory) {
            transport = await transportFactory(config, roomId, callbacks);
          } else {
            const { joinRoom, selfId } = await import('@trystero-p2p/torrent');
            transport = { room: joinRoom(config, roomId, callbacks), selfId };
          }
          if (left) { await (transport.room || transport).leave(); throw codeError('offline'); }
          room = transport.room || transport;
          user = { ...user, id: transport.selfId || transport.peerId || room.selfId || user.id };
          if (typeof room.makeAction !== 'function') throw codeError('connection_failed');
          profileAction = room.makeAction('profile');
          messageAction = room.makeAction('message');
          fileAction = room.makeAction('attachment');
          profileAction.onReceive = ({ byteLength }) => byteLength <= 4096;
          profileAction.onMessage = (profile, { peerId } = {}) => {
            if (left || !peerIds.has(peerId) || !plainObject(profile)) return;
            const name = normalizeNickname(profile.nickname);
            if (!validNickname(name) || !SUPPORTED_LANGUAGES.includes(profile.language) || !Number.isFinite(profile.claimedAt) || profile.claimedAt < 0 || profile.claimedAt > Date.now() + 60_000) return;
            profiles.set(peerId, { id: peerId, nickname: name, language: profile.language, claimedAt: profile.claimedAt, inCall: profile.inCall === true, audio: profile.audio === true, video: profile.video === true });
            if (status === 'error') setStatus('connected');
            presence();
          };
          messageAction.onReceive = ({ byteLength }) => byteLength <= 20_000;
          messageAction.onMessage = (message, { peerId } = {}) => receiveMessage(message, peerId);
          fileAction.onReceive = ({ byteLength, metadata, peerId }) => {
            const sender = profiles.get(peerId);
            return !!sender && !isConflicted(sender) && byteLength >= 0 && byteLength <= MAX_ATTACHMENT_BYTES
              && plainObject(metadata) && validMessage(metadata.message) && validId(metadata.id)
              && typeof metadata.name === 'string' && metadata.name.length <= 200 && metadata.size === byteLength;
          };
          fileAction.onMessage = (data, { peerId, metadata } = {}) => {
            const bytes = bytesOf(data);
            if (!bytes || bytes.byteLength > MAX_ATTACHMENT_BYTES || !plainObject(metadata) || !validMessage(metadata.message)
              || !validId(metadata.id) || typeof metadata.name !== 'string' || metadata.name.length > 200 || metadata.size !== bytes.byteLength
              || !profiles.has(peerId) || isConflicted(profiles.get(peerId)) || seen.has(`${peerId}:${metadata.message.id}`)) return;
            receiveMessage(metadata.message, peerId, attachment(bytes, metadata));
          };
          room.onPeerStream = receiveStream;
          room.onPeerTrack = (_track, stream, peerId) => receiveStream(stream, peerId);
          room.onPeerLeave = peerId => {
            peerIds.delete(peerId);
            profiles.delete(peerId);
            emit('peer-left', { peerId });
            if (status === 'error') setStatus('waiting');
            presence();
          };
          room.onPeerJoin = peerId => {
            if (left || peerId === user.id) return;
            peerIds.add(peerId);
            broadcastProfile(peerId).catch(() => emitError('connection_failed'));
            emit('peer-joined', { peerId });
          };
          if (typeof globalThis.addEventListener === 'function') {
            const offline = () => setStatus('offline');
            const online = () => { if (room && !left) { setStatus(profiles.size ? 'connected' : 'waiting'); broadcastProfile().catch(() => emitError('connection_failed')); } };
            globalThis.addEventListener('offline', offline);
            globalThis.addEventListener('online', online);
            removeNetworkListeners = () => { globalThis.removeEventListener('offline', offline); globalThis.removeEventListener('online', online); };
          }
          presence();
          if (status === 'connecting' || status === 'offline') setStatus(globalThis.navigator?.onLine === false ? 'offline' : 'waiting');
          return { user: { ...user } };
        } catch (error) {
          if (room) { try { await room.leave(); } catch {} room = null; }
          if (!left) { setStatus('error'); emitError(error?.code || 'connection_failed'); }
          throw codeError(error?.code || 'connection_failed');
        } finally { connecting = null; }
      })();
      return connecting;
    },
    async updateProfile(next = {}) {
      ensureRoom(true);
      if (!plainObject(next)) throw codeError('invalid_request');
      const nextName = next.nickname === undefined ? user.nickname : normalizeNickname(next.nickname);
      const nextLanguage = next.language === undefined ? user.language : next.language;
      if (!validNickname(nextName)) throw codeError('invalid_nickname');
      if (!SUPPORTED_LANGUAGES.includes(nextLanguage)) throw codeError('invalid_language');
      if (nicknameKey(nextName) !== nicknameKey(user.nickname) && [...profiles.values()].some(profile => nicknameKey(profile.nickname) === nicknameKey(nextName))) throw codeError('nickname_taken');
      user = { ...user, nickname: nextName, language: nextLanguage, claimedAt: nicknameKey(nextName) === nicknameKey(user.nickname) ? user.claimedAt : Date.now() };
      presence();
      await broadcastProfile();
      return { ...user };
    },
    async sendMessage({ text = '', file, clientId } = {}) {
      ensureRoom();
      if (typeof text !== 'string') throw codeError('invalid_request');
      text = text.trim();
      if ([...text].length > MAX_MESSAGE_LENGTH) throw codeError('message_too_long');
      if (!text && !file) throw codeError('message_required');
      if (file && (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES || typeof file.arrayBuffer !== 'function')) throw codeError(file?.size > MAX_ATTACHMENT_BYTES ? 'file_too_large' : 'upload_failed');
      const id = clientId || crypto.randomUUID();
      if (!validId(id)) throw codeError('invalid_request');
      if (localMessages.has(id)) return { message: localMessages.get(id) };
      const payload = { id, text, sourceLanguage: user.language, createdAt: new Date().toISOString() };
      const targets = [...profiles.values()].filter(profile => !isConflicted(profile)).map(profile => profile.id);
      if (!targets.length) throw codeError('no_peers');
      let localAttachment = null;
      if (file) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        if (bytes.byteLength > MAX_ATTACHMENT_BYTES || bytes.byteLength !== file.size) throw codeError('file_too_large');
        const metadata = { id: crypto.randomUUID(), name: safeName(file.name), mimeType: file.type || '', size: bytes.byteLength, message: payload };
        if (targets.length) await fileAction.send(bytes, { target: targets, metadata });
        if (left) throw codeError('offline');
        localAttachment = attachment(bytes, metadata);
      } else if (targets.length) await messageAction.send(payload, { target: targets });
      if (left) throw codeError('offline');
      const message = { ...payload, userId: user.id, nickname: user.nickname, attachment: localAttachment };
      localMessages.set(id, message);
      remember(`${user.id}:${id}`);
      emit('message', message);
      return { message };
    },
    async setCallState(state = {}) {
      ensureRoom(state?.inCall !== true);
      if (!plainObject(state)) throw codeError('invalid_request');
      user = { ...user, inCall: state.inCall === true, audio: state.inCall === true && state.audio === true, video: state.inCall === true && state.video === true };
      presence();
      await broadcastProfile();
      return { ...user };
    },
    async addStream(stream, target) { ensureRoom(); return settleMedia(room.addStream(stream, target ? { target } : undefined)); },
    async removeStream(stream, target) { if (room && !left) return settleMedia(room.removeStream(stream, target ? { target } : undefined)); },
    async addTrack(track, stream, target) { ensureRoom(); return settleMedia(room.addTrack(track, stream, target ? { target } : undefined)); },
    async removeTrack(track, target) { if (room && !left) return settleMedia(room.removeTrack(track, target ? { target } : undefined)); },
    async replaceTrack(oldTrack, newTrack, target) { ensureRoom(); return settleMedia(room.replaceTrack(oldTrack, newTrack, target ? { target } : undefined)); },
    getPeerConnections() { return room?.getPeers?.() || {}; },
    async leave() {
      if (left) return;
      left = true;
      removeNetworkListeners();
      if (room) {
        room.onPeerJoin = null; room.onPeerLeave = null; room.onPeerStream = null; room.onPeerTrack = null;
        for (const action of [profileAction, messageAction, fileAction]) if (action) { action.onMessage = null; action.onReceive = null; }
        try { await room.leave(); } catch { /* Local cleanup still completes if the transport has already failed. */ }
      }
      room = null;
      profiles.clear(); peerIds.clear(); seen.clear(); localMessages.clear();
      for (const url of objectUrls) URL.revokeObjectURL(url);
      objectUrls.clear();
      user = { ...user, inCall: false, audio: false, video: false, nicknameConflict: false };
      setStatus('offline');
      emit('presence', { users: [], total: 0 });
      handlers.clear();
    },
  };
  return client;
}
