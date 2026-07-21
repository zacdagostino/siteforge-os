function conciseText(value, limit = 220) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function packetFacts(page) {
  const primaryHeading = page.structure.headings.find((heading) => heading.level === 'h1')?.text;
  return [
    ['pageTitle', page.structure.title],
    ['primaryHeading', primaryHeading],
    ['metaDescription', page.structure.description],
    ['language', page.structure.language],
  ]
    .filter(([, value]) => conciseText(value))
    .map(([field, value]) => ({ field, value: conciseText(value), sourceUrl: page.finalUrl }));
}

/** A compact factual handoff. AI capability interpretation is deliberately deferred to its worker. */
export function createResearchPacket({ businessName, run, capture, capturedAt }) {
  const pageSummaries = capture.pages.map((page) => ({
    url: page.finalUrl,
    pageType: page.pageType,
    title: conciseText(page.structure.title),
    primaryHeading: conciseText(
      page.structure.headings.find((heading) => heading.level === 'h1')?.text,
    ),
    description: conciseText(page.structure.description),
    canonicalUrl: page.structure.canonicalUrl || undefined,
    navigation: page.structure.navigation.slice(0, 24),
    headings: page.structure.headings.slice(0, 24),
    formCount: page.structure.forms.length,
    integrations: Array.isArray(page.structure.integrations)
      ? page.structure.integrations.slice(0, 24)
      : [],
    imageCount: page.structure.images.length,
    readableTextAvailable: Boolean(page.structure.readableText),
  }));
  const facts = capture.pages.flatMap(packetFacts);
  const assetCatalog = capture.assets.map((asset) => ({
    type: asset.type,
    sourceUrl: asset.url,
    sourcePageUrl: asset.pageUrl,
    detail: conciseText(asset.detail),
    context: conciseText(asset.context),
    width: asset.width || undefined,
    height: asset.height || undefined,
    contentType: asset.contentType,
  }));
  const emails = [...new Set(capture.pages.flatMap((page) => page.structure.contacts.emails))];
  const phones = [...new Set(capture.pages.flatMap((page) => page.structure.contacts.phones))];
  return {
    schemaVersion: 3,
    generatedAt: capturedAt,
    sourceCapture: {
      id: run.id,
      targetUrl: run.target_url,
      scope: run.capture_scope,
      pageCount: capture.pages.length,
      discoveredPageCount: capture.discoveredPageCount,
      failedPageCount: capture.failedPages.length,
    },
    business: {
      name: conciseText(businessName),
      website: run.target_url,
      publicContacts: { emails, phones },
    },
    pages: pageSummaries,
    capturedFacts: facts,
    visualAssets: assetCatalog,
    sourceManifest: {
      privateArtifacts: {
        rawHtml: capture.pages.length,
        readableText: capture.pages.length,
        responsiveScreenshots: capture.pages.reduce(
          (total, page) => total + (Array.isArray(page.screenshots) ? page.screenshots.length : 0),
          0,
        ),
        automatedAccessibilityChecks: capture.pages.length,
        structureAndTimingFiles: capture.pages.length,
        visualAssets: assetCatalog.length,
      },
      notes: [
        'All facts are direct observations from the captured public website and retain a source URL.',
        'Missing, conflicting, or inferred business information must be flagged for human review.',
        'Visual assets remain private source material until a human approves any external use.',
        'Capability scope is interpreted separately by an AI worker and always requires human review.',
      ],
    },
  };
}
