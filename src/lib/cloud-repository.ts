import type { SupabaseClient } from '@supabase/supabase-js';
import type {
  Activity,
  Audit,
  AuditFinding,
  CapturedPage,
  Business,
  Contact,
  DecisionReport,
  EvidenceFact,
  ProspectWorkspace,
  ResearchArtifact,
  ResearchCapture,
  RedesignConcept,
  Task,
  Website,
} from './domain';
import { canonicalWebsiteUrl, type WorkspaceRepository } from './repository';

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
  return {
    id: readString(row, 'id'),
    businessId,
    websiteId: readString(row, 'website_id'),
    targetUrl: readOptionalString(row, 'target_url') ?? website?.url ?? '',
    scope: 'homepage',
    status: status === 'running' || status === 'ready' || status === 'failed' ? status : 'queued',
    requestedAt: readString(row, 'requested_at'),
    startedAt: readOptionalString(row, 'started_at'),
    completedAt: readOptionalString(row, 'completed_at'),
    discoveredPageCount: readNumber(row, 'discovered_page_count'),
    capturedPageCount: readNumber(row, 'captured_page_count'),
    failedPageCount: readNumber(row, 'failed_page_count'),
    errorSummary: readOptionalString(row, 'error_summary'),
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
    storagePath: readString(row, 'storage_path'),
    contentType: readOptionalString(row, 'content_type'),
    byteSize: typeof row.byte_size === 'number' ? row.byte_size : undefined,
    metadata,
    createdAt: readString(row, 'created_at'),
  };
}

function auditFromRow(row: DatabaseRow, findings: AuditFinding[]): Audit {
  return {
    id: readString(row, 'id'),
    businessId: readString(row, 'business_id'),
    status: auditStatus(readString(row, 'status')),
    findings,
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

    const [websites, contacts, facts, audits, concepts, reports, tasks, activity] =
      await Promise.all([
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
    [websites, contacts, facts, audits, concepts, reports, tasks, activity].forEach((result) =>
      throwIfError(result.error),
    );

    const website = (websites.data ?? [])[0]
      ? websiteFromRow((websites.data ?? [])[0] as DatabaseRow)
      : undefined;
    const captureResult = website
      ? await this.client
          .from('crawl_runs')
          .select('*')
          .eq('website_id', website.id)
          .order('requested_at', { ascending: false })
          .limit(1)
      : { data: [], error: null };
    throwIfError(captureResult.error);
    const latestCaptureRow = (captureResult.data ?? [])[0] as DatabaseRow | undefined;
    const latestCapture = latestCaptureRow
      ? captureFromRow(latestCaptureRow, businessId, website)
      : undefined;
    const [pagesResult, artifactsResult] = latestCapture
      ? await Promise.all([
          this.client
            .from('crawl_pages')
            .select('*')
            .eq('crawl_run_id', latestCapture.id)
            .order('created_at'),
          this.client
            .from('artifacts')
            .select('*')
            .eq('crawl_run_id', latestCapture.id)
            .order('created_at'),
        ])
      : [
          { data: [], error: null },
          { data: [], error: null },
        ];
    throwIfError(pagesResult.error);
    throwIfError(artifactsResult.error);

    const latestAudit = (audits.data ?? [])[0] as DatabaseRow | undefined;
    const findingResult = latestAudit
      ? await this.client
          .from('audit_findings')
          .select('*')
          .eq('audit_id', readString(latestAudit, 'id'))
      : { data: [], error: null };
    throwIfError(findingResult.error);

    return {
      business: businessFromRow(businessRow as DatabaseRow),
      website,
      contacts: ((contacts.data ?? []) as DatabaseRow[]).map(contactFromRow),
      facts: ((facts.data ?? []) as DatabaseRow[]).map(factFromRow),
      latestCapture,
      capturedPages: ((pagesResult.data ?? []) as DatabaseRow[]).map((page) =>
        pageFromRow(page, businessId),
      ),
      artifacts: ((artifactsResult.data ?? []) as DatabaseRow[]).map(artifactFromRow),
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
    return this.getWorkspace(data as string);
  }

  async requestResearchCapture(businessId: string) {
    const { data, error } = await this.client.rpc('request_homepage_capture', {
      target_business_id: businessId,
    });
    throwIfError(error);
    if (typeof data !== 'string') {
      throw new Error('The homepage capture could not be queued.');
    }
    const workspace = await this.getWorkspace(businessId);
    return workspace?.latestCapture;
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
