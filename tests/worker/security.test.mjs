import assert from 'node:assert/strict';
import test from 'node:test';
import { isPrivateIpAddress, isRobotsAllowed, normalisePublicUrl } from '../../worker/security.mjs';

test('only normalises credential-free HTTP(S) targets on standard ports', () => {
  assert.equal(normalisePublicUrl('https://example.com/').hostname, 'example.com');
  assert.throws(() => normalisePublicUrl('file:///etc/passwd'));
  assert.throws(() => normalisePublicUrl('https://user:pass@example.com'));
  assert.throws(() => normalisePublicUrl('https://example.com:8080'));
});

test('blocks local, private, documentation, multicast, and reserved addresses', () => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '172.16.0.1',
    '192.168.1.1',
    '203.0.113.9',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
  ]) {
    assert.equal(isPrivateIpAddress(address), true, address);
  }
  assert.equal(isPrivateIpAddress('8.8.8.8'), false);
  assert.equal(isPrivateIpAddress('2606:4700:4700::1111'), false);
});

test('respects the most specific matching robots rule for the homepage path', () => {
  const robots = `User-agent: *\nDisallow: /\nAllow: /public\n\nUser-agent: siteforgeresearchbot\nDisallow: /private`;
  assert.equal(isRobotsAllowed(robots, '/'), false);
  assert.equal(isRobotsAllowed(robots, '/public/home'), true);
  assert.equal(isRobotsAllowed(robots, '/private'), false);
});
