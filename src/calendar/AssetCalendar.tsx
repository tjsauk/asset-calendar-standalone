import React, { useEffect, useMemo, useRef, useState } from 'react';
import type {
  Asset,
  CalendarInput,
  CalendarOutput,
  CalendarViewMode,
  DraftGroup,
  ExistingGroup,
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
  parseDateTime,
  periodStatusForId,
  periodToDisplayRect,
  periodsToOutput,
  spanWeeks,
  splitPeriodForWeek,
  startOfDay,
} from './calendarUtils';
import './assetCalendar.css';

type DragKind = 'move' | 'resize-start' | 'resize-end';

type DragState = {
  kind: DragKind;
  startMouseHour: number;
  originalRange: TimePeriod;
  periodId: string;
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

export default function AssetCalendar({
  input,
  initialViewMode = 'week',
  onConfirm,
}: {
  input: CalendarInput;
  initialViewMode?: CalendarViewMode;
  onConfirm?: (output: CalendarOutput) => void;
}) {
  const [viewMode, setViewMode] = useState<CalendarViewMode>(initialViewMode);
  const [anchorDate, setAnchorDate] = useState(new Date());
  const [periods, setPeriods] = useState<SelectionPeriodDef[]>([
    { id: 'p1', requestedRange: null },
  ]);
  const [activePeriodId, setActivePeriodId] = useState('p1');
  const [dragState, setDragState] = useState<DragState | null>(null);
  const [now, setNow] = useState(new Date());
  const [repeatEveryWeeks, setRepeatEveryWeeks] = useState(1);
  const [repeatCount, setRepeatCount] = useState(1);

  const gridRef = useRef<HTMLDivElement | null>(null);

  const assets = useMemo(
    () =>
      input.assets.map((asset: Asset, index: number) => ({
        ...asset,
        color: asset.color ?? DEFAULT_COLORS[index % DEFAULT_COLORS.length],
      })),
    [input.assets],
  );

  const mode = input.mode;
  const currentUser = input.currentUser;
  const continuousCutMode = input.continuousCutMode ?? true;

  const weekStart = useMemo(() => getWeekStart(anchorDate), [anchorDate]);
  const weekDays = useMemo(() => getWeekDays(weekStart), [weekStart]);
  const minSelectableStart = useMemo(
    () => new Date(now.getFullYear(), now.getMonth(), now.getDate(), now.getHours(), 0, 0, 0),
    [now],
  );
  const activePeriod =
    periods.find((p: SelectionPeriodDef) => p.id === activePeriodId) ?? periods[0] ?? null;

  const draftsByAssetByPeriodId = useMemo(() => {
    const result: Record<string, Record<string, TimePeriod[]>> = {};

    for (const period of periods as SelectionPeriodDef[]) {
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
      for (const asset of assets) {
        byAsset[asset.id] = buildPeriodsForAsset(
          safeRange,
          asset.existingPeriods,
          currentUser,
          continuousCutMode,
        );
      }
      result[period.id] = byAsset;
    }

    return result;
  }, [periods, assets, currentUser, continuousCutMode, mode, minSelectableStart]);

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
      const hasAnyRange = prev.some((p: SelectionPeriodDef) => p.requestedRange !== null);
      if (hasAnyRange) {
        return prev.map((p: SelectionPeriodDef, index: number) =>
          index === 0 && p.requestedRange === null
            ? { ...p, requestedRange: currentHourPeriod }
            : p,
        );
      }

      return prev.map((p: SelectionPeriodDef, index: number) =>
        index === 0 ? { ...p, requestedRange: currentHourPeriod } : p,
      );
    });
  }, [mode, minSelectableStart]);

  const updatePeriodRange = (periodId: string, nextRange: TimePeriod | null) => {
    setPeriods((prev) =>
      prev.map((p: SelectionPeriodDef) =>
        p.id === periodId ? { ...p, requestedRange: nextRange } : p,
      ),
    );
  };

  const resetActivePeriod = () => {
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
      updatePeriodRange(activePeriod.id, null);
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
  }, [dragState, mode, minSelectableStart]);

  const handleCellClick = (date: Date) => {
    if (mode === 'view' || !activePeriod) return;

    const clickedHour = new Date(
      date.getFullYear(),
      date.getMonth(),
      date.getDate(),
      date.getHours(),
      0,
      0,
      0,
    );
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
    const targetPeriod = periods.find((p: SelectionPeriodDef) => p.id === periodId);
    const baseRange = dragRange ?? targetPeriod?.requestedRange;
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

    setActivePeriodId(periodId);
    setDragState({
      kind,
      startMouseHour: absoluteHour,
      originalRange: baseRange,
      periodId,
    });
  };

  const addNewPeriod = () => {
    if (mode !== 'reserve') return;
    const id = `p${periods.length + 1}`;
    setPeriods((prev) => [...prev, { id, requestedRange: null }]);
    setActivePeriodId(id);
  };

  const applyRepeat = () => {
    if (mode !== 'reserve' || !activePeriod?.requestedRange) return;

    const baseStart = parseDateTime(activePeriod.requestedRange.start);
    const baseEndExclusive = endToExclusive(activePeriod.requestedRange.end);

    const nextItems: SelectionPeriodDef[] = [];
    for (let i = 1; i <= repeatCount; i++) {
      const shiftedStart = addWeeks(baseStart, i * repeatEveryWeeks);
      const shiftedEndExclusive = addWeeks(baseEndExclusive, i * repeatEveryWeeks);
      const nextNumber = periods.length + nextItems.length + 1;

      nextItems.push({
        id: `p${nextNumber}`,
        requestedRange: {
          start: formatDateTime(shiftedStart),
          end: formatDateTime(addMinutes(shiftedEndExclusive, -1)),
        },
      });
    }

    setPeriods((prev) => [...prev, ...nextItems]);
  };

  const removePeriod = (periodId: string) => {
    setPeriods((prev) => {
      if (prev.length <= 1) {
        return prev.map((p: SelectionPeriodDef) =>
          p.id === periodId ? { ...p, requestedRange: null } : p,
        );
      }

      const filtered = prev.filter((p: SelectionPeriodDef) => p.id !== periodId);

      if (periodId === activePeriodId) {
        const nextActive = filtered[filtered.length - 1]?.id ?? filtered[0]?.id ?? null;
        if (nextActive) setActivePeriodId(nextActive);
      }

      return filtered;
    });

    if (dragState?.periodId === periodId) {
      setDragState(null);
    }
  };

  const periodStatuses = useMemo(() => {
    const result: Record<string, PeriodStatus> = {};
    for (const period of periods as SelectionPeriodDef[]) {
      result[period.id] = periodStatusForId(period, assets, draftsByAssetByPeriodId, currentUser);
    }
    return result;
  }, [periods, assets, draftsByAssetByPeriodId, currentUser]);

  const draftGroups = useMemo(
    () => buildDraftGroups(assets, periods, draftsByAssetByPeriodId, currentUser) as DraftGroup[],
    [assets, periods, draftsByAssetByPeriodId, currentUser],
  );

  const existingGroups = useMemo(() => buildExistingGroups(assets), [assets]);
  const activeRequestedRange = activePeriod?.requestedRange ?? null;

  const existingDayBars = useMemo(() => {
    const result: InternalDayBar[] = [];

    for (const group of existingGroups) {
      const parts = splitPeriodForWeek(group.period, weekStart);
      const overlapsActive =
        !!activeRequestedRange &&
        group.entries.some(
          ({
            reservation,
          }: {
            reservation: { start: string; end: string; userName: string };
          }) => {
            if (reservation.userName === currentUser) return false;
            const rs = parseDateTime(reservation.start);
            const re = endToExclusive(reservation.end);
            const ws = parseDateTime(activeRequestedRange.start);
            const we = endToExclusive(activeRequestedRange.end);
            return rs < we && re > ws;
          },
        );

      const label =
        group.entries.length === 1
          ? group.entries[0].asset.name
          : `${group.entries.length} reservations`;

      const tooltip = group.entries
        .map(
          ({
            asset,
            reservation,
          }: {
            asset: Asset;
            reservation: { start: string; end: string; userName: string };
          }) => `${asset.name} — ${reservation.userName}\n${reservation.start} -> ${reservation.end}`,
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
  }, [existingGroups, weekStart, activeRequestedRange, currentUser, mode]);

  const draftDayBars = useMemo(() => {
    const result: InternalDayBar[] = [];

    draftGroups.forEach((group, groupIndex) => {
      const assetNames = group.assets.map((a: Asset) => a.name);
      const label = group.assets.length === 1 ? assetNames[0] : `${group.assets.length} assets`;

      const tooltip = `Assets:\n${assetNames.join('\n')}\n\nPeriods:\n${group.periods
        .map((p: TimePeriod) => `${p.start} -> ${p.end}`)
        .join('\n')}`;

      group.periods.forEach((period: TimePeriod, periodIndex: number) => {
        const parts = splitPeriodForWeek(period, weekStart);
        parts.forEach((part, partIndex) => {
          const rect = periodToDisplayRect(part, weekStart);
          result.push({
            id: `draft-group-${group.periodId}-${groupIndex}-${periodIndex}-${partIndex}`,
            periodId: group.periodId,
            columnKey: group.groupKey,
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
  }, [draftGroups, weekStart]);

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

  const output = useMemo<CalendarOutput>(
    () => ({ assets: periodsToOutput(assets, draftsByAssetByPeriodId) }),
    [assets, draftsByAssetByPeriodId],
  );

  const weekEnd = useMemo(() => endOfDayInclusive(addDays(weekStart, 6)), [weekStart]);

  return (
    <section className="calendar-card standalone-calendar">
      <div className="calendar-toolbar calendar-toolbar-main">
        <div className="toolbar-left">
          <button
            type="button"
            onClick={() =>
              setAnchorDate((prev) => (viewMode === 'week' ? addDays(prev, -7) : addDays(prev, -28)))
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
              setAnchorDate((prev) => (viewMode === 'week' ? addDays(prev, 7) : addDays(prev, 28)))
            }
          >
            Next
          </button>

          <select value={viewMode} onChange={(e) => setViewMode(e.target.value as CalendarViewMode)}>
            <option value="week">Week view</option>
            <option value="month">Month view</option>
          </select>

          {mode === 'reserve' && (
            <button type="button" onClick={addNewPeriod}>
              Add new
            </button>
          )}

          {mode !== 'view' && activePeriod && (
            <button type="button" onClick={resetActivePeriod}>
              Cancel selection
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

      {mode !== 'view' && (
        <div className="period-panel">
          <div className="period-chip-list">
            {periods.map((period: SelectionPeriodDef) => (
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

                {periods.length > 1 && (
                  <button
                    type="button"
                    className="period-chip-remove"
                    onClick={() => removePeriod(period.id)}
                  >
                    ×
                  </button>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {viewMode === 'month' ? (
        <MonthOverview
          assets={assets}
          weekStart={weekStart}
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
              className={`day-column ${dayIndex % 2 === 1 ? 'alt' : ''}`}
            >
              {HOURS.map((hour) => (
                <button
                  type="button"
                  key={`${day.toISOString()}-${hour}`}
                  className={`hour-cell ${addHours(day, hour) < minSelectableStart && mode !== 'view' ? 'disabled-past' : ''}`}
                  onClick={() => handleCellClick(addHours(day, hour))}
                />
              ))}

              {nowMarker && nowMarker.dayIndex === dayIndex && (
                <div className="now-line" style={{ top: nowMarker.top }}>
                  <div className="now-dot" />
                </div>
              )}

              {dayLayouts[dayIndex].drafts.map((bar: InternalPositionedDayBar) => {
                const activeRequestedStart = activePeriod?.requestedRange
                  ? parseDateTime(activePeriod.requestedRange.start)
                  : null;

                const startVisible =
                  !!activeRequestedStart &&
                  activeRequestedStart >= weekStart &&
                  activeRequestedStart <= weekEnd;

                const showTopHandle =
                  bar.periodId === activePeriodId &&
                  activePeriod?.requestedRange &&
                  bar.start.getTime() === parseDateTime(activePeriod.requestedRange.start).getTime();

                const activeBarsForPeriod = dayLayouts
                  .flatMap((layout) => layout.drafts)
                  .filter((draftBar: InternalPositionedDayBar) => draftBar.periodId === activePeriodId);

                const latestVisibleEndMs =
                  activeBarsForPeriod.length > 0
                    ? Math.max(...activeBarsForPeriod.map((draftBar: InternalPositionedDayBar) => draftBar.end.getTime()))
                    : null;

                const showBottomHandle =
                  bar.periodId === activePeriodId &&
                  latestVisibleEndMs !== null &&
                  bar.end.getTime() === latestVisibleEndMs;

                const visibleDragRangeForEnd =
                  activePeriod?.requestedRange && latestVisibleEndMs !== null
                    ? {
                        start: activePeriod.requestedRange.start,
                        end: formatDateTime(new Date(latestVisibleEndMs)),
                      }
                    : undefined;

                const canMoveWholePeriod =
                  bar.periodId === activePeriodId &&
                  !!startVisible &&
                  !!activeRequestedStart &&
                  bar.start.getTime() === activeRequestedStart.getTime();

                return (
                  <div
                    key={bar.id}
                    className={`reservation-block draft ${bar.periodId === activePeriodId ? 'active' : ''} status-${bar.status ?? 'neutral'}`}
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
                      setActivePeriodId(bar.periodId);
                      if (mode !== 'checkout' && canMoveWholePeriod) {
                        beginDrag('move', e, bar.periodId);
                      }
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (bar.periodId) setActivePeriodId(bar.periodId);
                    }}
                  >
                    {showTopHandle && mode === 'reserve' && (
                      <div
                        className="drag-handle top"
                        onMouseDown={(e) => {
                          if (!bar.periodId) return;
                          beginDrag('resize-start', e, bar.periodId);
                        }}
                      />
                    )}

                    <div className="block-label">{bar.label}</div>

                    {showBottomHandle && (mode === 'reserve' || mode === 'checkout') && (
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
    </section>
  );
}