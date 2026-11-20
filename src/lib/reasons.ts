import { useQuery } from '@tanstack/react-query';
import apiService from '../services/api';

/** How a stoppage reason counts in the figures. */
export type ReasonKind = 'breakdown' | 'unplanned' | 'planned';

export interface StoppageReason {
  /** Stable id stored on each stoppage. */
  key: string;
  /** What people see. */
  label: string;
  kind: ReasonKind;
}

/** A stoppage nobody has given a reason yet. Never offered as a choice. */
export const NO_REASON = 'unclassified';

/** Used until the plant's own list has loaded, and when it has none. */
export const DEFAULT_REASONS: StoppageReason[] = [
  { key: 'breakdown', label: 'Breakdown', kind: 'breakdown' },
  { key: 'material_shortage', label: 'No material', kind: 'unplanned' },
  { key: 'mold_change', label: 'Mold change', kind: 'unplanned' },
  { key: 'maintenance', label: 'Unplanned maintenance', kind: 'unplanned' },
  { key: 'planned', label: 'Planned stop', kind: 'planned' },
  { key: 'other', label: 'Other', kind: 'unplanned' },
];

export const KIND_LABELS: Record<ReasonKind, string> = {
  breakdown: 'Breakdown',
  unplanned: 'Unplanned stop',
  planned: 'Planned stop',
};

/** What choosing a reason of this kind means, in one line. */
export const KIND_HINTS: Record<ReasonKind, string> = {
  breakdown: 'Counts in time between breakdowns and time to repair. Needs an SAP notification number.',
  unplanned: 'Counts against availability.',
  planned: 'Expected. Does not count against availability.',
};

/** The plant's stoppage reasons, with helpers to label a stored key. */
export function useStoppageReasons() {
  const query = useQuery<StoppageReason[]>({
    queryKey: ['stoppage-reasons'],
    queryFn: () => apiService.getStoppageReasons(),
    staleTime: 5 * 60_000,
  });
  const reasons = query.data?.length ? query.data : DEFAULT_REASONS;
  const find = (key: string) => reasons.find((r) => r.key === key);
  return {
    reasons,
    isLoading: query.isLoading,
    labelOf: (key: string) =>
      key === NO_REASON ? 'No reason recorded' : find(key)?.label ?? key.replace(/_/g, ' '),
    kindOf: (key: string): ReasonKind => find(key)?.kind ?? 'unplanned',
  };
}

/** A key for a new reason, derived from its label: lowercase letters, digits, underscores. */
export function keyFromLabel(label: string, taken: Set<string>): string {
  const base =
    label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || 'reason';
  let key = base === NO_REASON ? `${base}_1` : base;
  for (let n = 2; taken.has(key); n++) key = `${base}_${n}`;
  return key;
}
