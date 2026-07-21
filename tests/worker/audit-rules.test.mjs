import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAuditFindings } from '../../worker/audit-rules.mjs';

test('creates traceable findings only for observed capture signals', () => {
  const findings = generateAuditFindings({
    pages: [
      {
        url: 'https://example.test/contact',
        title: '',
        canonical_url: '',
        page_type: 'contact',
        metadata: {
          headingCount: 0,
          formCount: 0,
          imagesWithoutAlt: 2,
          unlabelledFormFieldCount: 1,
          viewportPresent: false,
        },
      },
    ],
    facts: [{ id: 'fact-contact', source_url: 'https://example.test/contact' }],
    accessibilityReports: [
      {
        sourceUrl: 'https://example.test/contact',
        violations: [
          {
            id: 'color-contrast',
            help: 'Elements must meet contrast requirements',
            impact: 'serious',
            nodeCount: 3,
          },
        ],
      },
    ],
    performanceReports: [
      { sourceUrl: 'https://example.test/contact', navigation: { loadMs: 3200 } },
    ],
    screenshots: [
      {
        sourceUrl: 'https://example.test/contact',
        metadata: { pageWidth: 900, layoutViewportWidth: 375 },
      },
    ],
  });

  assert.ok(findings.some((entry) => entry.title.includes('document title')));
  assert.ok(findings.some((entry) => entry.area === 'Accessibility' && entry.severity === 'high'));
  assert.ok(findings.some((entry) => entry.area === 'Mobile'));
  assert.ok(findings.every((entry) => entry.sourceUrls.includes('https://example.test/contact')));
  assert.ok(findings.every((entry) => entry.evidenceFactIds.includes('fact-contact')));
});
