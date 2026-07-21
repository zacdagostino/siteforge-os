/* global document, getComputedStyle, HTMLImageElement */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import ImageTracer from 'imagetracerjs';
import { chromium } from 'playwright';
import { assertPublicUrl } from './security.mjs';
import { coloursFromSvg, isBrandColour } from './brand-evidence.mjs';

const artifactBucket = 'siteforge-artifacts';
const requestTimeoutMs = 90_000;
const maxBrandEvidencePages = 8;
const cancellationPollMs = 500;
const workerHeartbeatMs = 10_000;
const defaultAssetAnalysisConcurrency = 3;
const maxAssetAnalysisConcurrency = 5;
const supportedRoles = new Set([
  'primary_logo',
  'secondary_mark',
  'worksite_photo',
  'team_photo',
  'project_photo',
  'partner_logo',
  'supplier_logo',
  'decorative',
  'unknown',
  'exclude',
]);
const supportedAssociations = new Set(['target_business', 'third_party', 'unknown']);
const supportedConfidence = new Set(['high', 'medium', 'low']);

class AssetAnalysisCancelledError extends Error {
  constructor() {
    super('Asset analysis cancelled by a workspace user.');
    this.name = 'AssetAnalysisCancelledError';
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the asset-analysis worker.`);
  return value;
}

function assetAnalysisConcurrency() {
  const configured = Number.parseInt(process.env.SITEFORGE_ASSET_ANALYSIS_CONCURRENCY ?? '', 10);
  if (!Number.isFinite(configured)) return defaultAssetAnalysisConcurrency;
  return Math.min(Math.max(configured, 1), maxAssetAnalysisConcurrency);
}

async function runWithConcurrency(items, concurrency, processItem) {
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const item = items[nextIndex];
      nextIndex += 1;
      await processItem(item);
    }
  });
  await Promise.all(workers);
}

function createTimedFetch(timeoutMs) {
  return (input, init = {}) => {
    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const signal = init.signal ? AbortSignal.any([init.signal, timeoutSignal]) : timeoutSignal;
    return fetch(input, { ...init, signal });
  };
}

function throwIfAborted(signal) {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new AssetAnalysisCancelledError();
}

function readString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function readStringList(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
}

function safeAssetPreparationDetail(error) {
  const message = error instanceof Error ? error.message : '';
  if (/Target page, context or browser has been closed/i.test(message))
    return 'The private image conversion browser closed before the image could be prepared.';
  if (/timed out|timeout/i.test(message))
    return 'The private image preparation step exceeded its time limit.';
  if (/vision provider returned/i.test(message))
    return 'The vision provider could not analyse this image during this run.';
  return 'The private image could not be prepared for automated analysis during this run.';
}

function recordValue(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function isSelectedForAnalysis(asset) {
  return recordValue(asset.metadata).analysisSelected !== false;
}

function storedAnnotationFromRow(row) {
  const modelOutput = recordValue(row.model_output);
  return {
    suggestedRole: readString(row.suggested_role),
    businessAssociation: readString(row.business_association),
    reviewState: readString(row.review_state),
    retryable: modelOutput.processingStatus === 'unavailable',
  };
}

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  const output = Array.isArray(response.output) ? response.output : [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    const text = content.find((entry) => entry?.type === 'output_text')?.text;
    if (typeof text === 'string') return text;
  }
  throw new Error('The vision model did not return structured text.');
}

function annotationSchema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: [
      'observed_description',
      'visible_text',
      'suggested_role',
      'business_association',
      'safe_reuse_note',
      'cautions',
      'confidence',
    ],
    properties: {
      observed_description: { type: 'string' },
      visible_text: { type: 'array', items: { type: 'string' } },
      suggested_role: { type: 'string', enum: [...supportedRoles] },
      business_association: { type: 'string', enum: [...supportedAssociations] },
      safe_reuse_note: { type: 'string' },
      cautions: { type: 'array', items: { type: 'string' } },
      confidence: { type: 'string', enum: [...supportedConfidence] },
    },
  };
}

async function imageInput(blob, signal) {
  throwIfAborted(signal);
  if (blob.type === 'image/avif' || blob.type === 'image/svg+xml') {
    const converter = await chromium.launch({ headless: true });
    try {
      const page = await converter.newPage({ viewport: { width: 1600, height: 1200 } });
      try {
        const source = `data:${blob.type};base64,${Buffer.from(await blob.arrayBuffer()).toString('base64')}`;
        await page.setContent(`<img id="asset" src="${source}">`);
        await page.waitForFunction(
          () => {
            const image = document.querySelector('#asset');
            return image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0;
          },
          undefined,
          { timeout: 12_000 },
        );
        const png = await page.locator('#asset').screenshot({ type: 'png', timeout: 12_000 });
        throwIfAborted(signal);
        return `data:image/png;base64,${png.toString('base64')}`;
      } finally {
        await page.close().catch(() => undefined);
      }
    } finally {
      await converter.close().catch(() => undefined);
    }
  }
  const image = `data:${blob.type || 'image/png'};base64,${Buffer.from(
    await blob.arrayBuffer(),
  ).toString('base64')}`;
  throwIfAborted(signal);
  return image;
}

function isDerivedVectorSuggestion(asset) {
  const metadata = recordValue(asset.metadata);
  return metadata.vectorSuggestion === true || Boolean(readString(metadata.derivedFromAssetId));
}

function canCreateVectorSuggestion(asset, annotation) {
  if (isDerivedVectorSuggestion(asset) || asset.content_type === 'image/svg+xml') return false;
  return (
    annotation?.reviewState === 'approved' &&
    annotation.businessAssociation === 'target_business' &&
    ['primary_logo', 'secondary_mark'].includes(annotation.suggestedRole)
  );
}

async function vectorizeLogo(browser, blob) {
  const page = await browser.newPage({ viewport: { width: 512, height: 512 } });
  let imageData;
  try {
    const source = `data:${blob.type || 'image/png'};base64,${Buffer.from(
      await blob.arrayBuffer(),
    ).toString('base64')}`;
    await page.setContent(`<img id="asset" src="${source}">`);
    imageData = await page.evaluate(async () => {
      const image = document.querySelector('#asset');
      if (!(image instanceof HTMLImageElement)) throw new Error('The raster logo could not load.');
      await image.decode();
      const longestEdge = 320;
      const scale = Math.min(1, longestEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) throw new Error('The raster logo could not be read.');
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height);
      return { width: pixels.width, height: pixels.height, data: Array.from(pixels.data) };
    });
  } finally {
    await page.close();
  }
  const svg = ImageTracer.imagedataToSVG(
    {
      width: imageData.width,
      height: imageData.height,
      data: Uint8ClampedArray.from(imageData.data),
    },
    {
      numberofcolors: 3,
      colorquantcycles: 2,
      pathomit: 8,
      ltres: 1,
      qtres: 1,
      rightangleenhance: true,
      viewbox: true,
      desc: false,
    },
  );
  if (typeof svg !== 'string' || !svg.startsWith('<svg') || Buffer.byteLength(svg) > 1_500_000) {
    throw new Error('The vector tracer did not produce a reviewable SVG.');
  }
  return svg;
}

async function storeVectorSuggestion(client, job, sourceAsset, svg) {
  const metadata = recordValue(sourceAsset.metadata);
  const storagePath = `${job.organization_id}/${job.business_id}/${job.crawl_run_id}/derived/vector-suggestion-${sourceAsset.id}.svg`;
  const content = Buffer.from(svg, 'utf8');
  const { error: uploadError } = await client.storage
    .from(artifactBucket)
    .upload(storagePath, content, {
      contentType: 'image/svg+xml',
      upsert: true,
    });
  if (uploadError) throw new Error('The worker could not save the private vector suggestion.');
  const { error: artifactError } = await client.from('artifacts').upsert(
    {
      organization_id: job.organization_id,
      business_id: job.business_id,
      crawl_run_id: job.crawl_run_id,
      kind: 'asset',
      label: `Derived vector suggestion from ${sourceAsset.label || 'approved logo'}`,
      storage_bucket: artifactBucket,
      storage_path: storagePath,
      content_type: 'image/svg+xml',
      byte_size: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      metadata: {
        sourceUrl: readString(metadata.sourceUrl),
        pageUrl: readString(metadata.pageUrl),
        assetType: 'logo',
        detail: 'Deterministic vector suggestion derived from a human-approved raster logo.',
        context: readString(metadata.context),
        vectorSuggestion: true,
        derivedFromAssetId: sourceAsset.id,
        derivedFromContentType: sourceAsset.content_type || 'image',
        reviewState: 'needs_review',
      },
    },
    { onConflict: 'storage_path' },
  );
  if (artifactError) throw new Error('The worker could not index the private vector suggestion.');
}

async function pixelColourCandidates(browser, blob) {
  const page = await browser.newPage({ viewport: { width: 400, height: 400 } });
  try {
    const source = `data:${blob.type || 'image/avif'};base64,${Buffer.from(
      await blob.arrayBuffer(),
    ).toString('base64')}`;
    await page.setContent(`<img id="asset" src="${source}">`);
    return await page.evaluate(async () => {
      const image = document.querySelector('#asset');
      if (!(image instanceof HTMLImageElement)) return [];
      await image.decode();
      const longestEdge = 180;
      const scale = Math.min(1, longestEdge / Math.max(image.naturalWidth, image.naturalHeight));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
      canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) return [];
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const buckets = new Map();
      for (let index = 0; index < pixels.length; index += 16) {
        if (pixels[index + 3] < 200) continue;
        const red = Math.min(255, Math.round(pixels[index] / 24) * 24);
        const green = Math.min(255, Math.round(pixels[index + 1] / 24) * 24);
        const blue = Math.min(255, Math.round(pixels[index + 2] / 24) * 24);
        const maximum = Math.max(red, green, blue) / 255;
        const minimum = Math.min(red, green, blue) / 255;
        const saturation = maximum === 0 ? 0 : (maximum - minimum) / maximum;
        const brightness = (red + green + blue) / (255 * 3);
        if (brightness > 0.94 || brightness < 0.08 || saturation < 0.28) continue;
        const key = `${red}-${green}-${blue}`;
        const bucket = buckets.get(key) ?? { red, green, blue, count: 0 };
        bucket.count += 1;
        buckets.set(key, bucket);
      }
      return [...buckets.values()]
        .sort((left, right) => right.count - left.count)
        .slice(0, 8)
        .map(({ red, green, blue, count }) => ({
          colour: `#${[red, green, blue]
            .map((value) => value.toString(16).padStart(2, '0'))
            .join('')}`.toUpperCase(),
          occurrenceCount: count,
        }));
    });
  } finally {
    await page.close();
  }
}

async function logoColourEvidence(browser, blob, asset, annotation) {
  const metadata = recordValue(asset.metadata);
  const likelyLogo =
    readString(metadata.assetType) === 'logo' ||
    (['primary_logo', 'secondary_mark'].includes(annotation.suggestedRole) &&
      annotation.businessAssociation === 'target_business');
  if (!likelyLogo || annotation.businessAssociation === 'third_party') return [];
  const confidence =
    annotation.suggestedRole === 'primary_logo' &&
    annotation.businessAssociation === 'target_business'
      ? 'high'
      : annotation.businessAssociation === 'unknown'
        ? 'low'
        : 'medium';
  const sourceUrl = readString(metadata.sourceUrl) || undefined;
  const base = {
    assetId: asset.id,
    sourceUrl,
    sourceLabel: asset.label || 'Captured logo asset',
    confidence,
  };
  const evidence = [];
  if (blob.type === 'image/svg+xml') {
    for (const colour of coloursFromSvg(await blob.text())) {
      if (!isBrandColour(colour)) continue;
      evidence.push({
        ...base,
        sourceType: 'logo_vector',
        colour,
        occurrenceCount: 1,
        details: { assetType: 'svg', detectedFrom: 'fill, stroke, or embedded SVG CSS' },
      });
    }
  }
  for (const candidate of await pixelColourCandidates(browser, blob)) {
    evidence.push({
      ...base,
      sourceType: 'logo_pixels',
      colour: candidate.colour,
      occurrenceCount: candidate.occurrenceCount,
      details: { assetType: blob.type || 'image', detectedFrom: 'logo image pixels' },
    });
  }
  return evidence;
}

async function collectRenderedInterfaceEvidence(browser, pages, assertActive = async () => {}) {
  const dnsCache = new Map();
  const context = await browser.newContext({
    serviceWorkers: 'block',
    viewport: { width: 1440, height: 900 },
  });
  await context.route('**/*', async (route) => {
    try {
      await assertPublicUrl(route.request().url(), dnsCache);
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  const evidence = [];
  try {
    for (const capturedPage of pages.slice(0, maxBrandEvidencePages)) {
      try {
        await assertActive();
        await assertPublicUrl(capturedPage.url, dnsCache);
        const page = await context.newPage();
        try {
          const response = await page.goto(capturedPage.url, {
            timeout: 30_000,
            waitUntil: 'domcontentloaded',
          });
          if (!response || response.status() >= 400) continue;
          await page.waitForLoadState('networkidle', { timeout: 3_000 }).catch(() => undefined);
          await assertActive();
          const signals = await page.evaluate(() => {
            const hexFromComputed = (value) => {
              const match = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/i.exec(value);
              return match
                ? `#${match
                    .slice(1, 4)
                    .map((channel) => Number(channel).toString(16).padStart(2, '0'))
                    .join('')}`.toUpperCase()
                : '';
            };
            const colourIsUseful = (colour) => {
              if (!/^#[0-9A-F]{6}$/.test(colour)) return false;
              const red = Number.parseInt(colour.slice(1, 3), 16);
              const green = Number.parseInt(colour.slice(3, 5), 16);
              const blue = Number.parseInt(colour.slice(5, 7), 16);
              const maximum = Math.max(red, green, blue) / 255;
              const minimum = Math.min(red, green, blue) / 255;
              const brightness = (red + green + blue) / (255 * 3);
              return (
                brightness >= 0.08 && brightness <= 0.94 && (maximum - minimum) / maximum >= 0.28
              );
            };
            const values = new Map();
            const add = (colour, sourceType, sourceLabel) => {
              if (!colourIsUseful(colour)) return;
              const key = `${sourceType}|${sourceLabel}|${colour}`;
              const current = values.get(key) ?? {
                colour,
                sourceType,
                sourceLabel,
                occurrenceCount: 0,
              };
              current.occurrenceCount += 1;
              values.set(key, current);
            };
            const rootStyle = getComputedStyle(document.documentElement);
            const variableNames = new Set(
              Array.from(rootStyle).filter((name) => name.startsWith('--')),
            );
            const collectVariableNames = (rules) => {
              for (const rule of rules) {
                if (rule.style) {
                  for (const name of Array.from(rule.style)) {
                    if (name.startsWith('--')) variableNames.add(name);
                  }
                }
                if (rule.cssRules) collectVariableNames(rule.cssRules);
              }
            };
            for (const stylesheet of Array.from(document.styleSheets)) {
              try {
                collectVariableNames(stylesheet.cssRules);
              } catch {
                // Browser security prevents reading some cross-origin stylesheets. Their applied
                // colours are still collected from rendered interface controls below.
              }
            }
            for (const name of variableNames) {
              if (!/(?:brand|primary|secondary|accent|action|button)/i.test(name)) continue;
              const probe = document.createElement('span');
              probe.style.color = `var(${name})`;
              document.body.append(probe);
              add(hexFromComputed(getComputedStyle(probe).color), 'website_css', name);
              probe.remove();
            }
            const controls = Array.from(
              document.querySelectorAll(
                'header, nav, button, a[href], input[type="submit"], [role="button"]',
              ),
            ).slice(0, 300);
            for (const element of controls) {
              const bounds = element.getBoundingClientRect();
              if (!bounds.width || !bounds.height || getComputedStyle(element).display === 'none')
                continue;
              const style = getComputedStyle(element);
              const label = element.matches('header, nav')
                ? element.tagName.toLowerCase()
                : element.matches('button, input[type="submit"], [role="button"]')
                  ? 'interactive control'
                  : 'link';
              const textColour = hexFromComputed(style.color);
              add(hexFromComputed(style.backgroundColor), 'rendered_ui', `${label} background`);
              if (textColour !== '#0000EE') add(textColour, 'rendered_ui', `${label} text`);
              if (label !== 'link') {
                add(hexFromComputed(style.borderTopColor), 'rendered_ui', `${label} border`);
              }
            }
            return [...values.values()];
          });
          evidence.push(
            ...signals.map((signal) => ({
              ...signal,
              sourceUrl: capturedPage.url,
              confidence: signal.sourceType === 'website_css' ? 'high' : 'medium',
              details: {
                pageType: capturedPage.page_type || 'page',
                detectedFrom: signal.sourceLabel,
              },
            })),
          );
          await assertActive();
        } finally {
          await page.close();
        }
      } catch {
        // Brand-colour enrichment never invalidates a completed capture or its asset analysis.
      }
    }
  } finally {
    await context.close();
  }
  return evidence;
}

async function saveBrandColourEvidence(client, job, evidence) {
  const { error: deleteError } = await client
    .from('brand_colour_evidence')
    .delete()
    .eq('crawl_run_id', job.crawl_run_id);
  if (deleteError) throw new Error('The worker could not refresh previous brand-colour evidence.');
  const unique = new Map();
  for (const item of evidence) {
    if (!isBrandColour(item.colour)) continue;
    const sourceKey = `${item.sourceType}|${item.assetId ?? item.sourceUrl ?? ''}|${item.sourceLabel}|${item.colour}`;
    const current = unique.get(sourceKey);
    if (current) current.occurrence_count += item.occurrenceCount;
    else {
      unique.set(sourceKey, {
        organization_id: job.organization_id,
        business_id: job.business_id,
        crawl_run_id: job.crawl_run_id,
        asset_id: item.assetId ?? null,
        source_type: item.sourceType,
        source_key: sourceKey,
        source_label: item.sourceLabel,
        source_url: item.sourceUrl ?? null,
        colour: item.colour,
        occurrence_count: item.occurrenceCount,
        confidence: item.confidence,
        details: item.details,
      });
    }
  }
  const records = [...unique.values()];
  if (!records.length) return 0;
  const { error } = await client.from('brand_colour_evidence').insert(records);
  if (error) throw new Error('The worker could not save brand-colour evidence.');
  return records.length;
}

async function analyzeAsset({ apiKey, model, blob, context, signal }) {
  const prompt = [
    'You are creating a private draft annotation for one public website image.',
    'Describe only directly observable visual content. Page context may help orientation but is not proof.',
    'Never claim a project, client, qualification, service, location, ownership, endorsement, or business relationship unless visible text in the image proves it.',
    'If a logo belongs to a third party or you cannot determine association, use third_party or unknown.',
    'Use the output only as a human-review suggestion for a redesign workflow.',
    `Source context: ${JSON.stringify(context)}`,
  ].join('\n');
  const image = await imageInput(blob, signal);
  throwIfAborted(signal);
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: signal
      ? AbortSignal.any([AbortSignal.timeout(requestTimeoutMs), signal])
      : AbortSignal.timeout(requestTimeoutMs),
    body: JSON.stringify({
      model,
      store: false,
      input: [
        {
          role: 'user',
          content: [
            { type: 'input_text', text: prompt },
            { type: 'input_image', image_url: image, detail: 'high' },
          ],
        },
      ],
      text: {
        format: {
          type: 'json_schema',
          name: 'asset_annotation',
          strict: true,
          schema: annotationSchema(),
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`The vision provider returned ${response.status}.`);
  const output = JSON.parse(outputText(await response.json()));
  return {
    observedDescription: readString(output.observed_description),
    visibleText: readStringList(output.visible_text),
    suggestedRole: supportedRoles.has(output.suggested_role) ? output.suggested_role : 'unknown',
    businessAssociation: supportedAssociations.has(output.business_association)
      ? output.business_association
      : 'unknown',
    safeReuseNote: readString(output.safe_reuse_note),
    cautions: readStringList(output.cautions),
    confidence: supportedConfidence.has(output.confidence) ? output.confidence : 'low',
    raw: output,
  };
}

async function assertJobActive(client, job, workerId) {
  const { data, error } = await client
    .from('asset_analysis_jobs')
    .select('status, worker_id, cancel_requested_at')
    .eq('id', job.id)
    .maybeSingle();
  if (error) throw new Error('The worker could not confirm the asset-analysis state.');
  if (data?.cancel_requested_at) throw new AssetAnalysisCancelledError();
  if (!data || data.status !== 'running' || data.worker_id !== workerId) {
    throw new Error('The asset-analysis worker lease was lost.');
  }
}

function createCancellationMonitor(client, job, workerId) {
  const controller = new AbortController();
  let stopped = false;
  let cancellationDetected = false;
  let checking = false;

  const check = async () => {
    if (stopped || checking || cancellationDetected) return;
    checking = true;
    try {
      const { data } = await client
        .from('asset_analysis_jobs')
        .select('cancel_requested_at')
        .eq('id', job.id)
        .eq('worker_id', workerId)
        .maybeSingle();
      if (data?.cancel_requested_at) {
        cancellationDetected = true;
        controller.abort(new AssetAnalysisCancelledError());
      }
    } finally {
      checking = false;
    }
  };

  const timer = setInterval(() => void check(), cancellationPollMs);
  const heartbeat = setInterval(() => {
    void client
      .from('asset_analysis_jobs')
      .update({ heartbeat_at: new Date().toISOString() })
      .eq('id', job.id)
      .eq('worker_id', workerId)
      .eq('status', 'running')
      .is('cancel_requested_at', null);
  }, workerHeartbeatMs);
  void check();
  return {
    signal: controller.signal,
    async assertActive() {
      if (cancellationDetected) throw new AssetAnalysisCancelledError();
      await assertJobActive(client, job, workerId);
      if (cancellationDetected) throw new AssetAnalysisCancelledError();
    },
    stop() {
      stopped = true;
      clearInterval(timer);
      clearInterval(heartbeat);
    },
  };
}

async function updateProgress(client, job, workerId, patch) {
  const { data, error } = await client
    .from('asset_analysis_jobs')
    .update(patch)
    .eq('id', job.id)
    .eq('worker_id', workerId)
    .eq('status', 'running')
    .is('cancel_requested_at', null)
    .select('id');
  if (error) throw new Error('The worker could not save asset-analysis progress.');
  if (!data?.length) await assertJobActive(client, job, workerId);
  if (!data?.length) throw new Error('The asset-analysis worker lease was lost.');
}

async function processJob(client, job, workerId, apiKey, model) {
  const cancellation = createCancellationMonitor(client, job, workerId);
  try {
    const { data: business, error: businessError } = await client
      .from('businesses')
      .select('name')
      .eq('id', job.business_id)
      .single();
    if (businessError || !business)
      throw new Error('The worker could not load the business context.');
    const { data: assets, error: assetError } = await client
      .from('artifacts')
      .select('*')
      .eq('crawl_run_id', job.crawl_run_id)
      .eq('kind', 'asset')
      .order('created_at');
    if (assetError) throw new Error('The worker could not load the private visual assets.');
    const { data: pages, error: pagesError } = await client
      .from('crawl_pages')
      .select('url, page_type, title')
      .eq('crawl_run_id', job.crawl_run_id)
      .eq('capture_status', 'ready')
      .order('created_at')
      .limit(maxBrandEvidencePages);
    if (pagesError) throw new Error('The worker could not load captured pages for brand evidence.');
    const { data: savedAnnotations, error: savedAnnotationsError } = await client
      .from('asset_annotations')
      .select('asset_id, suggested_role, business_association, review_state, model_output')
      .eq('crawl_run_id', job.crawl_run_id);
    if (savedAnnotationsError)
      throw new Error('The worker could not load saved visual suggestions for refresh.');
    const annotationsByAsset = new Map(
      (savedAnnotations ?? []).map((annotation) => [
        annotation.asset_id,
        storedAnnotationFromRow(annotation),
      ]),
    );
    const derivedFromAssetIds = new Set(
      (assets ?? [])
        .filter((asset) => isDerivedVectorSuggestion(asset))
        .map((asset) => readString(recordValue(asset.metadata).derivedFromAssetId))
        .filter(Boolean),
    );
    const selectedAssets = (assets ?? []).filter(
      (asset) => !isDerivedVectorSuggestion(asset) && isSelectedForAnalysis(asset),
    );
    const assetsNeedingAnalysis = selectedAssets.filter(
      (asset) =>
        !isDerivedVectorSuggestion(asset) &&
        (!annotationsByAsset.has(asset.id) || annotationsByAsset.get(asset.id)?.retryable),
    );
    const vectorCandidates = selectedAssets.filter(
      (asset) =>
        canCreateVectorSuggestion(asset, annotationsByAsset.get(asset.id)) &&
        !derivedFromAssetIds.has(asset.id),
    );
    const totalItems =
      assetsNeedingAnalysis.length +
      vectorCandidates.length +
      Math.min((pages ?? []).length, maxBrandEvidencePages);
    await updateProgress(client, job, workerId, {
      progress_phase: 'preparing',
      progress_detail: assetsNeedingAnalysis.length
        ? 'Private visual assets loaded. Preparing newly captured images for analysis.'
        : vectorCandidates.length
          ? 'Preparing review-required vector suggestions for approved raster logos.'
          : 'Existing visual suggestions retained. Refreshing deterministic brand evidence only.',
      current_asset_id: null,
      total_items: totalItems,
      completed_items: 0,
    });

    let completedItems = 0;
    let progressQueue = Promise.resolve();
    const queueProgress = (patch) => {
      progressQueue = progressQueue.then(() => updateProgress(client, job, workerId, patch));
      return progressQueue;
    };

    await runWithConcurrency(assetsNeedingAnalysis, assetAnalysisConcurrency(), async (asset) => {
      await cancellation.assertActive();
      await queueProgress({
        progress_phase: 'analysing_asset',
        progress_detail: `Analysing captured visual assets in parallel (${assetAnalysisConcurrency()} at a time).`,
        current_asset_id: asset.id,
        total_items: totalItems,
        completed_items: completedItems,
      });
      const { data: blob, error: downloadError } = await client.storage
        .from(asset.storage_bucket || artifactBucket)
        .download(asset.storage_path);
      if (downloadError || !blob) {
        throw new Error(`The worker could not download a private visual asset (${asset.id}).`);
      }
      await cancellation.assertActive();
      const metadata = recordValue(asset.metadata);
      const sourceContext = {
        businessName: business.name,
        sourcePageUrl: readString(metadata.pageUrl),
        originalImageUrl: readString(metadata.sourceUrl),
        capturedType: readString(metadata.assetType) || 'image',
        altOrDetail: readString(metadata.detail),
        surroundingContext: readString(metadata.context),
      };
      if (!apiKey) {
        throw new Error('OPENAI_API_KEY is required to analyse newly captured visual assets.');
      }
      let annotation;
      try {
        annotation = await analyzeAsset({
          apiKey,
          model,
          blob,
          context: sourceContext,
          signal: cancellation.signal,
        });
      } catch (error) {
        await cancellation.assertActive();
        const detail = safeAssetPreparationDetail(error);
        console.warn(`[asset-analysis-worker] skipped model analysis for ${asset.id}: ${detail}`);
        annotation = {
          observedDescription: '',
          visibleText: [],
          suggestedRole: 'unknown',
          businessAssociation: 'unknown',
          safeReuseNote: 'Review this captured image manually before deciding whether to reuse it.',
          cautions: [detail],
          confidence: 'low',
          raw: { processingStatus: 'unavailable', detail },
        };
      }
      await cancellation.assertActive();
      const { error: annotationError } = await client.from('asset_annotations').upsert(
        {
          organization_id: job.organization_id,
          business_id: job.business_id,
          crawl_run_id: job.crawl_run_id,
          asset_id: asset.id,
          analysis_job_id: job.id,
          source_context: sourceContext,
          observed_description: annotation.observedDescription,
          visible_text: annotation.visibleText,
          suggested_role: annotation.suggestedRole,
          business_association: annotation.businessAssociation,
          safe_reuse_note: annotation.safeReuseNote,
          cautions: annotation.cautions,
          confidence: annotation.confidence,
          review_state: 'needs_review',
          model,
          model_output: annotation.raw,
          analyzed_at: new Date().toISOString(),
        },
        { onConflict: 'asset_id' },
      );
      if (annotationError) throw new Error('The worker could not save an asset annotation.');
      annotationsByAsset.set(asset.id, {
        suggestedRole: annotation.suggestedRole,
        businessAssociation: annotation.businessAssociation,
        reviewState: 'needs_review',
        retryable: annotation.raw?.processingStatus === 'unavailable',
      });
      completedItems += 1;
      await queueProgress({
        progress_phase: 'analysing_asset',
        progress_detail:
          annotation.raw?.processingStatus === 'unavailable'
            ? 'An image needs manual review after preparation failed. Continuing with the remaining assets.'
            : 'Visual suggestion saved. Continuing with the remaining assets.',
        current_asset_id: asset.id,
        total_items: totalItems,
        completed_items: completedItems,
      });
    });

    let browser = await chromium.launch({ headless: true });
    try {
      const brandEvidence = [];
      for (const asset of selectedAssets) {
        await cancellation.assertActive();
        if (isDerivedVectorSuggestion(asset)) continue;
        const existingAnnotation = annotationsByAsset.get(asset.id);
        if (existingAnnotation && !existingAnnotation.retryable) {
          const metadata = recordValue(asset.metadata);
          const likelyLogo =
            readString(metadata.assetType) === 'logo' ||
            ['primary_logo', 'secondary_mark'].includes(existingAnnotation.suggestedRole);
          if (likelyLogo) {
            const { data: blob, error: downloadError } = await client.storage
              .from(asset.storage_bucket || artifactBucket)
              .download(asset.storage_path);
            if (!downloadError && blob) {
              await cancellation.assertActive();
              brandEvidence.push(
                ...(await logoColourEvidence(browser, blob, asset, existingAnnotation)),
              );
              await cancellation.assertActive();
              if (
                canCreateVectorSuggestion(asset, existingAnnotation) &&
                !derivedFromAssetIds.has(asset.id)
              ) {
                await updateProgress(client, job, workerId, {
                  progress_phase: 'vectorising_logo',
                  progress_detail:
                    'Creating a private vector suggestion from the approved raster logo.',
                  current_asset_id: asset.id,
                  total_items: totalItems,
                  completed_items: completedItems,
                });
                try {
                  await storeVectorSuggestion(
                    client,
                    job,
                    asset,
                    await vectorizeLogo(browser, blob),
                  );
                  derivedFromAssetIds.add(asset.id);
                } catch {
                  // Vectorisation is optional enrichment. Keep the approved original logo usable.
                }
                completedItems += 1;
              }
            }
          }
          await updateProgress(client, job, workerId, {
            progress_phase: 'retaining_asset_review',
            progress_detail: 'Existing visual suggestion retained without another model call.',
            current_asset_id: asset.id,
            total_items: totalItems,
            completed_items: completedItems,
          });
          continue;
        }
      }
      await cancellation.assertActive();
      await updateProgress(client, job, workerId, {
        progress_phase: 'collecting_brand_evidence',
        progress_detail: 'Reading repeated interface colours from captured pages.',
        current_asset_id: null,
        total_items: totalItems,
        completed_items: completedItems,
      });
      const interfaceEvidence = await collectRenderedInterfaceEvidence(browser, pages ?? [], () =>
        cancellation.assertActive(),
      );
      brandEvidence.push(...interfaceEvidence);
      completedItems += Math.min((pages ?? []).length, maxBrandEvidencePages);
      await cancellation.assertActive();
      const evidenceCount = await saveBrandColourEvidence(client, job, brandEvidence);
      await updateProgress(client, job, workerId, {
        progress_phase: 'saving_brand_evidence',
        progress_detail: evidenceCount
          ? `Saved ${evidenceCount} private brand-colour observations for review.`
          : 'No reliable brand colours were found. Manual colour review is still available.',
        current_asset_id: null,
        total_items: totalItems,
        completed_items: completedItems,
      });
    } finally {
      await browser.close();
    }
  } finally {
    cancellation.stop();
  }
}

async function markFailed(client, job, error) {
  const { error: updateError } = await client
    .from('asset_analysis_jobs')
    .update({
      status: 'failed',
      lease_expires_at: null,
      error_summary:
        error instanceof Error ? error.message.slice(0, 500) : 'Asset analysis failed.',
    })
    .eq('id', job.id)
    .eq('worker_id', job.worker_id)
    .eq('status', 'running');
  if (updateError) throw updateError;
}

async function markCancelled(client, job, workerId) {
  await client
    .from('asset_analysis_jobs')
    .update({
      status: 'failed',
      lease_expires_at: null,
      progress_phase: 'cancelled',
      progress_detail: 'Asset analysis cancelled. Saved suggestions remain private and editable.',
      error_summary: 'Asset analysis cancelled by a workspace user.',
    })
    .eq('id', job.id)
    .eq('worker_id', workerId)
    .not('cancel_requested_at', 'is', null);
}

async function processNext(client, workerId, apiKey, model) {
  const { data, error } = await client.rpc('claim_next_asset_analysis', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The worker could not claim asset analysis.');
  const job = Array.isArray(data) ? data[0] : undefined;
  if (!job) return false;
  try {
    await processJob(client, job, workerId, apiKey, model);
    const { error: completeError } = await client
      .from('asset_analysis_jobs')
      .update({
        status: 'ready',
        model,
        lease_expires_at: null,
        progress_phase: 'complete',
        progress_detail: 'Asset analysis complete. Suggestions are ready for human review.',
        current_asset_id: null,
        error_summary: null,
      })
      .eq('id', job.id)
      .eq('worker_id', workerId);
    if (completeError) throw completeError;
    await client.from('activities').insert({
      organization_id: job.organization_id,
      business_id: job.business_id,
      type: 'note',
      message: 'Private visual-asset suggestions are ready for review.',
    });
    console.log(`[asset-analysis-worker] completed ${job.id}`);
  } catch (error) {
    if (error instanceof AssetAnalysisCancelledError) {
      await markCancelled(client, job, workerId);
      console.log(`[asset-analysis-worker] cancelled ${job.id}`);
      return true;
    }
    await markFailed(client, job, error);
    console.error(
      '[asset-analysis-worker] failed',
      job.id,
      error instanceof Error ? error.message : error,
    );
  }
  return true;
}

async function main() {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  const supabaseUrl = requiredEnvironment('SITEFORGE_SUPABASE_URL');
  const serviceRoleKey = requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY');
  const model = process.env.SITEFORGE_ASSET_VISION_MODEL?.trim() || 'gpt-5';
  const workerId = process.env.SITEFORGE_WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
  const client = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { fetch: createTimedFetch(requestTimeoutMs) },
  });
  const runOnce = process.argv.includes('--once');
  let keepRunning = true;
  while (keepRunning) {
    const claimed = await processNext(client, workerId, apiKey, model);
    if (runOnce) {
      if (!claimed) console.log('[asset-analysis-worker] no queued asset analyses.');
      keepRunning = false;
      continue;
    }
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
}

main().catch((error) => {
  console.error(
    '[asset-analysis-worker] stopped unexpectedly',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
