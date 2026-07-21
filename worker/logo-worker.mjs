/* global HTMLImageElement, document */

import { createHash } from 'node:crypto';
import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';
import { assertPublicUrl } from './security.mjs';

const bucket = 'siteforge-artifacts';
const userAgent = 'SiteForgeLogoBot/0.1 (+https://siteforge.local/research)';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the logo worker.`);
  return value;
}

function contentHash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extensionFor(contentType) {
  return {
    'image/svg+xml': 'svg',
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/avif': 'avif',
  }[contentType];
}

async function retrieveHeaderLogo(targetUrl) {
  const dnsCache = new Map();
  await assertPublicUrl(targetUrl, dnsCache);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ userAgent, viewport: { width: 1440, height: 900 } });
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    const sourceUrl = await page.evaluate(() => {
      const image = document.querySelector('header img, [role="banner"] img, nav img');
      return image instanceof HTMLImageElement ? image.currentSrc || image.src : '';
    });
    if (!sourceUrl) throw new Error('No image logo was found in the website header or navigation.');
    await assertPublicUrl(sourceUrl, dnsCache);
    const response = await fetch(sourceUrl, {
      headers: {
        'user-agent': userAgent,
        accept: 'image/avif,image/webp,image/png,image/jpeg,image/svg+xml,*/*;q=0.5',
      },
      signal: AbortSignal.timeout(10_000),
    });
    const contentType = response.headers.get('content-type')?.split(';')[0].toLowerCase() ?? '';
    const extension = extensionFor(contentType);
    if (!response.ok || !extension)
      throw new Error('The header logo could not be downloaded as a supported image.');
    const content = Buffer.from(await response.arrayBuffer());
    if (!content.length || content.length > 8 * 1024 * 1024)
      throw new Error('The header logo file is not usable.');
    return { sourceUrl: response.url || sourceUrl, contentType, extension, content };
  } finally {
    await browser.close();
  }
}

async function processJob(client, workerId) {
  const { data, error } = await client.rpc('claim_next_logo_retrieval', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The logo worker could not claim the next job.');
  const job = Array.isArray(data) ? data[0] : undefined;
  if (!job) return false;
  try {
    const logo = await retrieveHeaderLogo(job.target_url);
    const key = contentHash(logo.sourceUrl).slice(0, 12);
    const storagePath = `${job.organization_id}/${job.business_id}/logos/header-${key}.${logo.extension}`;
    const { error: uploadError } = await client.storage
      .from(bucket)
      .upload(storagePath, logo.content, { contentType: logo.contentType, upsert: true });
    if (uploadError) throw new Error('The logo worker could not store the private logo.');
    const { error: artifactError } = await client.from('artifacts').upsert(
      {
        organization_id: job.organization_id,
        business_id: job.business_id,
        kind: 'asset',
        storage_bucket: bucket,
        storage_path: storagePath,
        content_type: logo.contentType,
        byte_size: logo.content.length,
        sha256: contentHash(logo.content),
        metadata: {
          sourceUrl: logo.sourceUrl,
          pageUrl: job.target_url,
          assetType: 'logo',
          preferredOrganisationLogo: true,
          source: 'header_navigation',
        },
      },
      { onConflict: 'storage_path' },
    );
    if (artifactError) throw new Error('The logo worker could not save the logo record.');
    await client
      .from('logo_retrieval_jobs')
      .update({ status: 'ready', completed_at: new Date().toISOString(), lease_expires_at: null })
      .eq('id', job.id)
      .eq('worker_id', workerId);
  } catch (error) {
    await client
      .from('logo_retrieval_jobs')
      .update({
        status: 'failed',
        completed_at: new Date().toISOString(),
        lease_expires_at: null,
        error_summary:
          error instanceof Error ? error.message.slice(0, 500) : 'Logo retrieval failed.',
      })
      .eq('id', job.id)
      .eq('worker_id', workerId);
  }
  return true;
}

async function main() {
  const client = createClient(
    requiredEnvironment('SITEFORGE_SUPABASE_URL'),
    requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const workerId =
    process.env.SITEFORGE_LOGO_WORKER_ID?.trim() || `${hostname()}-logos-${process.pid}`;
  const once = process.argv.includes('--once');
  do {
    if (!(await processJob(client, workerId)) && !once)
      await new Promise((resolve) => setTimeout(resolve, 5_000));
  } while (!once);
}

main().catch((error) => {
  console.error('[logo-worker] stopped unexpectedly', error);
  process.exitCode = 1;
});
