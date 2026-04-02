import React from 'react';
import type {
  Asset,
  CalendarMode,
  DraftGroup,
  MonthBlock,
  PeriodStatus,
  TimePeriod,
} from './calendarTypes';
import {
  DAY_NAMES,
  addDays,
  dateInPeriodDay,
  endOfDayInclusive,
  getWeekStart,
  isSameDay,
  monthDayResolutionBlock,
  pad,
  parseDateTime,
  startOfDay,
} from './calendarUtils';

export default function MonthOverview({
  assets,
  anchorDate,
  draftGroups,
  mode,
  onOpenWeek,
}: {
  assets: Asset[];
  anchorDate: Date;
  draftGroups: DraftGroup[];
  mode: CalendarMode;
  onOpenWeek: (date: Date) => void;
}) {
  const monthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const firstCell = getWeekStart(monthStart);
  const cells = Array.from({ length: 42 }, (_, i: number) => addDays(firstCell, i));
  const today = new Date();

  const selectedPeriodsByStatus = {
    good: draftGroups.filter((g: DraftGroup) => g.status === 'good'),
    warning: draftGroups.filter((g: DraftGroup) => g.status === 'warning'),
    error: draftGroups.filter((g: DraftGroup) => g.status === 'error'),
  };

  function viewModeBlocksForDate(date: Date): MonthBlock[] {
    const blocks: MonthBlock[] = [];
    const rowHeight = 12;

    assets.forEach((asset: Asset, assetIndex: number) => {
      asset.existingPeriods.forEach((reservation) => {
        const start = parseDateTime(reservation.start);
        const end = parseDateTime(reservation.end);

        if (!(date >= startOfDay(start) && date <= endOfDayInclusive(end))) return;

        const span = monthDayResolutionBlock(start, end, date);

        blocks.push({
          leftPct: span.leftPct,
          widthPct: span.widthPct,
          topPx: assetIndex * rowHeight,
          color: asset.color ?? '#9ca3af',
          label: asset.name,
          tooltip: `${asset.name} — ${reservation.userName}\n${reservation.start} -> ${reservation.end}`,
        });
      });
    });

    return blocks;
  }

  function selectionModeBlocksForDate(date: Date): MonthBlock[] {
    const reservationsForDay: Array<{
      start: Date;
      end: Date;
      assetName: string;
      userName: string;
      startText: string;
      endText: string;
    }> = [];

    assets.forEach((asset: Asset) => {
      asset.existingPeriods.forEach((reservation) => {
        const start = parseDateTime(reservation.start);
        const end = parseDateTime(reservation.end);

        if (!(date >= startOfDay(start) && date <= endOfDayInclusive(end))) return;

        const dayStart = isSameDay(date, start) ? start : startOfDay(date);
        const dayEnd = isSameDay(date, end) ? end : endOfDayInclusive(date);

        reservationsForDay.push({
          start: dayStart,
          end: dayEnd,
          assetName: asset.name,
          userName: reservation.userName,
          startText: reservation.start,
          endText: reservation.end,
        });
      });
    });

    reservationsForDay.sort((a, b) => a.start.getTime() - b.start.getTime());

    const merged: Array<{
      start: Date;
      end: Date;
      tooltipLines: string[];
    }> = [];

    for (const reservation of reservationsForDay) {
      const line = `${reservation.assetName} — ${reservation.userName}\n${reservation.startText} -> ${reservation.endText}`;
      const last = merged[merged.length - 1];

      if (!last || reservation.start.getTime() > last.end.getTime()) {
        merged.push({
          start: reservation.start,
          end: reservation.end,
          tooltipLines: [line],
        });
      } else {
        if (reservation.end.getTime() > last.end.getTime()) {
          last.end = reservation.end;
        }
        last.tooltipLines.push(line);
      }
    }

    return merged.map((interval) => {
      const span = monthDayResolutionBlock(interval.start, interval.end, date);
      return {
        leftPct: span.leftPct,
        widthPct: span.widthPct,
        topPx: 0,
        color: '#9ca3af',
        label: 'Existing reservation',
        tooltip: interval.tooltipLines.join('\n\n'),
      };
    });
  }

  function draftFlags(status: PeriodStatus, date: Date, index: number) {
    const groups =
      status === 'good'
        ? selectedPeriodsByStatus.good
        : status === 'warning'
          ? selectedPeriodsByStatus.warning
          : selectedPeriodsByStatus.error;

    const active = groups.some((group: DraftGroup) =>
      group.periods.some((period: TimePeriod) => dateInPeriodDay(period, date)),
    );

    const prevDate = index % 7 !== 0 ? cells[index - 1] : null;
    const nextDate = index % 7 !== 6 ? cells[index + 1] : null;

    const left = prevDate
      ? groups.some((group: DraftGroup) =>
          group.periods.some((period: TimePeriod) => dateInPeriodDay(period, prevDate)),
        )
      : false;

    const right = nextDate
      ? groups.some((group: DraftGroup) =>
          group.periods.some((period: TimePeriod) => dateInPeriodDay(period, nextDate)),
        )
      : false;

    const tooltip = groups
      .flatMap((group: DraftGroup) =>
        group.periods.filter((period: TimePeriod) => dateInPeriodDay(period, date)),
      )
      .map((period: TimePeriod) => `${period.start} -> ${period.end}`)
      .join('\n');

    return { active, left, right, tooltip };
  }

  const colorMode = mode === 'view' || mode === 'edit';
  const monthRows = colorMode ? assets.length : 1;
  const stripHeight = monthRows * 12;

  return (
    <div className="month-view">
      <div className="month-title">
        {anchorDate.toLocaleDateString('fi-FI', { month: 'long', year: 'numeric' })}
      </div>

      <div className="month-grid">
        {DAY_NAMES.map((d: string) => (
          <div key={d} className="month-head">
            {d}
          </div>
        ))}

        {cells.map((date: Date, index: number) => {
          const existingBlocks =
            colorMode ? viewModeBlocksForDate(date) : selectionModeBlocksForDate(date);

          const good = draftFlags('good', date, index);
          const warn = draftFlags('warning', date, index);
          const error = draftFlags('error', date, index);

          const isOutsideMonth =
            date.getMonth() !== monthStart.getMonth() ||
            date.getFullYear() !== monthStart.getFullYear();

          const isToday =
            date.getDate() === today.getDate() &&
            date.getMonth() === today.getMonth() &&
            date.getFullYear() === today.getFullYear();

          const cellTooltipParts: string[] = [];

          existingBlocks.forEach((block: MonthBlock) => {
            if (block.tooltip) cellTooltipParts.push(block.tooltip);
          });

          if (good.tooltip) {
            cellTooltipParts.push(`Selected periods:\n${good.tooltip}`);
          }
          if (warn.tooltip) {
            cellTooltipParts.push(`Partially limited periods:\n${warn.tooltip}`);
          }
          if (error.tooltip) {
            cellTooltipParts.push(`Unavailable periods:\n${error.tooltip}`);
          }

          const cellTooltip = cellTooltipParts.join('\n\n');

          return (
            <button
              type="button"
              key={date.toISOString()}
              className={`month-cell month-cell-button ${isOutsideMonth ? 'month-cell-dim' : ''} ${isToday ? 'month-cell-today' : ''}`}
              onClick={() => onOpenWeek(date)}
              title={cellTooltip}
            >
              <div className="month-date">
                <span className="month-date-weekday">
                  {DAY_NAMES[(date.getDay() + 6) % 7]}
                </span>
                <span>{pad(date.getDate())}.{pad(date.getMonth() + 1)}</span>
              </div>

              <div className="month-day-strip" style={{ height: `${stripHeight}px` }}>
                {existingBlocks.map((block: MonthBlock, i: number) => (
                  <div
                    key={`${date.toISOString()}-${i}`}
                    className="month-existing-block"
                    style={{
                      left: `${block.leftPct}%`,
                      width: `${block.widthPct}%`,
                      top: `${block.topPx}px`,
                      backgroundColor: block.color,
                    }}
                    title={block.tooltip}
                  />
                ))}
              </div>

              {good.active && (
                <div
                  className={`month-draft-outline good ${
                    good.left ? 'continue-left' : ''
                  } ${
                    good.right ? 'continue-right' : ''
                  }`}
                  title={good.tooltip}
                />
              )}

              {warn.active && (
                <div
                  className={`month-draft-outline warning ${
                    warn.left ? 'continue-left' : ''
                  } ${
                    warn.right ? 'continue-right' : ''
                  }`}
                  title={warn.tooltip}
                />
              )}

              {error.active && (
                <div
                  className={`month-draft-outline error ${
                    error.left ? 'continue-left' : ''
                  } ${
                    error.right ? 'continue-right' : ''
                  }`}
                  title={error.tooltip}
                />
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
}