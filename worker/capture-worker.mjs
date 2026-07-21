/* global CSS, document, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, PerformanceNavigationTiming, getComputedStyle, window */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { createResearchPacket } from './research-packet.mjs';
import { assertPublicUrl, isRobotsAllowed } from './security.mjs';
import { selectVisualAssets, visualAssetKey, visualAssetScore } from './visual-assets.mjs';

const artifactBucket = 'siteforge-artifacts';
const workerUserAgent = 'SiteForgeResearchBot/0.1 (+https://siteforge.local/research)';
const desktopUserAgent =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36';
const tabletUserAgent =
  'Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const mobileUserAgent =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';
const captureTimeoutMs = 45_000;
const maxHtmlBytes = 3 * 1024 * 1024;
const maxReadableTextCharacters = 50_000;
const maxScreenshotHeight = 20_000;
const maxVisualAssetBytes = 8 * 1024 * 1024;
const maxTotalVisualAssetBytes = 64 * 1024 * 1024;
const visualAssetConcurrency = 3;
const defaultFastPageConcurrency = 3;
const maxSitemapDocuments = 8;
const workerRequestTimeoutMs = 90_000;
const privateWriteAttempts = 3;

function captureVisualEvidence() {
  return process.env.SITEFORGE_CAPTURE_VISUAL_EVIDENCE?.trim().toLowerCase() === 'true';
}
const screenshotViewports = [
  {
    label: 'desktop',
    width: 1440,
    height: 900,
    isMobile: false,
    hasTouch: false,
    userAgent: desktopUserAgent,
  },
  {
    label: 'tablet',
    width: 768,
    height: 1024,
    isMobile: true,
    hasTouch: true,
    userAgent: tabletUserAgent,
  },
  {
    label: 'mobile',
    width: 375,
    height: 812,
    isMobile: true,
    hasTouch: true,
    userAgent: mobileUserAgent,
  },
];
const pagePriority = [
  ['contact', 100],
  ['quote', 95],
  ['book', 95],
  ['service', 90],
  ['about', 80],
  ['location', 75],
  ['area', 70],
  ['review', 65],
  ['faq', 60],
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the capture worker.`);
  return value;
}

function createTimedFetch(timeoutMs) {
  return (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
}

function hashContent(value) {
  return createHash('sha256').update(value).digest('hex');
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
}

function maxCapturePages() {
  const requested = Number.parseInt(process.env.SITEFORGE_CAPTURE_MAX_PAGES ?? '100', 10);
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 250) : 100;
}

function fastPageConcurrency() {
  const requested = Number.parseInt(
    process.env.SITEFORGE_FAST_PAGE_CONCURRENCY ?? String(defaultFastPageConcurrency),
    10,
  );
  return Number.isFinite(requested)
    ? Math.min(Math.max(requested, 1), 8)
    : defaultFastPageConcurrency;
}

function maxVisualAssets() {
  const requested = Number.parseInt(process.env.SITEFORGE_CAPTURE_MAX_VISUAL_ASSETS ?? '64', 10);
  return Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 120) : 64;
}

function safeErrorSummary(error) {
  if (error instanceof CaptureStorageError) {
    return error.context?.retryable
      ? 'Private capture storage was temporarily unavailable while saving page evidence.'
      : 'Private capture storage could not accept part of the captured page evidence.';
  }
  const message = error instanceof Error ? error.message : '';
  if (message.includes('Robots')) return message;
  if (message.includes('blocked network')) return message;
  if (message.includes('No public pages could be captured')) return message;
  if (message.includes('unavailable response'))
    return 'The public website returned an unavailable response to the capture worker.';
  if (/timed out|timeout/i.test(message))
    return 'The public website did not become ready before the capture timeout.';
  if (message.includes('page HTML exceeded'))
    return 'The public page exceeded the capture size limit.';
  if (message.includes('screenshot did not render'))
    return 'A responsive page view could not be rendered at the requested size.';
  return 'The protected capture worker could not complete this website capture.';
}

class CaptureCancelledError extends Error {
  constructor() {
    super('Capture cancelled by a workspace user.');
    this.name = 'CaptureCancelledError';
  }
}

class CaptureStorageError extends Error {
  constructor(error, context = {}) {
    super(error instanceof Error ? error.message : 'The worker could not save capture evidence.');
    this.name = 'CaptureStorageError';
    this.phase = context.phase ?? 'saving_page';
    this.url = context.url;
    this.pendingUrls = context.pendingUrls ?? [];
    this.context = {
      ...(error && typeof error === 'object' && 'context' in error ? error.context : {}),
      ...context,
    };
  }
}

class CaptureArtifactStorageError extends Error {
  constructor(operation, artifact, cause, attempts) {
    super('The capture worker could not save private page evidence.');
    this.name = 'CaptureArtifactStorageError';
    const providerCode = providerErrorCode(cause);
    this.context = {
      operation,
      artifactKind: artifact.kind,
      artifactLabel: artifact.label,
      byteSize: artifact.content?.size,
      attempts,
      providerCode,
      retryable: storageErrorIsRetryable(providerCode),
    };
  }
}

function providerErrorCode(error) {
  if (typeof error?.statusCode === 'number' || typeof error?.statusCode === 'string')
    return String(error.statusCode);
  if (typeof error?.status === 'number' || typeof error?.status === 'string')
    return String(error.status);
  return undefined;
}

function storageErrorIsRetryable(providerCode) {
  const status = Number(providerCode);
  if (!Number.isFinite(status) || status === 0) return true;
  return status === 408 || status === 429 || status >= 500;
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function captureFailureDetail(error, failurePhase) {
  const context = error instanceof CaptureStorageError ? error.context : undefined;
  if (context?.operation) {
    const artifact = context.artifactLabel ?? 'the captured evidence';
    const size = Number.isFinite(context.byteSize)
      ? ` (${Math.max(1, Math.round(context.byteSize / 1024))} KB)`
      : '';
    const attempts = context.attempts ? ` after ${context.attempts} automatic attempts` : '';
    const action =
      context.operation === 'artifact_index'
        ? 'Its private file may be present, but the evidence record could not be indexed.'
        : 'The file was not confirmed as saved.';
    return `${artifact}${size} could not be saved to private storage${attempts}. ${action} Continue scraping will retry only this incomplete page step.`;
  }
  if (failurePhase === 'saving_page')
    return 'The page was captured, but its private evidence could not be fully saved. Continue scraping will retry only this page.';
  if (failurePhase === 'saving_asset')
    return 'A selected visual asset could not be saved after the page evidence was captured. Continue scraping will retry the asset step.';
  return 'The worker could not safely complete the current public-page capture step.';
}

function normaliseText(value, limit = 600) {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

function normaliseCrawlUrl(value) {
  const url = new URL(value);
  url.hash = '';
  url.search = '';
  if (url.pathname !== '/') url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

function pageTypeForUrl(url) {
  const path = new URL(url).pathname.toLowerCase();
  if (path === '/') return 'homepage';
  if (/(contact|quote|book|enquir)/.test(path)) return 'contact';
  if (/(service|solution|what-we-do)/.test(path)) return 'service';
  if (/(about|team|company)/.test(path)) return 'about';
  if (/(location|area|suburb)/.test(path)) return 'location';
  if (/(review|testimonial|case-stud)/.test(path)) return 'trust';
  if (/(faq|question)/.test(path)) return 'faq';
  return 'other';
}

function extensionForContentType(contentType) {
  if (contentType === 'image/jpeg') return 'jpg';
  if (contentType === 'image/png') return 'png';
  if (contentType === 'image/webp') return 'webp';
  if (contentType === 'image/avif') return 'avif';
  if (contentType === 'image/gif') return 'gif';
  if (contentType === 'image/svg+xml') return 'svg';
  return undefined;
}

function discoverPageUrls(homeUrl, links) {
  const home = new URL(homeUrl);
  const candidates = new Map();
  for (const link of links) {
    try {
      const url = new URL(link.href, home);
      if (url.origin !== home.origin || !/^https?:$/.test(url.protocol)) continue;
      if (
        /\.(?:pdf|jpg|jpeg|png|gif|webp|avif|svg|ico|zip|docx?|xlsx?|pptx?|mp4|webm|mp3|wav|css|js)$/i.test(
          url.pathname,
        )
      )
        continue;
      const normalized = normaliseCrawlUrl(url.toString());
      if (!candidates.has(normalized)) {
        const path = url.pathname.toLowerCase();
        const score = pagePriority.reduce(
          (total, [keyword, points]) => (path.includes(keyword) ? total + points : total),
          0,
        );
        candidates.set(normalized, score);
      }
    } catch {
      // Ignore malformed or non-public links discovered in page markup.
    }
  }
  return [...candidates.entries()]
    .filter(([url]) => url !== normaliseCrawlUrl(homeUrl))
    .sort(
      ([leftUrl, leftScore], [rightUrl, rightScore]) =>
        rightScore - leftScore || leftUrl.localeCompare(rightUrl),
    )
    .map(([url]) => url);
}

function isBlurredAssetUrl(url) {
  return /(?:[?/,]|%2f)blur[_=-]?\d+/i.test(url);
}

async function fetchWithSafeRedirects(url, dnsCache) {
  let currentUrl = url;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicUrl(currentUrl, dnsCache);
    const response = await fetch(currentUrl, {
      headers: { 'user-agent': workerUserAgent, accept: 'text/plain,*/*;q=0.1' },
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get('location');
    if (!location) throw new Error('The capture target returned an invalid redirect.');
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error('The capture target exceeded the redirect limit.');
}

async function fetchPublicHtml(targetUrl, dnsCache) {
  let currentUrl = targetUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicUrl(currentUrl, dnsCache);
    const response = await fetch(currentUrl, {
      headers: {
        'user-agent': workerUserAgent,
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.1',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(captureTimeoutMs),
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) {
      if (!response.ok) throw new Error('The page returned an unavailable response.');
      const contentLength = Number(response.headers.get('content-length'));
      if (Number.isFinite(contentLength) && contentLength > maxHtmlBytes)
        throw new Error('The page HTML exceeded the capture limit.');
      const html = await response.text();
      if (bytes(html) > maxHtmlBytes) throw new Error('The page HTML exceeded the capture limit.');
      return { html, response, finalUrl: currentUrl };
    }
    const location = response.headers.get('location');
    if (!location) throw new Error('The capture target returned an invalid redirect.');
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error('The capture target exceeded the redirect limit.');
}

function urlsFromSitemapDocument(xml, homeUrl) {
  const urls = [];
  const locPattern = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let match;
  while ((match = locPattern.exec(xml))) {
    const value = match[1].trim().replace(/&amp;/g, '&');
    try {
      const url = new URL(value, homeUrl);
      if (url.origin !== new URL(homeUrl).origin || !/^https?:$/.test(url.protocol)) continue;
      urls.push(url.toString());
    } catch {
      // Ignore malformed sitemap entries.
    }
  }
  return urls;
}

async function discoverSitemapUrls(targetUrl, dnsCache) {
  const home = new URL(targetUrl);
  const sitemapDocuments = [new URL('/sitemap.xml', home).toString()];
  try {
    const robotsResponse = await fetchWithSafeRedirects(
      new URL('/robots.txt', home).toString(),
      dnsCache,
    );
    if (robotsResponse.ok) {
      const robots = await robotsResponse.text();
      for (const line of robots.split(/\r?\n/)) {
        const match = /^\s*sitemap\s*:\s*(\S+)\s*$/i.exec(line);
        if (!match) continue;
        const sitemapUrl = new URL(match[1], home);
        if (sitemapUrl.origin === home.origin) sitemapDocuments.push(sitemapUrl.toString());
      }
    }
  } catch {
    // Sitemap discovery is an optimization. Page capture remains possible without it.
  }

  const pendingDocuments = [...new Set(sitemapDocuments)];
  const visitedDocuments = new Set();
  const pageUrls = new Set();
  while (pendingDocuments.length && visitedDocuments.size < maxSitemapDocuments) {
    const sitemapUrl = pendingDocuments.shift();
    if (!sitemapUrl || visitedDocuments.has(sitemapUrl)) continue;
    visitedDocuments.add(sitemapUrl);
    try {
      const response = await fetchWithSafeRedirects(sitemapUrl, dnsCache);
      if (!response.ok) continue;
      const xml = await response.text();
      for (const url of urlsFromSitemapDocument(xml, targetUrl)) {
        if (/\.xml(?:$|\?)/i.test(new URL(url).pathname)) pendingDocuments.push(url);
        else pageUrls.add(normaliseCrawlUrl(url));
      }
    } catch {
      // A missing sitemap must not prevent the normal internal-link crawl.
    }
  }
  return [...pageUrls].slice(0, maxCapturePages());
}

function createSemaphore(limit) {
  let active = 0;
  const waiting = [];
  return async (operation) => {
    if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
      waiting.shift()?.();
    }
  };
}

async function assertRobotsAllowsUrl(targetUrl, dnsCache) {
  const robotsUrl = new URL('/robots.txt', targetUrl).toString();
  try {
    const response = await fetchWithSafeRedirects(robotsUrl, dnsCache);
    if (!response.ok) return;
    const robotsText = await response.text();
    if (!isRobotsAllowed(robotsText, new URL(targetUrl).pathname)) {
      throw new Error('Robots rules do not allow this page capture.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Robots')) throw error;
  }
}

async function createCaptureContext(browser, viewport, dnsCache) {
  const context = await browser.newContext({
    serviceWorkers: 'block',
    userAgent: viewport.userAgent,
    viewport: { width: viewport.width, height: viewport.height },
    screen: { width: viewport.width, height: viewport.height },
    isMobile: viewport.isMobile,
    hasTouch: viewport.hasTouch,
    deviceScaleFactor: 1,
  });
  await context.route('**/*', async (route) => {
    try {
      await assertPublicUrl(route.request().url(), dnsCache);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  return context;
}

async function waitForVisualReadiness(page) {
  await page.evaluate(async () => {
    const pause = (duration) => new Promise((resolve) => window.setTimeout(resolve, duration));
    const lazySourceAttributes = [
      'data-src',
      'data-lazy-src',
      'data-original',
      'data-image',
      'data-flickity-lazyload',
      'data-swiper-lazy',
      'data-lazyload',
    ];
    const lazySourceSetAttributes = [
      'data-srcset',
      'data-lazy-srcset',
      'data-original-set',
      'data-flickity-lazyload-srcset',
    ];
    document.querySelectorAll('img').forEach((image) => {
      image.loading = 'eager';
      if (!image.getAttribute('src')) {
        const source = lazySourceAttributes
          .map((attribute) => image.getAttribute(attribute))
          .find(Boolean);
        if (source) image.src = source;
      }
      if (!image.getAttribute('srcset')) {
        const sourceSet = lazySourceSetAttributes
          .map((attribute) => image.getAttribute(attribute))
          .find(Boolean);
        if (sourceSet) image.srcset = sourceSet;
      }
    });
    document.querySelectorAll('picture source').forEach((source) => {
      if (!source.getAttribute('srcset')) {
        const sourceSet = lazySourceSetAttributes
          .map((attribute) => source.getAttribute(attribute))
          .find(Boolean);
        if (sourceSet) source.setAttribute('srcset', sourceSet);
      }
    });
    document
      .querySelectorAll('[data-bg], [data-background-image], [data-lazy-bg]')
      .forEach((element) => {
        const background =
          element.getAttribute('data-bg') ??
          element.getAttribute('data-background-image') ??
          element.getAttribute('data-lazy-bg');
        if (background && !element.style.backgroundImage) {
          element.style.backgroundImage = `url(${JSON.stringify(background)})`;
        }
      });
    const initialY = window.scrollY;
    const step = Math.max(window.innerHeight - 120, 240);
    const maximum = Math.min(document.documentElement.scrollHeight, 20_000);
    for (let y = 0; y < maximum; y += step) {
      window.scrollTo(0, y);
      await pause(90);
    }
    window.scrollTo(0, initialY);

    const images = Array.from(document.images);
    await Promise.race([
      Promise.all(
        images.map(async (image) => {
          if (!image.complete) {
            await new Promise((resolve) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', resolve, { once: true });
            });
          }
          if (image.complete && image.naturalWidth > 0 && typeof image.decode === 'function') {
            await image.decode().catch(() => undefined);
          }
        }),
      ),
      pause(8_000),
    ]);
  });
  const visualsSettled = await page
    .waitForFunction(
      () =>
        Array.from(document.images)
          .filter((image) => {
            const bounds = image.getBoundingClientRect();
            return (
              bounds.top < 20_000 &&
              bounds.bottom > 0 &&
              bounds.width > 24 &&
              bounds.height > 24 &&
              getComputedStyle(image).display !== 'none'
            );
          })
          .every((image) => {
            const source = image.currentSrc || image.src;
            return (
              image.complete &&
              image.naturalWidth > 0 &&
              !/(?:[?/,]|%2f)blur[_=-]?\d+/i.test(source)
            );
          }),
      undefined,
      { timeout: 8_000 },
    )
    .then(() => true)
    .catch(() => false);
  if (visualsSettled) return { unresolvedVisualCount: 0 };

  // Some sites intentionally leave low-resolution placeholders in the DOM after the visible
  // image has failed to hydrate. Keep the page capture, but never preserve that blur in a view.
  const unresolvedVisualCount = await page.evaluate(() => {
    const visibleImages = Array.from(document.images).filter((image) => {
      const bounds = image.getBoundingClientRect();
      return (
        bounds.top < 20_000 &&
        bounds.bottom > 0 &&
        bounds.width > 24 &&
        bounds.height > 24 &&
        getComputedStyle(image).display !== 'none'
      );
    });
    const unresolved = visibleImages.filter((image) => {
      const source = image.currentSrc || image.src;
      return (
        !image.complete || image.naturalWidth === 0 || /(?:[?/,]|%2f)blur[_=-]?\d+/i.test(source)
      );
    });
    unresolved.forEach((image) => {
      image.setAttribute('data-siteforge-incomplete-media', 'true');
      image.style.setProperty('visibility', 'hidden', 'important');
    });
    return unresolved.length;
  });
  return { unresolvedVisualCount };
}

async function openPublicPage(browser, targetUrl, dnsCache, viewport) {
  const context = await createCaptureContext(browser, viewport, dnsCache);
  const page = await context.newPage();
  try {
    const response = await page.goto(targetUrl, {
      timeout: captureTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    if (!response || response.status() >= 400) {
      throw new Error('The page returned an unavailable response.');
    }
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await waitForVisualReadiness(page);
    await assertPublicUrl(page.url(), dnsCache);
    return { context, page, response };
  } catch (error) {
    await context.close();
    throw error;
  }
}

async function createFastParseContext(browser) {
  const context = await browser.newContext({
    viewport: { width: screenshotViewports[0].width, height: screenshotViewports[0].height },
    userAgent: workerUserAgent,
  });
  await context.route('**/*', (route) => route.abort());
  return context;
}

function withDocumentBase(html, sourceUrl) {
  const base = `<base href="${sourceUrl.replace(/"/g, '%22')}">`;
  if (/<head\b[^>]*>/i.test(html))
    return html.replace(/<head\b[^>]*>/i, (head) => `${head}${base}`);
  return `<!doctype html><html><head>${base}</head><body>${html}</body></html>`;
}

function needsRenderedFallback(html, structure) {
  const scriptCount = (html.match(/<script\b/gi) ?? []).length;
  const shellRoot = /<(?:div|main)[^>]+(?:id|class)=["'][^"']*(?:__next|root|app)[^"']*["']/i.test(
    html,
  );
  return structure.readableText.length < 280 && (scriptCount >= 3 || shellRoot);
}

async function collectPageStructure(page) {
  return page.evaluate((textLimit) => {
    const readMeta = (name) =>
      document
        .querySelector(`meta[name="${name}"], meta[property="${name}"]`)
        ?.getAttribute('content') ?? '';
    const text = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    const readableText = (document.body?.innerText ?? '').replace(/\s+/g, ' ').trim();
    const emailPattern = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
    const emails = new Set(readableText.match(emailPattern) ?? []);
    const phones = new Set(
      Array.from(document.querySelectorAll('a[href^="tel:"]'))
        .map((link) => link.getAttribute('href')?.replace(/^tel:/i, '').trim() ?? '')
        .filter(Boolean),
    );
    return {
      title: document.title.trim(),
      description: readMeta('description'),
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
      language: document.documentElement.lang,
      viewport: readMeta('viewport'),
      robots: readMeta('robots'),
      openGraph: {
        title: readMeta('og:title'),
        description: readMeta('og:description'),
        image: readMeta('og:image'),
      },
      structuredDataCount: document.querySelectorAll('script[type="application/ld+json"]').length,
      headings: Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((heading) => ({ level: heading.tagName.toLowerCase(), text: text(heading) }))
        .filter((heading) => heading.text)
        .slice(0, 80),
      navigation: Array.from(document.querySelectorAll('nav a'))
        .map((link) => ({ label: text(link), href: link.href }))
        .filter((link) => link.label)
        .slice(0, 60),
      contentBlocks: (() => {
        const scope = document.querySelector('main, [role="main"]') ?? document.body;
        return Array.from(
          scope?.querySelectorAll(
            'h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption, th, td',
          ) ?? [],
        )
          .map((element) => ({ tag: element.tagName.toLowerCase(), text: text(element) }))
          .filter((block) => block.text && block.text.length > 1)
          .slice(0, 600);
      })(),
      callsToAction: Array.from(
        document.querySelectorAll('a[href], button, input[type="submit"], input[type="button"]'),
      )
        .map((element) => ({
          label: element instanceof HTMLInputElement ? element.value.trim() : text(element),
          href: element.tagName === 'A' ? element.href : '',
        }))
        .filter((action) => action.label)
        .slice(0, 120),
      links: Array.from(document.querySelectorAll('a[href]'))
        .map((link) => ({ label: text(link), href: link.href }))
        .filter((link) => link.href)
        .slice(0, 2_000),
      forms: Array.from(document.forms)
        .slice(0, 20)
        .map((form) => ({
          action: form.action,
          method: form.method,
          controlCount: form.elements.length,
          fields: Array.from(form.elements)
            .filter(
              (field) =>
                field instanceof HTMLInputElement ||
                field instanceof HTMLTextAreaElement ||
                field instanceof HTMLSelectElement,
            )
            .slice(0, 40)
            .map((field) => {
              const id = field.id;
              const label = id
                ? document.querySelector(`label[for="${CSS.escape(id)}"]`)
                : undefined;
              return {
                name: field.getAttribute('name') ?? '',
                type: field instanceof HTMLInputElement ? field.type : field.tagName.toLowerCase(),
                required: field.required,
                hasLabel: Boolean(
                  label ||
                  field.getAttribute('aria-label') ||
                  field.getAttribute('aria-labelledby'),
                ),
                autocomplete: field.getAttribute('autocomplete') ?? '',
              };
            }),
        })),
      integrations: [...document.querySelectorAll('iframe[src], script[src]')]
        .map((element) => element.getAttribute('src') ?? '')
        .filter(Boolean)
        .flatMap((source) => {
          try {
            const url = new URL(source, window.location.href);
            return url.origin !== window.location.origin ? [url.origin] : [];
          } catch {
            return [];
          }
        })
        .filter((origin, index, origins) => origins.indexOf(origin) === index)
        .slice(0, 24),
      images: Array.from(document.images)
        .slice(0, 200)
        .map((image) => ({
          src: image.currentSrc || image.src,
          alt: image.alt,
          width: image.naturalWidth,
          height: image.naturalHeight,
          candidateType: /logo|brand/i.test(
            `${image.alt} ${image.className} ${image.id} ${image.src}`,
          )
            ? 'logo'
            : 'image',
        })),
      visualAssets: (() => {
        const candidates = [];
        const imageSourceAttributes = [
          'src',
          'data-src',
          'data-lazy-src',
          'data-original',
          'data-image',
          'data-flickity-lazyload',
          'data-swiper-lazy',
          'data-lazyload',
        ];
        const sourceSetAttributes = [
          'srcset',
          'data-srcset',
          'data-lazy-srcset',
          'data-original-set',
          'data-flickity-lazyload-srcset',
        ];
        const nearbyContext = (element) => {
          const container = element.closest('figure, section, article, main, li, div');
          if (!container) return '';
          const heading = container.querySelector('h1, h2, h3')?.textContent ?? '';
          const caption = container.querySelector('figcaption')?.textContent ?? '';
          return `${heading} ${caption}`.replace(/\s+/g, ' ').trim().slice(0, 360);
        };
        const add = (
          url,
          type,
          detail = '',
          width = 0,
          height = 0,
          context = '',
          isHeaderLogo = false,
        ) => {
          if (!url || url.startsWith('data:') || /(?:[?/,]|%2f)blur[_=-]?\d+/i.test(url)) return;
          candidates.push({ url, type, detail, width, height, context, isHeaderLogo });
        };
        const addSourceSet = (
          value,
          type,
          detail,
          width,
          height,
          context,
          isHeaderLogo = false,
        ) => {
          if (!value) return;
          const sourceCandidates =
            value.match(
              /https?:\/\/.+?\.(?:avif|webp|png|jpe?g|gif|svg)(?:\s+\d+(?:\.\d+)?[wx])?(?=,\s*https?:\/\/|$)/gi,
            ) ?? value.split(',');
          sourceCandidates.forEach((candidate) => {
            const url = candidate.trim().split(/\s+/)[0];
            add(url, type, detail, width, height, context, isHeaderLogo);
          });
        };
        const addBackgroundUrls = (value, element, detail) => {
          if (!value || value === 'none') return;
          for (const match of value.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/gi)) {
            add(match[2], 'background', detail, 0, 0, nearbyContext(element));
          }
        };
        Array.from(document.images).forEach((image) => {
          const sources = [
            image.currentSrc,
            ...imageSourceAttributes.map((attribute) => image.getAttribute(attribute)),
          ].filter(Boolean);
          const context = `${image.alt} ${image.className} ${image.id} ${sources.join(' ')}`;
          const headerContainer = image.closest('header, [role="banner"], nav');
          const isHeaderLogo = Boolean(headerContainer);
          // A header/nav image is the site's most reliable organisation-mark evidence,
          // even when its filename is opaque or it has an empty alt attribute.
          const type = isHeaderLogo || /logo|brand/i.test(context) ? 'logo' : 'image';
          sources.forEach((source) =>
            add(
              source,
              type,
              image.alt,
              image.naturalWidth,
              image.naturalHeight,
              nearbyContext(image),
              isHeaderLogo,
            ),
          );
          sourceSetAttributes.forEach((attribute) =>
            addSourceSet(
              image.getAttribute(attribute),
              type,
              image.alt,
              image.naturalWidth,
              image.naturalHeight,
              nearbyContext(image),
              isHeaderLogo,
            ),
          );
        });
        document.querySelectorAll('picture source').forEach((source) => {
          sourceSetAttributes.forEach((attribute) =>
            addSourceSet(
              source.getAttribute(attribute),
              'image',
              source.getAttribute('media') ?? 'responsive image source',
              0,
              0,
              nearbyContext(source),
            ),
          );
        });
        document.querySelectorAll('[data-image-info]').forEach((element) => {
          try {
            const imageInfo = JSON.parse(element.getAttribute('data-image-info') ?? '');
            const imageData = imageInfo?.imageData;
            const uri = typeof imageData?.uri === 'string' ? imageData.uri.trim() : '';
            if (!uri || !/\.(?:avif|webp|png|jpe?g|gif|svg)$/i.test(uri)) return;
            const detail =
              typeof imageData?.name === 'string' && imageData.name.trim()
                ? imageData.name.trim()
                : (element.querySelector('img')?.getAttribute('alt') ?? 'Wix managed image');
            add(
              `https://static.wixstatic.com/media/${uri}`,
              'background',
              detail,
              Number(imageData?.width) || 0,
              Number(imageData?.height) || 0,
              nearbyContext(element),
            );
          } catch {
            // Some sites use this attribute for non-image payloads.
          }
        });
        document.querySelectorAll('link[rel~="icon"]').forEach((link) => {
          add(link.href, 'favicon', link.getAttribute('rel') ?? '');
        });
        const socialImage = readMeta('og:image');
        if (socialImage)
          add(new URL(socialImage, document.baseURI).href, 'social', 'Open Graph image');
        Array.from(document.body?.querySelectorAll('*') ?? [])
          .slice(0, 2_000)
          .forEach((element) => {
            const detail = `${element.tagName.toLowerCase()} background`;
            addBackgroundUrls(getComputedStyle(element).backgroundImage, element, detail);
            addBackgroundUrls(
              getComputedStyle(element, '::before').backgroundImage,
              element,
              detail,
            );
            addBackgroundUrls(
              getComputedStyle(element, '::after').backgroundImage,
              element,
              detail,
            );
            ['data-bg', 'data-background-image', 'data-lazy-bg'].forEach((attribute) =>
              add(
                element.getAttribute(attribute),
                'background',
                detail,
                0,
                0,
                nearbyContext(element),
              ),
            );
          });
        const unique = new Map();
        candidates.forEach((candidate) => {
          try {
            const normalized = new URL(candidate.url, document.baseURI).href;
            const key = normalized
              .replace(/([?/,]|%2f)blur[_=-]?\d+/i, '')
              .replace(/\/v1\/.+$/i, '');
            const existing = unique.get(key);
            if (!existing || visualAssetScore(candidate) > visualAssetScore(existing)) {
              unique.set(key, { ...candidate, url: normalized });
            }
          } catch {
            // Ignore malformed public asset references.
          }
        });
        return [...unique.values()].slice(0, 80);
      })(),
      contacts: { emails: [...emails].slice(0, 20), phones: [...phones].slice(0, 20) },
      componentInventory: {
        tables: document.querySelectorAll('table').length,
        embeds: document.querySelectorAll('iframe, video, audio, object, embed').length,
        disclosures: document.querySelectorAll('details, [aria-expanded]').length,
        buttons: document.querySelectorAll('button, input[type="submit"], input[type="button"]')
          .length,
      },
      readableText: readableText.slice(0, textLimit),
      readableTextTruncated: readableText.length > textLimit,
    };
  }, maxReadableTextCharacters);
}

function evidenceFromStructure(structure, sourceUrl, capturedAt) {
  const fields = [
    ['Page title', structure.title, 'Captured from the document title.'],
    [
      'Primary heading',
      structure.headings.find((heading) => heading.level === 'h1')?.text,
      'Captured from the first H1.',
    ],
    ['Meta description', structure.description, 'Captured from the meta description.'],
    ['Canonical URL', structure.canonicalUrl, 'Captured from the canonical link element.'],
    ['Document language', structure.language, 'Captured from the HTML lang attribute.'],
    ...structure.contacts.emails.map((email) => [
      'Contact email',
      email,
      'Captured from public page content.',
    ]),
    ...structure.contacts.phones.map((phone) => [
      'Contact phone',
      phone,
      'Captured from a public telephone link.',
    ]),
  ];
  return fields
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value, evidence]) => ({
      label,
      value: normaliseText(value),
      source_url: sourceUrl,
      evidence,
      confidence: 'high',
      verification_state: 'captured',
      captured_at: capturedAt,
    }));
}

async function captureScreenshot(page, viewport) {
  const metrics = await page.evaluate(() => ({
    pageHeight: Math.ceil(document.documentElement.scrollHeight),
    pageWidth: Math.ceil(document.documentElement.scrollWidth),
    layoutViewportWidth: window.innerWidth,
  }));
  const captureHeight = Math.min(metrics.pageHeight, maxScreenshotHeight);
  const truncated = metrics.pageHeight > maxScreenshotHeight;

  // A full-page screenshot can inherit horizontal overflow from a broken layout. Clipping to the
  // requested viewport makes each saved image a faithful desktop, tablet, or mobile rendering.
  const image = await page.screenshot({
    type: 'png',
    clip: { x: 0, y: 0, width: viewport.width, height: captureHeight },
  });
  const renderedWidth = image.readUInt32BE(16);
  const renderedHeight = image.readUInt32BE(20);
  if (renderedWidth !== viewport.width) {
    throw new Error(`The ${viewport.label} screenshot did not render at the requested width.`);
  }
  return {
    image,
    metadata: {
      viewport: { width: viewport.width, height: viewport.height },
      pageHeight: metrics.pageHeight,
      pageWidth: metrics.pageWidth,
      layoutViewportWidth: metrics.layoutViewportWidth,
      renderedWidth,
      renderedHeight,
      truncated,
    },
  };
}

async function captureFastPage(browser, targetUrl, dnsCache, onStage = async () => {}) {
  await onStage('Checking the public URL and crawl permissions.');
  await assertPublicUrl(targetUrl, dnsCache);
  await assertRobotsAllowsUrl(targetUrl, dnsCache);
  await onStage('Fetching and parsing the public HTML.');
  const fetched = await fetchPublicHtml(targetUrl, dnsCache);
  const context = await createFastParseContext(browser);
  const page = await context.newPage();
  try {
    await onStage('Reading page structure, content, forms, and links.');
    await page.setContent(withDocumentBase(fetched.html, fetched.finalUrl), {
      waitUntil: 'domcontentloaded',
    });
    const structure = await collectPageStructure(page);
    return {
      finalUrl: fetched.finalUrl,
      html: fetched.html,
      structure,
      screenshots: [],
      accessibility: { status: 'deferred', violationCount: 0, violations: [] },
      navigation: undefined,
      statusCode: fetched.response.status,
      pageType: pageTypeForUrl(fetched.finalUrl),
      captureMethod: 'html',
    };
  } finally {
    await context.close();
  }
}

async function captureRenderedPage(browser, targetUrl, dnsCache, onStage = async () => {}) {
  await onStage('Opening a browser fallback for this JavaScript-rendered page.');
  const primary = await openPublicPage(browser, targetUrl, dnsCache, screenshotViewports[0]);
  try {
    await onStage('Reading rendered page structure, content, forms, and links.');
    const html = await primary.page.content();
    if (bytes(html) > maxHtmlBytes) throw new Error('The page HTML exceeded the capture limit.');
    const structure = await collectPageStructure(primary.page);
    const navigation = await primary.page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      if (!(entry instanceof PerformanceNavigationTiming)) return undefined;
      return {
        domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
        loadMs: Math.round(entry.loadEventEnd),
        transferSize: entry.transferSize,
      };
    });
    const finalUrl = primary.page.url();
    const screenshots = [];
    if (captureVisualEvidence()) {
      await onStage('Capturing the desktop layout for private visual evidence.');
      screenshots.push(await captureScreenshot(primary.page, screenshotViewports[0]));
      for (const viewport of screenshotViewports.slice(1)) {
        await onStage(`Capturing the ${viewport.label} layout for private visual evidence.`);
        const variant = await openPublicPage(browser, finalUrl, dnsCache, viewport);
        try {
          screenshots.push(await captureScreenshot(variant.page, viewport));
        } finally {
          await variant.context.close();
        }
      }
    }
    return {
      finalUrl,
      html,
      structure,
      screenshots,
      accessibility: { status: 'deferred', violationCount: 0, violations: [] },
      navigation,
      statusCode: primary.response.status(),
      pageType: pageTypeForUrl(finalUrl),
      captureMethod: 'rendered',
    };
  } finally {
    await primary.context.close();
  }
}

async function capturePage(
  browser,
  targetUrl,
  dnsCache,
  onStage = async () => {},
  withRenderedFallback = async (operation) => operation(),
) {
  const fastPage = await captureFastPage(browser, targetUrl, dnsCache, onStage);
  if (!captureVisualEvidence() && !needsRenderedFallback(fastPage.html, fastPage.structure)) {
    return fastPage;
  }
  await onStage(
    captureVisualEvidence()
      ? 'Visual evidence was requested; using the rendered-page capture path.'
      : 'This page appears to require JavaScript rendering; using the browser fallback.',
  );
  return withRenderedFallback(() => captureRenderedPage(browser, targetUrl, dnsCache, onStage));
}

async function captureWebsite(targetUrl, callbacks = {}) {
  const {
    onProgress = async () => {},
    onPage = async () => {},
    onAsset = async () => {},
    assertActive = async () => {},
    resumeQueue = [],
    knownUrls = [],
    discoveredPageCount = 0,
    existingCapturedPageCount = 0,
  } = callbacks;
  const dnsCache = new Map();
  const browser = await chromium.launch({ headless: true });
  try {
    const pages = [];
    const failedPages = [];
    const homeUrl = normaliseCrawlUrl(targetUrl);
    const seededQueue = resumeQueue
      .map((url) => {
        try {
          return normaliseCrawlUrl(url);
        } catch {
          return undefined;
        }
      })
      .filter(Boolean);
    const queuedUrls = [...new Set(seededQueue.length ? seededQueue : [homeUrl])];
    const discoveredUrls = new Set([homeUrl, ...knownUrls, ...queuedUrls]);
    const attemptedUrls = new Set(knownUrls.map((url) => normaliseCrawlUrl(url)));
    const progressCount = () => Math.max(discoveredUrls.size, discoveredPageCount);
    const capturedCount = () => pages.length + existingCapturedPageCount;
    const activeUrls = new Set();
    const resumableQueue = () => [...activeUrls, ...queuedUrls];
    const withRenderedFallback = createSemaphore(1);

    if (!seededQueue.length) {
      await onProgress({
        phase: 'discovering',
        detail: 'Reading the public sitemap to prepare parallel page capture.',
        currentUrl: homeUrl,
        discoveredPageCount: progressCount(),
        capturedPageCount: capturedCount(),
        failedPageCount: failedPages.length,
        pendingUrls: resumableQueue(),
      });
      for (const sitemapUrl of await discoverSitemapUrls(targetUrl, dnsCache)) {
        if (discoveredUrls.has(sitemapUrl)) continue;
        discoveredUrls.add(sitemapUrl);
        queuedUrls.push(sitemapUrl);
      }
    }

    while (queuedUrls.length && capturedCount() < maxCapturePages()) {
      await assertActive();
      const batch = [];
      while (queuedUrls.length && batch.length < fastPageConcurrency()) {
        const pageUrl = queuedUrls.shift();
        if (!pageUrl || attemptedUrls.has(pageUrl)) continue;
        attemptedUrls.add(pageUrl);
        activeUrls.add(pageUrl);
        batch.push(pageUrl);
      }
      if (!batch.length) continue;
      await onProgress({
        phase: 'capturing_page',
        detail: `Scanning ${batch.length} public ${batch.length === 1 ? 'page' : 'pages'} in parallel.`,
        currentUrl: batch[0],
        discoveredPageCount: progressCount(),
        capturedPageCount: capturedCount(),
        failedPageCount: failedPages.length,
        pendingUrls: resumableQueue(),
      });
      const results = await Promise.all(
        batch.map(async (pageUrl) => {
          try {
            const page = await capturePage(
              browser,
              pageUrl,
              dnsCache,
              async (detail) => {
                await assertActive();
                await onProgress({
                  phase: 'capturing_page',
                  detail,
                  currentUrl: pageUrl,
                  discoveredPageCount: progressCount(),
                  capturedPageCount: capturedCount(),
                  failedPageCount: failedPages.length,
                  pendingUrls: resumableQueue(),
                });
              },
              withRenderedFallback,
            );
            return { pageUrl, page };
          } catch (error) {
            return { pageUrl, error };
          }
        }),
      );
      for (let index = 0; index < results.length; index += 1) {
        const result = results[index];
        if ('error' in result) {
          activeUrls.delete(result.pageUrl);
          if (result.error instanceof CaptureCancelledError) throw result.error;
          const reason = safeErrorSummary(result.error);
          failedPages.push({ url: result.pageUrl, reason });
          console.warn(`[capture-worker] skipped ${result.pageUrl}: ${reason}`);
          await onProgress({
            phase: 'discovering',
            detail: 'A page could not be captured; continuing with the remaining public pages.',
            currentUrl: result.pageUrl,
            discoveredPageCount: progressCount(),
            capturedPageCount: capturedCount(),
            failedPageCount: failedPages.length,
            pendingUrls: resumableQueue(),
          });
          continue;
        }
        const page = result.page;
        const finalUrl = normaliseCrawlUrl(page.finalUrl);
        attemptedUrls.add(finalUrl);
        discoveredUrls.add(finalUrl);
        for (const discoveredUrl of discoverPageUrls(page.finalUrl, page.structure.links)) {
          if (discoveredUrls.has(discoveredUrl)) continue;
          discoveredUrls.add(discoveredUrl);
          queuedUrls.push(discoveredUrl);
        }
        pages.push(page);
        await assertActive();
        await onProgress({
          phase: 'saving_page',
          detail: 'Saving this page’s source files and observed facts.',
          currentUrl: page.finalUrl,
          discoveredPageCount: progressCount(),
          capturedPageCount: capturedCount(),
          failedPageCount: failedPages.length,
          pendingUrls: resumableQueue(),
        });
        try {
          await onPage(page, {
            discoveredPageCount: progressCount(),
            capturedPageCount: capturedCount(),
            failedPageCount: failedPages.length,
            pendingUrls: resumableQueue(),
          });
          activeUrls.delete(result.pageUrl);
        } catch (error) {
          if (error instanceof CaptureCancelledError) throw error;
          const unpersistedUrls = results
            .slice(index + 1)
            .map((pending) => pending.page?.finalUrl ?? pending.pageUrl);
          throw new CaptureStorageError(error, {
            phase: 'saving_page',
            url: page.finalUrl,
            pendingUrls: [page.finalUrl, ...unpersistedUrls, ...resumableQueue()],
          });
        }
      }
    }
    if (!pages.length && !existingCapturedPageCount) {
      const reason = failedPages[0]?.reason ?? 'The worker could not save any public pages.';
      throw new Error(`No public pages could be captured. ${reason}`);
    }
    await assertActive();
    await onProgress({
      phase: 'capturing_assets',
      detail: 'Collecting selected public visual assets from captured pages.',
      currentUrl: undefined,
      discoveredPageCount: progressCount(),
      capturedPageCount: capturedCount(),
      failedPageCount: failedPages.length,
      pendingUrls: [],
    });
    const assets = await captureVisualAssets(pages, dnsCache, {
      assertActive,
      onProgress,
      onAsset,
      progress: {
        discoveredPageCount: progressCount(),
        capturedPageCount: capturedCount(),
        failedPageCount: failedPages.length,
      },
    });
    return {
      pages,
      assets,
      discoveredPageCount: progressCount(),
      capturedPageCount: capturedCount(),
      failedPages,
    };
  } finally {
    await browser.close();
  }
}

async function fetchPublicVisualAsset(targetUrl, dnsCache) {
  let currentUrl = targetUrl;
  for (let redirectCount = 0; redirectCount <= 5; redirectCount += 1) {
    await assertPublicUrl(currentUrl, dnsCache);
    const response = await fetch(currentUrl, {
      headers: {
        'user-agent': workerUserAgent,
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml,*/*;q=0.5',
      },
      redirect: 'manual',
      signal: AbortSignal.timeout(8_000),
    });
    if (![301, 302, 303, 307, 308].includes(response.status))
      return { response, finalUrl: currentUrl };
    const location = response.headers.get('location');
    if (!location) throw new Error('A visual asset returned an invalid redirect.');
    currentUrl = new URL(location, currentUrl).toString();
  }
  throw new Error('A visual asset exceeded the redirect limit.');
}

async function captureVisualAssets(pages, dnsCache, callbacks = {}) {
  const {
    assertActive = async () => {},
    onProgress = async () => {},
    onAsset = async () => {},
    progress = {},
  } = callbacks;
  const candidates = new Map();
  pages.forEach((page) => {
    page.structure.visualAssets.forEach((asset) => {
      try {
        const url = new URL(asset.url, page.finalUrl).toString();
        if (isBlurredAssetUrl(url)) return;
        const candidate = {
          ...asset,
          url,
          pageUrl: page.finalUrl,
          pageUrls: [page.finalUrl],
          pageType: page.pageType,
        };
        const key = visualAssetKey(candidate);
        const existing = candidates.get(key);
        if (!existing) {
          candidates.set(key, candidate);
        } else {
          const pageUrls = [...new Set([...(existing.pageUrls ?? []), page.finalUrl])];
          candidates.set(
            key,
            visualAssetScore(candidate) > visualAssetScore(existing)
              ? { ...candidate, pageUrls }
              : { ...existing, pageUrls },
          );
        }
      } catch {
        // Ignore malformed visual asset URLs.
      }
    });
  });
  const assetSelection = selectVisualAssets([...candidates.values()], maxVisualAssets());
  const captured = [];
  let totalBytes = 0;
  const selectedCandidates = (
    callbacks.selectAll ? [...candidates.values()] : assetSelection.selected
  ).filter((candidate) => !callbacks.skipSourceUrls?.has(candidate.url));
  let nextCandidateIndex = 0;

  await onProgress({
    phase: 'capturing_assets',
    detail: `Found ${assetSelection.candidates.length} unique visual assets. Collecting ${selectedCandidates.length}: ${assetSelection.logoCount} logo${assetSelection.logoCount === 1 ? '' : 's'} and ${assetSelection.supportingCount} supporting image${assetSelection.supportingCount === 1 ? '' : 's'}.`,
    currentUrl: undefined,
    ...progress,
  });

  async function captureCandidate(candidate) {
    await assertActive();
    let asset;
    await onProgress({
      phase: 'capturing_assets',
      detail: `Downloading a ${candidate.type} asset from the captured page.`,
      currentUrl: candidate.pageUrl,
      ...progress,
    });
    try {
      const { response, finalUrl } = await fetchPublicVisualAsset(candidate.url, dnsCache);
      if (isBlurredAssetUrl(finalUrl)) return;
      if (!response.ok) return;
      const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase();
      const extension = extensionForContentType(contentType);
      const contentLength = Number(response.headers.get('content-length'));
      if (!extension || (Number.isFinite(contentLength) && contentLength > maxVisualAssetBytes))
        return;
      const content = Buffer.from(await response.arrayBuffer());
      if (
        content.length === 0 ||
        content.length > maxVisualAssetBytes ||
        totalBytes + content.length > maxTotalVisualAssetBytes
      )
        return;
      totalBytes += content.length;
      asset = {
        ...candidate,
        url: finalUrl,
        contentType,
        extension,
        content,
      };
    } catch (error) {
      if (error instanceof CaptureCancelledError || error instanceof CaptureStorageError)
        throw error;
      // A missing CDN image should never fail the page capture that discovered it.
      return;
    }
    await assertActive();
    captured.push(asset);
    try {
      await onAsset(asset, progress);
    } catch (error) {
      throw new CaptureStorageError(error, {
        phase: 'saving_asset',
        url: candidate.pageUrl,
      });
    }
  }

  async function worker() {
    while (nextCandidateIndex < selectedCandidates.length) {
      const candidate = selectedCandidates[nextCandidateIndex];
      nextCandidateIndex += 1;
      await captureCandidate(candidate);
    }
  }

  await Promise.all(
    Array.from({ length: callbacks.concurrency ?? visualAssetConcurrency }, () => worker()),
  );
  return captured;
}

function artifactPath(run, filename) {
  return `${run.organization_id}/${run.business_id}/${run.id}/${filename}`;
}

async function uploadArtifact(client, run, artifact) {
  const storagePath = artifactPath(run, artifact.filename);
  const blob = new Blob([artifact.content], { type: artifact.contentType });
  let failure;
  for (let attempt = 1; attempt <= privateWriteAttempts; attempt += 1) {
    try {
      const { error: uploadError } = await client.storage
        .from(artifactBucket)
        .upload(storagePath, blob, { contentType: artifact.contentType, upsert: true });
      if (!uploadError) {
        failure = undefined;
        break;
      }
      failure = new CaptureArtifactStorageError('storage_upload', artifact, uploadError, attempt);
    } catch (error) {
      failure = new CaptureArtifactStorageError('storage_upload', artifact, error, attempt);
    }
    if (!failure.context.retryable) throw failure;
    if (attempt < privateWriteAttempts) await wait(400 * 2 ** (attempt - 1));
  }
  if (failure) throw failure;
  return {
    organization_id: run.organization_id,
    business_id: run.business_id,
    crawl_run_id: run.id,
    kind: artifact.kind,
    label: artifact.label,
    storage_bucket: artifactBucket,
    storage_path: storagePath,
    content_type: artifact.contentType,
    byte_size: artifact.content.size,
    sha256: hashContent(Buffer.from(await artifact.content.arrayBuffer())),
    metadata: artifact.metadata,
  };
}

function artifactsForPage(page) {
  const key = hashContent(page.finalUrl).slice(0, 12);
  const label =
    page.pageType === 'homepage'
      ? 'Homepage'
      : page.pageType[0].toUpperCase() + page.pageType.slice(1);
  const baseMetadata = {
    sourceUrl: page.finalUrl,
    pageType: page.pageType,
    title: page.structure.title,
    captureMethod: page.captureMethod,
  };
  return [
    {
      filename: `${key}-page.html`,
      kind: 'html',
      label: `${label} HTML`,
      contentType: 'text/html',
      content: new Blob([page.html], { type: 'text/html' }),
      metadata: baseMetadata,
    },
    {
      filename: `${key}-content.json`,
      kind: 'content',
      label: `${label} readable text`,
      contentType: 'application/json',
      content: new Blob(
        [
          JSON.stringify(
            {
              url: page.finalUrl,
              title: page.structure.title,
              description: page.structure.description,
              headings: page.structure.headings,
              contentBlocks: page.structure.contentBlocks,
              callsToAction: page.structure.callsToAction,
              navigation: page.structure.navigation,
              forms: page.structure.forms,
              componentInventory: page.structure.componentInventory,
              text: page.structure.readableText,
              truncated: page.structure.readableTextTruncated,
            },
            null,
            2,
          ),
        ],
        { type: 'application/json' },
      ),
      metadata: baseMetadata,
    },
    ...page.screenshots.map((screenshot, index) => ({
      filename: `${key}-${screenshotViewports[index].label}.png`,
      kind: 'screenshot',
      label: `${label} ${screenshotViewports[index].label} screenshot`,
      contentType: 'image/png',
      content: new Blob([screenshot.image], { type: 'image/png' }),
      metadata: { ...baseMetadata, ...screenshot.metadata },
    })),
    {
      filename: `${key}-accessibility.json`,
      kind: 'accessibility',
      label: `${label} deferred accessibility check`,
      contentType: 'application/json',
      content: new Blob([JSON.stringify(page.accessibility, null, 2)], {
        type: 'application/json',
      }),
      metadata: {
        ...baseMetadata,
        status: page.accessibility.status ?? 'complete',
        violationCount: page.accessibility.violationCount,
      },
    },
    {
      filename: `${key}-summary.json`,
      kind: 'performance',
      label: `${label} structure and timing`,
      contentType: 'application/json',
      content: new Blob(
        [JSON.stringify({ structure: page.structure, navigation: page.navigation }, null, 2)],
        { type: 'application/json' },
      ),
      metadata: baseMetadata,
    },
  ];
}

function artifactsForVisualAsset(asset) {
  const key = hashContent(asset.url).slice(0, 12);
  const label = `${asset.type[0].toUpperCase() + asset.type.slice(1)} asset`;
  return {
    filename: `asset-${key}.${asset.extension}`,
    kind: 'asset',
    label: `${label} from ${new URL(asset.pageUrl).pathname || '/'}`,
    contentType: asset.contentType,
    content: new Blob([asset.content], { type: asset.contentType }),
    metadata: {
      sourceUrl: asset.url,
      pageUrl: asset.pageUrl,
      pageUrls: asset.pageUrls,
      assetType: asset.type,
      detail: asset.detail,
      context: asset.context,
      width: asset.width,
      height: asset.height,
      preferredOrganisationLogo: asset.type === 'logo' && asset.isHeaderLogo === true,
    },
  };
}

async function assertCaptureActive(client, run, workerId) {
  const { data, error } = await client
    .from('crawl_runs')
    .select('status, worker_id, cancel_requested_at')
    .eq('id', run.id)
    .maybeSingle();
  if (error) throw new Error('The worker could not confirm the website capture state.');
  if (data?.cancel_requested_at) throw new CaptureCancelledError();
  if (!data || data.status !== 'running' || data.worker_id !== workerId) {
    throw new Error('The worker lease was lost.');
  }
}

async function updateCaptureProgress(client, run, workerId, progress) {
  const pendingUrls = Array.isArray(progress.pendingUrls)
    ? progress.pendingUrls.slice(0, maxCapturePages())
    : undefined;
  const { data, error } = await client
    .from('crawl_runs')
    .update({
      progress_phase: progress.phase,
      progress_detail: progress.detail,
      current_url: progress.currentUrl ?? null,
      discovered_page_count: progress.discoveredPageCount,
      captured_page_count: progress.capturedPageCount,
      failed_page_count: progress.failedPageCount,
      ...(pendingUrls ? { resume_queue: pendingUrls } : {}),
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .eq('status', 'running')
    .is('cancel_requested_at', null)
    .select('id');
  if (error) throw new Error('The worker could not save capture progress.');
  if (!data?.length) await assertCaptureActive(client, run, workerId);
  if (!data?.length) throw new Error('The worker lease was lost.');
}

async function loadSavedCaptureData(client, run, currentCapture) {
  const { data: savedArtifacts, error } = await client
    .from('artifacts')
    .select('kind, storage_path, content_type, metadata')
    .eq('crawl_run_id', run.id)
    .in('kind', ['performance', 'asset']);
  if (error) throw new Error('The worker could not load saved capture evidence for finalisation.');

  const currentUrls = new Set(currentCapture.pages.map((page) => page.finalUrl));
  const savedPages = [];
  const savedAssets = [];
  for (const artifact of savedArtifacts ?? []) {
    const metadata =
      artifact.metadata && typeof artifact.metadata === 'object' ? artifact.metadata : {};
    if (artifact.kind === 'asset') {
      const sourceUrl = typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : undefined;
      const pageUrl = typeof metadata.pageUrl === 'string' ? metadata.pageUrl : undefined;
      if (sourceUrl && pageUrl) {
        savedAssets.push({
          type: typeof metadata.assetType === 'string' ? metadata.assetType : 'image',
          url: sourceUrl,
          pageUrl,
          detail: typeof metadata.detail === 'string' ? metadata.detail : '',
          context: typeof metadata.context === 'string' ? metadata.context : '',
          width: typeof metadata.width === 'number' ? metadata.width : 0,
          height: typeof metadata.height === 'number' ? metadata.height : 0,
          isHeaderLogo: metadata.preferredOrganisationLogo === true,
          contentType: artifact.content_type ?? 'application/octet-stream',
        });
      }
      continue;
    }
    const sourceUrl = typeof metadata.sourceUrl === 'string' ? metadata.sourceUrl : undefined;
    if (!sourceUrl || currentUrls.has(sourceUrl)) continue;
    const { data: file, error: downloadError } = await client.storage
      .from(artifactBucket)
      .download(artifact.storage_path);
    if (downloadError || !file) continue;
    try {
      const summary = JSON.parse(await file.text());
      if (!summary?.structure) continue;
      savedPages.push({
        finalUrl: sourceUrl,
        pageType:
          typeof metadata.pageType === 'string' ? metadata.pageType : pageTypeForUrl(sourceUrl),
        structure: summary.structure,
        navigation: summary.navigation,
        html: '',
        screenshots: [],
        accessibility: { violationCount: 0, violations: [] },
        statusCode: 200,
      });
    } catch {
      // A malformed prior summary should not erase the valid evidence that remains available.
    }
  }
  const pages = [...savedPages, ...currentCapture.pages];
  const assetByUrl = new Map();
  [...savedAssets, ...currentCapture.assets].forEach((asset) => assetByUrl.set(asset.url, asset));
  return { ...currentCapture, pages, assets: [...assetByUrl.values()] };
}

function pageRecord(run, page) {
  return {
    organization_id: run.organization_id,
    crawl_run_id: run.id,
    url: page.finalUrl,
    canonical_url: page.structure.canonicalUrl || null,
    title: page.structure.title || null,
    status_code: page.statusCode,
    content_hash: hashContent(page.html),
    capture_status: 'ready',
    page_type: page.pageType,
    metadata: {
      headingCount: page.structure.headings.length,
      h1Count: page.structure.headings.filter((heading) => heading.level === 'h1').length,
      linkCount: page.structure.links.length,
      formCount: page.structure.forms.length,
      formFieldCount: page.structure.forms.reduce((count, form) => count + form.fields.length, 0),
      integrationCount: page.structure.integrations.length,
      unlabelledFormFieldCount: page.structure.forms.reduce(
        (count, form) => count + form.fields.filter((field) => !field.hasLabel).length,
        0,
      ),
      imageCount: page.structure.images.length,
      imagesWithoutAlt: page.structure.images.filter((image) => !image.alt.trim()).length,
      viewportPresent: Boolean(page.structure.viewport),
      structuredDataCount: page.structure.structuredDataCount,
      captureMethod: page.captureMethod,
    },
  };
}

async function storeArtifacts(client, run, artifacts) {
  const records = [];
  for (const artifact of artifacts) records.push(await uploadArtifact(client, run, artifact));
  if (!records.length) return 0;
  const indexArtifact = {
    kind: records.length === 1 ? records[0].kind : 'page_evidence',
    label:
      records.length === 1
        ? records[0].label
        : `${records.length} private evidence files for one captured page`,
    content: { size: records.reduce((total, record) => total + (record.byte_size ?? 0), 0) },
  };
  let failure;
  for (let attempt = 1; attempt <= privateWriteAttempts; attempt += 1) {
    try {
      const { error } = await client
        .from('artifacts')
        .upsert(records, { onConflict: 'storage_path' });
      if (!error) return records.length;
      failure = new CaptureArtifactStorageError('artifact_index', indexArtifact, error, attempt);
    } catch (error) {
      failure = new CaptureArtifactStorageError('artifact_index', indexArtifact, error, attempt);
    }
    if (!failure.context.retryable) throw failure;
    if (attempt < privateWriteAttempts) await wait(400 * 2 ** (attempt - 1));
  }
  throw failure;
}

async function storeCapturedPage(client, run, workerId, page, progress) {
  await assertCaptureActive(client, run, workerId);
  await storeArtifacts(client, run, artifactsForPage(page));
  await assertCaptureActive(client, run, workerId);
  const { error: pageError } = await client
    .from('crawl_pages')
    .upsert(pageRecord(run, page), { onConflict: 'crawl_run_id,url' });
  if (pageError) throw new Error('The worker could not save the captured page record.');

  const { error: deleteFactError } = await client
    .from('evidence_facts')
    .delete()
    .eq('crawl_run_id', run.id)
    .eq('source_url', page.finalUrl);
  if (deleteFactError) throw new Error('The worker could not refresh extracted page evidence.');
  const facts = evidenceFromStructure(page.structure, page.finalUrl, new Date().toISOString()).map(
    (fact) => ({
      ...fact,
      organization_id: run.organization_id,
      business_id: run.business_id,
      crawl_run_id: run.id,
    }),
  );
  if (facts.length) {
    const { error: factError } = await client.from('evidence_facts').insert(facts);
    if (factError) throw new Error('The worker could not save extracted page evidence.');
  }
  await updateCaptureProgress(client, run, workerId, {
    ...progress,
    phase: 'discovering',
    detail: 'Page evidence saved. Finding the next crawlable public page.',
    currentUrl: page.finalUrl,
  });
}

async function storeCapturedAsset(client, run, workerId, asset, progress) {
  await assertCaptureActive(client, run, workerId);
  await storeArtifacts(client, run, [artifactsForVisualAsset(asset)]);
  await updateCaptureProgress(client, run, workerId, {
    ...progress,
    phase: 'capturing_assets',
    detail: 'Visual asset saved and ready for private review.',
    currentUrl: asset.pageUrl,
  });
}

async function storeCompletedCapture(client, run, workerId, capture) {
  await assertCaptureActive(client, run, workerId);
  if (!capture.capturedPageCount) {
    throw new Error('No public pages could be captured. The capture cannot be marked complete.');
  }
  const capturedAt = new Date().toISOString();
  await updateCaptureProgress(client, run, workerId, {
    phase: 'finalizing',
    detail: 'Preparing the final Research Packet from the saved capture evidence.',
    currentUrl: undefined,
    discoveredPageCount: capture.discoveredPageCount,
    capturedPageCount: capture.capturedPageCount,
    failedPageCount: capture.failedPages.length,
  });
  const { data: business, error: businessError } = await client
    .from('businesses')
    .select('name')
    .eq('id', run.business_id)
    .single();
  if (businessError || !business)
    throw new Error('The worker could not load the captured business.');
  const completeCapture = await loadSavedCaptureData(client, run, capture);
  const packet = createResearchPacket({
    businessName: business.name,
    run,
    capture: completeCapture,
    capturedAt,
  });
  const { error: packetError } = await client.from('research_packets').upsert(
    {
      organization_id: run.organization_id,
      business_id: run.business_id,
      crawl_run_id: run.id,
      schema_version: packet.schemaVersion,
      data: packet,
      generated_at: capturedAt,
    },
    { onConflict: 'crawl_run_id' },
  );
  if (packetError) throw new Error('The worker could not create the research packet.');

  const { data: completedRun, error: completeError } = await client
    .from('crawl_runs')
    .update({
      status: 'ready',
      completed_at: capturedAt,
      discovered_page_count: capture.discoveredPageCount,
      captured_page_count: capture.capturedPageCount,
      failed_page_count: capture.failedPages.length,
      progress_phase: 'complete',
      progress_detail: 'Capture complete. All saved evidence is ready for private review.',
      current_url: null,
      resume_queue: [],
      lease_expires_at: null,
      error_summary: null,
      failure_phase: null,
      failure_url: null,
      failure_detail: null,
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .is('cancel_requested_at', null)
    .select('id');
  if (completeError) throw completeError;
  if (!completedRun?.length) await assertCaptureActive(client, run, workerId);
  if (!completedRun?.length) throw new Error('The worker lease was lost.');

  const { error: capabilityJobError } = await client.from('capability_analysis_jobs').upsert(
    {
      organization_id: run.organization_id,
      business_id: run.business_id,
      crawl_run_id: run.id,
      status: 'queued',
      progress_phase: 'queued',
      progress_detail: 'AI capability analysis queued from the completed private capture.',
    },
    { onConflict: 'crawl_run_id' },
  );
  if (capabilityJobError) throw new Error('The worker could not queue AI capability analysis.');

  const { error: websiteError } = await client
    .from('websites')
    .update({ crawl_status: 'ready', last_captured_at: capturedAt })
    .eq('id', run.website_id);
  if (websiteError) throw new Error('The worker could not update the website capture state.');
  const { count, error: artifactCountError } = await client
    .from('artifacts')
    .select('*', { count: 'exact', head: true })
    .eq('crawl_run_id', run.id);
  if (artifactCountError)
    throw new Error('The worker could not count the saved capture artifacts.');
  const { error: activityError } = await client.from('activities').insert({
    organization_id: run.organization_id,
    business_id: run.business_id,
    type: 'note',
    message: `Website capture completed. ${capture.capturedPageCount} public pages and ${count ?? 0} private artifacts are ready for review.`,
  });
  if (activityError) throw new Error('The worker could not record capture completion.');
}

async function markCaptureFailed(client, run, workerId, error) {
  const failurePhase = error instanceof CaptureStorageError ? error.phase : 'capturing_page';
  const failureUrl =
    error instanceof CaptureStorageError && error.url
      ? error.url
      : (run.current_url ?? run.target_url);
  const pendingUrls =
    error instanceof CaptureStorageError && error.pendingUrls.length
      ? error.pendingUrls
      : [failureUrl];
  const failureDetail = captureFailureDetail(error, failurePhase);
  const { error: runError } = await client
    .from('crawl_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      failed_page_count: 1,
      lease_expires_at: null,
      progress_phase: 'failed',
      progress_detail: `Capture stopped while ${failurePhase.replace(/_/g, ' ')}.`,
      current_url: failureUrl,
      resume_queue: pendingUrls.slice(0, maxCapturePages()),
      error_summary: safeErrorSummary(error),
      failure_phase: failurePhase,
      failure_url: failureUrl,
      failure_detail: failureDetail,
    })
    .eq('id', run.id)
    .eq('worker_id', workerId);
  if (runError) throw runError;
  await client.from('websites').update({ crawl_status: 'failed' }).eq('id', run.website_id);
  await client.from('activities').insert({
    organization_id: run.organization_id,
    business_id: run.business_id,
    type: 'note',
    message: `Website capture failed while ${failurePhase.replace(/_/g, ' ')}. ${failureDetail}`,
  });
}

async function markCaptureCancelled(client, run, workerId) {
  const { error } = await client
    .from('crawl_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      lease_expires_at: null,
      progress_phase: 'cancelled',
      progress_detail: 'Capture cancelled. Any evidence saved before cancellation remains private.',
      error_summary: 'Capture cancelled by a workspace user.',
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .not('cancel_requested_at', 'is', null);
  if (error) throw error;
  await client.from('websites').update({ crawl_status: 'not_started' }).eq('id', run.website_id);
}

async function processNextCapture(client, workerId) {
  const { data, error } = await client.rpc('claim_next_homepage_capture', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The worker could not claim the next website capture.');
  const claimedRun = Array.isArray(data) ? data[0] : undefined;
  if (!claimedRun) return false;
  const { data: website, error: websiteError } = await client
    .from('websites')
    .select('business_id')
    .eq('id', claimedRun.website_id)
    .single();
  if (websiteError || !website) throw new Error('The worker could not load the requested website.');
  const run = { ...claimedRun, business_id: website.business_id };
  try {
    const { data: savedPages, error: savedPagesError } = await client
      .from('crawl_pages')
      .select('url')
      .eq('crawl_run_id', run.id);
    if (savedPagesError)
      throw new Error('The worker could not load previously saved page evidence.');
    const resumeQueue = Array.isArray(run.resume_queue)
      ? run.resume_queue.filter((url) => typeof url === 'string')
      : [];
    await updateCaptureProgress(client, run, workerId, {
      phase: 'discovering',
      detail: resumeQueue.length
        ? 'Resuming from the last incomplete public-page capture step.'
        : 'Starting public-page discovery from the submitted website URL.',
      currentUrl: resumeQueue[0] ?? run.target_url,
      discoveredPageCount: run.discovered_page_count || 1,
      capturedPageCount: (savedPages ?? []).length,
      failedPageCount: 0,
      pendingUrls: resumeQueue,
    });
    const capture = await captureWebsite(run.target_url, {
      assertActive: () => assertCaptureActive(client, run, workerId),
      onProgress: (progress) => updateCaptureProgress(client, run, workerId, progress),
      onPage: (page, progress) => storeCapturedPage(client, run, workerId, page, progress),
      onAsset: (asset, progress) => storeCapturedAsset(client, run, workerId, asset, progress),
      resumeQueue,
      knownUrls: (savedPages ?? []).map((page) => page.url),
      discoveredPageCount: run.discovered_page_count || 1,
      existingCapturedPageCount: (savedPages ?? []).length,
    });
    await storeCompletedCapture(client, run, workerId, capture);
    console.log(`[capture-worker] completed ${run.id}: ${capture.capturedPageCount} pages`);
  } catch (error) {
    if (error instanceof CaptureCancelledError) {
      await markCaptureCancelled(client, run, workerId);
      console.log(`[capture-worker] cancelled ${run.id}`);
      return true;
    }
    await markCaptureFailed(client, run, workerId, error);
    console.error(
      `[capture-worker] failed ${run.id}:`,
      error instanceof Error ? error.message : error,
    );
    if (error instanceof CaptureStorageError && error.context?.operation) {
      console.error(
        `[capture-worker] private evidence failure details ${run.id}:`,
        JSON.stringify(error.context),
      );
    }
  }
  return true;
}

async function updateAssetRefresh(client, job, workerId, patch) {
  const { error } = await client
    .from('asset_refresh_jobs')
    .update(patch)
    .eq('id', job.id)
    .eq('worker_id', workerId)
    .eq('status', 'running');
  if (error) throw new Error('The image-only refresh progress could not be saved.');
}

async function assertAssetRefreshActive(client, job, workerId) {
  const { data, error } = await client
    .from('asset_refresh_jobs')
    .select('status,cancel_requested_at,worker_id')
    .eq('id', job.id)
    .maybeSingle();
  if (error || !data || data.status !== 'running' || data.worker_id !== workerId)
    throw new Error('The image-only refresh worker lease was lost.');
  if (data.cancel_requested_at) throw new CaptureCancelledError();
}

async function processNextAssetRefresh(client, workerId) {
  const { data, error } = await client.rpc('claim_next_asset_refresh', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The worker could not claim the next image-only refresh.');
  const job = Array.isArray(data) ? data[0] : undefined;
  if (!job) return false;
  try {
    const [{ data: pageRows, error: pageError }, { data: artifactRows, error: artifactError }] =
      await Promise.all([
        client
          .from('crawl_pages')
          .select('url')
          .eq('crawl_run_id', job.crawl_run_id)
          .eq('capture_status', 'ready'),
        client
          .from('artifacts')
          .select('metadata')
          .eq('crawl_run_id', job.crawl_run_id)
          .eq('kind', 'asset'),
      ]);
    if (pageError || artifactError)
      throw new Error('The worker could not load the existing capture for image refresh.');
    const savedUrls = new Set(
      (artifactRows ?? [])
        .map((row) => row.metadata?.sourceUrl)
        .filter((url) => typeof url === 'string'),
    );
    const pageUrls = (pageRows ?? [])
      .map((page) => page.url)
      .filter((url) => typeof url === 'string');
    await updateAssetRefresh(client, job, workerId, {
      progress_phase: 'scanning_pages',
      progress_detail: 'Scanning existing captured pages for image sources.',
      total_items: pageUrls.length,
      completed_items: 0,
      discovered_items: 0,
      saved_items: 0,
    });
    const browser = await chromium.launch({ headless: true });
    try {
      const pages = [];
      for (let index = 0; index < pageUrls.length; index += 5) {
        await assertAssetRefreshActive(client, job, workerId);
        const batch = pageUrls.slice(index, index + 5);
        const scanned = await Promise.all(
          batch.map((url) => captureFastPage(browser, url, new Map())),
        );
        pages.push(...scanned);
        await updateAssetRefresh(client, job, workerId, {
          progress_phase: 'scanning_pages',
          progress_detail: `Scanned ${Math.min(index + batch.length, pageUrls.length)} of ${pageUrls.length} captured pages for image sources.`,
          current_url: batch.at(-1),
          completed_items: Math.min(index + batch.length, pageUrls.length),
        });
      }
      let savedItems = 0;
      const assetRun = {
        id: job.crawl_run_id,
        organization_id: job.organization_id,
        business_id: job.business_id,
      };
      await captureVisualAssets(pages, new Map(), {
        selectAll: true,
        concurrency: 5,
        skipSourceUrls: savedUrls,
        assertActive: () => assertAssetRefreshActive(client, job, workerId),
        onProgress: async (progress) =>
          updateAssetRefresh(client, job, workerId, {
            progress_phase: 'downloading_images',
            progress_detail: progress.detail,
            discovered_items: progress.discoveredPageCount ?? 0,
          }),
        onAsset: async (asset) => {
          await assertAssetRefreshActive(client, job, workerId);
          if (savedUrls.has(asset.url)) return;
          await storeArtifacts(client, assetRun, [artifactsForVisualAsset(asset)]);
          savedUrls.add(asset.url);
          savedItems += 1;
          await updateAssetRefresh(client, job, workerId, {
            progress_phase: 'saving_images',
            progress_detail: `Saved ${savedItems} new ${savedItems === 1 ? 'image' : 'images'} without changing existing evidence.`,
            current_url: asset.pageUrl,
            saved_items: savedItems,
          });
        },
      });
      await updateAssetRefresh(client, job, workerId, {
        status: 'ready',
        lease_expires_at: null,
        progress_phase: 'complete',
        progress_detail: `Image-only refresh complete. ${savedItems} new ${savedItems === 1 ? 'image was' : 'images were'} saved.`,
        saved_items: savedItems,
        current_url: null,
      });
    } finally {
      await browser.close();
    }
  } catch (error) {
    const cancelled = error instanceof CaptureCancelledError;
    await client
      .from('asset_refresh_jobs')
      .update({
        status: 'failed',
        lease_expires_at: null,
        progress_phase: cancelled ? 'cancelled' : 'failed',
        progress_detail: cancelled
          ? 'Image-only refresh cancelled. Saved images remain private.'
          : 'Image-only refresh failed.',
        error_summary: cancelled
          ? 'Image-only refresh cancelled by a workspace user.'
          : safeErrorSummary(error),
      })
      .eq('id', job.id)
      .eq('worker_id', workerId);
  }
  return true;
}

async function main() {
  const supabaseUrl = requiredEnvironment('SITEFORGE_SUPABASE_URL');
  const serviceRoleKey = requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY');
  const workerId = process.env.SITEFORGE_WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
  const pollIntervalMs = Number.parseInt(process.env.SITEFORGE_CAPTURE_POLL_MS ?? '5000', 10);
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: createTimedFetch(workerRequestTimeoutMs) },
  });
  const runOnce = process.argv.includes('--once');
  let stopping = false;
  process.on('SIGINT', () => {
    stopping = true;
  });
  process.on('SIGTERM', () => {
    stopping = true;
  });

  do {
    const claimed =
      (await processNextCapture(client, workerId)) ||
      (await processNextAssetRefresh(client, workerId));
    if (runOnce || stopping) {
      if (runOnce && !claimed) console.log('[capture-worker] no queued website captures.');
      break;
    }
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (!stopping);
}

main().catch((error) => {
  console.error(
    '[capture-worker] stopped unexpectedly',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
