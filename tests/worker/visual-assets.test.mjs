import test from 'node:test';
import assert from 'node:assert/strict';
import { selectVisualAssets, visualAssetKey } from '../../worker/visual-assets.mjs';

test('deduplicates Wix rendition URLs to their original media file', () => {
  const first = {
    type: 'image',
    url: 'https://static.wixstatic.com/media/project-photo.jpg/v1/fill/w_400,h_300,enc_avif/photo.jpg',
  };
  const second = {
    type: 'image',
    url: 'https://static.wixstatic.com/media/project-photo.jpg/v1/fill/w_1200,h_900,enc_avif/photo.jpg',
  };

  assert.equal(visualAssetKey(first), visualAssetKey(second));
});

test('reserves visual-capture capacity for supporting images', () => {
  const candidates = [
    ...Array.from({ length: 20 }, (_, index) => ({
      type: 'logo',
      url: `https://example.com/logo-${index}.svg`,
      isHeaderLogo: index === 0,
    })),
    ...Array.from({ length: 20 }, (_, index) => ({
      type: 'image',
      url: `https://example.com/project-${index}.jpg`,
      width: 1200,
      height: 800,
    })),
  ];
  const selection = selectVisualAssets(candidates, 10);

  assert.equal(selection.selected.length, 10);
  assert.equal(selection.logoCount, 4);
  assert.equal(selection.supportingCount, 6);
});
