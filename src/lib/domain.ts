export type BusinessKind = 'prospect' | 'client';

export type ProspectStage =
  | 'identified'
  | 'researching'
  | 'audit_ready'
  | 'concept_ready'
  | 'awaiting_approval'
  | 'outreach_pending'
  | 'responded'
  | 'proposal'
  | 'won'
  | 'lost'
  | 'paused';

export type ReviewState = 'needs_review' | 'approved' | 'blocked';
export type EvidenceState = 'not_collected' | 'inferred' | 'verified' | 'rejected';
export type AuditStatus = 'not_started' | 'research_pending' | 'running' | 'ready' | 'failed';
export type DeliverableStatus = 'not_started' | 'draft' | 'ready' | 'approved';
export type TaskState = 'open' | 'done';
export type CaptureStatus = 'queued' | 'running' | 'ready' | 'failed';
export type ArtifactKind =
  'html' | 'screenshot' | 'performance' | 'accessibility' | 'report' | 'preview';

export type Business = {
  id: string;
  kind: BusinessKind;
  name: string;
  stage: ProspectStage;
  reviewState: ReviewState;
  opportunityScore?: number;
  createdAt: string;
  updatedAt: string;
};

export type Website = {
  id: string;
  businessId: string;
  url: string;
  domain: string;
  crawlStatus: 'not_requested' | 'queued' | 'captured' | 'failed';
  lastCapturedAt?: string;
  createdAt: string;
  updatedAt: string;
};

export type Contact = {
  id: string;
  businessId: string;
  name?: string;
  role?: string;
  email?: string;
  phone?: string;
  verificationState: EvidenceState;
  createdAt: string;
  updatedAt: string;
};

export type EvidenceFact = {
  id: string;
  businessId: string;
  crawlRunId?: string;
  label: string;
  value: string;
  sourceUrl?: string;
  evidence: string;
  confidence: 'high' | 'medium' | 'low';
  verificationState: EvidenceState;
  capturedAt: string;
};

export type ResearchCapture = {
  id: string;
  businessId: string;
  websiteId: string;
  targetUrl: string;
  scope: 'homepage';
  status: CaptureStatus;
  requestedAt: string;
  startedAt?: string;
  completedAt?: string;
  discoveredPageCount: number;
  capturedPageCount: number;
  failedPageCount: number;
  errorSummary?: string;
};

export type CapturedPage = {
  id: string;
  businessId: string;
  crawlRunId: string;
  url: string;
  canonicalUrl?: string;
  title?: string;
  statusCode?: number;
  captureStatus: CaptureStatus | 'not_requested';
};

export type ResearchArtifact = {
  id: string;
  businessId: string;
  crawlRunId?: string;
  kind: ArtifactKind;
  label?: string;
  storagePath: string;
  contentType?: string;
  byteSize?: number;
  metadata: Record<string, unknown>;
  createdAt: string;
};

export type AuditFinding = {
  id: string;
  area:
    | 'UI'
    | 'UX'
    | 'Mobile'
    | 'Accessibility'
    | 'SEO'
    | 'Performance'
    | 'Content'
    | 'Trust'
    | 'Conversion';
  severity: 'high' | 'medium' | 'low';
  title: string;
  finding: string;
  recommendation: string;
  evidenceIds: string[];
};

export type Audit = {
  id: string;
  businessId: string;
  status: AuditStatus;
  findings: AuditFinding[];
  createdAt: string;
  updatedAt: string;
};

export type RedesignConcept = {
  id: string;
  businessId: string;
  status: DeliverableStatus;
  version: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type DecisionReport = {
  id: string;
  businessId: string;
  status: DeliverableStatus;
  version: number;
  summary: string;
  createdAt: string;
  updatedAt: string;
};

export type Task = {
  id: string;
  businessId: string;
  body: string;
  dueAt?: string;
  state: TaskState;
  createdAt: string;
  updatedAt: string;
};

export type Activity = {
  id: string;
  businessId: string;
  type: 'created' | 'research_requested' | 'approved' | 'task_completed' | 'note';
  message: string;
  createdAt: string;
};

export type ProspectWorkspace = {
  business: Business;
  website?: Website;
  contacts: Contact[];
  facts: EvidenceFact[];
  latestCapture?: ResearchCapture;
  capturedPages: CapturedPage[];
  artifacts: ResearchArtifact[];
  audit?: Audit;
  concept?: RedesignConcept;
  report?: DecisionReport;
  tasks: Task[];
  activity: Activity[];
};

export const stageLabels: Record<ProspectStage, string> = {
  identified: 'Identified',
  researching: 'Researching',
  audit_ready: 'Audit ready',
  concept_ready: 'Concept ready',
  awaiting_approval: 'Awaiting approval',
  outreach_pending: 'Outreach pending',
  responded: 'Responded',
  proposal: 'Proposal',
  won: 'Won',
  lost: 'Lost',
  paused: 'Paused',
};

export function isOpenTask(task: Task) {
  return task.state === 'open';
}
