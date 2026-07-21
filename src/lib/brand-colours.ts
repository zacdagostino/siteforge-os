import type { BrandColourEvidence } from './domain';

type RankedColour = {
  colour: string;
  score: number;
  evidence: BrandColourEvidence[];
};

const sourceWeight: Record<BrandColourEvidence['sourceType'], number> = {
  logo_vector: 14,
  logo_pixels: 9,
  website_css: 5,
  rendered_ui: 3,
};

const confidenceWeight: Record<BrandColourEvidence['confidence'], number> = {
  high: 1,
  medium: 0.72,
  low: 0.42,
};

function normaliseColour(value: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value.toUpperCase() : undefined;
}

function hue(value: string) {
  const red = Number.parseInt(value.slice(1, 3), 16) / 255;
  const green = Number.parseInt(value.slice(3, 5), 16) / 255;
  const blue = Number.parseInt(value.slice(5, 7), 16) / 255;
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  if (!delta) return 0;
  if (maximum === red) return (((green - blue) / delta + 6) % 6) / 6;
  if (maximum === green) return ((blue - red) / delta + 2) / 6;
  return ((red - green) / delta + 4) / 6;
}

function hueDistance(first: number, second: number) {
  const difference = Math.abs(first - second);
  return Math.min(difference, 1 - difference);
}

export function rankBrandColourEvidence(evidence: BrandColourEvidence[]) {
  const directLogoEvidence = evidence.filter(
    (item) =>
      (item.sourceType === 'logo_vector' || item.sourceType === 'logo_pixels') &&
      item.confidence === 'high',
  );
  const logoRanking = rankEvidence(directLogoEvidence);
  return logoRanking.primary && logoRanking.accent ? logoRanking : rankEvidence(evidence);
}

function rankEvidence(evidence: BrandColourEvidence[]) {
  const ranked = new Map<string, RankedColour>();
  for (const item of evidence) {
    const colour = normaliseColour(item.colour);
    if (!colour) continue;
    const current = ranked.get(colour) ?? { colour, score: 0, evidence: [] };
    current.score +=
      sourceWeight[item.sourceType] *
      confidenceWeight[item.confidence] *
      Math.max(1, Math.log2(item.occurrenceCount + 1));
    current.evidence.push(item);
    ranked.set(colour, current);
  }
  const candidates = [...ranked.values()].sort((left, right) => right.score - left.score);
  const primary = candidates[0];
  const accent = primary
    ? candidates.find((candidate) => hueDistance(hue(primary.colour), hue(candidate.colour)) > 0.1)
    : undefined;
  return { primary, accent, candidates };
}

export function brandColourEvidenceSummary(evidence: BrandColourEvidence[]) {
  const sourceLabels: Record<BrandColourEvidence['sourceType'], string> = {
    logo_vector: 'SVG logo',
    logo_pixels: 'logo image',
    website_css: 'website CSS',
    rendered_ui: 'rendered interface',
  };
  const sources = [...new Set(evidence.map((item) => sourceLabels[item.sourceType]))];
  return sources.join(', ');
}
