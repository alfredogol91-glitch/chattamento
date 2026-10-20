import { test, expect } from '@playwright/test';

// These component tests exercise real browser media devices and the room
// adapter contract. They do not claim media transport across external peers;
// the managed cloud browser blocks direct UDP without a TURN relay.
async function openHarness(page) {
  await page.addInitScript(() => {
    window.__callTracks = [];
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      window.__callTracks.push(...stream.getTracks());
      return stream;
    };
  });
  await page.goto('/tests/calls-harness.html');
  await expect(page.getByRole('button', { name: 'Audio call', exact: true })).toBeEnabled();
}

async function micEnabled(page) {
  return page.evaluate(() => window.__callTracks.find((track) => track.kind === 'audio' && track.readyState === 'live')?.enabled);
}

async function fixtureCalls(page, method) {
  return page.evaluate((name) => window.__callFixture.calls.filter((call) => call.method === name).map((call) => ({
    peerId: call.peerId, kind: call.track?.kind,
  })), method);
}

test('walkie-talkie captures only on entry, mutes on release/blur and supports hands-free audio', async ({ page }) => {
  await openHarness(page);
  expect(await page.evaluate(() => window.__callTracks.length)).toBe(0);
  await page.getByRole('button', { name: 'Audio call', exact: true }).click();
  const talk = page.getByRole('button', { name: 'Hold to talk', exact: true });
  await expect(talk).toBeVisible();
  expect(await micEnabled(page)).toBe(false);
  expect(await fixtureCalls(page, 'addStream')).toEqual([{ peerId: 'bob', kind: undefined }]);

  const bounds = await talk.boundingBox();
  await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await expect(page.getByRole('button', { name: 'Release to mute', exact: true })).toBeVisible();
  expect(await micEnabled(page)).toBe(true);
  // Pointer capture must mute even when the pointer is released outside.
  await page.mouse.move(5, 5);
  await page.mouse.up();
  await expect(talk).toBeVisible();
  expect(await micEnabled(page)).toBe(false);

  await talk.focus();
  await page.keyboard.down('Space');
  expect(await micEnabled(page)).toBe(true);
  await page.keyboard.up('Space');
  expect(await micEnabled(page)).toBe(false);
  await page.keyboard.down('Enter');
  expect(await micEnabled(page)).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  expect(await micEnabled(page)).toBe(false);
  await page.keyboard.up('Enter');

  await page.getByRole('button', { name: 'Hands-free microphone', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Mute microphone', exact: true })).toBeVisible();
  expect(await micEnabled(page)).toBe(true);
  await page.getByRole('button', { name: 'Mute microphone', exact: true }).click();
  expect(await micEnabled(page)).toBe(false);
  await page.getByRole('button', { name: 'Unmute microphone', exact: true }).click();
  expect(await micEnabled(page)).toBe(true);
  await page.getByRole('button', { name: 'Push-to-talk mode', exact: true }).click();
  await expect(talk).toBeVisible();
  expect(await micEnabled(page)).toBe(false);
  await page.getByRole('button', { name: 'Leave call', exact: true }).click();
  expect(await page.evaluate(() => window.__callTracks.every((track) => track.readyState === 'ended'))).toBe(true);
});

test('video uses normal audio, targets call participants, accepts remote streams and releases camera', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => window.__callFixture.sendRemoteStream('bob'));
  await expect(page.locator('.call-tile')).toHaveCount(0);
  await page.getByRole('button', { name: 'Video call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  expect(await micEnabled(page)).toBe(true);
  expect(await page.evaluate(() => window.__callTracks.map((track) => track.kind).sort())).toEqual(['audio', 'video']);
  await expect(page.getByRole('button', { name: 'Hold to talk', exact: true })).toHaveCount(0);
  await expect(page.locator('.call-tile')).toHaveCount(2);
  const remoteStreamId = await page.evaluate(() => window.__callFixture.sendRemoteStream('bob'));
  await expect.poll(() => page.locator('video[aria-label="Bob"]').evaluate((element) => element.srcObject?.id)).toBe(remoteStreamId);

  await page.getByRole('button', { name: 'Turn camera off', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn camera on', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__callTracks.filter((track) => track.kind === 'video').every((track) => track.readyState === 'ended'))).toBe(true);
  expect(await fixtureCalls(page, 'removeTrack')).toEqual([{ peerId: 'bob', kind: 'video' }]);
  await page.getByRole('button', { name: 'Turn camera on', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Turn camera off', exact: true })).toBeVisible();
  expect(await fixtureCalls(page, 'addTrack')).toEqual([{ peerId: 'bob', kind: 'video' }]);

  await page.evaluate(() => window.__callFixture.setPeer('bob', { inCall: false }));
  await expect(page.locator('.call-tile')).toHaveCount(1);
  expect(await fixtureCalls(page, 'removeStream')).toEqual([{ peerId: 'bob', kind: undefined }]);
  await page.evaluate(() => window.__callFixture.setPeer('bob', { inCall: true }));
  await expect(page.locator('.call-tile')).toHaveCount(2);
  expect(await fixtureCalls(page, 'addStream')).toHaveLength(2);
  await page.evaluate(() => window.__callFixture.setConnection(false));
  await expect(page.getByRole('button', { name: 'Video call', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__callTracks.every((track) => track.readyState === 'ended'))).toBe(true);
});

test('a room disconnect while permission is pending stops late-arriving microphone tracks', async ({ page }) => {
  await openHarness(page);
  await page.evaluate(() => {
    const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
    navigator.mediaDevices.getUserMedia = async (constraints) => {
      const stream = await getUserMedia(constraints);
      await new Promise((resolve) => { window.__releaseCapture = resolve; });
      return stream;
    };
  });
  await page.getByRole('button', { name: 'Audio call', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof window.__releaseCapture)).toBe('function');
  await page.evaluate(() => window.__callFixture.setConnection(false));
  await expect(page.getByRole('button', { name: 'Audio call', exact: true })).toBeVisible();
  await page.evaluate(() => window.__releaseCapture());
  await expect.poll(() => page.evaluate(() => window.__callTracks.every((track) => track.readyState === 'ended'))).toBe(true);
  expect(await fixtureCalls(page, 'addStream')).toHaveLength(0);
});

test('a nickname conflict ends an active call and releases every captured track', async ({ page }) => {
  await openHarness(page);
  await page.getByRole('button', { name: 'Video call', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Leave call', exact: true })).toBeVisible();
  await page.evaluate(() => window.__callFixture.setPeer('alice', { nicknameConflict: true, inCall: false }));
  await expect(page.getByRole('button', { name: 'Video call', exact: true })).toBeVisible();
  expect(await page.evaluate(() => window.__callTracks.every((track) => track.readyState === 'ended'))).toBe(true);
  expect(await fixtureCalls(page, 'removeStream')).toEqual([{ peerId: 'bob', kind: undefined }]);
});
