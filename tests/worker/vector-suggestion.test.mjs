import assert from 'node:assert/strict';
import test from 'node:test';
import ImageTracer from 'imagetracerjs';

test('creates a reviewable SVG from simple raster logo pixels', () => {
  const width = 24;
  const height = 24;
  const data = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 6; y < 18; y += 1) {
    for (let x = 6; x < 18; x += 1) {
      const pixel = (y * width + x) * 4;
      data[pixel] = 15;
      data[pixel + 1] = 112;
      data[pixel + 2] = 88;
    }
  }

  const svg = ImageTracer.imagedataToSVG(
    { width, height, data },
    { numberofcolors: 3, colorquantcycles: 2, pathomit: 8, viewbox: true, desc: false },
  );

  assert.match(svg, /^<svg\b/);
  assert.match(svg, /<path\b/);
  assert.doesNotMatch(svg, /data:image/i);
});
