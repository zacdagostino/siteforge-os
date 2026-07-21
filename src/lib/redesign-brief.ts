import type {
  AssetAnnotation,
  BrandKit,
  BriefPagePlan,
  BriefSitemapEntry,
  CapturedPage,
  RedesignBriefDraft,
  ResearchArtifact,
  ResearchPacket,
} from './domain';
import { detectCapabilities } from './capability-inventory';

type PacketPage = {
  url?: unknown;
  pageType?: unknown;
  title?: unknown;
  primaryHeading?: unknown;
  description?: unknown;
};

type SourcePage = {
  url: string;
  pageType: string;
  title: string;
  primaryHeading: string;
  description: string;
};

type ArchitectureRole =
  | 'home'
  | 'contact'
  | 'about'
  | 'service_hub'
  | 'service_detail'
  | 'sector'
  | 'projects'
  | 'resources_hub'
  | 'resource_taxonomy'
  | 'article'
  | 'tool'
  | 'careers'
  | 'legal'
  | 'success'
  | 'profile'
  | 'retained';

function stringValue(value: unknown) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalisePageUrl(value: string) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString();
  } catch {
    return value;
  }
}

function packetPages(packet: ResearchPacket): SourcePage[] {
  const pages = Array.isArray(packet.data.pages) ? packet.data.pages : [];
  return pages
    .filter((page): page is Record<string, unknown> => typeof page === 'object' && page !== null)
    .map((page) => ({
      url: normalisePageUrl(stringValue((page as PacketPage).url)),
      pageType: stringValue((page as PacketPage).pageType),
      title: stringValue((page as PacketPage).title),
      primaryHeading: stringValue((page as PacketPage).primaryHeading),
      description: stringValue((page as PacketPage).description),
    }))
    .filter((page) => page.url);
}

function sourcePages(packet: ResearchPacket, capturedPages: CapturedPage[]) {
  const packetByUrl = new Map(packetPages(packet).map((page) => [page.url, page]));
  const merged = new Map<string, SourcePage>();

  for (const capturedPage of capturedPages) {
    const url = normalisePageUrl(capturedPage.url);
    const packetPage = packetByUrl.get(url);
    merged.set(url, {
      url,
      pageType: stringValue(capturedPage.pageType) || packetPage?.pageType || '',
      title: stringValue(capturedPage.title) || packetPage?.title || '',
      primaryHeading: packetPage?.primaryHeading || '',
      description: packetPage?.description || '',
    });
  }

  for (const page of packetByUrl.values()) {
    if (!merged.has(page.url)) merged.set(page.url, page);
  }

  return [...merged.values()];
}

function labelForPage(page: SourcePage) {
  if (page.pageType === 'homepage') return 'Home';
  return page.title || page.primaryHeading || page.pageType || 'Captured page';
}

function pathname(page: SourcePage) {
  try {
    return new URL(page.url).pathname.toLowerCase().replace(/\/+$/, '') || '/';
  } catch {
    return page.url.toLowerCase();
  }
}

function pageText(page: SourcePage) {
  return `${pathname(page)} ${page.pageType} ${page.title} ${page.primaryHeading}`.toLowerCase();
}

function hasTerm(value: string, expression: RegExp) {
  return expression.test(value);
}

function architectureRole(page: SourcePage): ArchitectureRole {
  const path = pathname(page);
  const text = pageText(page);
  if (path === '/' || page.pageType === 'homepage') return 'home';
  if (page.pageType === 'contact' || /(^|\/)contact(?:[-/]|$)/.test(path)) return 'contact';
  if (hasTerm(text, /privacy|terms|cookie/)) return 'legal';
  if (hasTerm(text, /thank[- ]?you|confirmation/)) return 'success';
  if (/(^|\/)profile(?:\/|$)/.test(path) || hasTerm(text, /\bprofile\b/)) return 'profile';
  if (hasTerm(text, /career|job|recruit/)) return 'careers';
  if (path.startsWith('/post/')) return 'article';
  if (/^\/(?:news|blog|resources?)(?:\/|$)/.test(path)) {
    return /\/(?:categories|tags)\//.test(path) ? 'resource_taxonomy' : 'resources_hub';
  }
  if (hasTerm(text, /calculator|\btool\b|estimator/)) return 'tool';
  if (page.pageType === 'about' || hasTerm(text, /about[- ]?us|\babout\b/)) return 'about';
  if (/(^|\/)(?:our-)?services?$/.test(path)) {
    return 'service_hub';
  }
  if (/(^|\/)projects?$/.test(path)) return 'projects';
  if (
    page.pageType === 'service' ||
    hasTerm(
      text,
      /electrical|automation|control systems|instrumentation|maintenance|installation|callout|shutdown|eeha|audio.?visual|communications/,
    )
  ) {
    return 'service_detail';
  }
  if (hasTerm(text, /case stud/)) return 'projects';
  if (hasTerm(text, /\bbooking\b|enquir/)) return 'contact';
  if (hasTerm(text, /industrial|commercial|mining|who we service|who we serve|sector/)) {
    return 'sector';
  }
  return 'retained';
}

function countLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

function groupedPages(pages: SourcePage[]) {
  const groups = new Map<ArchitectureRole, SourcePage[]>();
  for (const page of pages) {
    const role = architectureRole(page);
    groups.set(role, [...(groups.get(role) ?? []), page]);
  }
  return groups;
}

function firstPage(groups: Map<ArchitectureRole, SourcePage[]>, role: ArchitectureRole) {
  return groups.get(role)?.[0];
}

function preferredPage(
  groups: Map<ArchitectureRole, SourcePage[]>,
  role: ArchitectureRole,
  predicate: (page: SourcePage) => boolean,
) {
  return groups.get(role)?.find(predicate) ?? firstPage(groups, role);
}

function proposedSitemapFor(pages: SourcePage[]): BriefSitemapEntry[] {
  const groups = groupedPages(pages);
  const entries: BriefSitemapEntry[] = [];
  const add = (label: string, purpose: string, page?: SourcePage) => {
    if (page) entries.push({ label, purpose, sourceUrl: page.url });
  };
  const servicePages = [
    ...(groups.get('service_hub') ?? []),
    ...(groups.get('service_detail') ?? []),
  ];
  const resourcePages = [
    ...(groups.get('resources_hub') ?? []),
    ...(groups.get('article') ?? []),
    ...(groups.get('resource_taxonomy') ?? []),
  ];
  const utilityPages = [
    ...(groups.get('legal') ?? []),
    ...(groups.get('success') ?? []),
    ...(groups.get('profile') ?? []),
    ...(groups.get('retained') ?? []),
  ];

  add(
    'Home',
    'Introduce the business using verified context and route visitors to the most relevant captured paths.',
    firstPage(groups, 'home'),
  );
  add(
    'Services',
    `Provide a clear entry into ${countLabel(servicePages.length, 'captured service route')} and retain each selected service page as its own destination.`,
    firstPage(groups, 'service_hub') ?? firstPage(groups, 'service_detail'),
  );
  add(
    'Industries and audiences',
    `Keep ${countLabel(groups.get('sector')?.length ?? 0, 'captured sector page')} findable without mixing it into the service hierarchy.`,
    firstPage(groups, 'sector'),
  );
  add(
    'Projects',
    'Present the captured project material as a focused proof and exploration route.',
    firstPage(groups, 'projects'),
  );
  add(
    'Resources and insights',
    `Use a resource index and reusable article structure for ${countLabel(resourcePages.length, 'captured resource route')}.`,
    preferredPage(groups, 'resources_hub', (page) =>
      /^\/(?:news|blog|resources?)$/.test(pathname(page)),
    ) ?? firstPage(groups, 'article'),
  );
  add(
    'Tools and calculators',
    `Keep ${countLabel(groups.get('tool')?.length ?? 0, 'captured tool')} accessible outside primary conversion navigation; approved capabilities determine any live behaviour.`,
    firstPage(groups, 'tool'),
  );
  add(
    'About',
    'Present verified business context without adding unsupported claims.',
    firstPage(groups, 'about'),
  );
  add(
    'Careers',
    'Retain the captured careers route as a separate audience path.',
    firstPage(groups, 'careers'),
  );
  add(
    'Contact',
    'Make the existing contact route easy to find and complete on any screen size.',
    preferredPage(groups, 'contact', (page) => /(^|\/)contact(?:[-/]|$)/.test(pathname(page))),
  );
  add(
    'Utility and retained routes',
    `Keep ${countLabel(utilityPages.length, 'selected supporting route')} available where needed without placing it in primary navigation.`,
    utilityPages[0],
  );

  return entries;
}

function planForPage(page: SourcePage): BriefPagePlan {
  const role = architectureRole(page);
  const plans: Record<ArchitectureRole, string[]> = {
    home: [
      'Verified value proposition and primary action',
      'Clear pathways into captured services, sectors, and resources',
      'Trust content only where captured and verified',
    ],
    contact: [
      'Clear contact context from the captured page',
      'Accessible labelled enquiry or contact form',
      'Confirmation state without implying live delivery',
    ],
    about: [
      'Verified business context',
      'Scannable organisation story and supporting evidence',
      'Clear route to a confirmed next action',
    ],
    service_hub: [
      'Service overview grounded in captured routes',
      'Scannable service pathways',
      'Clear route to a confirmed next action',
    ],
    service_detail: [
      'Service-specific heading and verified context',
      'Scannable explanation of captured service information',
      'Relevant accessible action route',
    ],
    sector: [
      'Sector-specific heading and verified context',
      'Relevant captured services or project pathways',
      'Clear route to a confirmed next action',
    ],
    projects: [
      'Project index or detail heading',
      'Captured project information in a scannable structure',
      'Relevant next action without unsupported outcomes',
    ],
    resources_hub: [
      'Resource index heading and introduction',
      'Accessible collection of captured article routes',
      'Clear content discovery controls where approved',
    ],
    resource_taxonomy: [
      'Taxonomy heading from the captured route',
      'Filtered captured resource collection',
      'Accessible route back to the resource index',
    ],
    article: [
      'Article heading and verified captured content',
      'Readable long-form information hierarchy',
      'Relevant resource and contact pathways',
    ],
    tool: [
      'Captured tool purpose and supporting context',
      'Accessible input and result interface where the capability is approved',
      'Honest static preview and production boundary when it is not',
    ],
    careers: [
      'Careers heading and verified captured information',
      'Clear application or enquiry path without invented workflow behaviour',
      'Accessible next steps',
    ],
    legal: [
      'Clear legal page heading',
      'Preserved captured legal content',
      'Accessible utility navigation',
    ],
    success: [
      'Clear confirmation heading',
      'Captured or neutral next-step context',
      'Route back to relevant public content',
    ],
    profile: [
      'Profile heading and verified captured content',
      'Clear relationship to the originating public route',
      'Relevant onward navigation',
    ],
    retained: [
      'Clear page heading',
      'Verified content from the captured website',
      'Purposeful placement outside primary navigation unless reviewed otherwise',
    ],
  };
  return { title: labelForPage(page), structure: plans[role], sourceUrl: page.url };
}

export function assetGuidanceFromAnnotations(annotations: AssetAnnotation[]) {
  return annotations
    .filter(
      (annotation) =>
        annotation.reviewState === 'approved' && annotation.suggestedRole !== 'exclude',
    )
    .map((annotation) => ({
      assetId: annotation.assetId,
      role: annotation.suggestedRole,
      observedDescription: annotation.observedDescription,
      visibleText: annotation.visibleText,
      safeReuseNote: annotation.safeReuseNote,
      cautions: annotation.cautions,
    }));
}

function brandGuidance(brandKit: BrandKit | undefined, annotations: AssetAnnotation[]) {
  if (!brandKit || brandKit.status !== 'approved' || !brandKit.primaryLogoAssetId) return [];
  const annotationsByAsset = new Map(
    annotations.map((annotation) => [annotation.assetId, annotation]),
  );
  return brandKit.approvedAssetIds.map((assetId) => {
    const annotation = annotationsByAsset.get(assetId);
    const isPrimaryLogo = assetId === brandKit.primaryLogoAssetId;
    return {
      assetId,
      role: isPrimaryLogo ? 'primary_logo' : (annotation?.suggestedRole ?? 'decorative'),
      observedDescription:
        annotation?.observedDescription ?? 'Human-approved captured brand asset.',
      visibleText: annotation?.visibleText ?? [],
      safeReuseNote: isPrimaryLogo
        ? 'Use as the organisation logo in the site header and footer.'
        : (annotation?.safeReuseNote ?? 'Use only in the approved visual role.'),
      cautions: annotation?.cautions ?? [],
    };
  });
}

export function createBriefDraft(
  businessName: string,
  packet: ResearchPacket,
  artifacts: ResearchArtifact[],
  annotations: AssetAnnotation[] = [],
  brandKit?: BrandKit,
  capturedPages: CapturedPage[] = [],
  selectedPageUrls?: string[],
) {
  const pages = sourcePages(packet, capturedPages);
  const selectedUrls = selectedPageUrls
    ? new Set(selectedPageUrls.map(normalisePageUrl))
    : undefined;
  const architecturePages = selectedUrls
    ? pages.filter((page) => selectedUrls.has(page.url))
    : pages;
  const visualAssets = artifacts.filter((artifact) => artifact.kind === 'asset');
  const approvedAssetGuidance = [
    ...brandGuidance(brandKit, annotations),
    ...assetGuidanceFromAnnotations(annotations).filter(
      (guidance) => !brandKit?.approvedAssetIds.includes(guidance.assetId),
    ),
  ];
  const proposedSitemap = proposedSitemapFor(architecturePages);
  const draft: RedesignBriefDraft = {
    strategy: `Create a clear, mobile-first redesign for ${businessName} using only the reviewed research packet. Separate primary conversion navigation from resources, tools, and utility routes; improve hierarchy, readability, and the path to a confirmed action without introducing new business claims. Every selected source page remains part of the private replacement scope.`,
    proposedSitemap,
    pagePlans: architecturePages.map(planForPage),
    assetGuidance: approvedAssetGuidance,
    capabilityInventory: detectCapabilities(packet, capturedPages),
    brandKit:
      brandKit?.status === 'approved' && brandKit.primaryLogoAssetId
        ? {
            id: brandKit.id,
            version: brandKit.version,
            primaryLogoAssetId: brandKit.primaryLogoAssetId,
            approvedAssetIds: brandKit.approvedAssetIds,
            palette: brandKit.palette,
          }
        : undefined,
    assumptions: [
      'The redesign will preserve reviewed factual content and approved visual assets from the captured website.',
      'Only the human-approved asset descriptions in this brief may guide visual interpretation or reuse.',
      'No testimonials, qualifications, prices, guarantees, services, or contact details will be invented.',
      'The primary conversion action remains a decision for human review before build work begins.',
    ],
    openQuestions: [
      'What is the primary conversion action for this website?',
      ...(brandKit?.status === 'approved'
        ? []
        : [
            'Which captured visual assets and brand palette are approved for the redesign preview?',
          ]),
      'Are there services, locations, or trust signals that need verification before they are included?',
    ],
  };

  return {
    sourceSelections: {
      pageUrls: pages.map((page) => page.url),
      assetIds: visualAssets.map((asset) => asset.id),
      autoSelectedAssetIds: visualAssets.map((asset) => asset.id),
      uncertainties: [],
    },
    draft,
    availablePageUrls: pages.map((page) => page.url),
    availableAssetIds: visualAssets.map((asset) => asset.id),
  };
}
