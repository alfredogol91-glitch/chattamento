const roomPattern = /^[a-f0-9]{32}$/i;
const keyPattern = /^[a-f0-9]{64}$/i;

function randomHex(bytes) {
  return Array.from(crypto.getRandomValues(new Uint8Array(bytes)), value => value.toString(16).padStart(2, '0')).join('');
}

export function createInvitation() {
  return { roomId: randomHex(16), password: randomHex(32) };
}

export function readInvitation(hash = globalThis.location?.hash || '') {
  if (!hash || hash === '#') return null;
  const params = new URLSearchParams(hash.replace(/^#/, ''));
  const roomId = params.get('room');
  const password = params.get('key');
  if (!roomPattern.test(roomId || '') || !keyPattern.test(password || '') || params.getAll('room').length !== 1 || params.getAll('key').length !== 1) {
    const error = new Error('invalid_invite');
    error.code = 'invalid_invite';
    throw error;
  }
  return { roomId: roomId.toLowerCase(), password: password.toLowerCase() };
}

export function invitationUrl(invitation, baseUrl = globalThis.location?.href) {
  if (!roomPattern.test(invitation?.roomId || '') || !keyPattern.test(invitation?.password || '')) throw new Error('invalid_invite');
  const url = new URL(baseUrl);
  url.search = '';
  url.hash = new URLSearchParams({ room: invitation.roomId, key: invitation.password }).toString();
  return url.toString();
}
