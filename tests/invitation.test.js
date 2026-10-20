import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInvitation, readInvitation, invitationUrl } from '../src/roomInvite.js';

test('invites contain independent random room and key, carried only in the fragment', () => {
  const first = createInvitation();
  const second = createInvitation();
  assert.match(first.roomId, /^[a-f0-9]{32}$/);
  assert.match(first.password, /^[a-f0-9]{64}$/);
  assert.notEqual(first.roomId, second.roomId);
  assert.notEqual(first.password, second.password);
  const url = new URL(invitationUrl(first, 'https://example.org/?tracking=old#old'));
  assert.equal(url.search, '');
  assert.ok(!`${url.origin}${url.pathname}${url.search}`.includes(first.password));
  assert.deepEqual(readInvitation(url.hash), first);
});

test('incomplete, malformed and duplicate invitation parameters are rejected', () => {
  assert.equal(readInvitation(''), null);
  assert.equal(readInvitation('#'), null);
  const valid = createInvitation();
  for (const hash of ['#room=x', '#key=x', '#room=../../etc', `#room=${valid.roomId}&key=${valid.password}&key=${valid.password}`]) {
    assert.throws(() => readInvitation(hash), { code: 'invalid_invite' });
  }
  assert.throws(() => invitationUrl({ roomId: 'x', password: 'y' }, 'https://example.org'));
});
