function channelToHex(value) {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0');
}

export function hexFromRgb(red, green, blue) {
  return `#${channelToHex(red)}${channelToHex(green)}${channelToHex(blue)}`.toUpperCase();
}

export function normaliseHexColour(value) {
  const match = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(value.trim());
  if (!match) return undefined;
  const hex = match[1];
  if (hex.length === 3) {
    return `#${hex
      .split('')
      .map((channel) => `${channel}${channel}`)
      .join('')}`.toUpperCase();
  }
  return `#${hex.slice(0, 6)}`.toUpperCase();
}

export function colourFromCssValue(value) {
  const hex = normaliseHexColour(value);
  if (hex) return hex;
  const match = /rgba?\(\s*([\d.]+)[,\s]+\s*([\d.]+)[,\s]+\s*([\d.]+)/i.exec(value);
  if (!match) return undefined;
  return hexFromRgb(Number(match[1]), Number(match[2]), Number(match[3]));
}

function rgbForHex(value) {
  const colour = normaliseHexColour(value);
  if (!colour) return undefined;
  return {
    red: Number.parseInt(colour.slice(1, 3), 16),
    green: Number.parseInt(colour.slice(3, 5), 16),
    blue: Number.parseInt(colour.slice(5, 7), 16),
  };
}

export function isBrandColour(value) {
  const colour = rgbForHex(value);
  if (!colour) return false;
  const maximum = Math.max(colour.red, colour.green, colour.blue) / 255;
  const minimum = Math.min(colour.red, colour.green, colour.blue) / 255;
  const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
  const brightness = (colour.red + colour.green + colour.blue) / (255 * 3);
  return brightness >= 0.08 && brightness <= 0.94 && saturation >= 0.28;
}

function hueForHex(value) {
  const colour = rgbForHex(value);
  if (!colour) return 0;
  const maximum = Math.max(colour.red, colour.green, colour.blue) / 255;
  const minimum = Math.min(colour.red, colour.green, colour.blue) / 255;
  const delta = maximum - minimum;
  if (!delta) return 0;
  if (maximum === colour.red / 255)
    return (((colour.green - colour.blue) / 255 / delta + 6) % 6) / 6;
  if (maximum === colour.green / 255) return ((colour.blue - colour.red) / 255 / delta + 2) / 6;
  return ((colour.red - colour.green) / 255 / delta + 4) / 6;
}

function hueDistance(first, second) {
  const difference = Math.abs(first - second);
  return Math.min(difference, 1 - difference);
}

const sourceWeight = {
  logo_vector: 14,
  logo_pixels: 9,
  website_css: 5,
  rendered_ui: 3,
};

const confidenceWeight = { high: 1, medium: 0.72, low: 0.42 };

/**
 * Produces human-review suggestions only. It never treats a website colour as approved branding.
 */
export function rankBrandColours(evidence) {
  const directLogoEvidence = evidence.filter(
    (item) =>
      (item.sourceType === 'logo_vector' || item.sourceType === 'logo_pixels') &&
      item.confidence === 'high',
  );
  const logoRanking = rankEvidence(directLogoEvidence);
  return logoRanking.primary && logoRanking.accent ? logoRanking : rankEvidence(evidence);
}

function rankEvidence(evidence) {
  const grouped = new Map();
  for (const item of evidence) {
    const colour = normaliseHexColour(item.colour ?? '');
    if (!colour || !isBrandColour(colour)) continue;
    const current = grouped.get(colour) ?? {
      colour,
      score: 0,
      evidence: [],
    };
    const typeWeight = sourceWeight[item.sourceType] ?? 1;
    const certainty = confidenceWeight[item.confidence] ?? confidenceWeight.low;
    current.score +=
      typeWeight * certainty * Math.max(1, Math.log2((item.occurrenceCount ?? 1) + 1));
    current.evidence.push(item);
    grouped.set(colour, current);
  }
  const candidates = [...grouped.values()].sort((left, right) => right.score - left.score);
  const primary = candidates[0];
  const accent = primary
    ? candidates.find(
        (candidate) => hueDistance(hueForHex(primary.colour), hueForHex(candidate.colour)) > 0.1,
      )
    : undefined;
  return { primary, accent, candidates };
}

export function coloursFromSvg(source) {
  const matches = source.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi) ?? [];
  return [...new Set(matches.map(colourFromCssValue).filter(Boolean))];
}
