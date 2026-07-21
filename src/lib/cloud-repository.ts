import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Activity,
  AssetAnalysisJob,
  AssetAnnotation,
  BrandColourEvidence,
  BrandKit,
  Audit,
  AuditFinding,
  BuildManifest,
  BuilderArtifact,
  BuilderEvent,
  BuilderPreviewMode,
  BuilderRun,
  CapturedPage,
  Business,
  Contact,
  DecisionReport,
  EvidenceFact,
  ProspectWorkspace,
  ResearchArtifact,
  ResearchCapture,
  ResearchPacket,
  RedesignBrief,
  RedesignConcept,
  Task,
  Website,
} from './domain';
import {
  buildManifestSchemaVersion,
  codexBuilderContractVersion,
  createBuildManifestData,
  manifestSourceMatchesBrief,
} from './build-manifest';
import { canonicalWebsiteUrl, type WorkspaceRepository } from './repository';
import { assetGuidanceFromAnnotations, createBriefDraft } from './redesign-brief';

type DatabaseRow = Record<string, unknown>;

function readString(row: DatabaseRow, key: string) {
  const value = row[key];
  return typeof value === 'string' ? value : '';
}

function readOptionalString(row: DatabaseRow, key: string) {
  const value = row[key];
  return typeof value === 'string' ? value : undefined;
}

function auditStatus(value: string): Audit['status'] {
  if (value === 'queued') return 'research_pending';
  if (value === 'running' || value === 'ready' || value === 'failed') return value;
  return 'not_started';
}

function crawlStatus(value: string): Website['crawlStatus'] {
  if (value === 'queued' || value === 'running') return 'queued';
  if (value === 'ready') return 'captured';
  if (value === 'failed') return 'failed';
  return 'not_requested';
}

function businessFromRow(row: DatabaseRow): Business {
  return {
    id: readString(row, 'id'),
    kind: readString(row, 'kind') as Business['kind'],
    name: readString(row, 'name'),
    stage: readString(row, 'stage') as Business['stage'],
    reviewState: readString(row, 'review_state') as Business['reviewState'],
    opportunityScore: typeof row.opportunity_score === 'number' ? row.opportunity_score : undefined,
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function websiteFromRow(row: DatabaseRow): Website {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    url: readString(row, 'url'),
    domain: readString(row, 'domain'),
    crawlStatus: crawlStatus(readString(row, 'crawl_status')),
    lastCapturedAt: readOptionalString(row, 'last_captured_at'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function contactFromRow(row: DatabaseRow): Contact {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    name: readOptionalString(row, 'name'),
    role: readOptionalString(row, 'role'),
    email: readOptionalString(row, 'email'),
    phone: readOptionalString(row, 'phone'),
    verificationState: readString(row, 'verification_state') as Contact['verificationState'],
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function factFromRow(row: DatabaseRow): EvidenceFact {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readOptionalString(row, 'crawl_run_id'),
    label: readString(row, 'label'),
    value: readString(row, 'value'),
    sourceUrl: readOptionalString(row, 'source_url'),
    evidence: readString(row, 'evidence'),
    confidence: readString(row, 'confidence') as EvidenceFact['confidence'],
    verificationState: readString(row, 'verification_state') as EvidenceFact['verificationState'],
    capturedAt: readString(row, 'captured_at'),
  };
}

function readNumber(row: DatabaseRow, key: string) {
  return typeof row[key] === 'number' ? row[key] : 0;
}

function captureFromRow(row: DatabaseRow, businessId: string, website?: Website): ResearchCapture {
  const status = readString(row, 'status');
  const cancelRequestedAt = readOptionalString(row, 'cancel_requested_at');
  return {
    id: readString(row, 'id'),
    businessId,
    websiteId: readString(row, 'website_id'),
    targetUrl: readOptionalString(row, 'target_url') ?? website?.url ?? '',
    scope:
      readString(row, 'capture_scope') === 'all_pages'
        ? 'all_pages'
        : readString(row, 'capture_scope') === 'key_pages'
          ? 'key_pages'
          : 'homepage',
    status:
      cancelRequestedAt && status === 'failed'
        ? 'cancelled'
        : status === 'running' || status === 'ready' || status === 'failed'
          ? status
          : 'queued',
    requestedAt: readString(row, 'requested_at'),
    startedAt: readOptionalString(row, 'started_at'),
    completedAt: readOptionalString(row, 'completed_at'),
    discoveredPageCount: readNumber(row, 'discovered_page_count'),
    capturedPageCount: readNumber(row, 'captured_page_count'),
    failedPageCount: readNumber(row, 'failed_page_count'),
    errorSummary: readOptionalString(row, 'error_summary'),
    progressPhase: readOptionalString(row, 'progress_phase'),
    progressDetail: readOptionalString(row, 'progress_detail'),
    currentUrl: readOptionalString(row, 'current_url'),
    cancelRequestedAt,
    failurePhase: readOptionalString(row, 'failure_phase'),
    failureUrl: readOptionalString(row, 'failure_url'),
    failureDetail: readOptionalString(row, 'failure_detail'),
  };
}

function pageFromRow(row: DatabaseRow, businessId: string): CapturedPage {
  const status = readString(row, 'capture_status');
  return {
    id: readString(row, 'id'),
    businessId,
    crawlRunId: readString(row, 'crawl_run_id'),
    url: readString(row, 'url'),
    canonicalUrl: readOptionalString(row, 'canonical_url'),
    title: readOptionalString(row, 'title'),
    statusCode: typeof row.status_code === 'number' ? row.status_code : undefined,
    captureStatus:
      status === 'queued' || status === 'running' || status === 'ready' || status === 'failed'
        ? status
        : 'not_requested',
    pageType: readOptionalString(row, 'page_type'),
    metadata:
      typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
        ? (row.metadata as Record<string, unknown>)
        : {},
  };
}

function artifactFromRow(row: DatabaseRow): ResearchArtifact {
  const metadata =
    typeof row.metadata === 'object' && row.metadata !== null && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)
      : {};
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readOptionalString(row, 'crawl_run_id'),
    kind: readString(row, 'kind') as ResearchArtifact['kind'],
    label: readOptionalString(row, 'label'),
    storageBucket: readOptionalString(row, 'storage_bucket') ?? 'siteforge-artifacts',
    storagePath: readString(row, 'storage_path'),
    contentType: readOptionalString(row, 'content_type'),
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : undefined,
    metadata,
    createdAt: readString(row, 'created_at'),
  };
}

function researchPacketFromRow(row: DatabaseRow): ResearchPacket {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    schemaVersion: readNumber(row, 'schema_version') || 1,
    data:
      typeof row.data === 'object' && row.data !== null && !Array.isArray(row.data)
        ? (row.data as Record<string, unknown>)
        : {},
    generatedAt: readString(row, 'generated_at'),
  };
}

function assetAnalysisFromRow(row: DatabaseRow): AssetAnalysisJob {
  const status = readString(row, 'status');
  const cancelRequestedAt = readOptionalString(row, 'cancel_requested_at');
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    status:
      cancelRequestedAt && status === 'failed'
        ? 'cancelled'
        : status === 'queued' || status === 'running' || status === 'ready' || status === 'failed'
          ? status
          : 'not_started',
    model: readOptionalString(row, 'model'),
    errorSummary: readOptionalString(row, 'error_summary'),
    progressPhase: readOptionalString(row, 'progress_phase'),
    progressDetail: readOptionalString(row, 'progress_detail'),
    totalItems: readNumber(row, 'total_items'),
    completedItems: readNumber(row, 'completed_items'),
    cancelRequestedAt,
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function assetAnnotationFromRow(row: DatabaseRow): AssetAnnotation {
  return {
    id: readString(row, 'id'),
    assetId: readString(row, 'asset_id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    analysisJobId: readOptionalString(row, 'analysis_job_id'),
    sourceContext: recordValue(row.source_context),
    observedDescription: readString(row, 'observed_description'),
    visibleText: Array.isArray(row.visible_text)
      ? row.visible_text.filter((value): value is string => typeof value === 'string')
      : [],
    suggestedRole: readString(row, 'suggested_role') as AssetAnnotation['suggestedRole'],
    businessAssociation: readString(
      row,
      'business_association',
    ) as AssetAnnotation['businessAssociation'],
    safeReuseNote: readString(row, 'safe_reuse_note'),
    cautions: Array.isArray(row.cautions)
      ? row.cautions.filter((value): value is string => typeof value === 'string')
      : [],
    confidence: readString(row, 'confidence') as AssetAnnotation['confidence'],
    reviewState: readString(row, 'review_state') as AssetAnnotation['reviewState'],
    humanNotes: readString(row, 'human_notes'),
    model: readOptionalString(row, 'model'),
    analyzedAt: readOptionalString(row, 'analyzed_at'),
    reviewedAt: readOptionalString(row, 'reviewed_at'),
  };
}

function brandPaletteFrom(value: unknown): BrandKit['palette'] {
  const palette = recordValue(value);
  return Object.fromEntries(
    ['primary', 'accent']
      .filter((key) => typeof palette[key] === 'string')
      .map((key) => [key, palette[key] as string]),
  );
}

function brandColourEvidenceFromRow(row: DatabaseRow): BrandColourEvidence {
  return {
    id: readString(row, 'id'),
    assetId: readOptionalString(row, 'asset_id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    sourceType: readString(row, 'source_type') as BrandColourEvidence['sourceType'],
    sourceLabel: readString(row, 'source_label'),
    sourceUrl: readOptionalString(row, 'source_url'),
    colour: readString(row, 'colour'),
    occurrenceCount: readNumber(row, 'occurrence_count') || 1,
    confidence: readString(row, 'confidence') as BrandColourEvidence['confidence'],
    details: recordValue(row.details),
    createdAt: readString(row, 'created_at'),
  };
}

function brandKitFromRow(row: DatabaseRow): BrandKit {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    version: readNumber(row, 'version'),
    status: readString(row, 'status') as BrandKit['status'],
    primaryLogoAssetId: readOptionalString(row, 'primary_logo_artifact_id'),
    approvedAssetIds: Array.isArray(row.approved_asset_ids)
      ? row.approved_asset_ids.filter((value): value is string => typeof value === 'string')
      : [],
    palette: brandPaletteFrom(row.palette),
    notes: readString(row, 'notes'),
    approvedAt: readOptionalString(row, 'approved_at'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function recordValue(value: unknown) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function briefFromRow(row: DatabaseRow): RedesignBrief {
  const sourceSelections = recordValue(row.source_selections);
  const draft = recordValue(row.draft);
  const brandKit = recordValue(draft.brandKit);
  const primaryLogoAssetId = readOptionalString(brandKit, 'primaryLogoAssetId');
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    researchPacketId: readString(row, 'research_packet_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    status: readString(row, 'status') as RedesignBrief['status'],
    version: readNumber(row, 'version') || 1,
    sourceSelections: {
      pageUrls: Array.isArray(sourceSelections.pageUrls)
        ? sourceSelections.pageUrls.filter((value): value is string => typeof value === 'string')
        : [],
      assetIds: Array.isArray(sourceSelections.assetIds)
        ? sourceSelections.assetIds.filter((value): value is string => typeof value === 'string')
        : [],
      autoSelectedAssetIds: Array.isArray(sourceSelections.autoSelectedAssetIds)
        ? sourceSelections.autoSelectedAssetIds.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
      uncertainties: Array.isArray(sourceSelections.uncertainties)
        ? sourceSelections.uncertainties.filter(
            (value): value is string => typeof value === 'string',
          )
        : [],
    },
    draft: {
      strategy: readOptionalString(draft, 'strategy') ?? '',
      proposedSitemap: Array.isArray(draft.proposedSitemap) ? draft.proposedSitemap : [],
      pagePlans: Array.isArray(draft.pagePlans) ? draft.pagePlans : [],
      assetGuidance: Array.isArray(draft.assetGuidance) ? draft.assetGuidance : [],
      brandKit:
        readOptionalString(brandKit, 'id') && primaryLogoAssetId
          ? {
              id: readString(brandKit, 'id'),
              version: readNumber(brandKit, 'version'),
              primaryLogoAssetId,
              approvedAssetIds: Array.isArray(brandKit.approvedAssetIds)
                ? brandKit.approvedAssetIds.filter(
                    (value): value is string => typeof value === 'string',
                  )
                : [],
              palette: brandPaletteFrom(brandKit.palette),
            }
          : undefined,
      assumptions: Array.isArray(draft.assumptions) ? draft.assumptions : [],
      openQuestions: Array.isArray(draft.openQuestions) ? draft.openQuestions : [],
      ...(Array.isArray(draft.capabilityInventory)
        ? { capabilityInventory: draft.capabilityInventory }
        : {}),
    } as RedesignBrief['draft'],
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
    approvedAt: readOptionalString(row, 'approved_at'),
  };
}

function buildManifestFromRow(row: DatabaseRow): BuildManifest {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    redesignBriefId: readString(row, 'redesign_brief_id'),
    researchPacketId: readString(row, 'research_packet_id'),
    crawlRunId: readString(row, 'crawl_run_id'),
    schemaVersion: readNumber(row, 'schema_version') || 1,
    builderContractVersion: readString(row, 'builder_contract_version'),
    status: 'ready',
    data: recordValue(row.data) as BuildManifest['data'],
    generatedAt: readString(row, 'generated_at'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function builderQualitySummary(value: unknown): BuilderRun['qualitySummary'] {
  const summary = recordValue(value);
  const checks = Array.isArray(summary.checks)
    ? summary.checks
        .filter(
          (check): check is Record<string, unknown> => Boolean(check) && typeof check === 'object',
        )
        .map((check) => ({
          id: typeof check.id === 'string' ? check.id : 'check',
          label: typeof check.label === 'string' ? check.label : 'Quality check',
          status:
            check.status === 'passed' ||
            check.status === 'needs_review' ||
            check.status === 'failed'
              ? check.status
              : ('not_run' as BuilderRun['qualitySummary']['checks'][number]['status']),
          detail: typeof check.detail === 'string' ? check.detail : '',
          metadata: recordValue(check.metadata),
        }))
    : [];
  return {
    status:
      summary.status === 'passed' ||
      summary.status === 'needs_review' ||
      summary.status === 'failed'
        ? summary.status
        : 'not_run',
    checks,
    generatedAt: typeof summary.generatedAt === 'string' ? summary.generatedAt : undefined,
  };
}

function builderRunFromRow(row: DatabaseRow): BuilderRun {
  const status = readString(row, 'status');
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    buildManifestId: readString(row, 'build_manifest_id'),
    status:
      status === 'queued' ||
      status === 'running' ||
      status === 'paused' ||
      status === 'ready' ||
      status === 'review_required' ||
      status === 'failed' ||
      status === 'cancelled'
        ? status
        : 'queued',
    templateVersion: readString(row, 'template_version'),
    model: readOptionalString(row, 'model'),
    progressPhase: readString(row, 'progress_phase') || 'queued',
    progressDetail: readOptionalString(row, 'progress_detail'),
    totalItems: readNumber(row, 'total_items'),
    completedItems: readNumber(row, 'completed_items'),
    cancelRequestedAt: readOptionalString(row, 'cancel_requested_at'),
    errorSummary: readOptionalString(row, 'error_summary'),
    failureCode: readOptionalString(row, 'failure_code'),
    failureStage: readOptionalString(row, 'failure_stage'),
    failureAction: readOptionalString(row, 'failure_action'),
    failureContext: recordValue(row.failure_context),
    retryAfter: readOptionalString(row, 'retry_after'),
    qualitySummary: builderQualitySummary(row.quality_summary),
    startedAt: readOptionalString(row, 'started_at'),
    completedAt: readOptionalString(row, 'completed_at'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function builderArtifactFromRow(row: DatabaseRow): BuilderArtifact {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    builderRunId: readString(row, 'builder_run_id'),
    kind: readString(row, 'kind') as BuilderArtifact['kind'],
    label: readString(row, 'label'),
    storageBucket: readOptionalString(row, 'storage_bucket') ?? 'siteforge-artifacts',
    storagePath: readString(row, 'storage_path'),
    contentType: readOptionalString(row, 'content_type'),
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : undefined,
    metadata: recordValue(row.metadata),
    createdAt: readString(row, 'created_at'),
  };
}

function builderEventFromRow(row: DatabaseRow): BuilderEvent {
  const kind = readString(row, 'kind');
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    builderRunId: readString(row, 'builder_run_id'),
    sequence: readNumber(row, 'sequence'),
    kind:
      kind === 'stage' ||
      kind === 'activity' ||
      kind === 'file' ||
      kind === 'quality' ||
      kind === 'diagnostic' ||
      kind === 'error'
        ? kind
        : 'activity',
    message: readString(row, 'message'),
    metadata: recordValue(row.metadata),
    createdAt: readString(row, 'created_at'),
  };
}

function auditFromRow(row: DatabaseRow, findings: AuditFinding[]): Audit {
  const cancelRequestedAt = readOptionalString(row, 'cancel_requested_at');
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    crawlRunId: readOptionalString(row, 'crawl_run_id'),
    status:
      cancelRequestedAt && readString(row, 'status') === 'failed'
        ? 'cancelled'
        : auditStatus(readString(row, 'status')),
    findings,
    progressPhase: readOptionalString(row, 'progress_phase'),
    progressDetail: readOptionalString(row, 'progress_detail'),
    totalItems: readNumber(row, 'total_items'),
    completedItems: readNumber(row, 'completed_items'),
    cancelRequestedAt,
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function findingFromRow(row: DatabaseRow): AuditFinding {
  const evidenceIds = Array.isArray(row.evidence_fact_ids)
    ? row.evidence_fact_ids.filter((value): value is string => typeof value === 'string')
    : [];
  return {
    id: readString(row, 'id'),
    area: readString(row, 'area') as AuditFinding['area'],
    severity: readString(row, 'severity') as AuditFinding['severity'],
    title: readString(row, 'title'),
    finding: readString(row, 'finding'),
    recommendation: readString(row, 'recommendation'),
    evidenceIds,
    sourceUrls: Array.isArray(row.source_urls)
      ? row.source_urls.filter((value): value is string => typeof value === 'string')
      : [],
    reviewState: readString(row, 'review_state') as AuditFinding['reviewState'],
  };
}

function conceptFromRow(row: DatabaseRow): RedesignConcept {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    status: readString(row, 'status') as RedesignConcept['status'],
    version: typeof row.version === 'number' ? row.version : 1,
    summary: readString(row, 'summary'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function reportFromRow(row: DatabaseRow): DecisionReport {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    status: readString(row, 'status') as DecisionReport['status'],
    version: typeof row.version === 'number' ? row.version : 1,
    summary: readString(row, 'summary'),
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function taskFromRow(row: DatabaseRow): Task {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    body: readString(row, 'body'),
    dueAt: readOptionalString(row, 'due_at'),
    state: readString(row, 'state') as Task['state'],
    createdAt: readString(row, 'created_at'),
    updatedAt: readString(row, 'updated_at'),
  };
}

function activityFromRow(row: DatabaseRow): Activity {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    type: readString(row, 'type') as Activity['type'],
    message: readString(row, 'message'),
    createdAt: readString(row, 'created_at'),
  };
}

function domainFromUrl(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProtocol).hostname.replace(/^www\./, '');
}

function displayName(domain: string) {
  return domain
    .split('.')[0]
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function throwIfError(error: { message: string } | null) {
  if (error) throw new Error(error.message);
}

function isDuplicateWebsiteError(error: { code?: string } | null) {
  return error?.code === '23505';
}

export class SupabaseWorkspaceRepository implements WorkspaceRepository {
  constructor(
    private readonly client: SupabaseClient,
    private readonly organizationId: string,
  ) {}

  async bootstrap() {
    // Authentication and organization membership are established before this adapter is created.
  }

  async listBusinesses() {
    const { data, error } = await this.client
      .from('businesses')
      .select('*')
      .eq('organization_id', this.organizationId)
      .order('updated_at', { ascending: false });
    throwIfError(error);
    return ((data ?? []) as DatabaseRow[]).map(businessFromRow);
  }

  async getWorkspace(businessId: string): Promise<ProspectWorkspace | undefined> {
    const { data: businessRow, error: businessError } = await this.client
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .eq('organization_id', this.organizationId)
      .maybeSingle();
    throwIfError(businessError);
    if (!businessRow) return undefined;

    const [
      websites,
      contacts,
      facts,
      audits,
      assetJobs,
      briefs,
      manifests,
      builderRuns,
      concepts,
      reports,
      tasks,
      activity,
    ] = await Promise.all([
      this.client.from('websites').select('*').eq('business_id', businessId).limit(1),
      this.client.from('contacts').select('*').eq('business_id', businessId),
      this.client.from('evidence_facts').select('*').eq('business_id', businessId),
      this.client
        .from('audits')
        .select('*')
        .eq('business_id', businessId)
        .order('version', { ascending: false })
        .limit(1),
      this.client
        .from('asset_analysis_jobs')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(1),
      this.client
        .from('redesign_briefs')
        .select('*')
        .eq('business_id', businessId)
        .order('version', { ascending: false })
        .limit(1),
      this.client
        .from('build_manifests')
        .select('*')
        .eq('business_id', businessId)
        .order('generated_at', { ascending: false })
        .limit(1),
      this.client
        .from('builder_runs')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false })
        .limit(1),
      this.client
        .from('redesign_concepts')
        .select('*')
        .eq('business_id', businessId)
        .order('version', { ascending: false })
        .limit(1),
      this.client
        .from('decision_reports')
        .select('*')
        .eq('business_id', businessId)
        .order('version', { ascending: false })
        .limit(1),
      this.client
        .from('tasks')
        .select('*')
        .eq('business_id', businessId)
        .order('state')
        .order('created_at'),
      this.client
        .from('activities')
        .select('*')
        .eq('business_id', businessId)
        .order('created_at', { ascending: false }),
    ]);
    [
      websites,
      contacts,
      facts,
      audits,
      assetJobs,
      briefs,
      manifests,
      builderRuns,
      concepts,
      reports,
      tasks,
      activity,
    ].forEach((result) => throwIfError(result.error));

    const website = (websites.data ?? [])[0]
      ? websiteFromRow((websites.data ?? [])[0] as DatabaseRow)
      : undefined;
    const captureResult = website
      ? await this.client
          .from('crawl_runs')
          .select('*')
          .eq('website_id', website.id)
          .order('requested_at', { ascending: false })
      : { data: [], error: null };
    throwIfError(captureResult.error);
    const orderedCaptures = ((captureResult.data ?? []) as DatabaseRow[]).map((row) =>
      captureFromRow(row, businessId, website),
    );
    const latestCapture = orderedCaptures[0];
    const previousCapture =
      latestCapture?.status === 'failed' || latestCapture?.status === 'cancelled'
        ? orderedCaptures.find(
            (capture) => capture.id !== latestCapture.id && capture.status === 'ready',
          )
        : undefined;
    const relevantCaptureIds = [latestCapture?.id, previousCapture?.id].filter((id): id is string =>
      Boolean(id),
    );
    const [
      pagesResult,
      artifactsResult,
      packetsResult,
      annotationsResult,
      brandColourEvidenceResult,
      brandKitsResult,
    ] = relevantCaptureIds.length
      ? await Promise.all([
          this.client
            .from('crawl_pages')
            .select('*')
            .in('crawl_run_id', relevantCaptureIds)
            .order('created_at'),
          this.client
            .from('artifacts')
            .select('*')
            .in('crawl_run_id', relevantCaptureIds)
            .order('created_at'),
          this.client
            .from('research_packets')
            .select('*')
            .in('crawl_run_id', relevantCaptureIds)
            .order('generated_at', { ascending: false }),
          this.client
            .from('asset_annotations')
            .select('*')
            .in('crawl_run_id', relevantCaptureIds)
            .order('created_at'),
          this.client
            .from('brand_colour_evidence')
            .select('*')
            .in('crawl_run_id', relevantCaptureIds)
            .order('created_at'),
          this.client
            .from('brand_kits')
            .select('*')
            .eq('business_id', businessId)
            .order('version', { ascending: false })
            .limit(1),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
          { data: [], error: null },
        ];
    throwIfError(pagesResult.error);
    throwIfError(artifactsResult.error);
    throwIfError(packetsResult.error);
    throwIfError(annotationsResult.error);
    throwIfError(brandColourEvidenceResult.error);
    throwIfError(brandKitsResult.error);
    const logoArtifactsResult = await this.client
      .from('artifacts')
      .select('*')
      .eq('business_id', businessId)
      .eq('kind', 'asset')
      .contains('metadata', { preferredOrganisationLogo: true })
      .order('created_at', { ascending: false });
    throwIfError(logoArtifactsResult.error);

    const latestAudit = (audits.data ?? [])[0] as DatabaseRow | undefined;
    const latestBuilderRun = (builderRuns.data ?? [])[0] as DatabaseRow | undefined;
    const findingResult = latestAudit
      ? await this.client
          .from('audit_findings')
          .select('*')
          .eq('audit_id', readString(latestAudit, 'id'))
      : { data: [], error: null };
    throwIfError(findingResult.error);
    const builderArtifactsResult = latestBuilderRun
      ? await this.client
          .from('builder_artifacts')
          .select('*')
          .eq('builder_run_id', readString(latestBuilderRun, 'id'))
          .order('created_at')
      : { data: [], error: null };
    const builderEventsResult = latestBuilderRun
      ? await this.client
          .from('builder_events')
          .select('*')
          .eq('builder_run_id', readString(latestBuilderRun, 'id'))
          .order('sequence', { ascending: false })
          .limit(180)
      : { data: [], error: null };
    throwIfError(builderArtifactsResult.error);
    throwIfError(builderEventsResult.error);
    const latestBriefRow = (briefs.data ?? [])[0] as DatabaseRow | undefined;
    const briefDraft = recordValue(latestBriefRow?.draft);
    const briefGuidance = Array.isArray(briefDraft.assetGuidance) ? briefDraft.assetGuidance : [];
    const briefAssetIds = briefGuidance
      .map((item: unknown) => readOptionalString(recordValue(item), 'assetId'))
      .filter((id): id is string => Boolean(id));
    const referencedAssetsResult = briefAssetIds.length
      ? await this.client
          .from('artifacts')
          .select('*')
          .eq('business_id', businessId)
          .in('id', briefAssetIds)
      : { data: [], error: null };
    throwIfError(referencedAssetsResult.error);
    const workspaceArtifacts = [
      ...((artifactsResult.data ?? []) as DatabaseRow[])
        .map(artifactFromRow)
        .filter((artifact) => artifact.crawlRunId === latestCapture?.id),
      ...((logoArtifactsResult.data ?? []) as DatabaseRow[]).map(artifactFromRow),
      ...((referencedAssetsResult.data ?? []) as DatabaseRow[]).map(artifactFromRow),
    ];

    return {
      business: businessFromRow(businessRow as DatabaseRow),
      website,
      contacts: ((contacts.data ?? []) as DatabaseRow[]).map(contactFromRow),
      facts:
        latestCapture?.status === 'ready' ||
        latestCapture?.status === 'running' ||
        latestCapture?.status === 'cancelled'
          ? ((facts.data ?? []) as DatabaseRow[])
              .map(factFromRow)
              .filter((fact) => fact.crawlRunId === latestCapture.id)
          : [],
      latestCapture,
      capturedPages: ((pagesResult.data ?? []) as DatabaseRow[])
        .map((page) => pageFromRow(page, businessId))
        .filter((page) => page.crawlRunId === latestCapture?.id),
      artifacts: [
        ...new Map(workspaceArtifacts.map((artifact) => [artifact.id, artifact])).values(),
      ],
      researchPacket: ((packetsResult.data ?? []) as DatabaseRow[])
        .map(researchPacketFromRow)
        .find((packet) => packet.crawlRunId === latestCapture?.id),
      assetAnalysis: (assetJobs.data ?? [])[0]
        ? assetAnalysisFromRow((assetJobs.data ?? [])[0] as DatabaseRow)
        : undefined,
      assetAnnotations: ((annotationsResult.data ?? []) as DatabaseRow[])
        .map(assetAnnotationFromRow)
        .filter((annotation) => annotation.crawlRunId === latestCapture?.id),
      brandColourEvidence: ((brandColourEvidenceResult.data ?? []) as DatabaseRow[])
        .map(brandColourEvidenceFromRow)
        .filter((evidence) => evidence.crawlRunId === latestCapture?.id),
      brandKit: (brandKitsResult.data ?? [])[0]
        ? brandKitFromRow((brandKitsResult.data ?? [])[0] as DatabaseRow)
        : undefined,
      redesignBrief: (briefs.data ?? [])[0]
        ? briefFromRow((briefs.data ?? [])[0] as DatabaseRow)
        : undefined,
      buildManifest: (manifests.data ?? [])[0]
        ? buildManifestFromRow((manifests.data ?? [])[0] as DatabaseRow)
        : undefined,
      latestBuilderRun: latestBuilderRun ? builderRunFromRow(latestBuilderRun) : undefined,
      builderArtifacts: ((builderArtifactsResult.data ?? []) as DatabaseRow[]).map(
        builderArtifactFromRow,
      ),
      builderEvents: ((builderEventsResult.data ?? []) as DatabaseRow[])
        .map(builderEventFromRow)
        .reverse(),
      previousCapture,
      previousFacts: previousCapture
        ? ((facts.data ?? []) as DatabaseRow[])
            .map(factFromRow)
            .filter((fact) => fact.crawlRunId === previousCapture.id)
        : [],
      previousArtifacts: previousCapture
        ? ((artifactsResult.data ?? []) as DatabaseRow[])
            .map(artifactFromRow)
            .filter((artifact) => artifact.crawlRunId === previousCapture.id)
        : [],
      audit: latestAudit
        ? auditFromRow(
            latestAudit,
            ((findingResult.data ?? []) as DatabaseRow[]).map(findingFromRow),
          )
        : undefined,
      concept: (concepts.data ?? [])[0]
        ? conceptFromRow((concepts.data ?? [])[0] as DatabaseRow)
        : undefined,
      report: (reports.data ?? [])[0]
        ? reportFromRow((reports.data ?? [])[0] as DatabaseRow)
        : undefined,
      tasks: ((tasks.data ?? []) as DatabaseRow[]).map(taskFromRow),
      activity: ((activity.data ?? []) as DatabaseRow[]).map(activityFromRow),
    };
  }

  async listWorkspaces() {
    const businesses = await this.listBusinesses();
    const workspaces = await Promise.all(
      businesses.map((business) => this.getWorkspace(business.id)),
    );
    return workspaces.filter((workspace): workspace is ProspectWorkspace => Boolean(workspace));
  }

  async createProspect(rawUrl: string, providedName?: string) {
    const domain = domainFromUrl(rawUrl);
    const websiteUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const canonicalUrl = canonicalWebsiteUrl(websiteUrl);
    const { data: existingWebsites, error: existingWebsitesError } = await this.client
      .from('websites')
      .select('url')
      .eq('organization_id', this.organizationId);
    throwIfError(existingWebsitesError);
    if (
      (existingWebsites ?? []).some(
        (website) =>
          typeof website.url === 'string' && canonicalWebsiteUrl(website.url) === canonicalUrl,
      )
    ) {
      throw new Error('You already have this website as a prospect.');
    }
    const { data, error } = await this.client.rpc('create_prospect_workspace', {
      target_organization_id: this.organizationId,
      business_name: providedName?.trim() || displayName(domain) || domain,
      website_url: websiteUrl,
      website_domain: domain,
    });
    if (isDuplicateWebsiteError(error)) {
      throw new Error('You already have this website as a prospect.');
    }
    throwIfError(error);
    const businessId = data as string;
    await this.requestLogoRetrieval(businessId);
    return this.getWorkspace(businessId);
  }

  private async requestLogoRetrieval(businessId: string) {
    const { data, error } = await this.client.rpc('request_logo_retrieval', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') throw new Error('The logo retrieval could not be queued.');
  }

  async requestResearchCapture(businessId: string) {
    const { data, error } = await this.client.rpc('request_website_capture', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') {
      throw new Error('The website capture could not be queued.');
    }
    const workspace = await this.getWorkspace(businessId);
    return workspace?.latestCapture;
  }

  async continueResearchCapture(businessId: string) {
    const { data, error } = await this.client.rpc('continue_website_capture', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') throw new Error('The website capture could not be continued.');
    const workspace = await this.getWorkspace(businessId);
    return workspace?.latestCapture;
  }

  async cancelResearchCapture(businessId: string) {
    const { error } = await this.client.rpc('cancel_website_capture', {
      target_business_id: businessId,
    });
    throwIfError(error);
  }

  async requestWebsiteAudit(businessId: string) {
    const { data, error } = await this.client.rpc('request_website_audit', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') throw new Error('The website audit could not be queued.');
    const workspace = await this.getWorkspace(businessId);
    return workspace?.audit;
  }

  async cancelWebsiteAudit(businessId: string) {
    const { error } = await this.client.rpc('cancel_website_audit', {
      target_business_id: businessId,
    });
    throwIfError(error);
  }

  async updateAuditFinding(
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) {
    const { error } = await this.client
      .from('audit_findings')
      .update({
        title: patch.title,
        finding: patch.finding,
        recommendation: patch.recommendation,
        severity: patch.severity,
        review_state: patch.reviewState,
      })
      .eq('id', finding.id);
    throwIfError(error);
  }

  async requestAssetAnalysis(businessId: string) {
    const { data, error } = await this.client.rpc('request_asset_analysis', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') throw new Error('The visual-asset analysis could not be queued.');
    const workspace = await this.getWorkspace(businessId);
    return workspace?.assetAnalysis;
  }

  async cancelAssetAnalysis(businessId: string) {
    const { error } = await this.client.rpc('cancel_asset_analysis', {
      target_business_id: businessId,
    });
    throwIfError(error);
  }

  async requestAssetRefresh(businessId: string) {
    const { data, error } = await this.client.rpc('request_asset_refresh', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') throw new Error('The image-only refresh could not be queued.');
    const workspace = await this.getWorkspace(businessId);
    return (
      workspace?.assetRefresh ?? {
        id: data,
        businessId,
        crawlRunId: '',
        status: 'queued',
        totalItems: 0,
        completedItems: 0,
        discoveredItems: 0,
        savedItems: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }
    );
  }

  async cancelAssetRefresh(businessId: string) {
    const { error } = await this.client.rpc('cancel_asset_refresh', {
      target_business_id: businessId,
    });
    throwIfError(error);
  }

  async setAssetAnalysisSelected(asset: ResearchArtifact, selected: boolean) {
    const { error } = await this.client
      .from('artifacts')
      .update({ metadata: { ...asset.metadata, analysisSelected: selected } })
      .eq('id', asset.id)
      .eq('kind', 'asset');
    throwIfError(error);
  }

  async updateAssetAnnotation(
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ) {
    const { error } = await this.client
      .from('asset_annotations')
      .update({
        suggested_role: patch.suggestedRole,
        business_association: patch.businessAssociation,
        review_state: patch.reviewState,
        human_notes: patch.humanNotes,
        reviewed_at: patch.reviewState === 'needs_review' ? null : new Date().toISOString(),
      })
      .eq('id', annotation.id);
    throwIfError(error);

    const workspace = await this.getWorkspace(annotation.businessId);
    const brief = workspace?.redesignBrief;
    if (!workspace || !brief || brief.status !== 'draft') return;

    const excludedAssetIds = new Set(
      workspace.assetAnnotations
        .filter(
          (candidate) =>
            candidate.reviewState === 'blocked' || candidate.suggestedRole === 'exclude',
        )
        .map((candidate) => candidate.assetId),
    );
    const { error: briefError } = await this.client
      .from('redesign_briefs')
      .update({
        source_selections: {
          ...brief.sourceSelections,
          assetIds: brief.sourceSelections.assetIds.filter(
            (assetId) => !excludedAssetIds.has(assetId),
          ),
        },
        draft: {
          ...brief.draft,
          assetGuidance: assetGuidanceFromAnnotations(workspace.assetAnnotations),
        },
      })
      .eq('id', brief.id);
    throwIfError(briefError);
  }

  async saveBrandKit(
    businessId: string,
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve = false,
    recordActivity = true,
  ) {
    const workspace = await this.getWorkspace(businessId);
    if (!workspace?.latestCapture || workspace.latestCapture.status !== 'ready') {
      throw new Error('A completed website capture is required before a Brand Kit can be saved.');
    }
    const assetIds = [...new Set(draft.approvedAssetIds)];
    if (draft.primaryLogoAssetId && !assetIds.includes(draft.primaryLogoAssetId)) {
      assetIds.unshift(draft.primaryLogoAssetId);
    }
    if (approve) {
      if (!draft.primaryLogoAssetId)
        throw new Error('Choose the organisation logo before approval.');
      if (!/^#[0-9a-f]{6}$/i.test(draft.palette.primary ?? '')) {
        throw new Error('Enter a reviewed six-digit primary brand colour before approval.');
      }
      if (!/^#[0-9a-f]{6}$/i.test(draft.palette.accent ?? '')) {
        throw new Error('Enter a reviewed six-digit accent colour before approval.');
      }
    }
    const existing = workspace.brandKit;
    const payload = {
      primary_logo_artifact_id: draft.primaryLogoAssetId || null,
      approved_asset_ids: assetIds,
      palette: draft.palette,
      notes: draft.notes.trim(),
      status: approve ? 'approved' : 'draft',
      approved_at: approve ? new Date().toISOString() : null,
    };
    const { data, error } =
      existing?.status === 'draft'
        ? await this.client
            .from('brand_kits')
            .update(payload)
            .eq('id', existing.id)
            .eq('status', 'draft')
            .select('*')
            .single()
        : await this.client
            .from('brand_kits')
            .insert({
              organization_id: this.organizationId,
              business_id: businessId,
              crawl_run_id: workspace.latestCapture.id,
              version: (existing?.version ?? 0) + 1,
              ...payload,
            })
            .select('*')
            .single();
    throwIfError(error);
    if (recordActivity) {
      const { error: activityError } = await this.client.from('activities').insert({
        organization_id: this.organizationId,
        business_id: businessId,
        type: approve ? 'approved' : 'note',
        message: approve
          ? `Brand Kit v${readNumber(data as DatabaseRow, 'version')} approved for future redesigns.`
          : 'Brand Kit saved as a private draft.',
      });
      throwIfError(activityError);
    }
    return brandKitFromRow(data as DatabaseRow);
  }

  async createBrandAwareBriefRevision(businessId: string) {
    const workspace = await this.getWorkspace(businessId);
    const brandKit = workspace?.brandKit;
    const previousBrief = workspace?.redesignBrief;
    if (
      !workspace?.researchPacket ||
      !workspace.latestCapture ||
      workspace.latestCapture.status !== 'ready' ||
      !brandKit ||
      brandKit.status !== 'approved' ||
      !brandKit.primaryLogoAssetId
    ) {
      throw new Error('Approve a complete Brand Kit before creating a brand-aware brief revision.');
    }
    const generated = createBriefDraft(
      workspace.business.name,
      workspace.researchPacket,
      workspace.artifacts,
      workspace.assetAnnotations,
      brandKit,
      workspace.capturedPages,
    );
    if (!generated.draft.brandKit) {
      throw new Error('The approved Brand Kit could not be attached to the new brief revision.');
    }
    generated.sourceSelections.pageUrls = [
      ...new Set(workspace.capturedPages.map((page) => page.url)),
    ];
    generated.sourceSelections.assetIds = [
      ...new Set(
        workspace.artifacts
          .filter((artifact) => artifact.kind === 'asset')
          .map((artifact) => artifact.id),
      ),
    ];
    generated.sourceSelections.autoSelectedAssetIds = generated.sourceSelections.assetIds;
    const { data, error } = await this.client
      .from('redesign_briefs')
      .insert({
        organization_id: this.organizationId,
        business_id: businessId,
        research_packet_id: workspace.researchPacket.id,
        crawl_run_id: workspace.latestCapture.id,
        status: 'draft',
        version: (previousBrief?.version ?? 0) + 1,
        source_selections: generated.sourceSelections,
        draft: generated.draft,
      })
      .select('*')
      .single();
    throwIfError(error);
    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: businessId,
      type: 'note',
      message: `Brand-aware redesign brief v${(previousBrief?.version ?? 0) + 1} drafted from Brand Kit v${brandKit.version}.`,
    });
    throwIfError(activityError);
    return briefFromRow(data as DatabaseRow);
  }

  async createRedesignBrief(businessId: string) {
    const workspace = await this.getWorkspace(businessId);
    if (
      !workspace?.researchPacket ||
      !workspace.latestCapture ||
      workspace.latestCapture.status !== 'ready'
    ) {
      throw new Error(
        'A completed Research Packet is required before a redesign brief can be drafted.',
      );
    }
    if (recordValue(workspace.researchPacket.data.capabilityAnalysis).status !== 'ready') {
      const { error } = await this.client.rpc('request_capability_analysis', {
        target_business_id: businessId,
      });
      throwIfError(error);
      return undefined;
    }
    const latestBrief = workspace.redesignBrief;
    if (latestBrief?.status === 'draft' && Array.isArray(latestBrief.draft.capabilityInventory)) {
      return latestBrief;
    }
    if (
      latestBrief?.status === 'approved' &&
      manifestSourceMatchesBrief(workspace, latestBrief) &&
      Array.isArray(latestBrief.draft.capabilityInventory)
    ) {
      return latestBrief;
    }
    const generated = createBriefDraft(
      workspace.business.name,
      workspace.researchPacket,
      workspace.artifacts,
      workspace.assetAnnotations,
      workspace.brandKit,
      workspace.capturedPages,
    );
    generated.sourceSelections.pageUrls = [
      ...new Set(workspace.capturedPages.map((page) => page.url)),
    ];
    generated.sourceSelections.assetIds = [
      ...new Set(
        workspace.artifacts
          .filter((artifact) => artifact.kind === 'asset')
          .map((artifact) => artifact.id),
      ),
    ];
    const record = {
      organization_id: this.organizationId,
      business_id: businessId,
      research_packet_id: workspace.researchPacket.id,
      crawl_run_id: workspace.latestCapture.id,
      status: 'draft',
      version: (latestBrief?.version ?? 0) + 1,
      source_selections: generated.sourceSelections,
      draft:
        latestBrief?.status === 'draft'
          ? { ...latestBrief.draft, capabilityInventory: generated.draft.capabilityInventory }
          : generated.draft,
    };
    const { data, error } =
      latestBrief?.status === 'draft'
        ? await this.client
            .from('redesign_briefs')
            .update({ draft: record.draft })
            .eq('id', latestBrief.id)
            .eq('status', 'draft')
            .select('*')
            .single()
        : await this.client.from('redesign_briefs').insert(record).select('*').single();
    if (isDuplicateWebsiteError(error)) {
      const refreshed = await this.getWorkspace(businessId);
      return refreshed?.redesignBrief;
    }
    throwIfError(error);
    const { error: businessError } = await this.client
      .from('businesses')
      .update({ stage: 'awaiting_approval' })
      .eq('id', businessId);
    throwIfError(businessError);
    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: businessId,
      type: 'note',
      message:
        latestBrief?.status === 'draft'
          ? 'Capability inventory generated from saved capture evidence without a new website scrape.'
          : `Redesign brief v${(latestBrief?.version ?? 0) + 1} drafted from the reviewed Research Packet.`,
    });
    throwIfError(activityError);
    return briefFromRow(data as DatabaseRow);
  }

  async refreshRedesignBriefArchitecture(brief: RedesignBrief) {
    if (brief.status !== 'draft') {
      throw new Error(
        'Approved briefs cannot be changed. Create a new draft before refreshing it.',
      );
    }
    const workspace = await this.getWorkspace(brief.businessId);
    if (
      !workspace?.researchPacket ||
      !workspace.latestCapture ||
      workspace.latestCapture.id !== brief.crawlRunId ||
      workspace.researchPacket.id !== brief.researchPacketId
    ) {
      throw new Error(
        'This draft belongs to an earlier capture. Create a new brief revision instead.',
      );
    }
    const generated = createBriefDraft(
      workspace.business.name,
      workspace.researchPacket,
      workspace.artifacts,
      workspace.assetAnnotations,
      workspace.brandKit,
      workspace.capturedPages,
      brief.sourceSelections.pageUrls,
    );
    const draft = {
      ...brief.draft,
      strategy: generated.draft.strategy,
      proposedSitemap: generated.draft.proposedSitemap,
      pagePlans: generated.draft.pagePlans,
    };
    const { data, error } = await this.client
      .from('redesign_briefs')
      .update({ draft })
      .eq('id', brief.id)
      .eq('status', 'draft')
      .select('*')
      .single();
    throwIfError(error);
    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: brief.businessId,
      type: 'note',
      message: `Redesign brief v${brief.version} architecture regenerated from selected captured pages.`,
    });
    throwIfError(activityError);
    return briefFromRow(data as DatabaseRow);
  }

  async updateRedesignBrief(
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) {
    if (brief.status === 'approved') {
      throw new Error('Approved briefs cannot be changed. Create a new draft for further changes.');
    }
    const { error } = await this.client
      .from('redesign_briefs')
      .update({ source_selections: patch.sourceSelections, draft: patch.draft })
      .eq('id', brief.id)
      .eq('status', 'draft');
    throwIfError(error);
  }

  async approveRedesignBrief(brief: RedesignBrief) {
    if (brief.status === 'approved') return;
    const approvedAt = new Date().toISOString();
    const { data, error } = await this.client
      .from('redesign_briefs')
      .update({ status: 'approved', approved_at: approvedAt })
      .eq('id', brief.id)
      .eq('status', 'draft')
      .select('id');
    throwIfError(error);
    if (!(data ?? []).length) throw new Error('The brief is no longer available for approval.');
    const { error: businessError } = await this.client
      .from('businesses')
      .update({ stage: 'concept_ready' })
      .eq('id', brief.businessId);
    throwIfError(businessError);
    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: brief.businessId,
      type: 'approved',
      message: 'Redesign brief approved. A builder can now use the approved strategy.',
    });
    throwIfError(activityError);
  }

  async createBuildManifest(businessId: string) {
    const workspace = await this.getWorkspace(businessId);
    const brief = workspace?.redesignBrief;
    if (!workspace || !brief || brief.status !== 'approved') {
      throw new Error('Approve the redesign brief before preparing a Build Manifest.');
    }
    if (!manifestSourceMatchesBrief(workspace, brief)) {
      throw new Error(
        'This approved brief belongs to an earlier capture. Create and approve a new brief before preparing a Build Manifest.',
      );
    }
    if (!workspace.brandKit || workspace.brandKit.status !== 'approved') {
      throw new Error(
        'Approve a complete Brand Kit with a primary logo and reviewed colours before preparing a Build Manifest.',
      );
    }
    if (!brief.draft.brandKit) {
      throw new Error(
        `Brand Kit v${workspace.brandKit.version} is approved, but redesign brief v${brief.version} does not reference it. Create and approve a new brand-aware brief revision before preparing a replacement Build Manifest.`,
      );
    }
    if (brief.draft.brandKit.id !== workspace.brandKit.id) {
      throw new Error(
        `Redesign brief v${brief.version} references an earlier Brand Kit. Create and approve a new brand-aware brief revision using Brand Kit v${workspace.brandKit.version}.`,
      );
    }
    if (workspace.buildManifest?.redesignBriefId === brief.id) return workspace.buildManifest;

    const generatedAt = new Date().toISOString();
    const { data, error } = await this.client
      .from('build_manifests')
      .insert({
        organization_id: this.organizationId,
        business_id: businessId,
        redesign_brief_id: brief.id,
        research_packet_id: brief.researchPacketId,
        crawl_run_id: brief.crawlRunId,
        schema_version: buildManifestSchemaVersion,
        builder_contract_version: codexBuilderContractVersion,
        status: 'ready',
        data: createBuildManifestData(workspace, brief),
        generated_at: generatedAt,
      })
      .select('*')
      .single();
    if (isDuplicateWebsiteError(error)) {
      const refreshed = await this.getWorkspace(businessId);
      return refreshed?.buildManifest;
    }
    throwIfError(error);

    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: businessId,
      type: 'note',
      message:
        'Build Manifest prepared from the approved redesign brief for the future Codex builder.',
    });
    throwIfError(activityError);
    return buildManifestFromRow(data as DatabaseRow);
  }

  async requestWebsiteBuild(businessId: string) {
    const { error } = await this.client.rpc('request_website_build', {
      target_business_id: businessId,
    });
    throwIfError(error);
    const workspace = await this.getWorkspace(businessId);
    return workspace?.latestBuilderRun;
  }

  async resumeWebsiteBuild(builderRunId: string) {
    const { error } = await this.client.rpc('resume_website_build', {
      target_builder_run_id: builderRunId,
    });
    throwIfError(error);
    const { data: run, error: runError } = await this.client
      .from('builder_runs')
      .select('*')
      .eq('id', builderRunId)
      .single();
    throwIfError(runError);
    return builderRunFromRow(run as DatabaseRow);
  }

  async cancelWebsiteBuild(businessId: string) {
    const { error } = await this.client.rpc('cancel_website_build', {
      target_business_id: businessId,
    });
    throwIfError(error);
  }

  async createBuilderPreviewUrl(builderRunId: string, mode: BuilderPreviewMode = 'ready') {
    const { data, error } = await this.client.rpc('create_builder_preview_access', {
      target_builder_run_id: builderRunId,
      requested_mode: mode,
    });
    throwIfError(error);
    const access = recordValue(data);
    const token = typeof access.token === 'string' ? access.token : '';
    const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
    if (!token || !supabaseUrl) {
      throw new Error('The private preview service is not configured.');
    }
    const draftPath = mode === 'draft' ? '__draft__/' : '';
    const sourceUrl = `${supabaseUrl}/functions/v1/siteforge-preview/${builderRunId}/${token}/${draftPath}`;
    return `${window.location.origin}${window.location.pathname}#/preview?source=${encodeURIComponent(sourceUrl)}`;
  }

  async setTaskState(task: Task, state: Task['state']) {
    const { error: taskError } = await this.client
      .from('tasks')
      .update({ state })
      .eq('id', task.id);
    throwIfError(taskError);
    const { error: activityError } = await this.client.from('activities').insert({
      organization_id: this.organizationId,
      business_id: task.businessId,
      type: 'task_completed',
      message: state === 'done' ? `Completed task: ${task.body}` : `Reopened task: ${task.body}`,
    });
    throwIfError(activityError);
  }

  async approveForOutreach(businessId: string) {
    const { data, error } = await this.client.rpc('approve_business_for_outreach', {
      target_business_id: businessId,
    });
    throwIfError(error);
    return data === true;
  }

  async deleteProspect(businessId: string) {
    const { data, error } = await this.client
      .from('businesses')
      .delete()
      .eq('id', businessId)
      .eq('organization_id', this.organizationId)
      .eq('kind', 'prospect')
      .select('id');
    throwIfError(error);
    return (data ?? []).length === 1;
  }
}
