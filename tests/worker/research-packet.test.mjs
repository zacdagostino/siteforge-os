import test from 'node:test';
import assert from 'node:assert/strict';
import { createResearchPacket } from '../../worker/research-packet.mjs';

test('creates a compact, source-oriented research packet', () => {
  const packet = createResearchPacket({
    businessName: 'Example Electrical',
    run: {
      id: 'run-1',
      target_url: 'https://example.test',
      capture_scope: 'key_pages',
    },
    capturedAt: '2026-07-18T00:00:00.000Z',
    capture: {
      discoveredPageCount: 3,
      failedPages: [],
      assets: [
        {
          type: 'logo',
          url: 'https://example.test/logo.svg',
          pageUrl: 'https://example.test',
          detail: 'Example logo',
          context: 'Electrical services Example logo',
          width: 420,
          height: 120,
          contentType: 'image/svg+xml',
        },
      ],
      pages: [
        {
          finalUrl: 'https://example.test',
          pageType: 'homepage',
          structure: {
            title: 'Example Electrical',
            description: 'Reliable electrical work',
            canonicalUrl: 'https://example.test',
            language: 'en',
            headings: [{ level: 'h1', text: 'Electrical services' }],
            navigation: [{ label: 'Contact', href: 'https://example.test/contact' }],
            forms: [],
            integrations: [],
            images: [],
            readableText: 'A short source page body.',
            contacts: { emails: ['hello@example.test'], phones: ['1234'] },
          },
        },
      ],
    },
  });

  assert.equal(packet.business.name, 'Example Electrical');
  assert.equal(packet.pages[0].primaryHeading, 'Electrical services');
  assert.equal(packet.visualAssets[0].type, 'logo');
  assert.equal(packet.visualAssets[0].context, 'Electrical services Example logo');
  assert.equal(packet.sourceManifest.privateArtifacts.responsiveScreenshots, 0);
  assert.equal(packet.schemaVersion, 3);
});
