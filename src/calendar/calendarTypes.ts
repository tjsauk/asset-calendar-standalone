export type CalendarMode = 'view' | 'reserve' | 'checkout';
export type CalendarViewMode = 'week' | 'month';

export type TimePeriod = {
  start: string;
  end: string;
};

export type ExistingReservation = {
  start: string;
  end: string;
  userName: string;
};

export type Asset = {
  id: string;
  name: string;
  color?: string;
  existingPeriods: ExistingReservation[];
};

export type SelectedAssetPeriods = {
  id: string;
  name: string;
  selectedPeriods: TimePeriod[];
};

export type CalendarInput = {
  mode: CalendarMode;
  currentUser: string;
  assets: Asset[];
  continuousCutMode?: boolean;
};

export type CalendarOutput = {
  assets: SelectedAssetPeriods[];
};

export type PeriodStatus = 'neutral' | 'good' | 'warning' | 'error';

export type SelectionPeriodDef = {
  id: string;
  requestedRange: TimePeriod | null;
};

export type DraftGroup = {
  periodId: string;
  groupKey: string;
  assets: Asset[];
  periods: TimePeriod[];
  status: PeriodStatus;
};

export type ExistingGroup = {
  groupKey: string;
  entries: { asset: Asset; reservation: ExistingReservation }[];
  period: TimePeriod;
};

export type MonthBlock = {
  leftPct: number;
  widthPct: number;
  topPx: number;
  color: string;
  label: string;
  tooltip: string;
};