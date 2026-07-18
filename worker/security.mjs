import { lookup } from 'node:dns/promises';
import net from 'node:net';

const allowedProtocols = new Set(['http:', 'https:']);

export function normalisePublicUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('The capture target is not a valid URL.');
  }
  if (!allowedProtocols.has(url.protocol) || url.username || url.password) {
    throw new Error('The capture target must be a public HTTP or HTTPS URL.');
  }
  if (url.port && !['80', '443'].includes(url.port)) {
    throw new Error('The capture target uses a blocked network port.');
  }
  return url;
}

export function isPrivateIpAddress(address) {
  const family = net.isIP(address);
  if (family === 4) {
    const [first, second] = address.split('.').map(Number);
    return (
      first === 0 ||
      first === 10 ||
      first === 127 ||
      (first === 100 && second >= 64 && second <= 127) ||
      (first === 169 && second === 254) ||
      (first === 172 && second >= 16 && second <= 31) ||
      (first === 192 && (second === 0 || second === 168)) ||
      (first === 198 && (second === 18 || second === 19 || second === 51)) ||
      (first === 203 && second === 0) ||
      first >= 224
    );
  }
  if (family === 6) {
    const normalized = address.toLowerCase();
    return (
      normalized === '::' ||
      normalized === '::1' ||
      normalized.startsWith('fc') ||
      normalized.startsWith('fd') ||
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb') ||
      normalized.startsWith('ff') ||
      normalized.startsWith('2001:db8:') ||
      normalized.startsWith('::ffff:') ||
      normalized.includes('::ffff:127.') ||
      normalized.includes('::ffff:10.') ||
      normalized.includes('::ffff:192.168.')
    );
  }
  return true;
}

export async function assertPublicUrl(value, cache = new Map()) {
  const url = normalisePublicUrl(value);
  const hostname = url.hostname;
  const addresses = cache.get(hostname) ?? (await lookup(hostname, { all: true, verbatim: true }));
  cache.set(hostname, addresses);
  if (!addresses.length || addresses.some(({ address }) => isPrivateIpAddress(address))) {
    throw new Error('The capture target resolves to a blocked network address.');
  }
  return url;
}

export function isRobotsAllowed(robotsText, pathname, userAgent = 'siteforgeresearchbot') {
  const groups = robotsText.replace(/\r/g, '').split(/\n\s*\n/);
  const rules = [];
  for (const group of groups) {
    const lines = group
      .split('\n')
      .map((line) => line.replace(/#.*/, '').trim())
      .filter(Boolean);
    const agents = lines
      .filter((line) => /^user-agent\s*:/i.test(line))
      .map((line) => line.split(':').slice(1).join(':').trim().toLowerCase());
    if (!agents.includes('*') && !agents.includes(userAgent.toLowerCase())) continue;
    for (const line of lines) {
      const match = /^(allow|disallow)\s*:\s*(.*)$/i.exec(line);
      if (!match || !match[2]) continue;
      const [kind, path] = [match[1].toLowerCase(), match[2].trim()];
      if (pathname.startsWith(path)) rules.push({ kind, path });
    }
  }
  if (!rules.length) return true;
  rules.sort((left, right) => right.path.length - left.path.length);
  return rules[0].kind === 'allow';
}
