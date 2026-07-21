function cleanPathSegment(value) {
  return decodeURIComponent(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

export function normaliseSourceUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  url.pathname = url.pathname.replace(/\/+$/, '') || '/';
  return url.toString();
}

export function sourcePagePlan(selectedPages) {
  const usedPaths = new Set();
  return selectedPages
    .filter((page) => typeof page?.url === 'string' && page.url)
    .map((page, index) => {
      const sourceUrl = normaliseSourceUrl(page.url);
      const pathname = new URL(sourceUrl).pathname;
      const stem = pathname
        .split('/')
        .filter(Boolean)
        .map(cleanPathSegment)
        .filter(Boolean)
        .join('--');
      const basePath = `${stem || 'index'}.html`;
      let outputPath = basePath;
      let duplicate = 2;
      while (usedPaths.has(outputPath)) {
        outputPath = `${stem || 'index'}-${duplicate}.html`;
        duplicate += 1;
      }
      usedPaths.add(outputPath);
      return {
        index: index + 1,
        sourceUrl,
        title: typeof page.title === 'string' ? page.title : '',
        pageType: typeof page.pageType === 'string' ? page.pageType : '',
        outputPath,
      };
    });
}
