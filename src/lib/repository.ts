import type {
  Activity,
  AssetAnnotation,
  AssetAnalysisJob,
  AssetRefreshJob,
  BrandKit,
  Audit,
  AuditFinding,
  BuildManifest,
  BuilderPreviewMode,
  BuilderRunMode,
  BuilderRun,
  CapturedPage,
  Business,
  Contact,
  DecisionReport,
  EvidenceFact,
  ProspectWorkspace,
  ResearchArtifact,
  ResearchCapture,
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
import { createBriefDraft } from './redesign-brief';

export type WorkspaceRepository = {
  bootstrap(): Promise<void>;
  listBusinesses(): Promise<Business[]>;
  getWorkspace(businessId: string): Promise<ProspectWorkspace | undefined>;
  listWorkspaces(): Promise<ProspectWorkspace[]>;
  createProspect(rawUrl: string, providedName?: string): Promise<ProspectWorkspace | undefined>;
  requestResearchCapture(businessId: string): Promise<ResearchCapture | undefined>;
  continueResearchCapture(businessId: string): Promise<ResearchCapture | undefined>;
  cancelResearchCapture(businessId: string): Promise<void>;
  requestWebsiteAudit(businessId: string): Promise<Audit | undefined>;
  cancelWebsiteAudit(businessId: string): Promise<void>;
  updateAuditFinding(
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ): Promise<void>;
  requestAssetAnalysis(businessId: string): Promise<AssetAnalysisJob | undefined>;
  cancelAssetAnalysis(businessId: string): Promise<void>;
  requestAssetRefresh(businessId: string): Promise<AssetRefreshJob | undefined>;
  cancelAssetRefresh(businessId: string): Promise<void>;
  setAssetAnalysisSelected(asset: ResearchArtifact, selected: boolean): Promise<void>;
  updateAssetAnnotation(
    annotation: AssetAnnotation,
    patch: Pick<
      AssetAnnotation,
      'suggestedRole' | 'businessAssociation' | 'reviewState' | 'humanNotes'
    >,
  ): Promise<void>;
  saveBrandKit(
    businessId: string,
    draft: Pick<BrandKit, 'primaryLogoAssetId' | 'approvedAssetIds' | 'palette' | 'notes'>,
    approve?: boolean,
    recordActivity?: boolean,
  ): Promise<BrandKit | undefined>;
  createBrandAwareBriefRevision(businessId: string): Promise<RedesignBrief | undefined>;
  createRedesignBrief(businessId: string): Promise<RedesignBrief | undefined>;
  refreshRedesignBriefArchitecture(brief: RedesignBrief): Promise<RedesignBrief | undefined>;
  updateRedesignBrief(
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ): Promise<void>;
  approveRedesignBrief(brief: RedesignBrief): Promise<void>;
  createBuildManifest(businessId: string): Promise<BuildManifest | undefined>;
  requestWebsiteBuild(
    businessId: string,
    mode?: BuilderRunMode,
    targetSourceUrl?: string,
  ): Promise<BuilderRun | undefined>;
  resumeWebsiteBuild(builderRunId: string): Promise<BuilderRun | undefined>;
  cancelWebsiteBuild(businessId: string): Promise<void>;
  deleteWebsiteBuild(builderRunId: string): Promise<void>;
  deleteWebsiteBuildHistory(businessId: string): Promise<void>;
  deleteManagedRecord(
    kind: 'capture' | 'asset_analysis' | 'brief' | 'manifest' | 'build',
    id: string,
  ): Promise<void>;
  deleteBuildPackage(businessId: string, redesignBriefId: string): Promise<void>;
  createBuilderPreviewUrl(builderRunId: string, mode?: BuilderPreviewMode): Promise<string>;
  setTaskState(task: Task, state: Task['state']): Promise<void>;
  approveForOutreach(businessId: string): Promise<boolean>;
  deleteProspect(businessId: string): Promise<boolean>;
};

const databaseName = 'siteforge-os';
const databaseVersion = 4;
const legacyStorageKey = 'siteforge-os.records.v2';

type StoreName =
  | 'activities'
  | 'audits'
  | 'artifacts'
  | 'businesses'
  | 'buildManifests'
  | 'briefs'
  | 'concepts'
  | 'contacts'
  | 'crawlPages'
  | 'crawlRuns'
  | 'facts'
  | 'meta'
  | 'reports'
  | 'tasks'
  | 'websites';

type MetaRecord = { id: string; value: string };

function requestResult<T>(request: IDBRequest<T>) {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed.'));
  });
}

function transactionResult(transaction: IDBTransaction) {
  return new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction failed.'));
    transaction.onabort = () =>
      reject(transaction.error ?? new Error('IndexedDB transaction aborted.'));
  });
}

function openDatabase() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, databaseVersion);
    request.onupgradeneeded = () => {
      const database = request.result;
      const upgradeTransaction = request.transaction;
      if (!upgradeTransaction) throw new Error('Unable to initialise SiteForge storage.');
      (
        [
          'businesses',
          'buildManifests',
          'briefs',
          'websites',
          'contacts',
          'crawlRuns',
          'crawlPages',
          'artifacts',
          'facts',
          'audits',
          'concepts',
          'reports',
          'tasks',
          'activities',
          'meta',
        ] as StoreName[]
      ).forEach((name) => {
        const store = database.objectStoreNames.contains(name)
          ? upgradeTransaction.objectStore(name)
          : database.createObjectStore(name, { keyPath: 'id' });
        if (name !== 'businesses' && name !== 'meta' && !store.indexNames.contains('businessId')) {
          store.createIndex('businessId', 'businessId');
        }
      });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Unable to open SiteForge storage.'));
  });
}

function domainFromUrl(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  return new URL(withProtocol).hostname.replace(/^www\./, '');
}

export function canonicalWebsiteUrl(value: string) {
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  const url = new URL(withProtocol);
  const path = url.pathname.replace(/\/+$/, '');
  return `${url.host.toLowerCase()}${path}`;
}

function displayName(domain: string) {
  return domain
    .split('.')[0]
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

function id(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

export class SiteforgeRepository {
  private databasePromise?: Promise<IDBDatabase>;
  private bootstrapPromise?: Promise<void>;

  private database() {
    this.databasePromise ??= openDatabase();
    return this.databasePromise;
  }

  private async get<T>(storeName: StoreName, key: string) {
    const database = await this.database();
    const transaction = database.transaction(storeName, 'readonly');
    const record = await requestResult(transaction.objectStore(storeName).get(key));
    return record as T | undefined;
  }

  private async getAll<T>(storeName: StoreName) {
    const database = await this.database();
    const transaction = database.transaction(storeName, 'readonly');
    const records = await requestResult(transaction.objectStore(storeName).getAll());
    return records as T[];
  }

  private async getAllForBusiness<T>(
    storeName: Exclude<StoreName, 'businesses' | 'meta'>,
    businessId: string,
  ) {
    const database = await this.database();
    const transaction = database.transaction(storeName, 'readonly');
    const records = await requestResult(
      transaction.objectStore(storeName).index('businessId').getAll(businessId),
    );
    return records as T[];
  }

  private async put<T>(storeName: StoreName, record: T) {
    const database = await this.database();
    const transaction = database.transaction(storeName, 'readwrite');
    const completed = transactionResult(transaction);
    transaction.objectStore(storeName).put(record);
    await completed;
  }

  private async putMany(entries: Array<[StoreName, object]>) {
    const database = await this.database();
    const transaction = database.transaction(
      [...new Set(entries.map(([storeName]) => storeName))],
      'readwrite',
    );
    const completed = transactionResult(transaction);
    entries.forEach(([storeName, record]) => transaction.objectStore(storeName).put(record));
    await completed;
  }

  private async deleteRecord(storeName: StoreName, id: string) {
    const database = await this.database();
    const transaction = database.transaction(storeName, 'readwrite');
    const completed = transactionResult(transaction);
    transaction.objectStore(storeName).delete(id);
    await completed;
  }

  async bootstrap() {
    this.bootstrapPromise ??= this.bootstrapStorage();
    return this.bootstrapPromise;
  }

  private async bootstrapStorage() {
    const migrated = await this.get<MetaRecord>('meta', 'legacy-local-storage-v2');
    if (!migrated) {
      await this.migrateLegacyRecords();
      await this.put('meta', {
        id: 'legacy-local-storage-v2',
        value: 'complete',
      } satisfies MetaRecord);
    }

    if ((await this.listBusinesses()).length === 0) {
      await this.seedDemoWorkspace();
    }
  }

  private async migrateLegacyRecords() {
    try {
      const raw = window.localStorage.getItem(legacyStorageKey);
      const records = raw
        ? (JSON.parse(raw) as Array<{ businessName?: string; websiteUrl?: string }>)
        : [];
      for (const record of records) {
        if (record.websiteUrl) {
          await this.createProspect(record.websiteUrl, record.businessName);
        }
      }
    } catch {
      // Legacy browser data remains untouched when it cannot be safely interpreted.
    }
  }

  private async seedDemoWorkspace() {
    const now = new Date().toISOString();
    const businessId = 'business-demo-local-services';
    const websiteId = 'website-demo-local-services';

    const business: Business = {
      id: businessId,
      kind: 'prospect',
      name: 'Demo Local Services',
      stage: 'researching',
      reviewState: 'needs_review',
      opportunityScore: 61,
      createdAt: now,
      updatedAt: now,
    };
    const website: Website = {
      id: websiteId,
      businessId,
      url: 'https://demo-local-services.example',
      domain: 'demo-local-services.example',
      crawlStatus: 'not_requested',
      createdAt: now,
      updatedAt: now,
    };
    const audit: Audit = {
      id: 'audit-demo-local-services',
      businessId,
      status: 'research_pending',
      findings: [],
      totalItems: 0,
      completedItems: 0,
      createdAt: now,
      updatedAt: now,
    };
    const concept: RedesignConcept = {
      id: 'concept-demo-local-services',
      businessId,
      status: 'not_started',
      version: 1,
      summary: 'A concept is created only after research evidence has been reviewed.',
      createdAt: now,
      updatedAt: now,
    };
    const report: DecisionReport = {
      id: 'report-demo-local-services',
      businessId,
      status: 'not_started',
      version: 1,
      summary:
        'A client-facing report is created only from approved evidence and design decisions.',
      createdAt: now,
      updatedAt: now,
    };
    const task: Task = {
      id: 'task-demo-verify',
      businessId,
      body: 'Verify business identity, services, and contact details.',
      state: 'open',
      createdAt: now,
      updatedAt: now,
    };
    const activity: Activity = {
      id: 'activity-demo-created',
      businessId,
      type: 'created',
      message: 'Demo prospect workspace created. Research has not run.',
      createdAt: now,
    };

    await this.putMany([
      ['businesses', business],
      ['websites', website],
      ['audits', audit],
      ['concepts', concept],
      ['reports', report],
      ['tasks', task],
      ['activities', activity],
    ]);
  }

  async listBusinesses() {
    return (await this.getAll<Business>('businesses')).sort((left, right) =>
      right.updatedAt.localeCompare(left.updatedAt),
    );
  }

  async getWorkspace(businessId: string): Promise<ProspectWorkspace | undefined> {
    const business = await this.get<Business>('businesses', businessId);
    if (!business) return undefined;

    const [
      websites,
      contacts,
      facts,
      captures,
      pages,
      artifacts,
      audits,
      briefs,
      buildManifests,
      concepts,
      reports,
      tasks,
      activity,
    ] = await Promise.all([
      this.getAllForBusiness<Website>('websites', businessId),
      this.getAllForBusiness<Contact>('contacts', businessId),
      this.getAllForBusiness<EvidenceFact>('facts', businessId),
      this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId),
      this.getAllForBusiness<CapturedPage>('crawlPages', businessId),
      this.getAllForBusiness<ResearchArtifact>('artifacts', businessId),
      this.getAllForBusiness<Audit>('audits', businessId),
      this.getAllForBusiness<RedesignBrief>('briefs', businessId),
      this.getAllForBusiness<BuildManifest>('buildManifests', businessId),
      this.getAllForBusiness<RedesignConcept>('concepts', businessId),
      this.getAllForBusiness<DecisionReport>('reports', businessId),
      this.getAllForBusiness<Task>('tasks', businessId),
      this.getAllForBusiness<Activity>('activities', businessId),
    ]);

    const orderedCaptures = captures.sort((left, right) =>
      right.requestedAt.localeCompare(left.requestedAt),
    );
    const latestCapture = orderedCaptures[0];
    const previousCapture =
      latestCapture?.status === 'failed'
        ? orderedCaptures.find(
            (capture) => capture.id !== latestCapture.id && capture.status === 'ready',
          )
        : undefined;

    return {
      business,
      website: websites[0],
      captures: orderedCaptures,
      contacts,
      facts:
        latestCapture?.status === 'ready'
          ? facts.filter((fact) => fact.crawlRunId === latestCapture.id)
          : [],
      latestCapture,
      capturedPages: latestCapture
        ? pages.filter((page) => page.crawlRunId === latestCapture.id)
        : [],
      artifacts: latestCapture
        ? artifacts.filter((artifact) => artifact.crawlRunId === latestCapture.id)
        : [],
      assetAnnotations: [],
      assetAnalysisJobs: [],
      brandColourEvidence: [],
      previousCapture,
      previousFacts: previousCapture
        ? facts.filter((fact) => fact.crawlRunId === previousCapture.id)
        : [],
      previousArtifacts: previousCapture
        ? artifacts.filter((artifact) => artifact.crawlRunId === previousCapture.id)
        : [],
      audit: audits[0],
      redesignBrief: briefs.sort((left, right) => right.version - left.version)[0],
      redesignBriefs: briefs.sort((left, right) => right.version - left.version),
      buildManifest: buildManifests.sort((left, right) =>
        right.generatedAt.localeCompare(left.generatedAt),
      )[0],
      buildManifests: buildManifests.sort((left, right) =>
        right.generatedAt.localeCompare(left.generatedAt),
      ),
      builderArtifacts: [],
      builderEvents: [],
      builderRuns: [],
      concept: concepts[0],
      report: reports[0],
      tasks: tasks.sort((left, right) => left.state.localeCompare(right.state)),
      activity: activity.sort((left, right) => right.createdAt.localeCompare(left.createdAt)),
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
    const now = new Date().toISOString();
    const domain = domainFromUrl(rawUrl);
    const canonicalUrl = canonicalWebsiteUrl(rawUrl);
    const existingWebsites = await this.getAll<Website>('websites');
    if (existingWebsites.some((website) => canonicalWebsiteUrl(website.url) === canonicalUrl)) {
      throw new Error('You already have this website as a prospect.');
    }
    const businessId = id('business');
    const websiteUrl = /^https?:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    const business: Business = {
      id: businessId,
      kind: 'prospect',
      name: providedName?.trim() || displayName(domain) || domain,
      stage: 'researching',
      reviewState: 'needs_review',
      createdAt: now,
      updatedAt: now,
    };
    const website: Website = {
      id: id('website'),
      businessId,
      url: websiteUrl,
      domain,
      crawlStatus: 'not_requested',
      createdAt: now,
      updatedAt: now,
    };
    const audit: Audit = {
      id: id('audit'),
      businessId,
      status: 'research_pending',
      findings: [],
      totalItems: 0,
      completedItems: 0,
      createdAt: now,
      updatedAt: now,
    };
    const concept: RedesignConcept = {
      id: id('concept'),
      businessId,
      status: 'not_started',
      version: 1,
      summary: 'Awaiting verified research before a redesign concept can be drafted.',
      createdAt: now,
      updatedAt: now,
    };
    const report: DecisionReport = {
      id: id('report'),
      businessId,
      status: 'not_started',
      version: 1,
      summary: 'Awaiting approved evidence and design decisions.',
      createdAt: now,
      updatedAt: now,
    };
    const tasks: Task[] = [
      {
        id: id('task'),
        businessId,
        body: 'Verify business identity, services, and contact details.',
        state: 'open',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: id('task'),
        businessId,
        body: 'Run research and capture evidence before approving any claims.',
        state: 'open',
        createdAt: now,
        updatedAt: now,
      },
    ];
    const activity: Activity = {
      id: id('activity'),
      businessId,
      type: 'research_requested',
      message: `Prospect created from ${domain}. Research is awaiting a crawler connection.`,
      createdAt: now,
    };

    await this.putMany([
      ['businesses', business],
      ['websites', website],
      ['audits', audit],
      ['concepts', concept],
      ['reports', report],
      ...tasks.map((task) => ['tasks', task] as [StoreName, Task]),
      ['activities', activity],
    ]);
    await this.requestResearchCapture(businessId);
    return this.getWorkspace(businessId);
  }

  async requestResearchCapture(businessId: string) {
    const [business, websites, captures] = await Promise.all([
      this.get<Business>('businesses', businessId),
      this.getAllForBusiness<Website>('websites', businessId),
      this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId),
    ]);
    const website = websites[0];
    if (!business || !website) throw new Error('A website is required before research can begin.');

    const activeCapture = captures
      .filter((capture) => capture.status === 'queued' || capture.status === 'running')
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (activeCapture) return activeCapture;

    const now = new Date().toISOString();
    const capture: ResearchCapture = {
      id: id('crawl'),
      businessId,
      websiteId: website.id,
      targetUrl: website.url,
      scope: 'all_pages',
      status: 'queued',
      requestedAt: now,
      discoveredPageCount: 0,
      capturedPageCount: 0,
      failedPageCount: 0,
      progressPhase: 'queued',
      progressDetail: 'Waiting for the protected worker to begin.',
    };
    const activity: Activity = {
      id: id('activity'),
      businessId,
      type: 'research_requested',
      message:
        'Website capture requested. Discoverable public pages will remain private until a worker completes it.',
      createdAt: now,
    };
    await this.putMany([
      ['crawlRuns', capture],
      ['websites', { ...website, crawlStatus: 'queued', updatedAt: now }],
      ['businesses', { ...business, updatedAt: now }],
      ['activities', activity],
    ]);
    return capture;
  }

  async continueResearchCapture(businessId: string) {
    const captures = await this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId);
    const capture = captures
      .filter((candidate) => candidate.status === 'failed' && !candidate.cancelRequestedAt)
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (!capture) throw new Error('There is no failed website capture to continue.');
    const now = new Date().toISOString();
    const continued = {
      ...capture,
      status: 'queued',
      requestedAt: now,
      startedAt: undefined,
      completedAt: undefined,
      errorSummary: undefined,
      failurePhase: undefined,
      failureUrl: undefined,
      failureDetail: undefined,
      progressPhase: 'queued',
      progressDetail: 'Continuation requested. The worker will retry the incomplete capture step.',
      currentUrl: capture.failureUrl ?? capture.currentUrl ?? capture.targetUrl,
    } satisfies ResearchCapture;
    await this.put('crawlRuns', continued);
    return continued;
  }

  async cancelResearchCapture(businessId: string) {
    const [website, captures] = await Promise.all([
      this.getAllForBusiness<Website>('websites', businessId).then((websites) => websites[0]),
      this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId),
    ]);
    const capture = captures
      .filter((candidate) => candidate.status === 'queued' || candidate.status === 'running')
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (!capture) throw new Error('There is no active website capture to cancel.');
    const now = new Date().toISOString();
    await this.put('crawlRuns', {
      ...capture,
      status: 'cancelled',
      cancelRequestedAt: now,
      completedAt: now,
      progressPhase: 'cancelled',
      progressDetail: 'Capture cancelled before a protected worker completed it.',
      errorSummary: 'Capture cancelled by a workspace user.',
    } satisfies ResearchCapture);
    if (website) {
      await this.put('websites', { ...website, crawlStatus: 'not_requested', updatedAt: now });
    }
    await this.put('activities', {
      id: id('activity'),
      businessId,
      type: 'note',
      message: 'Website capture cancelled in local mode.',
      createdAt: now,
    } satisfies Activity);
  }

  async requestWebsiteAudit(businessId: string) {
    const [business, audits, captures] = await Promise.all([
      this.get<Business>('businesses', businessId),
      this.getAllForBusiness<Audit>('audits', businessId),
      this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId),
    ]);
    const completedCapture = captures
      .filter((capture) => capture.status === 'ready')
      .sort((left, right) => right.requestedAt.localeCompare(left.requestedAt))[0];
    if (!business || !completedCapture) {
      throw new Error('A completed website capture is required before an audit can be generated.');
    }
    const now = new Date().toISOString();
    const audit = audits[0] ?? {
      id: id('audit'),
      businessId,
      status: 'not_started' as const,
      findings: [],
      totalItems: 0,
      completedItems: 0,
      createdAt: now,
      updatedAt: now,
    };
    const updatedAudit: Audit = {
      ...audit,
      status: 'ready',
      findings: audit.findings,
      updatedAt: now,
    };
    await this.putMany([
      ['audits', updatedAudit],
      ['businesses', { ...business, stage: 'audit_ready', updatedAt: now }],
      [
        'activities',
        {
          id: id('activity'),
          businessId,
          type: 'note',
          message:
            'Audit requested in local mode. Connect the protected audit worker to generate findings from saved evidence.',
          createdAt: now,
        } satisfies Activity,
      ],
    ]);
    return updatedAudit;
  }

  async cancelWebsiteAudit(businessId: string) {
    const audits = await this.getAllForBusiness<Audit>('audits', businessId);
    const audit = audits.find(
      (candidate) => candidate.status === 'research_pending' || candidate.status === 'running',
    );
    if (!audit) throw new Error('There is no active website audit to cancel.');
    await this.put('audits', {
      ...audit,
      status: 'cancelled',
      cancelRequestedAt: new Date().toISOString(),
      progressPhase: 'cancelled',
      progressDetail: 'Audit cancelled in local mode.',
    });
  }

  async updateAuditFinding(
    finding: AuditFinding,
    patch: Pick<AuditFinding, 'title' | 'finding' | 'recommendation' | 'severity' | 'reviewState'>,
  ) {
    const audits = await this.getAll<Audit>('audits');
    const audit = audits.find((candidate) =>
      candidate.findings.some((candidateFinding) => candidateFinding.id === finding.id),
    );
    if (!audit) throw new Error('The audit finding could not be found.');
    const now = new Date().toISOString();
    await this.put('audits', {
      ...audit,
      findings: audit.findings.map((candidate) =>
        candidate.id === finding.id ? { ...candidate, ...patch } : candidate,
      ),
      updatedAt: now,
    });
  }

  async requestAssetAnalysis(): Promise<AssetAnalysisJob | undefined> {
    throw new Error('Asset analysis requires the protected Supabase worker.');
  }

  async cancelAssetAnalysis(): Promise<void> {
    throw new Error('Asset analysis requires the protected Supabase worker.');
  }

  async requestAssetRefresh(): Promise<AssetRefreshJob | undefined> {
    throw new Error('Image-only refresh requires the protected Supabase worker.');
  }

  async cancelAssetRefresh(): Promise<void> {
    throw new Error('Image-only refresh requires the protected Supabase worker.');
  }

  async setAssetAnalysisSelected(asset: ResearchArtifact, selected: boolean): Promise<void> {
    await this.put('artifacts', {
      ...asset,
      metadata: { ...asset.metadata, analysisSelected: selected },
    } satisfies ResearchArtifact);
  }

  async updateAssetAnnotation() {
    throw new Error('Asset annotations require the protected Supabase worker.');
  }

  async saveBrandKit(): Promise<BrandKit | undefined> {
    throw new Error('Brand Kits require the protected Supabase workspace.');
  }

  async createBrandAwareBriefRevision(): Promise<RedesignBrief | undefined> {
    throw new Error('Brand-aware revisions require the protected Supabase workspace.');
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
    if (
      !workspace.researchPacket.data.capabilityAnalysis ||
      typeof workspace.researchPacket.data.capabilityAnalysis !== 'object' ||
      (workspace.researchPacket.data.capabilityAnalysis as Record<string, unknown>).status !==
        'ready'
    ) {
      throw new Error(
        'AI capability analysis must complete from the saved capture before a brief can be drafted.',
      );
    }
    const existingBriefs = await this.getAllForBusiness<RedesignBrief>('briefs', businessId);
    const latestBrief = existingBriefs.sort((left, right) => right.version - left.version)[0];
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
    const now = new Date().toISOString();
    const generated = createBriefDraft(
      workspace.business.name,
      workspace.researchPacket,
      workspace.artifacts,
      workspace.assetAnnotations,
      undefined,
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
    const isLegacyDraft = latestBrief?.status === 'draft';
    const brief: RedesignBrief = {
      id: id('brief'),
      businessId,
      researchPacketId: workspace.researchPacket.id,
      crawlRunId: workspace.latestCapture.id,
      status: 'draft',
      version: (latestBrief?.version ?? 0) + 1,
      sourceSelections: isLegacyDraft ? latestBrief.sourceSelections : generated.sourceSelections,
      draft: isLegacyDraft
        ? { ...latestBrief.draft, capabilityInventory: generated.draft.capabilityInventory }
        : generated.draft,
      createdAt: now,
      updatedAt: now,
    };
    await this.putMany([
      [
        'briefs',
        isLegacyDraft
          ? {
              ...brief,
              id: latestBrief.id,
              version: latestBrief.version,
              createdAt: latestBrief.createdAt,
            }
          : brief,
      ],
      ['businesses', { ...workspace.business, stage: 'awaiting_approval', updatedAt: now }],
      [
        'activities',
        {
          id: id('activity'),
          businessId,
          type: 'note',
          message: isLegacyDraft
            ? 'Capability inventory generated from saved capture evidence without a new website scrape.'
            : `Redesign brief v${(latestBrief?.version ?? 0) + 1} drafted from the reviewed Research Packet.`,
          createdAt: now,
        } satisfies Activity,
      ],
    ]);
    return isLegacyDraft
      ? {
          ...brief,
          id: latestBrief.id,
          version: latestBrief.version,
          createdAt: latestBrief.createdAt,
        }
      : brief;
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
      workspace.latestCapture.id !== brief.crawlRunId
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
    const now = new Date().toISOString();
    const refreshed: RedesignBrief = {
      ...brief,
      draft: {
        ...brief.draft,
        strategy: generated.draft.strategy,
        proposedSitemap: generated.draft.proposedSitemap,
        pagePlans: generated.draft.pagePlans,
      },
      updatedAt: now,
    };
    await this.putMany([
      ['briefs', refreshed],
      [
        'activities',
        {
          id: id('activity'),
          businessId: brief.businessId,
          type: 'note',
          message: `Redesign brief v${brief.version} architecture regenerated from selected captured pages.`,
          createdAt: now,
        } satisfies Activity,
      ],
    ]);
    return refreshed;
  }

  async updateRedesignBrief(
    brief: RedesignBrief,
    patch: Pick<RedesignBrief, 'sourceSelections' | 'draft'>,
  ) {
    if (brief.status === 'approved') {
      throw new Error('Approved briefs cannot be changed. Create a new draft for further changes.');
    }
    await this.put('briefs', { ...brief, ...patch, updatedAt: new Date().toISOString() });
  }

  async approveRedesignBrief(brief: RedesignBrief) {
    const business = await this.get<Business>('businesses', brief.businessId);
    if (!business) throw new Error('The prospect could not be found.');
    if (brief.status === 'approved') return;
    const now = new Date().toISOString();
    await this.putMany([
      ['briefs', { ...brief, status: 'approved', approvedAt: now, updatedAt: now }],
      ['businesses', { ...business, stage: 'concept_ready', updatedAt: now }],
      [
        'activities',
        {
          id: id('activity'),
          businessId: brief.businessId,
          type: 'approved',
          message: 'Redesign brief approved. A builder can now use the approved strategy.',
          createdAt: now,
        } satisfies Activity,
      ],
    ]);
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
    if (workspace.buildManifest) return workspace.buildManifest;

    const now = new Date().toISOString();
    const manifest: BuildManifest = {
      id: id('manifest'),
      businessId,
      redesignBriefId: brief.id,
      researchPacketId: brief.researchPacketId,
      crawlRunId: brief.crawlRunId,
      schemaVersion: buildManifestSchemaVersion,
      builderContractVersion: codexBuilderContractVersion,
      status: 'ready',
      data: createBuildManifestData(workspace, brief),
      generatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await this.putMany([
      ['buildManifests', manifest],
      [
        'activities',
        {
          id: id('activity'),
          businessId,
          type: 'note',
          message:
            'Build Manifest prepared from the approved redesign brief for the future Codex builder.',
          createdAt: now,
        } satisfies Activity,
      ],
    ]);
    return manifest;
  }

  async requestWebsiteBuild(): Promise<BuilderRun | undefined> {
    throw new Error('Private preview builds require the protected Supabase builder worker.');
  }

  async resumeWebsiteBuild(): Promise<BuilderRun | undefined> {
    throw new Error('Private preview builds require the protected Supabase builder worker.');
  }

  async cancelWebsiteBuild(): Promise<void> {
    throw new Error('Private preview builds require the protected Supabase builder worker.');
  }

  async deleteWebsiteBuild(): Promise<void> {
    throw new Error('Private preview builds require the protected Supabase builder worker.');
  }

  async deleteWebsiteBuildHistory(): Promise<void> {
    throw new Error('Private preview builds require the protected Supabase builder worker.');
  }

  async deleteManagedRecord(
    kind: 'capture' | 'asset_analysis' | 'brief' | 'manifest' | 'build',
    id: string,
  ) {
    if (kind === 'capture') return this.deleteRecord('crawlRuns', id);
    if (kind === 'brief') return this.deleteRecord('briefs', id);
    if (kind === 'manifest') return this.deleteRecord('buildManifests', id);
    if (kind === 'asset_analysis' || kind === 'build') return;
  }

  async deleteBuildPackage(businessId: string, redesignBriefId: string) {
    const database = await this.database();
    const readTransaction = database.transaction('buildManifests', 'readonly');
    const manifests = await requestResult(
      readTransaction.objectStore('buildManifests').index('businessId').getAll(businessId),
    );
    const transaction = database.transaction(['briefs', 'buildManifests'], 'readwrite');
    const manifestStore = transaction.objectStore('buildManifests');
    const completed = transactionResult(transaction);
    for (const item of manifests) {
      if (item.redesignBriefId === redesignBriefId) {
        manifestStore.delete(item.id);
      }
    }
    transaction.objectStore('briefs').delete(redesignBriefId);
    await completed;
  }

  async createBuilderPreviewUrl(): Promise<string> {
    throw new Error('Private preview builds require the protected Supabase preview service.');
  }

  async setTaskState(task: Task, state: Task['state']) {
    const now = new Date().toISOString();
    const updatedTask = { ...task, state, updatedAt: now };
    const business = await this.get<Business>('businesses', task.businessId);
    const activity: Activity = {
      id: id('activity'),
      businessId: task.businessId,
      type: 'task_completed',
      message: state === 'done' ? `Completed task: ${task.body}` : `Reopened task: ${task.body}`,
      createdAt: now,
    };
    await this.putMany([
      ['tasks', updatedTask],
      ['activities', activity],
      ...(business
        ? [['businesses', { ...business, updatedAt: now }] as [StoreName, Business]]
        : []),
    ]);
  }

  async approveForOutreach(businessId: string) {
    const business = await this.get<Business>('businesses', businessId);
    const [audits, concepts] = await Promise.all([
      this.getAllForBusiness<Audit>('audits', businessId),
      this.getAllForBusiness<RedesignConcept>('concepts', businessId),
    ]);
    if (!business || audits[0]?.status !== 'ready' || concepts[0]?.status !== 'ready') return false;
    const now = new Date().toISOString();
    const updatedBusiness: Business = {
      ...business,
      stage: 'outreach_pending',
      reviewState: 'approved',
      updatedAt: now,
    };
    const activity: Activity = {
      id: id('activity'),
      businessId,
      type: 'approved',
      message: 'Research review approved for the next human-controlled outreach step.',
      createdAt: now,
    };
    await this.putMany([
      ['businesses', updatedBusiness],
      ['activities', activity],
    ]);
    return true;
  }

  async deleteProspect(businessId: string) {
    const business = await this.get<Business>('businesses', businessId);
    if (!business || business.kind !== 'prospect') return false;

    const relatedRecords = await Promise.all([
      this.getAllForBusiness<Website>('websites', businessId),
      this.getAllForBusiness<Contact>('contacts', businessId),
      this.getAllForBusiness<ResearchCapture>('crawlRuns', businessId),
      this.getAllForBusiness<CapturedPage>('crawlPages', businessId),
      this.getAllForBusiness<ResearchArtifact>('artifacts', businessId),
      this.getAllForBusiness<EvidenceFact>('facts', businessId),
      this.getAllForBusiness<Audit>('audits', businessId),
      this.getAllForBusiness<BuildManifest>('buildManifests', businessId),
      this.getAllForBusiness<RedesignConcept>('concepts', businessId),
      this.getAllForBusiness<DecisionReport>('reports', businessId),
      this.getAllForBusiness<Task>('tasks', businessId),
      this.getAllForBusiness<Activity>('activities', businessId),
    ]);
    const stores: StoreName[] = [
      'businesses',
      'websites',
      'contacts',
      'crawlRuns',
      'crawlPages',
      'artifacts',
      'facts',
      'audits',
      'buildManifests',
      'concepts',
      'reports',
      'tasks',
      'activities',
    ];
    const database = await this.database();
    const transaction = database.transaction(stores, 'readwrite');
    const completed = transactionResult(transaction);
    transaction.objectStore('businesses').delete(businessId);
    const storesByRecord = [
      'websites',
      'contacts',
      'crawlRuns',
      'crawlPages',
      'artifacts',
      'facts',
      'audits',
      'buildManifests',
      'concepts',
      'reports',
      'tasks',
      'activities',
    ] as const;
    relatedRecords.forEach((records, index) => {
      records.forEach((record) => transaction.objectStore(storesByRecord[index]).delete(record.id));
    });
    await completed;
    return true;
  }
}

export const siteforgeRepository = new SiteforgeRepository();
