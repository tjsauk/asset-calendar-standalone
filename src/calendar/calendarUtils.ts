import type {
  Asset,
  ExistingGroup,
  ExistingReservation,
  PeriodStatus,
  SelectedAssetPeriods,
  SelectionPeriodDef,
  TimePeriod,
} from './calendarTypes';

export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const HOURS = Array.from({ length: 24 }, (_, i) => i);
export const HOUR_ROW_PX = 16;
export const MONTH_SLOT_HOURS = 2;
export const MONTH_SLOT_COUNT = 24 / MONTH_SLOT_HOURS;

export function pad(v: number) {
  return String(v).padStart(2, '0');
}

export function formatDateTime(date: Date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function parseDateTime(value: string) {
  const [datePart, timePart] = value.split(' ');
  const [year, month, day] = datePart.split('-').map(Number);
  const [hour, minute] = timePart.split(':').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

export function addMinutes(date: Date, minutes: number) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

export function addHours(date: Date, hours: number) {
  return new Date(date.getTime() + hours * 60 * 60 * 1000);
}

export function addDays(date: Date, days: number) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

export function addWeeks(date: Date, weeks: number) {
  return addDays(date, weeks * 7);
}

export function startOfHour(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), 0, 0, 0);
}

export function startOfDay(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 0, 0, 0, 0);
}

export function endOfDayInclusive(date: Date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 23, 59, 0, 0);
}

export function endToExclusive(endString: string) {
  return addMinutes(parseDateTime(endString), 1);
}

export function toInclusiveEndFromExclusive(date: Date) {
  return addMinutes(date, -1);
}

export function buildOneHourPeriod(start: Date): TimePeriod {
  const s = startOfHour(start);
  return {
    start: formatDateTime(s),
    end: formatDateTime(addMinutes(addHours(s, 1), -1)),
  };
}

export function normalizePeriod(start: Date, endExclusive: Date): TimePeriod | null {
  const s = startOfHour(start);
  const e = addMinutes(startOfHour(addMinutes(endExclusive, -1)), 59);

  if (e.getTime() < s.getTime()) return null;

  return {
    start: formatDateTime(s),
    end: formatDateTime(e),
  };
}

export function getWeekStart(anchor: Date) {
  const d = startOfDay(anchor);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d;
}

export function getWeekDays(weekStart: Date) {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

export function isSameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
}

export function mergeReservations(reservations: ExistingReservation[]) {
  const overlaps = reservations
    .map((r) => ({
      start: parseDateTime(r.start),
      end: endToExclusive(r.end),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: { start: Date; end: Date }[] = [];
  for (const item of overlaps) {
    const last = merged[merged.length - 1];
    if (!last || item.start.getTime() > last.end.getTime()) {
      merged.push({ ...item });
    } else if (item.end.getTime() > last.end.getTime()) {
      last.end = item.end;
    }
  }
  return merged;
}

export function subtractPeriods(base: TimePeriod, reservations: ExistingReservation[]): TimePeriod[] {
  const baseStart = parseDateTime(base.start);
  const baseEndExclusive = endToExclusive(base.end);

  const overlaps = reservations
    .map((r) => ({
      start: parseDateTime(r.start),
      end: endToExclusive(r.end),
    }))
    .filter((r) => r.start < baseEndExclusive && r.end > baseStart)
    .map((r) => ({
      start: new Date(Math.max(r.start.getTime(), baseStart.getTime())),
      end: new Date(Math.min(r.end.getTime(), baseEndExclusive.getTime())),
    }))
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const merged: { start: Date; end: Date }[] = [];
  for (const item of overlaps) {
    const last = merged[merged.length - 1];
    if (!last || item.start.getTime() > last.end.getTime()) {
      merged.push({ ...item });
    } else if (item.end.getTime() > last.end.getTime()) {
      last.end = item.end;
    }
  }

  const result: TimePeriod[] = [];
  let cursor = baseStart;

  for (const blocked of merged) {
    if (blocked.start.getTime() > cursor.getTime()) {
      const part = normalizePeriod(cursor, blocked.start);
      if (part) result.push(part);
    }
    if (blocked.end.getTime() > cursor.getTime()) {
      cursor = blocked.end;
    }
  }

  if (cursor.getTime() < baseEndExclusive.getTime()) {
    const part = normalizePeriod(cursor, baseEndExclusive);
    if (part) result.push(part);
  }

  return result;
}

export function buildContinuousUntilFirstBlock(
  wanted: TimePeriod,
  blockers: ExistingReservation[],
): TimePeriod[] {
  const wantedStart = parseDateTime(wanted.start);
  const wantedEndExclusive = endToExclusive(wanted.end);
  const merged = mergeReservations(blockers);

  for (const blocked of merged) {
    if (blocked.end <= wantedStart) continue;
    if (blocked.start >= wantedEndExclusive) break;

    if (blocked.start <= wantedStart) {
      return [];
    }

    const part = normalizePeriod(wantedStart, blocked.start);
    return part ? [part] : [];
  }

  const full = normalizePeriod(wantedStart, wantedEndExclusive);
  return full ? [full] : [];
}

export function buildPeriodsForAsset(
  wanted: TimePeriod,
  existing: ExistingReservation[],
  currentUser: string,
  continuousCutMode: boolean,
): TimePeriod[] {
  const blockers = existing.filter((r) => r.userName !== currentUser);
  const own = existing.filter((r) => r.userName === currentUser);

  const basePeriods = continuousCutMode
    ? buildContinuousUntilFirstBlock(wanted, blockers)
    : subtractPeriods(wanted, blockers);

  const result: TimePeriod[] = [];
  for (const base of basePeriods) {
    result.push(...subtractPeriods(base, own));
  }
  return result;
}

export function splitPeriodForWeek(period: TimePeriod, weekStart: Date) {
  const start = parseDateTime(period.start);
  const end = parseDateTime(period.end);
  const weekEnd = endOfDayInclusive(addDays(weekStart, 6));

  if (end < weekStart || start > weekEnd) return [];

  const clippedStart = start < weekStart ? weekStart : start;
  const clippedEnd = end > weekEnd ? weekEnd : end;

  const parts: TimePeriod[] = [];
  let currentDay = startOfDay(clippedStart);
  const finalDay = startOfDay(clippedEnd);

  while (currentDay.getTime() <= finalDay.getTime()) {
    const partStart = isSameDay(currentDay, clippedStart) ? clippedStart : currentDay;
    const partEnd = isSameDay(currentDay, clippedEnd) ? clippedEnd : endOfDayInclusive(currentDay);
    parts.push({
      start: formatDateTime(partStart),
      end: formatDateTime(partEnd),
    });
    currentDay = addDays(currentDay, 1);
  }

  return parts;
}

export function periodToDisplayRect(period: TimePeriod, weekStart: Date) {
  const start = parseDateTime(period.start);
  const end = parseDateTime(period.end);

  const dayIndex = Math.floor((startOfDay(start).getTime() - startOfDay(weekStart).getTime()) / (24 * 60 * 60 * 1000));
  const top = start.getHours() * HOUR_ROW_PX + (start.getMinutes() / 60) * HOUR_ROW_PX;
  const bottom = end.getHours() * HOUR_ROW_PX + (end.getMinutes() / 60) * HOUR_ROW_PX;
  const height = Math.max(HOUR_ROW_PX * 0.8, bottom - top + 1);

  return { dayIndex, top, height, start, end };
}

export function clampHourIndex(v: number) {
  return Math.max(0, Math.min(24 * 7 - 1, v));
}

export function formatDayHeader(date: Date) {
  return `${DAY_NAMES[(date.getDay() + 6) % 7]} ${pad(date.getDate())}.${pad(date.getMonth() + 1)}`;
}

export function buildMovedRange(range: TimePeriod, deltaHours: number): TimePeriod {
  const start = addHours(parseDateTime(range.start), deltaHours);
  const endExclusive = addHours(endToExclusive(range.end), deltaHours);

  return {
    start: formatDateTime(startOfHour(start)),
    end: formatDateTime(toInclusiveEndFromExclusive(endExclusive)),
  };
}

export function buildResizeStartRange(range: TimePeriod, deltaHours: number): TimePeriod {
  const oldStart = parseDateTime(range.start);
  const endExclusive = endToExclusive(range.end);
  const nextStart = addHours(oldStart, deltaHours);

  if (nextStart >= endExclusive) {
    return buildOneHourPeriod(oldStart);
  }

  return {
    start: formatDateTime(startOfHour(nextStart)),
    end: range.end,
  };
}

export function buildResizeEndRange(range: TimePeriod, deltaHours: number): TimePeriod {
  const start = parseDateTime(range.start);
  const oldEndExclusive = endToExclusive(range.end);
  const nextEndExclusive = addHours(oldEndExclusive, deltaHours);

  if (nextEndExclusive <= addHours(start, 1)) {
    return buildOneHourPeriod(start);
  }

  return {
    start: range.start,
    end: formatDateTime(toInclusiveEndFromExclusive(nextEndExclusive)),
  };
}

export function normalizePeriodsForKey(periods: TimePeriod[]) {
  return [...periods]
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .map((p) => `${p.start}|${p.end}`)
    .join(';');
}

export function clampRangeToMinStart(range: TimePeriod, minStart: Date): TimePeriod | null {
  const start = parseDateTime(range.start);
  const endExclusive = endToExclusive(range.end);
  const clampedStart = start < minStart ? minStart : start;

  if (endExclusive <= clampedStart) return null;

  return {
    start: formatDateTime(startOfHour(clampedStart)),
    end: formatDateTime(toInclusiveEndFromExclusive(endExclusive)),
  };
}

export function spanWeeks(period: TimePeriod) {
  const start = parseDateTime(period.start);
  const endExclusive = endToExclusive(period.end);
  const ms = endExclusive.getTime() - start.getTime();
  const days = Math.max(1, Math.ceil(ms / (24 * 60 * 60 * 1000)));
  return Math.max(1, Math.ceil(days / 7));
}

export function dateLabel(period: SelectionPeriodDef) {
  if (!period.requestedRange) return 'empty';
  return `${period.requestedRange.start} → ${period.requestedRange.end}`;
}

export function dateInPeriodDay(period: TimePeriod, date: Date) {
  const s = parseDateTime(period.start);
  const e = parseDateTime(period.end);
  return date >= startOfDay(s) && date <= endOfDayInclusive(e);
}

export function blockerOverlapExists(
  wanted: TimePeriod,
  existing: ExistingReservation[],
  currentUser: string,
): boolean {
  const ws = parseDateTime(wanted.start);
  const we = endToExclusive(wanted.end);
  return existing.some((r) => {
    if (r.userName === currentUser) return false;
    const rs = parseDateTime(r.start);
    const re = endToExclusive(r.end);
    return rs < we && re > ws;
  });
}

export function periodStatusForId(
  period: SelectionPeriodDef,
  assets: Asset[],
  draftsByAssetByPeriodId: Record<string, Record<string, TimePeriod[]>>,
  currentUser: string,
): PeriodStatus {
  if (!period.requestedRange) return 'neutral';

  const byAsset = draftsByAssetByPeriodId[period.id] ?? {};
  const totalAccepted = assets.reduce((sum, asset) => sum + (byAsset[asset.id]?.length ?? 0), 0);

  if (totalAccepted === 0) return 'error';

  const hasBlockerOverlap = assets.some((asset) =>
    blockerOverlapExists(period.requestedRange!, asset.existingPeriods, currentUser),
  );

  return hasBlockerOverlap ? 'warning' : 'good';
}

export function periodsToOutput(
  assets: Asset[],
  draftsByAssetByPeriodId: Record<string, Record<string, TimePeriod[]>>,
): SelectedAssetPeriods[] {
  return assets.map((asset) => {
    const selectedPeriods = Object.values(draftsByAssetByPeriodId).flatMap(
      (byAsset) => byAsset[asset.id] ?? [],
    );

    return {
      id: asset.id,
      name: asset.name,
      selectedPeriods,
    };
  });
}

export function buildDraftGroups(
  assets: Asset[],
  periods: SelectionPeriodDef[],
  draftsByAssetByPeriodId: Record<string, Record<string, TimePeriod[]>>,
  currentUser: string,
) {
  const groups: Array<{
    periodId: string;
    groupKey: string;
    assets: Asset[];
    periods: TimePeriod[];
    status: PeriodStatus;
  }> = [];

  for (const period of periods) {
    const byAsset = draftsByAssetByPeriodId[period.id] ?? {};
    const status = periodStatusForId(period, assets, draftsByAssetByPeriodId, currentUser);
    const groupMap = new Map<string, any>();

    for (const asset of assets) {
      const selected = byAsset[asset.id] ?? [];
      if (selected.length === 0) continue;

      const key = normalizePeriodsForKey(selected);
      const existing = groupMap.get(key);

      if (existing) {
        existing.assets.push(asset);
      } else {
        groupMap.set(key, {
          periodId: period.id,
          groupKey: `${period.id}::${key}`,
          assets: [asset],
          periods: selected,
          status,
        });
      }
    }

    groups.push(...groupMap.values());
  }

  return groups;
}

export function monthDayResolutionBlock(start: Date, end: Date, date: Date) {
  const sameStartDay = isSameDay(date, start);
  const sameEndDay = isSameDay(date, end);

  const dayStartHour = sameStartDay ? start.getHours() + start.getMinutes() / 60 : 0;
  const dayEndHour = sameEndDay ? end.getHours() + (end.getMinutes() + 1) / 60 : 24;

  const startSlot = Math.max(0, Math.floor(dayStartHour / MONTH_SLOT_HOURS));
  const endSlot = Math.min(MONTH_SLOT_COUNT, Math.ceil(dayEndHour / MONTH_SLOT_HOURS));
  const widthSlots = Math.max(1, endSlot - startSlot);

  return {
    leftPct: (startSlot / MONTH_SLOT_COUNT) * 100,
    widthPct: (widthSlots / MONTH_SLOT_COUNT) * 100,
  };
}