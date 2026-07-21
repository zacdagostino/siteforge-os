import type { CapabilityInventoryItem, CapturedPage, ResearchPacket } from './domain';

function text(value: unknown) {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
}
function list(value: unknown) {
  return Array.isArray(value) ? value : [];
}

/** Reads only the AI-generated, source-cited inventory stored in the private Research Packet. */
export function detectCapabilities(
  packet: ResearchPacket,
  _capturedPages: CapturedPage[] = [],
): CapabilityInventoryItem[] {
  const analysis = packet.data.capabilityAnalysis;
  if (
    !analysis ||
    typeof analysis !== 'object' ||
    Array.isArray(analysis) ||
    (analysis as Record<string, unknown>).status !== 'ready'
  )
    return [];
  void _capturedPages;
  return list(packet.data.capabilityInventory)
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object')
    .map(
      (item) =>
        ({
          id: text(item.id),
          kind: text(item.kind) as CapabilityInventoryItem['kind'],
          title: text(item.title),
          description: text(item.description),
          delivery: text(item.delivery) as CapabilityInventoryItem['delivery'],
          confidence: text(item.confidence) as CapabilityInventoryItem['confidence'],
          evidence: list(item.evidence)
            .filter(
              (entry): entry is Record<string, unknown> =>
                Boolean(entry) && typeof entry === 'object',
            )
            .map((entry) => ({ sourceUrl: text(entry.sourceUrl), detail: text(entry.detail) }))
            .filter((entry) => entry.sourceUrl && entry.detail),
          decision:
            item.decision === 'include' || item.decision === 'exclude'
              ? item.decision
              : 'needs_review',
          decisionQuestion: text(item.decisionQuestion),
        }) as CapabilityInventoryItem,
    )
    .filter((item) => item.id && item.title && item.evidence.length && item.decisionQuestion);
}

export function unresolvedCapabilities(items: CapabilityInventoryItem[]) {
  return items.filter((item) => item.decision === 'needs_review');
}
