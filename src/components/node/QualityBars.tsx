import { useCallback, useMemo } from "react";
import { CanvasStrip, fillRoundedRect, resolveCssColor } from "./CanvasStrip";
import { lossHeatColor } from "@/utils/metricTone";
import type { PingOverviewBucket } from "@/types/komari";

const ACTIVE_BAR_HEIGHT = 0.84;

interface QualityBarsProps {
  /** Aggregated ping buckets (always a fixed-length window). */
  buckets: PingOverviewBucket[];
  redrawKey?: string;
  onHoverIndex?: (index: number | null) => void;
}

export function QualityBars({ buckets, redrawKey, onHoverIndex }: QualityBarsProps) {
  const bars = useMemo(
    () =>
      buckets.map((bucket) => {
        const hasBucketValue =
          bucket.loss != null && Number.isFinite(bucket.loss) && bucket.total > 0;
        return {
          active: hasBucketValue,
          index: bucket.index,
          tone: hasBucketValue ? lossHeatColor(bucket.loss) : "var(--progress-bg)",
        };
      }),
    [buckets],
  );

  const getHoverIndex = useCallback(
    (offsetX: number, width: number) => {
      if (bars.length === 0 || width <= 0) return null;
      const slotWidth = width / bars.length;
      const slot = Math.max(0, Math.min(bars.length - 1, Math.floor(offsetX / slotWidth)));
      return bars[slot]?.index ?? null;
    },
    [bars],
  );

  const draw = useCallback(
    (ctx: CanvasRenderingContext2D, width: number, height: number) => {
      const inactiveColor = resolveCssColor("var(--progress-bg)");
      const gap = bars.length > 48 ? 1 : 2;
      const barWidth = Math.max(1, (width - gap * (bars.length - 1)) / Math.max(1, bars.length));
      const barHeight = height * ACTIVE_BAR_HEIGHT;
      const y = height - barHeight;

      bars.forEach(({ active, tone }, index) => {
        const x = index * (barWidth + gap);
        ctx.globalAlpha = active ? 0.94 : 0.42;
        ctx.fillStyle = active ? tone : inactiveColor;
        fillRoundedRect(ctx, x, y, barWidth, barHeight, 2);
      });

      ctx.globalAlpha = 1;
    },
    [bars],
  );

  return (
    <CanvasStrip
      className="mini-bar-row"
      ariaHidden
      height={16}
      redrawKey={redrawKey}
      getHoverIndex={getHoverIndex}
      onHoverIndex={onHoverIndex}
      draw={draw}
    />
  );
}
