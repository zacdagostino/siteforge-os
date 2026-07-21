const typeScore = { logo: 1_000, image: 650, background: 600, social: 300, favicon: 25 };

/**
 * Give the organisation mark in a site's header/navigation a deterministic
 * preference over unrelated logos that appear in page content.
 */
export function visualAssetScore(asset) {
  const placementScore = asset.isHeaderLogo ? 10_000 : 0;
  const homepageScore = asset.pageType === 'homepage' ? 100 : 0;
  const dimensionsScore = Math.min((asset.width || 0) * (asset.height || 0), 2_000_000) / 2_000;
  return placementScore + homepageScore + (typeScore[asset.type] ?? 0) + dimensionsScore;
}

export function visualAssetKey(asset) {
  const url = new URL(asset.url);
  url.hash = '';
  url.search = '';
  const wixMediaPath = /^(\/media\/[^/]+)\/v1\//i.exec(url.pathname)?.[1];
  if (wixMediaPath) return `${url.origin}${wixMediaPath}`;
  return url.toString();
}

/**
 * Keep the organisation mark available without letting many CDN renditions or
 * unrelated client logos crowd out the site photography needed for redesign work.
 */
export function selectVisualAssets(candidates, maximum) {
  const uniqueCandidates = new Map();
  for (const candidate of candidates) {
    const key = visualAssetKey(candidate);
    const existing = uniqueCandidates.get(key);
    if (!existing || visualAssetScore(candidate) > visualAssetScore(existing)) {
      uniqueCandidates.set(key, candidate);
    }
  }
  const ordered = [...uniqueCandidates.values()].sort(
    (left, right) => visualAssetScore(right) - visualAssetScore(left),
  );
  const logoQuota = Math.min(maximum, Math.max(4, Math.ceil(maximum * 0.2)));
  const logos = ordered.filter((candidate) => candidate.type === 'logo');
  const supporting = ordered.filter((candidate) => candidate.type !== 'logo');
  const selected = [...logos.slice(0, logoQuota), ...supporting.slice(0, maximum - logoQuota)];
  if (selected.length < maximum) {
    const selectedKeys = new Set(selected.map((candidate) => visualAssetKey(candidate)));
    selected.push(
      ...ordered
        .filter((candidate) => !selectedKeys.has(visualAssetKey(candidate)))
        .slice(0, maximum - selected.length),
    );
  }
  return {
    candidates: ordered,
    selected,
    logoCount: selected.filter((candidate) => candidate.type === 'logo').length,
    supportingCount: selected.filter((candidate) => candidate.type !== 'logo').length,
  };
}

export function isPreferredOrganisationLogo(asset) {
  return asset.type === 'logo' && asset.isHeaderLogo === true;
}
