import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Asset,
  CalendarInput,
  CalendarOutput,
  CalendarViewMode,
  DraftGroup,
  ExistingGroup,
  ExistingReservation,
  OutputAssetPeriods,
  PeriodStatus,
  SelectionPeriodDef,
  TimePeriod,
} from './internalTypesCompat';
import MonthOverview from './MonthOverview';
import {
  HOURS,
  HOUR_ROW_PX,
  addDays,
  addHours,
  addMinutes,
  addWeeks,
  buildDraftGroups,
  buildMovedRange,
  buildOneHourPeriod,
  buildPeriodsForAsset,
  buildResizeEndRange,
  buildResizeStartRange,
  clampHourIndex,
  clampRangeToMinStart,
  dateLabel,
  endOfDayInclusive,
  endToExclusive,
  formatDayHeader,
  formatDateTime,
  getWeekDays,
  getWeekStart,
  normalizePeriod,
  parseDateTime,
  periodStatusForId,
  periodToDisplayRect,
  periodsToOutput,
  spanWeeks,
  splitPeriodForWeek,
  startOfDay,
  startOfHour,
  subtractPeriods,
} from './calendarUtils';
import './assetCalendar.css';

type DragKind = 'move' | 'resize-start' | 'resize-end';

type DragState = {
  kind: DragKind;
  startMouseHour: number;
  originalRange: TimePeriod;
  periodId: string;
};

type InternalSelectionPeriodDef = SelectionPeriodDef & {
  sortOrder: number;
};

type InternalDayBar = {
  id: string;
  periodId?: string;
  columnKey?: string;
  type: 'existing' | 'draft';
  dayIndex: number;
  start: Date;
  end: Date;
  top: number;
  height: number;
  color: string;
  label: string;
  tooltip: string;
  sortEnd: number;
  status?: PeriodStatus;
  showWarning?: boolean;
};

type InternalPositionedDayBar = InternalDayBar & {
  leftPct: number;
  widthPct: number;
};

type EditSelection = {
  assetId: string;
  userName: string;
  index: number;
} | null;

type AddEditTarget = {
  assetId: string;
  userName: string;
} | null;

const TIME_COL_W = 62;
const HEADER_H = 42;
const DEFAULT_COLORS = [
  '#2563eb',
  '#16a34a',
  '#dc2626',
  '#9333ea',
  '#ea580c',
  '#0891b2',
  '#ca8a04',
  '#be185d',
];
const MAX_VISUAL_ASSETS = 8;
const MAX_VISIBLE_GROUPS = 8;

function modeIsColorDense(mode: CalendarInput['mode']) {
  return mode === 'view' || mode === 'edit';
}

function subtractTimePeriods(basePeriods: TimePeriod[], blockedPeriods: TimePeriod[]): TimePeriod[] {
  if (basePeriods.length === 0 || blockedPeriods.length === 0) return basePeriods;

  const blockedReservations = blockedPeriods.map((period) => ({
    start: period.start,
    end: period.end,
    userName: '__draft__',
  }));

  return basePeriods.flatMap((period) => subtractPeriods(period, blockedReservations));
}

function getEditableUsers(input: CalendarInput): string[] {
  if (Array.isArray(input.currentUsers) && input.currentUsers.length > 0) {
    return [...new Set(input.currentUsers)];
  }
  if (input.currentUser && input.currentUser.trim().length > 0) {
    return [input.currentUser];
  }
  return [];
}

function normalizePeriodsKey(periods: TimePeriod[]): string {
  return [...periods]
    .sort((a, b) => a.start.localeCompare(b.start) || a.end.localeCompare(b.end))
    .map((p) => `${p.start}|${p.end}`)
    .join(';');
}

function earliestEndOfPeriods(periods: TimePeriod[]): number {
  if (periods.length === 0) return Number.MAX_SAFE_INTEGER;
  return Math.min(...periods.map((p) => parseDateTime(p.end).getTime()));
}

function createPeriodId(nextPeriodNumberRef: React.MutableRefObject<number>) {
  const id = `p${nextPeriodNumberRef.current}`;
  nextPeriodNumberRef.current += 1;
  return id;
}

function assetSetColumnKey(assets: Asset[]) {
  return assets
    .map((asset) => asset.id)
    .sort()
    .join('|');
}

function layoutDraftColumns(dayBars: InternalDayBar[]): InternalPositionedDayBar[] {
  if (dayBars.length === 0) return [];

  const byColumnKey = new Map<string, InternalDayBar[]>();

  for (const bar of dayBars) {
    const key = bar.columnKey ?? bar.id;
    const arr = byColumnKey.get(key) ?? [];
    arr.push(bar);
    byColumnKey.set(key, arr);
  }

  const columns = [...byColumnKey.entries()].map(([key, bars]) => {
    const earliestEnd = Math.min(...bars.map((b: InternalDayBar) => b.sortEnd));
    return { key, bars, earliestEnd };
  });

  columns.sort((a, b) => a.earliestEnd - b.earliestEnd);

  const laneCount = columns.length;
  const widthPct = 100 / Math.max(laneCount, 1);

  const positioned: InternalPositionedDayBar[] = [];

  columns.forEach((column, index) => {
    const leftPct = (laneCount - 1 - index) * widthPct;
    column.bars.forEach((bar: InternalDayBar) => {
      positioned.push({
        ...bar,
        leftPct,
        widthPct,
      });
    });
  });

  return positioned;
}

function layoutExistingColumns(dayBars: InternalDayBar[]): InternalPositionedDayBar[] {
  if (dayBars.length === 0) return [];

  const sorted = [...dayBars].sort((a, b) => {
    const s = a.start.getTime() - b.start.getTime();
    if (s !== 0) return s;
    return a.end.getTime() - b.end.getTime();
  });

  const groups: InternalDayBar[][] = [];
  let currentGroup: InternalDayBar[] = [];
  let currentGroupMaxEnd = -Infinity;

  for (const bar of sorted) {
    if (currentGroup.length === 0) {
      currentGroup = [bar];
      currentGroupMaxEnd = bar.end.getTime();
      continue;
    }

    if (bar.start.getTime() < currentGroupMaxEnd) {
      currentGroup.push(bar);
      currentGroupMaxEnd = Math.max(currentGroupMaxEnd, bar.end.getTime());
    } else {
      groups.push(currentGroup);
      currentGroup = [bar];
      currentGroupMaxEnd = bar.end.getTime();
    }
  }

  if (currentGroup.length > 0) groups.push(currentGroup);

  const positioned: InternalPositionedDayBar[] = [];

  for (const group of groups) {
    const ordered = [...group].sort((a, b) => {
      const endDiff = a.sortEnd - b.sortEnd;
      if (endDiff !== 0) return endDiff;
      return a.start.getTime() - b.start.getTime();
    });

    const laneCount = ordered.length;
    const widthPct = 100 / Math.max(laneCount, 1);

    ordered.forEach((bar, index) => {
      const leftPct = 100 - laneCount * widthPct + index * widthPct;
      positioned.push({
        ...bar,
        leftPct,
        widthPct,
      });
    });
  }

  return positioned;
}

function buildExistingGroups(assets: Asset[]): ExistingGroup[] {
  const map = new Map<string, ExistingGroup>();

  for (const asset of assets) {
    for (const reservation of asset.existingPeriods) {
      const key = `${reservation.start}|${reservation.end}`;
      const existing = map.get(key);

      if (existing) {
        existing.entries.push({ asset, reservation });
      } else {
        map.set(key, {
          groupKey: key,
          entries: [{ asset, reservation }],
          period: { start: reservation.start, end: reservation.end },
        });
      }
    }
  }

  return [...map.values()];
}

function buildInitialEditPeriodsByAssetUser(
  assets: Asset[],
  editableUsers: string[],
): Record<string, Record<string, TimePeriod[]>> {
  const editableSet = new Set(editableUsers);
  const result: Record<string, Record<string, TimePeriod[]>> = {};

  for (const asset of assets) {
    result[asset.id] = {};
    for (const userName of editableUsers) {
      result[asset.id][userName] = [];
    }
    for (const reservation of asset.existingPeriods) {
      if (editableSet.has(reservation.userName)) {
        result[asset.id][reservation.userName].push({
          start: reservation.start,
          end: reservation.end,
        });
      }
    }
  }

  return result;
}

function getBlockedReservationsForAsset(
  asset: Asset,
  editableUsers: string[],
): ExistingReservation[] {
  const editableSet = new Set(editableUsers);
  return asset.existingPeriods.filter((p) => !editableSet.has(p.userName));
}

function clampEditPeriodWithinAsset(
  editableByUser: Record<string, TimePeriod[]>,
  blockedReservations: ExistingReservation[],
  skipUserName: string,
  skipIndex: number,
  proposed: TimePeriod,
): TimePeriod | null {
  let start = parseDateTime(proposed.start);
  let endExclusive = endToExclusive(proposed.end);

  const others: Array<{ start: Date; end: Date }> = [];

  Object.entries(editableByUser).forEach(([userName, periods]) => {
    periods.forEach((p, index) => {
      if (userName === skipUserName && index === skipIndex) return;
      others.push({
        start: parseDateTime(p.start),
        end: endToExclusive(p.end),
      });
    });
  });

  blockedReservations.forEach((p) => {
    others.push({
      start: parseDateTime(p.start),
      end: endToExclusive(p.end),
    });
  });

  others.sort((a, b) => a.start.getTime() - b.start.getTime());

  const prev = [...others]
    .filter((p) => p.start.getTime() < start.getTime())
    .sort((a, b) => b.start.getTime() - a.start.getTime())[0];

  if (prev && prev.end.getTime() > start.getTime()) {
    start = new Date(prev.end);
  }

  const next = others.find((p) => p.start.getTime() > start.getTime());

  if (next && endExclusive.getTime() > next.start.getTime()) {
    endExclusive = new Date(next.start);
  }

  const normalized = normalizePeriod(start, endExclusive);
  if (!normalized) return null;
  return normalized;
}

function applyGroupLimitToSelections(
  byAsset: Record<string, TimePeriod[]>,
  assets: Asset[],
) {
  const groupMap = new Map<
    string,
    { periods: TimePeriod[]; assetIds: string[]; earliestEnd: number }
  >();

  for (const asset of assets) {
    const periods = byAsset[asset.id] ?? [];
    if (periods.length === 0) continue;
    const key = normalizePeriodsKey(periods);
    const existing = groupMap.get(key);
    if (existing) {
      existing.assetIds.push(asset.id);
    } else {
      groupMap.set(key, {
        periods,
        assetIds: [asset.id],
        earliestEnd: earliestEndOfPeriods(periods),
      });
    }
  }

  const groups = [...groupMap.values()].sort((a, b) => a.earliestEnd - b.earliestEnd);

  if (groups.length <= MAX_VISIBLE_GROUPS) {
    return {
      byAsset,
      wasLimited: false,
    };
  }

  const cutoffPeriods = groups[MAX_VISIBLE_GROUPS - 1].periods;
  const keepKeys = new Set(
    groups.slice(0, MAX_VISIBLE_GROUPS).map((g) => normalizePeriodsKey(g.periods)),
  );

  const nextByAsset: Record<string, TimePeriod[]> = { ...byAsset };

  for (const asset of assets) {
    const periods = byAsset[asset.id] ?? [];
    if (periods.length === 0) continue;
    const key = normalizePeriodsKey(periods);
    if (!keepKeys.has(key)) {
      nextByAsset[asset.id] = cutoffPeriods;
    }
  }

  return {
    byAsset: nextByAsset,
    wasLimited: true,
  };
}

export default function AssetCalendar({
  input,
  initialViewMode = 'week',
  onConfirm,
}: {
  input: CalendarInput;
  initialViewMode?: CalendarViewMode;
  onConfirm?: (output: CalendarOutput) => void;
}) {
  const mode = input.mode;
  const editableUsers = useMemo(() => getEditableUsers(input), [input]);
  const primaryUser = editableUsers[0] ?? '';

  const nextPeriodNumberRef = useRef(2);
  const nextSortOrderRef = useRef(2);

  const [viewMode, setViewMode] = useState<CalendarViewMode>(initialViewMode);
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [periods, setPeriods] = useState<InternalSelectionPeriodDef[]>([
    { id: 'p1', requestedRange: null, sortOrder: 1 },
  ]);
  const [activePeriodId, setActivePeriodId] = useState('p1');
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [now, setNow] = useState(new Date());
  const [repeatEveryWeeks, setRepeatEveryWeeks] = useState(1);
  const [repeatCount, setRepeatCount] = useState(1);

  const [editPeriodsByAssetUser, setEditPeriodsByAssetUser] = useState<
    Record<string, Record<string, TimePeriod[]>>
  >({});
  const [selectedEditPeriod, setSelectedEditPeriod] = useState<EditSelection>(null);
  const [addForTarget, setAddForTarget] = useState<AddEditTarget>(null);

  const gridRef = useRef<HTMLDivElement | null>(null);

  const assets = useMemo(
    () =>
      input.assets.map((asset: Asset, index: number) => ({
        ...asset,
        color: asset.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      })),
    [input.assets],
  );

  const visualAssets = useMemo(
    () => (modeIsColorDense(mode) ? assets.slice(0, MAX_VISUAL_ASSETS) : assets),
    [assets, mode],
  );

  const omittedAssets = useMemo(
    () => (modeIsColorDense(mode) ? assets.slice(MAX_VISUAL_ASSETS) : []),
    [assets, mode],
  );

  useEffect(() => {
    if (mode === 'edit') {
      setEditPeriodsByAssetUser(buildInitialEditPeriodsByAssetUser(assets, editableUsers));
      setSelectedEditPeriod(null);
      setAddForTarget(null);
    }
  }, [assets, editableUsers, mode]);

  const weekStart = useMemo(() => getWeekStart(anchorDate), [anchorDate]);
  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);
  const minSelectableStart = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0),
    [now],
  );

  const activePeriod =
    periods.find((p: InternalSelectionPeriodDef) => p.id === activePeriodId) ?? periods[0] ?? null;

  const draftsByAssetByPeriodId = useMemo(() => {
    const result: Record<string, Record<string, TimePeriod[]>> = {};
    const acceptedDraftsByAsset: Record<string, TimePeriod[]> = {};

    const orderedPeriods = [...periods].sort((a, b) => a.sortOrder - b.sortOrder);

    for (const period of orderedPeriods) {
      const range =
        mode === 'checkout'
          ? period.requestedRange
            ? {
                start: formatDateTime(minSelectableStart),
                end: period.requestedRange.end,
              }
            : null
          : period.requestedRange;

      if (!range) {
        result[period.id] = {};
        continue;
      }

      const safeRange = clampRangeToMinStart(range, minSelectableStart);
      if (!safeRange) {
        result[period.id] = {};
        continue;
      }

      const byAsset: Record<string, TimePeriod[]> = {};

      for (const asset of visualAssets) {
        const basePeriods = buildPeriodsForAsset(
          safeRange,
          asset.existingPeriods,
          primaryUser,
          input.continuousCutMode ?? true,
        );

        const earlierAcceptedForAsset = acceptedDraftsByAsset[asset.id] ?? [];
        const legalized = subtractTimePeriods(basePeriods, earlierAcceptedForAsset);

        byAsset[asset.id] = legalized;
        acceptedDraftsByAsset[asset.id] = [
          ...(acceptedDraftsByAsset[asset.id] ?? []),
          ...legalized,
        ];
      }

      result[period.id] =
        mode === 'reserve' || mode === 'checkout'
          ? applyGroupLimitToSelections(byAsset, visualAssets).byAsset
          : byAsset;
    }

    return result;
  }, [
    periods,
    visualAssets,
    mode,
    minSelectableStart,
    primaryUser,
    input.continuousCutMode,
  ]);

  const selectionGroupLimitMessage = useMemo(() => {
    if (mode !== 'reserve' && mode !== 'checkout') return '';

    for (const period of periods) {
      const range =
        mode === 'checkout'
          ? period.requestedRange
            ? {
                start: formatDateTime(minSelectableStart),
                end: period.requestedRange.end,
              }
            : null
          : period.requestedRange;

      if (!range) continue;
      const safeRange = clampRangeToMinStart(range, minSelectableStart);
      if (!safeRange) continue;

      const byAsset: Record<string, TimePeriod[]> = {};
      for (const asset of visualAssets) {
        byAsset[asset.id] = buildPeriodsForAsset(
          safeRange,
          asset.existingPeriods,
          primaryUser,
          input.continuousCutMode ?? true,
        );
      }

      const limited = applyGroupLimitToSelections(byAsset, visualAssets);
      if (limited.wasLimited) {
        return `The selected assets would split into more than ${MAX_VISIBLE_GROUPS} different visible bars, so the preview has been gently limited to keep the calendar readable.`;
      }
    }

    return '';
  }, [mode, periods, minSelectableStart, visualAssets, primaryUser, input.continuousCutMode]);

  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(id);
  }, []);

  useEffect(() => {
    if (mode !== 'checkout') return;

    const currentHourPeriod: TimePeriod = {
      start: formatDateTime(minSelectableStart),
      end: formatDateTime(addMinutes(addHours(minSelectableStart, 1), -1)),
    };

    setPeriods((prev) => {
      const hasAnyRange = prev.some((p) => p.requestedRange !== null);

      if (hasAnyRange) {
        return prev.map((p, index) =>
          index === 0 && p.requestedRange === null
            ? {
                ...p,
                requestedRange: currentHourPeriod,
                sortOrder: nextSortOrderRef.current++,
              }
            : p,
        );
      }

      return prev.map((p, index) =>
        index === 0
          ? {
              ...p,
              requestedRange: currentHourPeriod,
              sortOrder: nextSortOrderRef.current++,
            }
          : p,
      );
    });
  }, [mode, minSelectableStart]);

  const updatePeriodRange = (periodId: string, nextRange: TimePeriod | null) => {
    setPeriods((prev) =>
      prev.map((p) =>
        p.id === periodId
          ? {
              ...p,
              requestedRange: nextRange,
              sortOrder: nextRange ? nextSortOrderRef.current++ : p.sortOrder,
            }
          : p,
      ),
    );
  };

  const updateEditPeriodRange = (
    assetId: string,
    userName: string,
    index: number,
    nextRange: TimePeriod | null,
  ) => {
    setEditPeriodsByAssetUser((prev) => {
      const assetBlock = { ...(prev[assetId] ?? {}) };
      const userPeriods = [...(assetBlock[userName] ?? [])];
      const blocked = getBlockedReservationsForAsset(
        visualAssets.find((a) => a.id === assetId) as Asset,
        editableUsers,
      );

      if (nextRange === null) {
        userPeriods.splice(index, 1);
        assetBlock[userName] = userPeriods;
        return {
          ...prev,
          [assetId]: assetBlock,
        };
      }

      const clamped = clampEditPeriodWithinAsset(
        assetBlock,
        blocked,
        userName,
        index,
        nextRange,
      );
      if (!clamped) return prev;

      userPeriods[index] = clamped;
      assetBlock[userName] = userPeriods;

      return {
        ...prev,
        [assetId]: assetBlock,
      };
    });
  };

  const resetActivePeriod = () => {
    if (mode === 'edit') {
      if (!selectedEditPeriod) return;
      updateEditPeriodRange(
        selectedEditPeriod.assetId,
        selectedEditPeriod.userName,
        selectedEditPeriod.index,
        null,
      );
      setSelectedEditPeriod(null);
      return;
    }

    if (!activePeriod) return;

    if (mode === 'checkout') {
      const currentHourPeriod: TimePeriod = {
        start: formatDateTime(minSelectableStart),
        end: formatDateTime(addMinutes(addHours(minSelectableStart, 1), -1)),
      };
      updatePeriodRange(activePeriod.id, currentHourPeriod);
      return;
    }

    if (mode === 'reserve') {
      removePeriod(activePeriod.id);
    }
  };

  useEffect(() => {
    if (!dragState) return;

    const onMove = (event: MouseEvent) => {
      if (!gridRef.current) return;
      if (mode === 'checkout' && dragState.kind === 'move') return;
      if (mode === 'checkout' && dragState.kind === 'resize-start') return;

      const rect = gridRef.current.getBoundingClientRect();
      const x = event.clientX - rect.left - TIME_COL_W;
      const y = event.clientY - rect.top - HEADER_H;

      const colWidth = (rect.width - TIME_COL_W) / 7;
      const dayIndex = Math.max(0, Math.min(6, Math.floor(x / colWidth)));
      const hourIndex = Math.max(0, Math.min(23, Math.floor(y / HOUR_ROW_PX)));
      const absoluteHour = dayIndex * 24 + hourIndex;
      const deltaHours = clampHourIndex(absoluteHour) - dragState.startMouseHour;

      let nextRange = dragState.originalRange;

      if (dragState.kind === 'move') {
        nextRange = buildMovedRange(dragState.originalRange, deltaHours);
      } else if (dragState.kind === 'resize-start') {
        nextRange = buildResizeStartRange(dragState.originalRange, deltaHours);
      } else if (dragState.kind === 'resize-end') {
        nextRange = buildResizeEndRange(dragState.originalRange, deltaHours);
      }

      if (mode === 'checkout') {
        nextRange = {
          start: formatDateTime(minSelectableStart),
          end: nextRange.end,
        };
      }

      if (mode === 'edit') {
        const [assetId, userName, indexText] = dragState.periodId.split('__');
        updateEditPeriodRange(assetId, userName, Number(indexText), nextRange);
        return;
      }

      const safe = clampRangeToMinStart(nextRange, minSelectableStart);
      if (!safe) return;

      updatePeriodRange(dragState.periodId, safe);
    };

    const onUp = () => setDragState(null);

    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [dragState, mode, minSelectableStart, visualAssets, editableUsers]);

  const handleCellClick = (date: Date) => {
    if (mode === 'view' || !gridRef.current) return;

    const clickedHour = startOfHour(date);

      if (mode === 'edit') {
        if (addForTarget) {
          const proposed = buildOneHourPeriod(clickedHour);
          const asset = visualAssets.find((a) => a.id === addForTarget.assetId);
          if (!asset) return;

          setEditPeriodsByAssetUser((prev) => {
            const assetBlock = { ...(prev[addForTarget.assetId] ?? {}) };
            const userPeriods = [...(assetBlock[addForTarget.userName] ?? [])];
            userPeriods.push(proposed);
            const newIndex = userPeriods.length - 1;
            assetBlock[addForTarget.userName] = userPeriods;

            const blocked = getBlockedReservationsForAsset(asset, editableUsers);
            const clamped = clampEditPeriodWithinAsset(
              assetBlock,
              blocked,
              addForTarget.userName,
              newIndex,
              proposed,
            );
            if (!clamped) return prev;

            userPeriods[newIndex] = clamped;
            assetBlock[addForTarget.userName] = userPeriods;

            return {
              ...prev,
              [addForTarget.assetId]: assetBlock,
            };
          });

          const newIndex =
            editPeriodsByAssetUser[addForTarget.assetId]?.[addForTarget.userName]?.length ?? 0;

          setSelectedEditPeriod({
            assetId: addForTarget.assetId,
            userName: addForTarget.userName,
            index: newIndex,
          });
          setAddForTarget(null);
          return;
        }

        if (!selectedEditPeriod) return;

        const selectedRange =
          editPeriodsByAssetUser[selectedEditPeriod.assetId]?.[selectedEditPeriod.userName]?.[
            selectedEditPeriod.index
          ] ?? null;

        if (!selectedRange) return;

        const currentStart = parseDateTime(selectedRange.start);
        const currentEnd = parseDateTime(selectedRange.end);

        if (clickedHour < currentStart) {
          updateEditPeriodRange(
            selectedEditPeriod.assetId,
            selectedEditPeriod.userName,
            selectedEditPeriod.index,
            {
              start: formatDateTime(clickedHour),
              end: formatDateTime(currentEnd),
            },
          );
          return;
        }

        if (clickedHour > currentEnd) {
          updateEditPeriodRange(
            selectedEditPeriod.assetId,
            selectedEditPeriod.userName,
            selectedEditPeriod.index,
            {
              start: formatDateTime(currentStart),
              end: formatDateTime(addMinutes(addHours(clickedHour, 1), -1)),
            },
          );
        }

        return;
      }

    if (!activePeriod) return;
    if (clickedHour < minSelectableStart) return;

    if (mode === 'checkout') {
      const start = minSelectableStart;
      const end = clickedHour < start ? start : clickedHour;
      updatePeriodRange(activePeriod.id, {
        start: formatDateTime(start),
        end: formatDateTime(addMinutes(addHours(end, 1), -1)),
      });
      return;
    }

    if (!activePeriod.requestedRange) {
      updatePeriodRange(activePeriod.id, buildOneHourPeriod(clickedHour));
      return;
    }

    const currentStart = parseDateTime(activePeriod.requestedRange.start);
    const currentEnd = parseDateTime(activePeriod.requestedRange.end);

    if (clickedHour < currentStart) {
      updatePeriodRange(activePeriod.id, {
        start: formatDateTime(clickedHour),
        end: formatDateTime(currentEnd),
      });
      return;
    }

    if (clickedHour > currentEnd) {
      updatePeriodRange(activePeriod.id, {
        start: formatDateTime(currentStart),
        end: formatDateTime(addMinutes(addHours(clickedHour, 1), -1)),
      });
    }
  };

  const beginDrag = (
    kind: DragKind,
    event: React.MouseEvent,
    periodId: string,
    dragRange?: TimePeriod,
  ) => {
    let baseRange: TimePeriod | null = dragRange ?? null;

    if (!baseRange) {
      if (mode === 'edit') {
        const [assetId, userName, indexText] = periodId.split('__');
        baseRange = editPeriodsByAssetUser[assetId]?.[userName]?.[Number(indexText)] ?? null;
      } else {
        const targetPeriod = periods.find((p) => p.id === periodId);
        baseRange = targetPeriod?.requestedRange ?? null;
      }
    }

    if (!baseRange) return;
    if (mode === 'checkout' && kind !== 'resize-end') return;

    event.preventDefault();
    event.stopPropagation();

    const rect = gridRef.current?.getBoundingClientRect();
    if (!rect) return;

    const x = event.clientX - rect.left - TIME_COL_W;
    const y = event.clientY - rect.top - HEADER_H;
    const colWidth = (rect.width - TIME_COL_W) / 7;
    const dayIndex = Math.max(0, Math.min(6, Math.floor(x / colWidth)));
    const hourIndex = Math.max(0, Math.min(23, Math.floor(y / HOUR_ROW_PX)));
    const absoluteHour = dayIndex * 24 + hourIndex;

    setDragState({
      kind,
      startMouseHour: absoluteHour,
      originalRange: baseRange,
      periodId,
    });
  };

  const addNewPeriod = () => {
    if (mode !== 'reserve') return;
    const id = createPeriodId(nextPeriodNumberRef);
    const sortOrder = nextSortOrderRef.current++;
    setPeriods((prev) => [...prev, { id, requestedRange: null, sortOrder }]);
    setActivePeriodId(id);
  };

  const toggleAddForTarget = (assetId: string, userName: string) => {
    setAddForTarget((prev) =>
      prev?.assetId === assetId && prev?.userName === userName ? null : { assetId, userName },
    );
    setSelectedEditPeriod(null);
  };

  const applyRepeat = () => {
    if (mode !== 'reserve' || !activePeriod?.requestedRange) return;

    const baseStart = parseDateTime(activePeriod.requestedRange.start);
    const baseEndExclusive = endToExclusive(activePeriod.requestedRange.end);

    const nextItems: InternalSelectionPeriodDef[] = [];
    for (let i = 1; i < repeatCount; i++) {
      const shiftedStart = addWeeks(baseStart, i * repeatEveryWeeks);
      const shiftedEndExclusive = addWeeks(baseEndExclusive, i * repeatEveryWeeks);

      nextItems.push({
        id: createPeriodId(nextPeriodNumberRef),
        sortOrder: nextSortOrderRef.current++,
        requestedRange: {
          start: formatDateTime(shiftedStart),
          end: formatDateTime(addMinutes(shiftedEndExclusive, -1)),
        },
      });
    }

    setPeriods((prev) => [...prev, ...nextItems]);
  };

  function removePeriod(periodId: string) {
    setPeriods((prev) => {
      const filtered = prev.filter((p) => p.id !== periodId);

      if (filtered.length === 0) {
        const replacementId = createPeriodId(nextPeriodNumberRef);
        const replacement = {
          id: replacementId,
          requestedRange: null,
          sortOrder: nextSortOrderRef.current++,
        };
        setActivePeriodId(replacementId);
        return [replacement];
      }

      if (periodId === activePeriodId) {
        const nextActive = filtered[filtered.length - 1]?.id ?? filtered[0]?.id ?? null;
        if (nextActive) setActivePeriodId(nextActive);
      }

      return filtered;
    });

    if (dragState?.periodId === periodId) {
      setDragState(null);
    }
  }

  const periodStatuses = useMemo(() => {
    const result: Record<string, PeriodStatus> = {};
    for (const period of periods) {
      result[period.id] = periodStatusForId(
        period,
        visualAssets,
        draftsByAssetByPeriodId,
        primaryUser,
      );
    }
    return result;
  }, [periods, visualAssets, draftsByAssetByPeriodId, primaryUser]);

  const draftGroups = useMemo(() => {
    const rawGroups = buildDraftGroups(
      visualAssets,
      periods as SelectionPeriodDef[],
      draftsByAssetByPeriodId,
      primaryUser,
    ) as DraftGroup[];

    return rawGroups.map((group) => ({
      ...group,
      displayColumnKey: assetSetColumnKey(group.assets),
    }));
  }, [visualAssets, periods, draftsByAssetByPeriodId, primaryUser]);

  const existingGroups = useMemo(() => buildExistingGroups(visualAssets), [visualAssets]);
  const activeRequestedRange = activePeriod?.requestedRange ?? null;

  const existingDayBars = useMemo(() => {
    const result: InternalDayBar[] = [];

    if (mode === 'edit') {
      for (const asset of visualAssets) {
        const blocked = getBlockedReservationsForAsset(asset, editableUsers);
        blocked.forEach((reservation, reservationIndex) => {
          const parts = splitPeriodForWeek(
            { start: reservation.start, end: reservation.end },
            weekStart,
          );
          const tooltip = `${asset.name} — ${reservation.userName}\n${reservation.start} -> ${reservation.end}`;

          parts.forEach((part, partIndex) => {
            const rect = periodToDisplayRect(part, weekStart);
            result.push({
              id: `edit-blocked-${asset.id}-${reservationIndex}-${partIndex}`,
              type: 'existing',
              dayIndex: rect.dayIndex,
              start: rect.start,
              end: rect.end,
              top: rect.top,
              height: rect.height,
              color: '#9ca3af',
              label: `${asset.name} — ${reservation.userName}`,
              tooltip,
              sortEnd: rect.end.getTime(),
            });
          });
        });
      }
      return result;
    }

    for (const group of existingGroups) {
      const parts = splitPeriodForWeek(group.period, weekStart);
      const overlapsActive =
        !!activeRequestedRange &&
        group.entries.some(({ reservation }) => {
          if (reservation.userName === primaryUser) return false;
          const rs = parseDateTime(reservation.start);
          const re = endToExclusive(reservation.end);
          const ws = parseDateTime(activeRequestedRange.start);
          const we = endToExclusive(activeRequestedRange.end);
          return rs < we && re > ws;
        });

      const label =
        group.entries.length === 1
          ? group.entries[0].asset.name
          : `${group.entries.length} reservations`;

      const tooltip = group.entries
        .map(
          ({ asset, reservation }) =>
            `${asset.name} — ${reservation.userName}\n${reservation.start} -> ${reservation.end}`,
        )
        .join('\n\n');

      parts.forEach((part, partIndex) => {
        const rect = periodToDisplayRect(part, weekStart);
        result.push({
          id: `existing-${group.groupKey}-${partIndex}`,
          type: 'existing',
          dayIndex: rect.dayIndex,
          start: rect.start,
          end: rect.end,
          top: rect.top,
          height: rect.height,
          color: mode === 'view' ? (group.entries[0].asset.color ?? '#9ca3af') : '#9ca3af',
          label,
          tooltip,
          sortEnd: rect.end.getTime(),
          showWarning: overlapsActive,
        });
      });
    }

    return result;
  }, [mode, visualAssets, editableUsers, weekStart, existingGroups, activeRequestedRange, primaryUser]);

  const draftDayBars = useMemo(() => {
    if (mode === 'edit') {
      const result: InternalDayBar[] = [];

      visualAssets.forEach((asset: Asset) => {
        const userBlock = editPeriodsByAssetUser[asset.id] ?? {};
        editableUsers.forEach((userName) => {
          const periodsForUser = userBlock[userName] ?? [];
          periodsForUser.forEach((period: TimePeriod, periodIndex: number) => {
            const parts = splitPeriodForWeek(period, weekStart);
            const tooltip = `${asset.name} — ${userName}\n${period.start} -> ${period.end}`;

            parts.forEach((part, partIndex) => {
              const rect = periodToDisplayRect(part, weekStart);
              result.push({
                id: `edit-${asset.id}-${userName}-${periodIndex}-${partIndex}`,
                periodId: `${asset.id}__${userName}__${periodIndex}`,
                columnKey: `${asset.id}__${userName}`,
                type: 'draft',
                dayIndex: rect.dayIndex,
                start: rect.start,
                end: rect.end,
                top: rect.top,
                height: rect.height,
                color: asset.color ?? '#2563eb',
                label: `${asset.name} — ${userName}`,
                tooltip,
                sortEnd: rect.end.getTime(),
                status: 'neutral',
              });
            });
          });
        });
      });

      return result;
    }

    const result: InternalDayBar[] = [];

    draftGroups.forEach((group) => {
      const assetNames = group.assets.map((a: Asset) => a.name);
      const label = group.assets.length === 1 ? assetNames[0] : `${group.assets.length} assets`;

      const tooltip = `Assets:\n${assetNames.join('\n')}\n\nPeriods:\n${group.periods
        .map((p: TimePeriod) => `${p.start} -> ${p.end}`)
        .join('\n')}`;

      const groupColumnKey = assetSetColumnKey(group.assets);

      group.periods.forEach((period: TimePeriod, periodIndex: number) => {
        const parts = splitPeriodForWeek(period, weekStart);
        parts.forEach((part, partIndex) => {
          const rect = periodToDisplayRect(part, weekStart);
          result.push({
            id: `draft-group-${group.periodId}-${groupColumnKey}-${periodIndex}-${partIndex}`,
            periodId: group.periodId,
            columnKey: groupColumnKey,
            type: 'draft',
            dayIndex: rect.dayIndex,
            start: rect.start,
            end: rect.end,
            top: rect.top,
            height: rect.height,
            color:
              group.status === 'good'
                ? '#16a34a'
                : group.status === 'warning'
                  ? '#ca8a04'
                  : group.status === 'error'
                    ? '#dc2626'
                    : '#94a3b8',
            label,
            tooltip,
            sortEnd: rect.end.getTime(),
            status: group.status,
          });
        });
      });
    });

    return result;
  }, [mode, visualAssets, editPeriodsByAssetUser, editableUsers, weekStart, draftGroups]);

  const dayLayouts = useMemo(() => {
    return Array.from({ length: 7 }, (_, dayIndex) => {
      const drafts = draftDayBars.filter((b: InternalDayBar) => b.dayIndex === dayIndex);
      const existing = existingDayBars.filter((b: InternalDayBar) => b.dayIndex === dayIndex);

      return {
        drafts: layoutDraftColumns(drafts),
        existing: layoutExistingColumns(existing),
      };
    });
  }, [draftDayBars, existingDayBars]);

  const nowMarker = useMemo(() => {
    const weekEnd = endOfDayInclusive(addDays(weekStart, 6));
    if (now < weekStart || now > weekEnd) return null;

    const dayIndex = Math.floor(
      (startOfDay(now).getTime() - startOfDay(weekStart).getTime()) /
        (24 * 60 * 60 * 1000),
    );
    const top = now.getHours() * HOUR_ROW_PX + (now.getMinutes() / 60) * HOUR_ROW_PX;

    return { dayIndex, top };
  }, [now, weekStart]);

  const minRepeatWeeks = activePeriod?.requestedRange ? spanWeeks(activePeriod.requestedRange) : 1;

  useEffect(() => {
    if (repeatEveryWeeks < minRepeatWeeks) {
      setRepeatEveryWeeks(minRepeatWeeks);
    }
  }, [minRepeatWeeks, repeatEveryWeeks]);

  const output = useMemo<CalendarOutput>(() => {
    if (mode === 'edit') {
      const assetsOutput: OutputAssetPeriods[] = assets.map((asset: Asset) => ({
        id: asset.id,
        name: asset.name,
        users: editableUsers.map((userName) => ({
          userName,
          selectedPeriods: editPeriodsByAssetUser[asset.id]?.[userName] ?? [],
        })),
      }));
      return { assets: assetsOutput };
    }

    return { assets: periodsToOutput(visualAssets, draftsByAssetByPeriodId) };
  }, [mode, assets, editableUsers, editPeriodsByAssetUser, visualAssets, draftsByAssetByPeriodId]);

  const weekEnd = useMemo(() => endOfDayInclusive(addDays(weekStart, 6)), [weekStart]);

  const monthAssets = useMemo(() => {
    if (mode !== 'edit') return visualAssets;

    return visualAssets.map((asset: Asset) => {
      const blocked = getBlockedReservationsForAsset(asset, editableUsers);
      const editablePeriods = editableUsers.flatMap((userName) =>
        (editPeriodsByAssetUser[asset.id]?.[userName] ?? []).map((p: TimePeriod) => ({
          start: p.start,
          end: p.end,
          userName,
        })),
      );

      return {
        ...asset,
        existingPeriods: [...blocked, ...editablePeriods],
      };
    });
  }, [mode, visualAssets, editableUsers, editPeriodsByAssetUser]);

  return (
    <section className="calendar-card standalone-calendar">
      <div className="calendar-toolbar calendar-toolbar-main">
        <div className="toolbar-left">
          <button
            type="button"
            onClick={() =>
              setAnchorDate((prev) =>
                viewMode === 'week'
                  ? addDays(prev, -7)
                  : new Date(prev.getFullYear(), prev.getMonth() - 1, 1),
              )
            }
          >
            Prev
          </button>

          <button type="button" onClick={() => setAnchorDate(new Date())}>
            Today
          </button>

          <button
            type="button"
            onClick={() =>
              setAnchorDate((prev) =>
                viewMode === 'week'
                  ? addDays(prev, 7)
                  : new Date(prev.getFullYear(), prev.getMonth() + 1, 1),
              )
            }
          >
            Next
          </button>

          <select
            value={viewMode}
            onChange={(e) => setViewMode(e.target.value as CalendarViewMode)}
          >
            <option value="week">Week view</option>
            <option value="month">Month view</option>
          </select>

          {mode === 'reserve' && (
            <button type="button" onClick={addNewPeriod}>
              Add new
            </button>
          )}

          {mode !== 'view' && (
            <button type="button" onClick={resetActivePeriod}>
              {mode === 'edit' ? 'Remove selected' : 'Remove selected'}
            </button>
          )}
        </div>

        {mode === 'reserve' && activePeriod?.requestedRange && (
          <div className="toolbar-right repeat-inline">
            <span className="repeat-title">Repeat selected</span>

            <label>
              every
              <input
                type="number"
                min={minRepeatWeeks}
                step={1}
                value={repeatEveryWeeks}
                onChange={(e) =>
                  setRepeatEveryWeeks(
                    Math.max(minRepeatWeeks, Number(e.target.value) || minRepeatWeeks),
                  )
                }
              />
              weeks
            </label>

            <label>
              times
              <input
                type="number"
                min={1}
                step={1}
                value={repeatCount}
                onChange={(e) => setRepeatCount(Math.max(1, Number(e.target.value) || 1))}
              />
            </label>

            <button type="button" onClick={applyRepeat}>
              Apply
            </button>
          </div>
        )}

        {mode !== 'view' && onConfirm && (
          <div className="toolbar-right">
            <button type="button" onClick={() => onConfirm(output)}>
              Confirm
            </button>
          </div>
        )}
      </div>

      {mode === 'edit' && (
        <div className="period-panel">
          <div className="period-chip-list">
            {visualAssets.flatMap((asset: Asset) =>
              editableUsers.map((userName) => {
                const active =
                  addForTarget?.assetId === asset.id && addForTarget?.userName === userName;

                return (
                  <button
                    key={`${asset.id}-${userName}`}
                    type="button"
                    className={`period-chip ${active ? 'active' : ''}`}
                    onClick={() => toggleAddForTarget(asset.id, userName)}
                  >
                    <span
                      className="period-status-dot"
                      style={{ backgroundColor: asset.color ?? '#2563eb' }}
                    />
                    <span className="period-chip-meta">
                      {active
                        ? `Click calendar for ${asset.name} — ${userName}`
                        : `Add for ${asset.name} — ${userName}`}
                    </span>
                  </button>
                );
              }),
            )}
          </div>
        </div>
      )}

      {mode !== 'view' && mode !== 'edit' && (
        <div className="period-panel">
          <div className="period-chip-list">
            {periods.map((period) => (
              <div
                key={period.id}
                className={`period-chip ${period.id === activePeriodId ? 'active' : ''} status-${periodStatuses[period.id]}`}
              >
                <button
                  type="button"
                  className="period-chip-main"
                  onClick={() => setActivePeriodId(period.id)}
                >
                  <span className="period-status-dot" />
                  <span className="period-chip-meta">{dateLabel(period)}</span>
                </button>

                <button
                  type="button"
                  className="period-chip-remove"
                  onClick={() => removePeriod(period.id)}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'month' ? (
        <MonthOverview
          assets={monthAssets}
          anchorDate={anchorDate}
          draftGroups={draftGroups}
          mode={mode}
          onOpenWeek={(date) => {
            setAnchorDate(date);
            setViewMode('week');
          }}
        />
      ) : (
        <div className="week-shell" ref={gridRef}>
          <div className="week-header-spacer" />

          {weekDays.map((day) => (
            <div key={day.toISOString()} className="week-day-header">
              {formatDayHeader(day)}
            </div>
          ))}

          <div className="time-column">
            {HOURS.map((hour) => (
              <div key={hour} className="time-cell">
                {String(hour).padStart(2, '0')}:00
              </div>
            ))}
          </div>

          {weekDays.map((day, dayIndex) => (
            <div
              key={day.toISOString()}
              className={`day-column ${dayIndex % 2 === 1 ? 'alt' : ''} ${
                mode === 'edit' && addForTarget ? 'day-column-add-mode' : ''
              }`}
            >
              {HOURS.map((hour) => (
                <button
                  type="button"
                  key={`${day.toISOString()}-${hour}`}
                  className={`hour-cell ${
                    addHours(day, hour) < minSelectableStart &&
                    mode !== 'view' &&
                    mode !== 'edit'
                      ? 'disabled-past'
                      : ''
                  }`}
                  onClick={() => handleCellClick(addHours(day, hour))}
                />
              ))}

              {nowMarker && nowMarker.dayIndex === dayIndex && (
                <div className="now-line" style={{ top: nowMarker.top }}>
                  <div className="now-dot" />
                </div>
              )}

              {dayLayouts[dayIndex].drafts.map((bar: InternalPositionedDayBar) => {
                const isEditBar = mode === 'edit';
                const activeRequestedStart =
                  !isEditBar && activePeriod?.requestedRange
                    ? parseDateTime(activePeriod.requestedRange.start)
                    : null;

                const startVisible =
                  isEditBar
                    ? true
                    : !!activeRequestedStart &&
                      activeRequestedStart >= weekStart &&
                      activeRequestedStart <= weekEnd;

                const selectedEdit =
                  isEditBar && selectedEditPeriod
                    ? `${selectedEditPeriod.assetId}__${selectedEditPeriod.userName}__${selectedEditPeriod.index}`
                    : null;

                const currentBarSelected = isEditBar
                  ? bar.periodId === selectedEdit
                  : bar.periodId === activePeriodId;

                const showTopHandle =
                  currentBarSelected &&
                  (isEditBar
                    ? true
                    : !!activePeriod?.requestedRange &&
                      bar.start.getTime() ===
                        parseDateTime(activePeriod.requestedRange.start).getTime());

                const relevantBars = dayLayouts
                  .flatMap((layout) => layout.drafts)
                  .filter((draftBar: InternalPositionedDayBar) =>
                    isEditBar
                      ? draftBar.periodId === bar.periodId
                      : draftBar.periodId === activePeriodId,
                  );

                const latestVisibleEndMs =
                  relevantBars.length > 0
                    ? Math.max(...relevantBars.map((draftBar) => draftBar.end.getTime()))
                    : null;

                const showBottomHandle =
                  currentBarSelected &&
                  latestVisibleEndMs !== null &&
                  bar.end.getTime() === latestVisibleEndMs;

                const visibleDragRangeForEnd =
                  latestVisibleEndMs !== null
                    ? isEditBar
                      ? (() => {
                          const [assetId, userName, indexText] = (bar.periodId ?? '').split('__');
                          const idx = Number(indexText);
                          const base = editPeriodsByAssetUser[assetId]?.[userName]?.[idx];
                          return base
                            ? {
                                start: base.start,
                                end: formatDateTime(new Date(latestVisibleEndMs)),
                              }
                            : undefined;
                        })()
                      : activePeriod?.requestedRange
                        ? {
                            start: activePeriod.requestedRange.start,
                            end: formatDateTime(new Date(latestVisibleEndMs)),
                          }
                        : undefined
                    : undefined;

                const canMoveWholePeriod = isEditBar
                  ? true
                  : currentBarSelected &&
                    !!startVisible &&
                    !!activeRequestedStart &&
                    bar.start.getTime() === activeRequestedStart.getTime();

                return (
                  <div
                    key={bar.id}
                    className={`reservation-block draft ${currentBarSelected ? 'active' : ''} status-${bar.status ?? 'neutral'}`}
                    style={{
                      top: bar.top,
                      height: bar.height,
                      backgroundColor: bar.color,
                      left: `calc(${bar.leftPct}% + 2px)`,
                      width: `calc(${bar.widthPct}% - 4px)`,
                    }}
                    title={bar.tooltip}
                    onMouseDown={(e) => {
                      if (!bar.periodId) return;

                      if (isEditBar) {
                        const [assetId, userName, indexText] = bar.periodId.split('__');
                        setSelectedEditPeriod({
                          assetId,
                          userName,
                          index: Number(indexText),
                        });
                        setAddForTarget(null);
                      } else {
                        setActivePeriodId(bar.periodId);
                      }

                      if ((mode === 'edit' || mode !== 'checkout') && canMoveWholePeriod) {
                        beginDrag('move', e, bar.periodId);
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (!bar.periodId) return;

                      if (isEditBar) {
                        const [assetId, userName, indexText] = bar.periodId.split('__');
                        setSelectedEditPeriod({
                          assetId,
                          userName,
                          index: Number(indexText),
                        });
                        setAddForTarget(null);
                      } else {
                        setActivePeriodId(bar.periodId);
                      }
                    }}
                  >
                    {showTopHandle && mode !== 'checkout' && (
                      <div
                        className="drag-handle top"
                        onMouseDown={(e) => {
                          if (!bar.periodId) return;
                          beginDrag('resize-start', e, bar.periodId);
                        }}
                      />
                    )}

                    <div className="block-label">{bar.label}</div>

                    {showBottomHandle && mode !== 'view' && (
                      <div
                        className="drag-handle bottom"
                        onMouseDown={(e) => {
                          if (!bar.periodId) return;
                          beginDrag('resize-end', e, bar.periodId, visibleDragRangeForEnd);
                        }}
                      />
                    )}
                  </div>
                );
              })}

              {dayLayouts[dayIndex].existing.map((bar: InternalPositionedDayBar) => (
                <div
                  key={bar.id}
                  className="reservation-block existing"
                  style={{
                    top: bar.top,
                    height: bar.height,
                    backgroundColor: bar.color,
                    left: `calc(${bar.leftPct}% + 2px)`,
                    width: `calc(${bar.widthPct}% - 4px)`,
                  }}
                  title={bar.tooltip}
                >
                  <div className="block-label">
                    {bar.showWarning ? '!' : ''} {bar.label}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      {omittedAssets.length > 0 && (
        <div className="calendar-message calendar-message-info">
          <div className="calendar-message-title">
            A few assets were left out of the current visual view to keep the calendar readable.
          </div>
          <div className="calendar-message-list">
            {omittedAssets.map((asset: Asset) => (
              <div key={asset.id} className="calendar-message-row">
                <span>{asset.name}</span>
                <span>{asset.id}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {selectionGroupLimitMessage && (
        <div className="calendar-message calendar-message-soft-warning">
          {selectionGroupLimitMessage}
        </div>
      )}
    </section>
  );
}