import type {
  BuildManifestData,
  EvidenceFact,
  ProspectWorkspace,
  RedesignBrief,
  ResearchArtifact,
} from './domain';

export const buildManifestSchemaVersion = 1;
export const codexBuilderContractVersion = 'siteforge-codex-builder-v2';

const builderRules = [
  'Build a complete mobile-first website from this manifest, not a superficial reskin of the captured website.',
  'Use only permitted facts and source-bound content. Do not invent reviews, qualifications, prices, guarantees, locations, services, contact details, or performance claims.',
  'Treat selected pages and selected assets as research context. Only approved asset guidance authorises visual reuse in the redesign.',
  'When a Brand Kit is present, use its staged primary logo in the header and footer, use its reviewed primary and accent colours as brand tokens, and derive accessible neutral, background, surface, muted, and border tokens rather than copying a weak legacy palette or substituting a generic identity.',
  'Use semantic HTML, labelled forms, keyboard-accessible controls, accessible colour contrast, and a clear focus order.',
  'Create a clear visual hierarchy with purposeful typography, spacing, navigation, calls to action, trust presentation, and restrained animation.',
  'Design responsive mobile, tablet, and desktop layouts. Do not rely on desktop layouts shrinking into mobile.',
  'Keep performance, privacy, maintainability, local SEO foundations, and reusable design tokens as first-class implementation constraints.',
  'Surface open questions and uncertainties for human review rather than resolving them with assumptions.',
  'Treat the proposed sitemap as an information-hierarchy model, not a list of the only pages to build. Every selected source page remains required output scope; keep articles, tools, legal, confirmation, profile, and other supporting routes available without forcing them into primary navigation.',
  'Do not publish, contact a prospect, use uncertain information as fact, or make compliance guarantees without human approval.',
  'Implement only the approved capabilities. For a capability that requires an external service, account, authentication, payments, or server-side data, create an honest preview of the user-facing flow and record the production integration requirement; do not invent credentials, accounts, transactions, or working backend behaviour.',
];

function selectedArtifacts(artifacts: ResearchArtifact[], ids: string[]) {
  const selectedIds = new Set(ids);
  return artifacts
    .filter((artifact) => artifact.kind === 'asset' && selectedIds.has(artifact.id))
    .map((artifact) => ({
      artifactId: artifact.id,
      label: artifact.label,
      contentType: artifact.contentType,
      storageBucket: artifact.storageBucket,
      storagePath: artifact.storagePath,
      sourceSelected: true,
    }));
}

function permittedFacts(facts: EvidenceFact[]) {
  return facts
    .filter(
      (fact) => fact.verificationState !== 'rejected' && fact.verificationState !== 'inferred',
    )
    .map((fact) => ({
      id: fact.id,
      label: fact.label,
      value: fact.value,
      sourceUrl: fact.sourceUrl,
      evidence: fact.evidence,
      confidence: fact.confidence,
      verificationState: fact.verificationState,
    }));
}

export function manifestSourceMatchesBrief(workspace: ProspectWorkspace, brief: RedesignBrief) {
  return (
    workspace.latestCapture?.id === brief.crawlRunId &&
    workspace.researchPacket?.id === brief.researchPacketId
  );
}

export function createBuildManifestData(
  workspace: ProspectWorkspace,
  brief: RedesignBrief,
): BuildManifestData {
  const selectedPageUrls = new Set(brief.sourceSelections.pageUrls);

  return {
    source: {
      businessName: workspace.business.name,
      websiteUrl: workspace.website?.url,
      researchPacketId: brief.researchPacketId,
      crawlRunId: brief.crawlRunId,
      redesignBriefId: brief.id,
    },
    permittedFacts: permittedFacts(workspace.facts),
    selectedPages: workspace.capturedPages
      .filter((page) => selectedPageUrls.has(page.url))
      .map((page) => ({
        url: page.url,
        title: page.title,
        pageType: page.pageType,
        canonicalUrl: page.canonicalUrl,
        sourceSelected: true,
      })),
    selectedAssets: selectedArtifacts(workspace.artifacts, brief.sourceSelections.assetIds),
    approvedAssetGuidance: brief.draft.assetGuidance,
    approvedCapabilities: (brief.draft.capabilityInventory ?? []).filter(
      (capability) => capability.decision === 'include',
    ),
    brandKit: brief.draft.brandKit,
    strategy: brief.draft.strategy,
    proposedSitemap: brief.draft.proposedSitemap,
    pagePlans: brief.draft.pagePlans,
    assumptions: brief.draft.assumptions,
    openQuestions: brief.draft.openQuestions,
    uncertainties: brief.sourceSelections.uncertainties,
    builderRules,
  };
}
