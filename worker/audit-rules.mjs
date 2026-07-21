const severityForImpact = {
  critical: 'high',
  serious: 'high',
  moderate: 'medium',
  minor: 'low',
};

function numberValue(record, key) {
  const value = record?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function sourceEvidenceIds(factsByUrl, sourceUrls) {
  return [...new Set(sourceUrls.flatMap((url) => factsByUrl.get(url) ?? []))];
}

function finding({
  area,
  severity,
  title,
  finding: description,
  recommendation,
  sourceUrls,
  factsByUrl,
}) {
  return {
    area,
    severity,
    title,
    finding: description,
    recommendation,
    sourceUrls: [...new Set(sourceUrls)],
    evidenceFactIds: sourceEvidenceIds(factsByUrl, sourceUrls),
  };
}

/**
 * Produces only observations supported by the saved capture. This deliberately does not judge a
 * business claim, legal compliance, visual taste, or conversion outcome without human review.
 */
export function generateAuditFindings({
  pages,
  facts,
  accessibilityReports,
  performanceReports,
  screenshots,
}) {
  const factsByUrl = new Map();
  facts.forEach((fact) => {
    if (!fact.source_url || !fact.id) return;
    factsByUrl.set(fact.source_url, [...(factsByUrl.get(fact.source_url) ?? []), fact.id]);
  });
  const findings = [];
  const capturedPages = pages.filter((page) => page.url);

  const missingTitles = capturedPages.filter((page) => !page.title).map((page) => page.url);
  if (missingTitles.length) {
    findings.push(
      finding({
        area: 'SEO',
        severity: 'medium',
        title: 'Some captured pages do not have a document title',
        finding: `${missingTitles.length} captured ${missingTitles.length === 1 ? 'page does' : 'pages do'} not expose a document title in the saved markup.`,
        recommendation:
          'Add a concise, page-specific document title that matches the page purpose.',
        sourceUrls: missingTitles,
        factsByUrl,
      }),
    );
  }

  const missingCanonicals = capturedPages
    .filter((page) => !page.canonical_url)
    .map((page) => page.url);
  if (missingCanonicals.length) {
    findings.push(
      finding({
        area: 'SEO',
        severity: 'low',
        title: 'Canonical URLs are missing on captured pages',
        finding: `${missingCanonicals.length} captured ${missingCanonicals.length === 1 ? 'page does' : 'pages do'} not provide a canonical link element.`,
        recommendation:
          'Confirm the preferred public URL for each page and add canonical links where appropriate.',
        sourceUrls: missingCanonicals,
        factsByUrl,
      }),
    );
  }

  const pagesWithoutHeadings = capturedPages
    .filter((page) => numberValue(page.metadata, 'headingCount') === 0)
    .map((page) => page.url);
  if (pagesWithoutHeadings.length) {
    findings.push(
      finding({
        area: 'Content',
        severity: 'medium',
        title: 'Some pages have no captured heading structure',
        finding: `${pagesWithoutHeadings.length} captured ${pagesWithoutHeadings.length === 1 ? 'page has' : 'pages have'} no H1, H2, or H3 elements in the saved markup.`,
        recommendation:
          'Add a clear primary heading and a logical heading hierarchy that reflects the page content.',
        sourceUrls: pagesWithoutHeadings,
        factsByUrl,
      }),
    );
  }

  const imageAltByPage = capturedPages
    .map((page) => ({ page, count: numberValue(page.metadata, 'imagesWithoutAlt') }))
    .filter(({ count }) => count > 0);
  const imagesWithoutAlt = imageAltByPage.reduce((total, entry) => total + entry.count, 0);
  if (imagesWithoutAlt) {
    findings.push(
      finding({
        area: 'Accessibility',
        severity: 'medium',
        title: 'Images without alternative text were found',
        finding: `${imagesWithoutAlt} images across ${imageAltByPage.length} captured ${imageAltByPage.length === 1 ? 'page do' : 'pages do'} not have alternative text in the saved markup.`,
        recommendation:
          'Add meaningful alternative text for informative images and use empty alt text only for genuinely decorative images.',
        sourceUrls: imageAltByPage.map(({ page }) => page.url),
        factsByUrl,
      }),
    );
  }

  const unlabelledFields = capturedPages
    .map((page) => ({ page, count: numberValue(page.metadata, 'unlabelledFormFieldCount') }))
    .filter(({ count }) => count > 0);
  const totalUnlabelledFields = unlabelledFields.reduce((total, entry) => total + entry.count, 0);
  if (totalUnlabelledFields) {
    findings.push(
      finding({
        area: 'Accessibility',
        severity: 'high',
        title: 'Form controls without programmatic labels were found',
        finding: `${totalUnlabelledFields} form controls across ${unlabelledFields.length} captured ${unlabelledFields.length === 1 ? 'page do' : 'pages do'} not expose a label, aria-label, or aria-labelledby attribute.`,
        recommendation:
          'Give every form control a persistent visible label and connect it programmatically to the field.',
        sourceUrls: unlabelledFields.map(({ page }) => page.url),
        factsByUrl,
      }),
    );
  }

  const formsFound = capturedPages.reduce(
    (total, page) => total + numberValue(page.metadata, 'formCount'),
    0,
  );
  const contactPages = capturedPages.filter((page) => page.page_type === 'contact');
  if (contactPages.length && formsFound === 0) {
    findings.push(
      finding({
        area: 'Conversion',
        severity: 'medium',
        title: 'No form was found on the captured contact pages',
        finding:
          'The captured contact page set contains no HTML form. The capture cannot determine whether another lead path is effective.',
        recommendation:
          'Review the primary contact journey and ensure the preferred lead action is clear, accessible, and easy to complete on mobile.',
        sourceUrls: contactPages.map((page) => page.url),
        factsByUrl,
      }),
    );
  }

  const viewportMissing = capturedPages
    .filter((page) => page.metadata.viewportPresent === false)
    .map((page) => page.url);
  if (viewportMissing.length) {
    findings.push(
      finding({
        area: 'Mobile',
        severity: 'high',
        title: 'Viewport metadata is missing',
        finding: `${viewportMissing.length} captured ${viewportMissing.length === 1 ? 'page does' : 'pages do'} not include a viewport meta tag.`,
        recommendation: 'Add a responsive viewport meta tag and retest the page on narrow screens.',
        sourceUrls: viewportMissing,
        factsByUrl,
      }),
    );
  }

  const overflowingScreens = screenshots.filter((screenshot) => {
    const pageWidth = numberValue(screenshot.metadata, 'pageWidth');
    const viewportWidth = numberValue(screenshot.metadata, 'layoutViewportWidth');
    return viewportWidth > 0 && pageWidth > viewportWidth;
  });
  const overflowUrls = overflowingScreens.map((screenshot) => screenshot.sourceUrl).filter(Boolean);
  if (overflowUrls.length) {
    findings.push(
      finding({
        area: 'Mobile',
        severity: 'high',
        title: 'Horizontal layout overflow was recorded at a captured viewport',
        finding: `${new Set(overflowUrls).size} captured ${new Set(overflowUrls).size === 1 ? 'page has' : 'pages have'} a document width wider than the requested viewport.`,
        recommendation:
          'Inspect fixed-width elements, media, tables, and navigation at the affected viewport before redesigning the responsive layout.',
        sourceUrls: overflowUrls,
        factsByUrl,
      }),
    );
  }

  const accessibilityByRule = new Map();
  accessibilityReports.forEach((report) => {
    (report.violations ?? []).forEach((violation) => {
      const existing = accessibilityByRule.get(violation.id) ?? {
        id: violation.id,
        help: violation.help,
        impact: violation.impact,
        nodeCount: 0,
        sourceUrls: [],
      };
      existing.nodeCount += numberValue(violation, 'nodeCount');
      existing.sourceUrls.push(report.sourceUrl);
      accessibilityByRule.set(violation.id, existing);
    });
  });
  [...accessibilityByRule.values()].slice(0, 8).forEach((violation) => {
    findings.push(
      finding({
        area: 'Accessibility',
        severity: severityForImpact[violation.impact] ?? 'medium',
        title: `Automated accessibility check: ${violation.help || violation.id}`,
        finding: `The automated check recorded ${violation.nodeCount} affected ${violation.nodeCount === 1 ? 'element' : 'elements'} across ${new Set(violation.sourceUrls).size} captured ${new Set(violation.sourceUrls).size === 1 ? 'page' : 'pages'}.`,
        recommendation:
          'Inspect the affected components and validate the remedy with keyboard and assistive-technology testing.',
        sourceUrls: violation.sourceUrls.filter(Boolean),
        factsByUrl,
      }),
    );
  });

  const slowPages = performanceReports.filter(
    (report) => numberValue(report.navigation, 'loadMs') > 3_000,
  );
  if (slowPages.length) {
    const maxLoadMs = Math.max(
      ...slowPages.map((report) => numberValue(report.navigation, 'loadMs')),
    );
    findings.push(
      finding({
        area: 'Performance',
        severity: 'medium',
        title: 'Captured navigation timing indicates slow page loads',
        finding: `${slowPages.length} captured ${slowPages.length === 1 ? 'page recorded' : 'pages recorded'} a load event above 3 seconds; the highest recorded value was ${maxLoadMs} ms. This is a lab-style capture signal, not a field performance measurement.`,
        recommendation:
          'Profile the affected pages for render-blocking resources, oversized media, third-party scripts, and avoidable network work.',
        sourceUrls: slowPages.map((report) => report.sourceUrl).filter(Boolean),
        factsByUrl,
      }),
    );
  }

  return findings;
}
