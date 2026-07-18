/* global document, PerformanceNavigationTiming */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import AxeBuilder from '@axe-core/playwright';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { assertPublicUrl, isRobotsAllowed } from './security.mjs';

const artifactBucket = 'siteforge-artifacts';
const workerUserAgent = 'SiteForgeResearchBot/0.1 (+https://siteforge.local/research)';
const captureTimeoutMs = 45_000;
const maxHtmlBytes = 3 * 1024 * 1024;
const maxScreenshotHeight = 20_000;
const screenshotViewports = [
  { label: 'desktop', width: 1440, height: 900 },
  { label: 'tablet', width: 768, height: 1024 },
  { label: 'mobile', width: 375, height: 812 },
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the capture worker.`);
  return value;
}

function hashContent(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeErrorSummary(error) {
  if (error instanceof Error && error.message.includes('Robots')) return error.message;
  if (error instanceof Error && error.message.includes('blocked network')) return error.message;
  return 'The protected capture worker could not complete this homepage capture.';
}

function bytes(value) {
  return Buffer.byteLength(value, 'utf8');
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

async function assertRobotsAllowsHomepage(targetUrl, dnsCache) {
  const robotsUrl = new URL('/robots.txt', targetUrl).toString();
  try {
    const response = await fetchWithSafeRedirects(robotsUrl, dnsCache);
    if (!response.ok) return;
    const robotsText = await response.text();
    if (!isRobotsAllowed(robotsText, new URL(targetUrl).pathname)) {
      throw new Error('Robots rules do not allow this homepage capture.');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Robots')) throw error;
  }
}

function normaliseText(value, limit = 600) {
  return value.replace(/\s+/g, ' ').trim().slice(0, limit);
}

async function collectPageStructure(page) {
  return page.evaluate(() => {
    const readMeta = (name) =>
      document
        .querySelector(`meta[name="${name}"], meta[property="${name}"]`)
        ?.getAttribute('content') ?? '';
    const text = (element) => (element.textContent ?? '').replace(/\s+/g, ' ').trim();
    return {
      title: document.title.trim(),
      description: readMeta('description'),
      canonicalUrl: document.querySelector('link[rel="canonical"]')?.getAttribute('href') ?? '',
      language: document.documentElement.lang,
      viewport: readMeta('viewport'),
      headings: Array.from(document.querySelectorAll('h1, h2, h3'))
        .map((heading) => ({ level: heading.tagName.toLowerCase(), text: text(heading) }))
        .filter((heading) => heading.text)
        .slice(0, 40),
      navigation: Array.from(document.querySelectorAll('nav a'))
        .map((link) => ({ label: text(link), href: link.href }))
        .filter((link) => link.label)
        .slice(0, 30),
      links: Array.from(document.querySelectorAll('a[href]'))
        .map((link) => ({ label: text(link), href: link.href }))
        .filter((link) => link.label)
        .slice(0, 80),
      forms: Array.from(document.forms)
        .slice(0, 10)
        .map((form) => ({
          action: form.action,
          method: form.method,
          controlCount: form.elements.length,
        })),
      imageCount: document.images.length,
      imagesWithoutAlt: Array.from(document.images).filter((image) => !image.alt.trim()).length,
    };
  });
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
  ];
  return fields
    .filter(([, value]) => typeof value === 'string' && value.trim())
    .map(([label, value, evidence]) => ({
      label,
      value: normaliseText(value),
      source_url: sourceUrl,
      evidence,
      confidence: 'high',
      verification_state: 'not_collected',
      captured_at: capturedAt,
    }));
}

async function captureScreenshot(page, viewport) {
  await page.setViewportSize({ width: viewport.width, height: viewport.height });
  await page.waitForTimeout(400);
  const pageHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  const truncated = pageHeight > maxScreenshotHeight;
  const image = await page.screenshot(
    truncated
      ? {
          type: 'png',
          clip: { x: 0, y: 0, width: viewport.width, height: maxScreenshotHeight },
        }
      : { type: 'png', fullPage: true },
  );
  return {
    image,
    metadata: {
      viewport: { width: viewport.width, height: viewport.height },
      pageHeight,
      truncated,
    },
  };
}

async function captureHomepage(targetUrl) {
  const dnsCache = new Map();
  await assertPublicUrl(targetUrl, dnsCache);
  await assertRobotsAllowsHomepage(targetUrl, dnsCache);

  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({
      serviceWorkers: 'block',
      userAgent: workerUserAgent,
      viewport: screenshotViewports[0],
    });
    const page = await context.newPage();
    await page.route('**/*', async (route) => {
      try {
        await assertPublicUrl(route.request().url(), dnsCache);
        await route.continue();
      } catch {
        await route.abort('blockedbyclient');
      }
    });
    const response = await page.goto(targetUrl, {
      timeout: captureTimeoutMs,
      waitUntil: 'domcontentloaded',
    });
    if (!response || response.status() >= 400) {
      throw new Error('The homepage returned an unavailable response.');
    }
    await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => undefined);
    await assertPublicUrl(page.url(), dnsCache);

    const html = await page.content();
    if (bytes(html) > maxHtmlBytes)
      throw new Error('The homepage HTML exceeded the capture limit.');

    const structure = await collectPageStructure(page);
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
      .analyze();
    const screenshots = [];
    for (const viewport of screenshotViewports) {
      screenshots.push(await captureScreenshot(page, viewport));
    }
    const navigation = await page.evaluate(() => {
      const entry = performance.getEntriesByType('navigation')[0];
      if (!(entry instanceof PerformanceNavigationTiming)) return undefined;
      return {
        domContentLoadedMs: Math.round(entry.domContentLoadedEventEnd),
        loadMs: Math.round(entry.loadEventEnd),
        transferSize: entry.transferSize,
      };
    });
    const finalUrl = page.url();
    await context.close();
    return {
      finalUrl,
      html,
      structure,
      screenshots,
      accessibility: {
        violationCount: accessibility.violations.length,
        violations: accessibility.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodeCount: violation.nodes.length,
        })),
      },
      navigation,
      statusCode: response.status(),
    };
  } finally {
    await browser.close();
  }
}

function artifactPath(run, filename) {
  return `${run.organization_id}/${run.business_id}/${run.id}/${filename}`;
}

async function uploadArtifact(client, run, artifact) {
  const storagePath = artifactPath(run, artifact.filename);
  const blob = new Blob([artifact.content], { type: artifact.contentType });
  const { error: uploadError } = await client.storage
    .from(artifactBucket)
    .upload(storagePath, blob, {
      contentType: artifact.contentType,
      upsert: true,
    });
  if (uploadError) throw new Error('The worker could not store a private capture artifact.');
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

async function storeCompletedCapture(client, run, workerId, capture) {
  const capturedAt = new Date().toISOString();
  const artifacts = [
    {
      filename: 'homepage.html',
      kind: 'html',
      label: 'Homepage HTML',
      contentType: 'text/html',
      content: new Blob([capture.html], { type: 'text/html' }),
      metadata: { finalUrl: capture.finalUrl, title: capture.structure.title },
    },
    ...capture.screenshots.map((screenshot, index) => ({
      filename: `homepage-${screenshotViewports[index].label}.png`,
      kind: 'screenshot',
      label: `${screenshotViewports[index].label[0].toUpperCase()}${screenshotViewports[index].label.slice(1)} screenshot`,
      contentType: 'image/png',
      content: new Blob([screenshot.image], { type: 'image/png' }),
      metadata: screenshot.metadata,
    })),
    {
      filename: 'accessibility.json',
      kind: 'accessibility',
      label: 'Automated accessibility check',
      contentType: 'application/json',
      content: new Blob([JSON.stringify(capture.accessibility, null, 2)], {
        type: 'application/json',
      }),
      metadata: { violationCount: capture.accessibility.violationCount },
    },
    {
      filename: 'capture-summary.json',
      kind: 'performance',
      label: 'Homepage structure and timing',
      contentType: 'application/json',
      content: new Blob(
        [JSON.stringify({ structure: capture.structure, navigation: capture.navigation }, null, 2)],
        { type: 'application/json' },
      ),
      metadata: { navigation: capture.navigation },
    },
  ];
  const records = [];
  for (const artifact of artifacts) records.push(await uploadArtifact(client, run, artifact));

  const { error: pageError } = await client.from('crawl_pages').upsert(
    {
      organization_id: run.organization_id,
      crawl_run_id: run.id,
      url: capture.finalUrl,
      canonical_url: capture.structure.canonicalUrl || null,
      title: capture.structure.title || null,
      status_code: capture.statusCode,
      content_hash: hashContent(capture.html),
      capture_status: 'ready',
    },
    { onConflict: 'crawl_run_id,url' },
  );
  if (pageError) throw new Error('The worker could not save the captured page record.');

  const { error: deleteArtifactError } = await client
    .from('artifacts')
    .delete()
    .eq('crawl_run_id', run.id);
  if (deleteArtifactError) throw new Error('The worker could not refresh artifact metadata.');
  const { error: artifactError } = await client.from('artifacts').insert(records);
  if (artifactError) throw new Error('The worker could not save artifact metadata.');

  const { error: deleteFactError } = await client
    .from('evidence_facts')
    .delete()
    .eq('crawl_run_id', run.id);
  if (deleteFactError) throw new Error('The worker could not refresh extracted evidence.');
  const facts = evidenceFromStructure(capture.structure, capture.finalUrl, capturedAt).map(
    (fact) => ({
      ...fact,
      organization_id: run.organization_id,
      business_id: run.business_id,
      crawl_run_id: run.id,
    }),
  );
  if (facts.length) {
    const { error: factError } = await client.from('evidence_facts').insert(facts);
    if (factError) throw new Error('The worker could not save extracted evidence.');
  }

  const { data: completedRun, error: completeError } = await client
    .from('crawl_runs')
    .update({
      status: 'ready',
      completed_at: capturedAt,
      discovered_page_count: 1,
      captured_page_count: 1,
      failed_page_count: 0,
      lease_expires_at: null,
      error_summary: null,
    })
    .eq('id', run.id)
    .eq('worker_id', workerId)
    .select('id');
  if (completeError || !completedRun?.length) throw new Error('The capture worker lease was lost.');

  const { error: websiteError } = await client
    .from('websites')
    .update({ crawl_status: 'ready', last_captured_at: capturedAt })
    .eq('id', run.website_id);
  if (websiteError) throw new Error('The worker could not update the website capture state.');
  const { error: activityError } = await client.from('activities').insert({
    organization_id: run.organization_id,
    business_id: run.business_id,
    type: 'note',
    message: 'Homepage capture completed. Evidence and private artifacts are ready for review.',
  });
  if (activityError) throw new Error('The worker could not record capture completion.');
}

async function markCaptureFailed(client, run, workerId, error) {
  const { error: runError } = await client
    .from('crawl_runs')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      failed_page_count: 1,
      lease_expires_at: null,
      error_summary: safeErrorSummary(error),
    })
    .eq('id', run.id)
    .eq('worker_id', workerId);
  if (runError) throw runError;
  await client.from('websites').update({ crawl_status: 'failed' }).eq('id', run.website_id);
  await client.from('activities').insert({
    organization_id: run.organization_id,
    business_id: run.business_id,
    type: 'note',
    message:
      'Homepage capture failed. Review the website URL and capture status before trying again.',
  });
}

async function processNextCapture(client, workerId) {
  const { data, error } = await client.rpc('claim_next_homepage_capture', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The worker could not claim the next homepage capture.');
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
    const capture = await captureHomepage(run.target_url);
    await storeCompletedCapture(client, run, workerId, capture);
    console.log(`[capture-worker] completed ${run.id}`);
  } catch (error) {
    await markCaptureFailed(client, run, workerId, error);
    console.error(`[capture-worker] failed ${run.id}`);
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
    const claimed = await processNextCapture(client, workerId);
    if (runOnce || stopping) break;
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
