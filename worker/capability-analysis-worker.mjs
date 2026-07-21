import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';

const artifactBucket = 'siteforge-artifacts';
const timeoutMs = 120_000;
const supportedKinds = [
  'content_collection',
  'interactive_tool',
  'booking_workflow',
  'lead_form',
  'account_area',
  'commerce',
  'search_and_filter',
  'third_party_integration',
];
const supportedDeliveries = [
  'managed_content',
  'application',
  'workflow',
  'integration',
  'authenticated_application',
];

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the capability-analysis worker.`);
  return value;
}

function record(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function text(value, limit = 1800) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '';
}

function outputText(response) {
  if (typeof response.output_text === 'string') return response.output_text;
  for (const item of response.output ?? []) {
    const value = item?.content?.find((entry) => entry?.type === 'output_text')?.text;
    if (typeof value === 'string') return value;
  }
  throw new Error('The capability model did not return structured output.');
}

async function downloadJson(client, artifact) {
  const { data, error } = await client.storage
    .from(artifact.storage_bucket || artifactBucket)
    .download(artifact.storage_path);
  if (error || !data) return undefined;
  try {
    return JSON.parse(await data.text());
  } catch {
    return undefined;
  }
}

async function dossier(client, job) {
  const [packetResult, pagesResult, artifactsResult] = await Promise.all([
    client.from('research_packets').select('*').eq('crawl_run_id', job.crawl_run_id).single(),
    client
      .from('crawl_pages')
      .select('*')
      .eq('crawl_run_id', job.crawl_run_id)
      .eq('capture_status', 'ready'),
    client
      .from('artifacts')
      .select('storage_bucket, storage_path, metadata')
      .eq('crawl_run_id', job.crawl_run_id)
      .eq('kind', 'content'),
  ]);
  if (packetResult.error || pagesResult.error || artifactsResult.error || !packetResult.data) {
    throw new Error('The worker could not load the completed capture dossier.');
  }
  const contentByUrl = new Map();
  for (const artifact of artifactsResult.data ?? []) {
    const metadata = record(artifact.metadata);
    const sourceUrl = text(metadata.sourceUrl, 600);
    if (!sourceUrl) continue;
    const content = await downloadJson(client, artifact);
    if (!content) continue;
    contentByUrl.set(sourceUrl, {
      headings: Array.isArray(content.headings) ? content.headings.slice(0, 30) : [],
      navigation: Array.isArray(content.navigation) ? content.navigation.slice(0, 40) : [],
      callsToAction: Array.isArray(content.callsToAction) ? content.callsToAction.slice(0, 40) : [],
      forms: Array.isArray(content.forms) ? content.forms.slice(0, 12) : [],
      componentInventory: record(content.componentInventory),
      text: text(content.text, 2200),
    });
  }
  const pages = (pagesResult.data ?? []).slice(0, 80).map((page) => ({
    url: page.url,
    title: page.title,
    pageType: page.page_type,
    metadata: record(page.metadata),
    content: contentByUrl.get(page.url) ?? {},
  }));
  return { packet: packetResult.data, pages };
}

function schema() {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['capabilities'],
    properties: {
      capabilities: {
        type: 'array',
        maxItems: 30,
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'kind',
            'title',
            'description',
            'delivery',
            'confidence',
            'evidence',
            'decisionQuestion',
          ],
          properties: {
            kind: { type: 'string', enum: supportedKinds },
            title: { type: 'string' },
            description: { type: 'string' },
            delivery: { type: 'string', enum: supportedDeliveries },
            confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
            decisionQuestion: { type: 'string' },
            evidence: {
              type: 'array',
              minItems: 1,
              maxItems: 8,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['sourceUrl', 'detail'],
                properties: { sourceUrl: { type: 'string' }, detail: { type: 'string' } },
              },
            },
          },
        },
      },
    },
  };
}

async function interpret(apiKey, model, input) {
  const allowedUrls = new Set(input.pages.map((page) => page.url));
  const prompt = [
    'Identify user-facing website capabilities from this private captured dossier.',
    'Use only observable evidence. Do not infer hidden backends, subscriptions, ownership, access roles, payments, or integrations.',
    'A capability is a meaningful feature or repeatable workflow, not a normal static page. Return no capability when evidence is insufficient.',
    'For each item, cite only an exact sourceUrl present in the dossier, explain the evidence, and ask the human decision needed to scope a replacement.',
    'Set no approval state; SiteForge will mark every result needs_review.',
    JSON.stringify(input),
  ].join('\n');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
    body: JSON.stringify({
      model,
      store: false,
      input: [{ role: 'user', content: [{ type: 'input_text', text: prompt }] }],
      text: {
        format: {
          type: 'json_schema',
          name: 'capability_inventory',
          strict: true,
          schema: schema(),
        },
      },
    }),
  });
  if (!response.ok) throw new Error(`The capability model returned ${response.status}.`);
  const parsed = JSON.parse(outputText(await response.json()));
  return parsed.capabilities
    .filter((item) => item.evidence.every((entry) => allowedUrls.has(entry.sourceUrl)))
    .map((item, index) => ({ ...item, id: `${item.kind}:${index + 1}`, decision: 'needs_review' }));
}

async function processJob(client, job, workerId, apiKey, model) {
  const { packet, pages } = await dossier(client, job);
  await client
    .from('capability_analysis_jobs')
    .update({
      progress_phase: 'interpreting_scope',
      progress_detail: 'AI is interpreting captured pages, forms, controls, and integrations.',
      model,
    })
    .eq('id', job.id)
    .eq('worker_id', workerId);
  const capabilities = await interpret(apiKey, model, { pages });
  const data = record(packet.data);
  const { error: packetError } = await client
    .from('research_packets')
    .update({
      schema_version: Math.max(Number(packet.schema_version) || 1, 3),
      data: {
        ...data,
        capabilityInventory: capabilities,
        capabilityAnalysis: { status: 'ready', model, generatedAt: new Date().toISOString() },
      },
      generated_at: new Date().toISOString(),
    })
    .eq('id', packet.id);
  if (packetError) throw new Error('The worker could not save the AI capability inventory.');
  const { error } = await client
    .from('capability_analysis_jobs')
    .update({
      status: 'ready',
      worker_id: null,
      lease_expires_at: null,
      progress_phase: 'complete',
      progress_detail: `${capabilities.length} AI capability candidates are ready for human review.`,
      error_summary: null,
    })
    .eq('id', job.id)
    .eq('worker_id', workerId);
  if (error) throw error;
  await client.from('activities').insert({
    organization_id: job.organization_id,
    business_id: job.business_id,
    type: 'note',
    message: `AI capability analysis completed. ${capabilities.length} scope candidates require human review.`,
  });
}

async function main() {
  const apiKey = requiredEnvironment('OPENAI_API_KEY');
  const client = createClient(
    requiredEnvironment('SITEFORGE_SUPABASE_URL'),
    requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY'),
    { auth: { autoRefreshToken: false, persistSession: false } },
  );
  const model = process.env.SITEFORGE_CAPABILITY_MODEL?.trim() || 'gpt-5';
  const workerId = `${hostname()}-${process.pid}`;
  while (true) {
    const { data, error } = await client.rpc('claim_next_capability_analysis', {
      worker_identity: workerId,
    });
    if (error) throw error;
    const job = Array.isArray(data) ? data[0] : undefined;
    if (!job) {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      continue;
    }
    try {
      await processJob(client, job, workerId, apiKey, model);
      console.log(`[capability-analysis-worker] completed ${job.id}`);
    } catch (error) {
      await client
        .from('capability_analysis_jobs')
        .update({
          status: 'failed',
          worker_id: null,
          lease_expires_at: null,
          error_summary:
            error instanceof Error ? error.message.slice(0, 500) : 'Capability analysis failed.',
        })
        .eq('id', job.id)
        .eq('worker_id', workerId);
      console.error(
        '[capability-analysis-worker] failed',
        job.id,
        error instanceof Error ? error.message : error,
      );
    }
  }
}

main().catch((error) => {
  console.error(
    '[capability-analysis-worker] stopped unexpectedly',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
