import { hostname } from 'node:os';
import { createClient } from '@supabase/supabase-js';
import { generateAuditFindings } from './audit-rules.mjs';

class AuditCancelledError extends Error {
  constructor() {
    super('Website audit cancelled by a workspace user.');
    this.name = 'AuditCancelledError';
  }
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the audit worker.`);
  return value;
}

function safeErrorSummary(error) {
  if (error instanceof Error && error.message.includes('capture')) return error.message;
  return 'The protected audit worker could not generate findings from this capture.';
}

async function downloadJson(client, artifact) {
  const { data, error } = await client.storage
    .from(artifact.storage_bucket)
    .download(artifact.storage_path);
  if (error || !data) return undefined;
  try {
    return JSON.parse(await data.text());
  } catch {
    return undefined;
  }
}

function sourceUrl(artifact) {
  return typeof artifact.metadata?.sourceUrl === 'string' ? artifact.metadata.sourceUrl : undefined;
}

async function assertAuditActive(client, audit, workerId) {
  const { data, error } = await client
    .from('audits')
    .select('status, worker_id, cancel_requested_at')
    .eq('id', audit.id)
    .maybeSingle();
  if (error) throw new Error('The audit worker could not confirm the audit state.');
  if (data?.cancel_requested_at) throw new AuditCancelledError();
  if (!data || data.status !== 'running' || data.worker_id !== workerId) {
    throw new Error('The audit worker lease was lost.');
  }
}

async function updateAuditProgress(client, audit, workerId, patch) {
  const { data, error } = await client
    .from('audits')
    .update(patch)
    .eq('id', audit.id)
    .eq('worker_id', workerId)
    .eq('status', 'running')
    .is('cancel_requested_at', null)
    .select('id');
  if (error) throw new Error('The audit worker could not save progress.');
  if (!data?.length) await assertAuditActive(client, audit, workerId);
  if (!data?.length) throw new Error('The audit worker lease was lost.');
}

async function auditInput(client, audit, workerId) {
  await updateAuditProgress(client, audit, workerId, {
    progress_phase: 'reading_evidence',
    progress_detail: 'Loading pages, facts, and private technical evidence.',
    total_items: 0,
    completed_items: 0,
  });
  const [pagesResult, factsResult, artifactsResult] = await Promise.all([
    client.from('crawl_pages').select('*').eq('crawl_run_id', audit.crawl_run_id),
    client.from('evidence_facts').select('id, source_url').eq('crawl_run_id', audit.crawl_run_id),
    client.from('artifacts').select('*').eq('crawl_run_id', audit.crawl_run_id),
  ]);
  if (pagesResult.error || factsResult.error || artifactsResult.error) {
    throw new Error('The audit worker could not load the saved capture evidence.');
  }
  const artifacts = artifactsResult.data ?? [];
  await assertAuditActive(client, audit, workerId);
  await updateAuditProgress(client, audit, workerId, {
    progress_phase: 'reading_evidence',
    progress_detail: 'Reading captured accessibility and performance reports.',
    total_items: artifacts.length,
    completed_items: 0,
  });
  const [accessibilityJson, performanceJson] = await Promise.all([
    Promise.all(
      artifacts
        .filter((artifact) => artifact.kind === 'accessibility')
        .map(async (artifact) => ({
          sourceUrl: sourceUrl(artifact),
          ...(await downloadJson(client, artifact)),
        })),
    ),
    Promise.all(
      artifacts
        .filter((artifact) => artifact.kind === 'performance')
        .map(async (artifact) => {
          const content = await downloadJson(client, artifact);
          return { sourceUrl: sourceUrl(artifact), navigation: content?.navigation };
        }),
    ),
  ]);

  return {
    pages: pagesResult.data ?? [],
    facts: factsResult.data ?? [],
    accessibilityReports: accessibilityJson.filter((report) => report.violations),
    performanceReports: performanceJson.filter((report) => report.navigation),
    screenshots: artifacts
      .filter((artifact) => artifact.kind === 'screenshot')
      .map((artifact) => ({ sourceUrl: sourceUrl(artifact), metadata: artifact.metadata ?? {} })),
  };
}

async function storeCompletedAudit(client, audit, workerId, findings) {
  await assertAuditActive(client, audit, workerId);
  const { error: deleteError } = await client
    .from('audit_findings')
    .delete()
    .eq('audit_id', audit.id);
  if (deleteError) throw new Error('The audit worker could not replace prior findings.');
  await updateAuditProgress(client, audit, workerId, {
    progress_phase: 'saving_findings',
    progress_detail: 'Saving evidence-led findings for human review.',
    total_items: findings.length,
    completed_items: 0,
  });
  let completedItems = 0;
  for (const entry of findings) {
    await assertAuditActive(client, audit, workerId);
    const { error: insertError } = await client.from('audit_findings').insert({
      organization_id: audit.organization_id,
      audit_id: audit.id,
      area: entry.area,
      severity: entry.severity,
      title: entry.title,
      finding: entry.finding,
      recommendation: entry.recommendation,
      evidence_fact_ids: entry.evidenceFactIds,
      source_urls: entry.sourceUrls,
      review_state: 'needs_review',
    });
    if (insertError) throw new Error('The audit worker could not save generated findings.');
    completedItems += 1;
    await updateAuditProgress(client, audit, workerId, {
      progress_phase: 'saving_findings',
      progress_detail: 'A finding was saved. Continuing the private audit.',
      total_items: findings.length,
      completed_items: completedItems,
    });
  }
  const { data: updatedAudit, error: auditError } = await client
    .from('audits')
    .update({
      status: 'ready',
      worker_id: null,
      lease_expires_at: null,
      progress_phase: 'complete',
      progress_detail: 'Automated audit complete. Findings are ready for human review.',
      error_summary: null,
    })
    .eq('id', audit.id)
    .eq('worker_id', workerId)
    .select('id');
  if (auditError || !updatedAudit?.length) throw new Error('The audit worker lease was lost.');
  await client
    .from('businesses')
    .update({ stage: 'audit_ready' })
    .eq('id', audit.business_id)
    .in('stage', ['identified', 'researching']);
  await client.from('activities').insert({
    organization_id: audit.organization_id,
    business_id: audit.business_id,
    type: 'note',
    message: `Automated audit completed. ${findings.length} evidence-led findings are ready for human review.`,
  });
}

async function markAuditFailed(client, audit, workerId, error) {
  await client
    .from('audits')
    .update({
      status: 'failed',
      worker_id: null,
      lease_expires_at: null,
      error_summary: safeErrorSummary(error),
    })
    .eq('id', audit.id)
    .eq('worker_id', workerId);
  await client.from('activities').insert({
    organization_id: audit.organization_id,
    business_id: audit.business_id,
    type: 'note',
    message: 'Automated audit failed. Check the saved capture and request another audit.',
  });
}

async function markAuditCancelled(client, audit, workerId) {
  await client
    .from('audits')
    .update({
      status: 'failed',
      worker_id: null,
      lease_expires_at: null,
      progress_phase: 'cancelled',
      progress_detail: 'Audit cancelled. Saved findings remain private and editable.',
      error_summary: 'Website audit cancelled by a workspace user.',
    })
    .eq('id', audit.id)
    .eq('worker_id', workerId)
    .not('cancel_requested_at', 'is', null);
}

async function processNextAudit(client, workerId) {
  const { data, error } = await client.rpc('claim_next_website_audit', {
    worker_identity: workerId,
  });
  if (error) throw new Error('The audit worker could not claim the next queued audit.');
  const audit = Array.isArray(data) ? data[0] : undefined;
  if (!audit) return false;
  try {
    const input = await auditInput(client, audit, workerId);
    await assertAuditActive(client, audit, workerId);
    await updateAuditProgress(client, audit, workerId, {
      progress_phase: 'generating_findings',
      progress_detail: 'Comparing the saved evidence against automated audit rules.',
      total_items: 0,
      completed_items: 0,
    });
    const findings = generateAuditFindings(input);
    await storeCompletedAudit(client, audit, workerId, findings);
    console.log(`[audit-worker] completed ${audit.id}: ${findings.length} findings`);
  } catch (error) {
    if (error instanceof AuditCancelledError) {
      await markAuditCancelled(client, audit, workerId);
      console.log(`[audit-worker] cancelled ${audit.id}`);
      return true;
    }
    await markAuditFailed(client, audit, workerId, error);
    console.error(`[audit-worker] failed ${audit.id}`);
  }
  return true;
}

async function main() {
  const supabaseUrl = requiredEnvironment('SITEFORGE_SUPABASE_URL');
  const serviceRoleKey = requiredEnvironment('SITEFORGE_SUPABASE_SERVICE_ROLE_KEY');
  const workerId = process.env.SITEFORGE_AUDIT_WORKER_ID?.trim() || `${hostname()}-${process.pid}`;
  const pollIntervalMs = Number.parseInt(process.env.SITEFORGE_AUDIT_POLL_MS ?? '5000', 10);
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
    const claimed = await processNextAudit(client, workerId);
    if (runOnce || stopping) {
      if (runOnce && !claimed) console.log('[audit-worker] no queued website audits.');
      break;
    }
    if (!claimed) await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  } while (!stopping);
}

main().catch((error) => {
  console.error(
    '[audit-worker] stopped unexpectedly',
    error instanceof Error ? error.message : error,
  );
  process.exitCode = 1;
});
