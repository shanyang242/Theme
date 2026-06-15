import { useEffect, useRef, useState } from "react";
import type uPlot from "uplot";

// Shared chart palette. LoadChart keys colors by metric (cpu/memory/…) while
// PingChart cycles them per task; both draw from this single source so the hex
// values can't drift between the two charts.
export const CHART_PALETTE = {
  cpu: "#5d88ff",
  memory: "#a35cf5",
  disk: "#f1873d",
  success: "#61c08f",
  warning: "#d4a54a",
} as const;

const CHART_SERIES_COLORS = [
  CHART_PALETTE.cpu,
  CHART_PALETTE.success,
  CHART_PALETTE.memory,
  CHART_PALETTE.disk,
  CHART_PALETTE.warning,
] as const;

export function colorForSeries(index: number): string {
  return CHART_SERIES_COLORS[index % CHART_SERIES_COLORS.length];
}

// Shared hover-tooltip state shape for the uPlot charts (LoadChart / PingChart).
export interface ChartTooltipState {
  show: boolean;
  left: number;
  top: number;
  rows: Array<{ label: string; value: string; color: string }>;
  time: string;
}

interface TimeRangeOption {
  label: string;
  value: number;
}

// Load and ping share the same history presets; the only difference is whether a
// "实时" option is prepended, which buildHistoryRangeOptions handles via its
// includeRealtime flag rather than via the preset list itself.
const TIME_RANGE_OPTIONS: TimeRangeOption[] = [
  { label: "1 小时", value: 1 },
  { label: "4 小时", value: 4 },
  { label: "1 天", value: 24 },
  { label: "7 天", value: 168 },
  { label: "30 天", value: 720 },
];

function formatRangeLabel(hours: number) {
  if (hours % 24 === 0) {
    const days = hours / 24;
    return `${days} 天`;
  }

  return `${hours} 小时`;
}

function buildHistoryRangeOptions(
  presets: TimeRangeOption[],
  maxHours: number | null | undefined,
  includeRealtime: boolean,
) {
  const options = includeRealtime ? [{ label: "实时", value: 0 }] : [];
  if (!Number.isFinite(maxHours) || !maxHours || maxHours <= 0) {
    return [...options, ...presets];
  }

  const safeMaxHours = Math.floor(maxHours);
  const resolved = presets.filter((option) => option.value <= safeMaxHours);
  const hasExactMatch = resolved.some((option) => option.value === safeMaxHours);

  if (safeMaxHours > 0 && !hasExactMatch) {
    resolved.push({
      label: formatRangeLabel(safeMaxHours),
      value: safeMaxHours,
    });
  }

  return [...options, ...resolved];
}

export function buildLoadTimeRangeOptions(maxHours: number | null | undefined) {
  return buildHistoryRangeOptions(TIME_RANGE_OPTIONS, maxHours, true);
}

export function buildPingTimeRangeOptions(maxHours: number | null | undefined) {
  return buildHistoryRangeOptions(TIME_RANGE_OPTIONS, maxHours, false);
}

const GRID_CHART_DEFAULT = { w: 420, h: 150 };
const GRID_CHART_DESKTOP_MAX_WIDTH = 480;
const GRID_CHART_TABLET_MAX_WIDTH = 560;
const GRID_CHART_DESKTOP_GUTTER = 180;
const GRID_CHART_TABLET_GUTTER = 100;
const GRID_CHART_MOBILE_GUTTER = 56;
const GRID_CHART_HEIGHT = 148;
const WIDE_CHART_MIN_WIDTH = 300;
const WIDE_CHART_MAX_WIDTH = 1720;
const WIDE_CHART_GUTTER = 96;
const WIDE_CHART_HEIGHT = 340;
const WIDE_CHART_TABLET_HEIGHT = 300;
const WIDE_CHART_MOBILE_HEIGHT = 260;
// Quantize responsive chart widths to this step so drag-resizes collapse into
// discrete sizes instead of rebuilding uPlot on every pixel.
const CHART_WIDTH_STEP = 8;

export function toChartSeconds(value: string | number): number {
  if (typeof value === "number") {
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed / 1000;
}

function pad2(value: number) {
  return value.toString().padStart(2, "0");
}

function getDateParts(timestampSeconds: number) {
  const date = new Date(timestampSeconds * 1000);
  return {
    year: date.getFullYear(),
    month: pad2(date.getMonth() + 1),
    day: pad2(date.getDate()),
    hour: pad2(date.getHours()),
    minute: pad2(date.getMinutes()),
    second: pad2(date.getSeconds()),
  };
}

function formatAxisTime(timestampSeconds: number, rangeHours: number) {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 72) return `${parts.month}/${parts.day}`;
  return `${parts.hour}:${parts.minute}`;
}

export function createTimeAxisFormatter(rangeHours: number) {
  return (_self: uPlot, splits: number[]): string[] =>
    splits.map((value) => formatAxisTime(value, rangeHours));
}

export function formatTooltipTime(timestampSeconds: number, rangeHours = 0): string {
  const parts = getDateParts(timestampSeconds);
  if (rangeHours >= 24) {
    return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
  }
  return `${parts.hour}:${parts.minute}:${parts.second}`;
}

export function formatChartCoverageTime(timestampSeconds: number): string {
  const parts = getDateParts(timestampSeconds);
  return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export function getChartTooltipPosition({
  containerWidth,
  containerHeight,
  anchorX,
  anchorY,
  rowCount,
  estimatedWidth = 188,
}: {
  containerWidth: number;
  containerHeight: number;
  anchorX: number;
  anchorY: number;
  rowCount: number;
  estimatedWidth?: number;
}) {
  const margin = 10;
  const offsetX = 18;
  const offsetY = 16;
  const estimatedHeight = 34 + rowCount * 22;
  const maxLeft = Math.max(margin, containerWidth - estimatedWidth - margin);
  const maxTop = Math.max(margin, containerHeight - estimatedHeight - margin);

  let left =
    anchorX + estimatedWidth + offsetX <= containerWidth - margin
      ? anchorX + offsetX
      : anchorX - estimatedWidth - offsetX;
  left = clamp(left, margin, maxLeft);

  let top = anchorY - estimatedHeight - offsetY;
  if (top < margin) top = anchorY + offsetY;
  top = clamp(top, margin, maxTop);

  return { left, top };
}

export function useResponsiveChartSize(mode: "grid" | "wide") {
  const ref = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState(
    mode === "grid"
      ? GRID_CHART_DEFAULT
      : { w: WIDE_CHART_MAX_WIDTH, h: WIDE_CHART_HEIGHT },
  );

  useEffect(() => {
    function computeSize(viewportWidth: number, containerWidth?: number): { w: number; h: number } {
      // The grid width is a continuous (width - gutter) / N below its cap, so an
      // exact skip-if-unchanged never fires during a drag-resize and every rAF
      // frame rebuilds all 6 uPlot charts. Quantizing to a step collapses runs of
      // near-identical widths into one, so a rebuild happens ~once per step.
      const q = (value: number) => Math.floor(value / CHART_WIDTH_STEP) * CHART_WIDTH_STEP;

      if (mode === "wide") {
        const height =
          viewportWidth < 720
            ? WIDE_CHART_MOBILE_HEIGHT
            : viewportWidth < 1024
              ? WIDE_CHART_TABLET_HEIGHT
              : WIDE_CHART_HEIGHT;
        const measuredWidth =
          typeof containerWidth === "number" && containerWidth > 0
            ? containerWidth
            : viewportWidth - WIDE_CHART_GUTTER;
        return {
          w: Math.min(WIDE_CHART_MAX_WIDTH, Math.max(WIDE_CHART_MIN_WIDTH, q(measuredWidth))),
          h: height,
        };
      }

      if (viewportWidth >= 1280) {
        return {
          w: Math.min(GRID_CHART_DESKTOP_MAX_WIDTH, q((viewportWidth - GRID_CHART_DESKTOP_GUTTER) / 3)),
          h: GRID_CHART_HEIGHT,
        };
      }

      if (viewportWidth >= 768) {
        return {
          w: Math.min(GRID_CHART_TABLET_MAX_WIDTH, q((viewportWidth - GRID_CHART_TABLET_GUTTER) / 2)),
          h: GRID_CHART_HEIGHT,
        };
      }

      return {
        w: Math.max(WIDE_CHART_MIN_WIDTH - 20, q(viewportWidth - GRID_CHART_MOBILE_GUTTER)),
        h: 136,
      };
    }

    function apply() {
      const next = computeSize(window.innerWidth, ref.current?.clientWidth);
      // Skip the state update (and the uPlot teardown it triggers) when the
      // computed size is unchanged — resize fires far more often than the
      // breakpoint-bucketed dimensions actually change.
      setSize((prev) => (prev.w === next.w && prev.h === next.h ? prev : next));
    }

    let frame: number | null = null;
    function onResize() {
      if (frame != null) return;
      frame = window.requestAnimationFrame(() => {
        frame = null;
        apply();
      });
    }

    apply();
    window.addEventListener("resize", onResize);
    const observer =
      mode === "wide" && typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(onResize)
        : null;
    if (observer && ref.current) {
      observer.observe(ref.current);
    }
    return () => {
      if (frame != null) window.cancelAnimationFrame(frame);
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
    };
  }, [mode]);

  return { ...size, ref };
}
