import test from 'node:test';
import assert from 'node:assert/strict';
import { normaliseSourceUrl, sourcePagePlan } from '../../worker/source-page-plan.mjs';

test('creates a stable private output map for every selected source page', () => {
  const pages = sourcePagePlan([
    { url: 'https://example.com/' },
    { url: 'https://example.com/about-us' },
    { url: 'https://example.com/post/Helpful%20Article?utm_source=test' },
    { url: 'https://example.com/about-us/' },
  ]);

  assert.deepEqual(
    pages.map(({ sourceUrl, outputPath }) => ({ sourceUrl, outputPath })),
    [
      { sourceUrl: 'https://example.com/', outputPath: 'index.html' },
      { sourceUrl: 'https://example.com/about-us', outputPath: 'about-us.html' },
      {
        sourceUrl: 'https://example.com/post/Helpful%20Article',
        outputPath: 'post--helpful-article.html',
      },
      { sourceUrl: 'https://example.com/about-us', outputPath: 'about-us-2.html' },
    ],
  );
});

test('normalises source URLs without discarding their path', () => {
  assert.equal(
    normaliseSourceUrl('https://example.com/services/?campaign=spring#quote'),
    'https://example.com/services',
  );
});
