import test from 'node:test';
import assert from 'node:assert/strict';
import { coloursFromSvg, rankBrandColours } from '../../worker/brand-evidence.mjs';

test('prefers repeated logo evidence while retaining a distinct accent', () => {
  const ranked = rankBrandColours([
    {
      colour: '#306090',
      sourceType: 'logo_pixels',
      confidence: 'high',
      occurrenceCount: 80,
      sourceLabel: 'Organisation logo',
    },
    {
      colour: '#FF0000',
      sourceType: 'logo_pixels',
      confidence: 'high',
      occurrenceCount: 40,
      sourceLabel: 'Organisation logo',
    },
    {
      colour: '#306090',
      sourceType: 'rendered_ui',
      confidence: 'medium',
      occurrenceCount: 16,
      sourceLabel: 'interactive control background',
    },
  ]);
  assert.equal(ranked.primary?.colour, '#306090');
  assert.equal(ranked.accent?.colour, '#FF0000');
});

test('does not let generic website colours override a confident coloured organisation logo', () => {
  const ranked = rankBrandColours([
    {
      colour: '#306090',
      sourceType: 'logo_pixels',
      confidence: 'high',
      occurrenceCount: 196,
      sourceLabel: 'Organisation logo',
    },
    {
      colour: '#FF0000',
      sourceType: 'logo_pixels',
      confidence: 'high',
      occurrenceCount: 65,
      sourceLabel: 'Organisation logo',
    },
    {
      colour: '#7FCCF7',
      sourceType: 'website_css',
      confidence: 'high',
      occurrenceCount: 80,
      sourceLabel: '--button-color-fill-primary',
    },
  ]);
  assert.equal(ranked.primary?.colour, '#306090');
  assert.equal(ranked.accent?.colour, '#FF0000');
});

test('uses rendered website evidence when a monochrome logo provides no colour', () => {
  const ranked = rankBrandColours([
    {
      colour: '#1866A8',
      sourceType: 'website_css',
      confidence: 'high',
      occurrenceCount: 18,
      sourceLabel: '--brand-primary',
    },
    {
      colour: '#D1495B',
      sourceType: 'rendered_ui',
      confidence: 'medium',
      occurrenceCount: 11,
      sourceLabel: 'interactive control background',
    },
  ]);
  assert.equal(ranked.primary?.colour, '#1866A8');
  assert.equal(ranked.accent?.colour, '#D1495B');
});

test('reads fill and stroke colours from SVG source', () => {
  assert.deepEqual(coloursFromSvg('<svg><path fill="#1b6ca8" stroke="rgb(209, 73, 91)" /></svg>'), [
    '#1B6CA8',
    '#D1495B',
  ]);
});
