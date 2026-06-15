import { memo, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import UplotReact from "uplot-react";
import type uPlot from "uplot";
import { ArrowDown, ArrowUp, Cpu, Gauge, HardDrive, MemoryStick, Network, Workflow } from "lucide-react";
import { useLoadRecords } from "@/hooks/useRecords";
import { useNodeMetrics } from "@/hooks/useNode";
import { InstancePanel } from "./InstancePanel";
import {
  CHART_PALETTE,
  createTimeAxisFormatter,
  formatChartCoverageTime,
  formatTooltipTime,
  getChartTooltipPosition,
  toChartSeconds,
  useResponsiveChartSize,
  type ChartTooltipState,
} from "./chartShared";
import {
  fillMissingMetricPoints,
  interpolateMetricGaps,
} from "./chartData";
import { formatBytes, formatTrafficRateLabel } from "@/utils/format";
import { usePreferences } from "@/hooks/usePreferences";
import type { NodeMetrics } from "@/types/komari";

const LOAD_HISTORY_SAMPLE_LIMIT = 360;
const LOAD_HISTORY_RENDER_LIMIT = 720;
const REALTIME_HISTORY_SEED_LIMIT = 120;
const REALTIME_SAMPLE_LIMIT = 600;

const CPU_KEYS = ["cpu"];
const CPU_COLORS = [CHART_PALETTE.cpu];
const MEMORY_KEYS = ["ram", "swap"];
const MEMORY_COLORS = [CHART_PALETTE.memory, CHART_PALETTE.warning];
const DISK_KEYS = ["disk"];
const DISK_COLORS = [CHART_PALETTE.disk];
const NETWORK_KEYS = ["netIn", "netOut"];
const NETWORK_COLORS = [CHART_PALETTE.success, CHART_PALETTE.cpu];
const CONNECTION_KEYS = ["connections", "udp"];
const CONNECTION_COLORS = [CHART_PALETTE.memory, CHART_PALETTE.cpu];
const PROCESS_KEYS = ["process"];
const PROCESS_COLORS = [CHART_PALETTE.warning];
const SERIES_LABELS: Record<string, string> = {
  cpu: "CPU",
  ram: "内存",
  swap: "Swap",
  disk: "磁盘",
  diskBytes: "磁盘",
  netIn: "下行",
  netOut: "上行",
  connections: "TCP",
  udp: "UDP",
  process: "进程",
  load: "负载",
};
const LOAD_INTERPOLATE_KEYS = [
  "cpu",
  "ram",
  "swap",
  "disk",
  "diskBytes",
  "netIn",
  "netOut",
  "connections",
  "udp",
  "process",
  "load",
];

interface ChartPoint {
  time: number;
  [key: string]: number | null;
}


function metricData(points: ChartPoint[], keys: string[]): uPlot.AlignedData {
  const times = points.map((point) => point.time);
  return [times, ...keys.map((key) => points.map((point) => point[key] ?? null))] as uPlot.AlignedData;
}

function getHistoryRenderLimit(hours: number) {
  if (hours <= 4) return LOAD_HISTORY_SAMPLE_LIMIT;
  return LOAD_HISTORY_RENDER_LIMIT;
}

function downsamplePoints(points: ChartPoint[], limit: number) {
  if (points.length <= limit || limit < 2) return points;

  const result: ChartPoint[] = [];
  const lastIndex = points.length - 1;
  const step = lastIndex / (limit - 1);
  let previousIndex = -1;

  for (let index = 0; index < limit; index += 1) {
    const sourceIndex = Math.min(lastIndex, Math.round(index * step));
    if (sourceIndex === previousIndex) continue;
    result.push(points[sourceIndex]);
    previousIndex = sourceIndex;
  }

  return result;
}

function formatRangeSummary(hours: number) {
  if (hours === 0) return "实时";
  if (hours % 24 === 0) return `${hours / 24} 天`;
  return `${hours} 小时`;
}

function getSeriesLabel(key: string) {
  return SERIES_LABELS[key] ?? key;
}

function pointFromNode(node: NodeMetrics): ChartPoint {
  return {
    time: Date.now() / 1000,
    cpu: node.cpuPct,
    ram: node.ramTotal > 0 ? (node.ramUsed / node.ramTotal) * 100 : 0,
    swap: node.swapTotal > 0 ? (node.swapUsed / node.swapTotal) * 100 : 0,
    disk: node.diskTotal > 0 ? (node.diskUsed / node.diskTotal) * 100 : 0,
    diskBytes: node.diskUsed,
    netIn: node.netDown,
    netOut: node.netUp,
    connections: node.connectionsTcp,
    udp: node.connectionsUdp,
    process: node.process,
    load: node.load1,
  };
}

function formatTooltipValue(key: string, value: number | null | undefined, unit: string) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (key === "netIn" || key === "netOut") return formatTrafficRateLabel(value);
  if (unit === "%") return `${value.toFixed(2)}%`;
  if (key === "process" || key === "connections" || key === "udp") return `${Math.round(value)}`;
  return value.toFixed(2);
}

function formatPercentAxisValue(value: number, min: number, max: number) {
  const span = Math.abs(max - min);
  if (span < 0.5) return `${value.toFixed(2)}%`;
  if (span < 5) return `${value.toFixed(1)}%`;
  return `${Math.round(value)}%`;
}

function formatNetworkAxisValue(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "";
  return formatTrafficRateLabel(value);
}

function formatCountAxisValue(value: number, min: number, max: number) {
  const span = Math.abs(max - min);
  if (span < 10) return value.toFixed(1);
  return `${Math.round(value)}`;
}

// Size-independent options. Width/height are added by the caller in a separate
// memo so a resize only changes those keys — uplot-react then calls setSize()
// instead of recreating the chart. (Plain function, not a hook — it calls no
// hooks; the previous `use` prefix tripped the rules-of-hooks lint.)
function buildBaseOptions({
  title,
  keys,
  colors,
  unit,
  resolvedAppearance,
  rangeHours,
  spanGaps,
  axisKind = "default",
  axisSize = 52,
}: {
  title: string;
  keys: string[];
  colors: string[];
  unit: string;
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  spanGaps?: boolean;
  axisKind?: "default" | "percent" | "network" | "count";
  axisSize?: number;
}): Omit<uPlot.Options, "width" | "height"> {
  const isDark = resolvedAppearance === "dark";
  const grid = isDark ? "rgba(255,255,255,0.065)" : "rgba(0,0,0,0.08)";
  const text = isDark ? "#a5a5aa" : "#52525b";

  return {
    padding: [8, 12, 10, 2],
    cursor: { drag: { x: true, y: false } },
    legend: { show: false },
    scales: { x: { time: true }, y: { auto: true } },
    axes: [
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: rangeHours >= 72 ? 38 : 34,
        values: createTimeAxisFormatter(rangeHours),
      },
      {
        stroke: text,
        grid: { stroke: grid, width: 1 },
        ticks: { stroke: grid },
        size: axisSize,
        values: (self, splits) => {
          const min = Number(self.scales.y.min ?? 0);
          const max = Number(self.scales.y.max ?? 0);
          return splits.map((value) => {
            if (value === 0 && axisKind !== "percent") return "";
            if (axisKind === "network") return formatNetworkAxisValue(value);
            if (axisKind === "percent") return formatPercentAxisValue(value, min, max);
            if (axisKind === "count") return formatCountAxisValue(value, min, max);
            return value === 0 ? "" : `${Math.round(value)}${unit}`;
          });
        },
      },
    ],
    series: [
      { label: "time" },
      ...keys.map((key, index) => ({
        label: key,
        stroke: colors[index] ?? colors[0],
        fill: index === 0 ? `${colors[index] ?? colors[0]}22` : undefined,
        width: 1.6,
        spanGaps: spanGaps ?? false,
        points: { show: false },
      })),
    ],
    hooks: {
      init: [
        (u) => {
          u.root.setAttribute("aria-label", title);
        },
      ],
    },
  };
}

const ChartCard = memo(function ChartCard({
  icon,
  title,
  value,
  note,
  points,
  keys,
  colors,
  width,
  height,
  resolvedAppearance,
  rangeHours,
  unit = "",
  spanGaps,
  axisKind,
  axisSize,
}: {
  icon: ReactNode;
  title: string;
  value: ReactNode;
  note?: ReactNode;
  points: ChartPoint[];
  keys: string[];
  colors: string[];
  width: number;
  height: number;
  resolvedAppearance: "light" | "dark";
  rangeHours: number;
  unit?: string;
  spanGaps?: boolean;
  axisKind?: "default" | "percent" | "network" | "count";
  axisSize?: number;
}) {
  const dataRef = useRef<uPlot.AlignedData>([[]]);
  const [tooltip, setTooltip] = useState<ChartTooltipState>({
    show: false,
    left: 0,
    top: 0,
    rows: [],
    time: "",
  });
  const data = useMemo(() => metricData(points, keys), [points, keys]);
  useEffect(() => {
    dataRef.current = data;
  }, [data]);
  const baseOptions = useMemo(
    () =>
      buildBaseOptions({
        title,
        keys,
        colors,
        unit,
        resolvedAppearance,
        rangeHours,
        spanGaps,
        axisKind,
        axisSize,
      }),
    [axisKind, axisSize, colors, keys, rangeHours, resolvedAppearance, spanGaps, title, unit],
  );

  // Size-independent enhanced options (base + interaction hooks). Stable across
  // resizes so only width/height change on the final object below.
  const enhancedOptions = useMemo<Omit<uPlot.Options, "width" | "height">>(() => ({
    ...baseOptions,
    hooks: {
      ...baseOptions.hooks,
      init: [
        ...(baseOptions.hooks?.init ?? []),
        (u) => {
          u.root.addEventListener("mouseleave", () => {
            setTooltip((prev) => ({ ...prev, show: false }));
          });
        },
      ],
      setCursor: [
        (u) => {
          const idx = u.cursor.idx;
          if (idx == null || idx < 0) {
            setTooltip((prev) => ({ ...prev, show: false }));
            return;
          }
          const currentData = dataRef.current;
          const timestamp = currentData[0]?.[idx];
          if (typeof timestamp !== "number") {
            setTooltip((prev) => ({ ...prev, show: false }));
            return;
          }
          const rows = keys.map((key, keyIndex) => {
            const value = currentData[keyIndex + 1]?.[idx] as number | null | undefined;
            return {
              label: getSeriesLabel(key),
              value: formatTooltipValue(key, value, unit),
              color: colors[keyIndex] ?? colors[0],
            };
          });
          const bbox = u.root.getBoundingClientRect();
          const anchorX = u.valToPos(timestamp, "x");
          const anchorY = typeof u.cursor.top === "number" ? u.cursor.top : bbox.height * 0.5;
          const position = getChartTooltipPosition({
            containerWidth: bbox.width,
            containerHeight: bbox.height,
            anchorX,
            anchorY,
            rowCount: rows.length,
            estimatedWidth: 176,
          });
          setTooltip({
            show: true,
            left: position.left,
            top: position.top,
            rows,
            time: formatTooltipTime(timestamp, rangeHours),
          });
        },
      ],
    },
  }), [colors, keys, baseOptions, rangeHours, unit]);

  // Only this memo changes on resize, so uplot-react performs a setSize() rather
  // than a full teardown/rebuild of the chart.
  const chartOptions = useMemo<uPlot.Options>(
    () => ({ ...enhancedOptions, width, height }) as uPlot.Options,
    [enhancedOptions, width, height],
  );

  return (
    <div
      className="instance-chart-card"
      style={{ "--chart-accent": colors[0] } as CSSProperties}
    >
      <header className="instance-chart-card-head">
        <div className="instance-panel-subhead">
          {icon}
          <span>{title}</span>
        </div>
        <div className="instance-series-stats">
          <span className="tabular">{value}</span>
          {note && <span className="tabular text-[var(--text-tertiary)]">{note}</span>}
        </div>
      </header>
      <div className="instance-uplot-wrap">
        <UplotReact options={chartOptions} data={data} />
        {tooltip.show && (
          <div
            className="instance-chart-tooltip"
            style={{ left: tooltip.left, top: tooltip.top }}
          >
            <div className="instance-chart-tooltip-time">{tooltip.time}</div>
            {tooltip.rows.map((row) => (
              <div key={row.label} className="instance-chart-tooltip-row">
                <span className="instance-chart-tooltip-dot" style={{ background: row.color }} />
                <span>{row.label}</span>
                <strong>{row.value}</strong>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

export function LoadChart({
  uuid,
  hours,
  active = true,
}: {
  uuid: string;
  hours: number;
  active?: boolean;
}) {
  const queryHours = hours === 0 ? 1 : hours;
  const { data, isLoading } = useLoadRecords(uuid, queryHours, active);
  const isRealtime = hours === 0;
  const node = useNodeMetrics(uuid, isRealtime && active);
  const { resolvedAppearance } = usePreferences();
  const { w, h } = useResponsiveChartSize("grid");
  const [realtimePoints, setRealtimePoints] = useState<ChartPoint[]>([]);
  const [connectNulls, setConnectNulls] = useState(false);

  useEffect(() => {
    if (!active || !isRealtime || !node) return;
    const point = pointFromNode(node);
    setRealtimePoints((prev) => {
      const last = prev[prev.length - 1];
      if (last && Math.abs(last.time - point.time) < 1) return prev;
      return [...prev, point].slice(-REALTIME_SAMPLE_LIMIT);
    });
  }, [active, isRealtime, node]);

  useEffect(() => {
    setRealtimePoints([]);
  }, [hours, uuid]);

  const historyPoints = useMemo<ChartPoint[]>(() => {
    const records = [...(data?.records ?? [])];
    const rawPoints = records
      .map((record) => ({
        time: toChartSeconds(record.time),
        cpu: record.cpu,
        ram: record.ram_total > 0 ? (record.ram / record.ram_total) * 100 : 0,
        swap: record.swap_total > 0 ? (record.swap / record.swap_total) * 100 : 0,
        disk: record.disk_total > 0 ? (record.disk / record.disk_total) * 100 : 0,
        diskBytes: record.disk,
        netIn: record.net_in,
        netOut: record.net_out,
        connections: record.connections,
        udp: record.connections_udp,
        process: record.process,
        load: record.load,
      }))
      .filter((point) => point.time > 0)
      .sort((a, b) => a.time - b.time);
    const sampled = downsamplePoints(rawPoints, getHistoryRenderLimit(hours));
    const filled = fillMissingMetricPoints(sampled);
    return interpolateMetricGaps(filled, LOAD_INTERPOLATE_KEYS);
  }, [data, hours]);

  const points = useMemo<ChartPoint[]>(() => {
    if (isRealtime) {
      const initial = historyPoints.slice(-REALTIME_HISTORY_SEED_LIMIT);
      const merged = [...initial, ...realtimePoints].sort((a, b) => a.time - b.time);
      const deduped = merged.filter((point, index, arr) => {
        const next = arr[index + 1];
        return !next || Math.abs(next.time - point.time) >= 1;
      });
      return deduped.slice(-REALTIME_SAMPLE_LIMIT);
    }
    return historyPoints;
  }, [historyPoints, isRealtime, realtimePoints]);

  const rangeSummary = formatRangeSummary(hours);
  const sourceRecordCount = data?.records.length ?? 0;
  const wasDownsampled = !isRealtime && sourceRecordCount > getHistoryRenderLimit(hours);
  const sampleSummary = isRealtime
    ? `${points.length} 个点`
    : wasDownsampled
      ? `${points.length} / ${sourceRecordCount} 个点`
      : `${points.length} 个点`;
  const coverageSummary = points.length
    ? `${formatChartCoverageTime(points[0].time)} - ${formatChartCoverageTime(points[points.length - 1].time)}`
    : "—";

  if (isLoading) {
    return <section className="instance-panel h-[260px] animate-pulse" aria-busy />;
  }

  if (!points.length) {
    return (
      <InstancePanel title="负载图表">
        <div className="instance-empty">暂无负载历史数据</div>
      </InstancePanel>
    );
  }

  return (
    <InstancePanel
      title="负载图表"
      description={coverageSummary}
      aside={<span className="instance-chart-range-chip">{rangeSummary}</span>}
      className="instance-chart-panel"
    >
      <div className="instance-chart-toolbar">
        <div className="instance-chart-meta" aria-label="图表数据范围">
          <span>
            覆盖 <strong>{coverageSummary}</strong>
          </span>
          <span>
            采样 <strong>{sampleSummary}</strong>
          </span>
        </div>
        <button
          type="button"
          className="instance-toggle-button instance-switch-button"
          data-active={connectNulls ? "true" : "false"}
          onClick={() => setConnectNulls((value) => !value)}
          aria-pressed={connectNulls}
        >
          <span className="instance-switch-copy">断点连线</span>
          <span className="instance-switch-track" aria-hidden>
            <span className="instance-switch-thumb" />
          </span>
          <span className="instance-switch-state">
            {connectNulls ? "开启" : "关闭"}
          </span>
        </button>
      </div>
      <div className="instance-chart-grid">
        <ChartCard
          icon={<Cpu size={13} />}
          title="CPU"
          value={
            isRealtime && node
              ? `${node.cpuPct.toFixed(2)}%`
              : `${(points[points.length - 1]?.cpu ?? 0).toFixed(2)}%`
          }
          note="使用率"
          points={points}
          keys={CPU_KEYS}
          colors={CPU_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
        />
        <ChartCard
          icon={<MemoryStick size={13} />}
          title="内存"
          value={
            isRealtime && node
              ? `${formatBytes(node.ramUsed)} / ${formatBytes(node.ramTotal)}`
              : data?.records.length
                ? `${formatBytes(data.records[data.records.length - 1]?.ram ?? 0)} / ${formatBytes(data.records[data.records.length - 1]?.ram_total ?? 0)}`
                : "—"
          }
          note={
            isRealtime && node
              ? node.swapTotal
                ? `Swap ${formatBytes(node.swapUsed)} / ${formatBytes(node.swapTotal)}`
                : "Swap 无"
              : data?.records.length && (data.records[data.records.length - 1]?.swap_total ?? 0) > 0
                ? `Swap ${formatBytes(data.records[data.records.length - 1]?.swap ?? 0)} / ${formatBytes(data.records[data.records.length - 1]?.swap_total ?? 0)}`
                : "Swap 无"
          }
          points={points}
          keys={MEMORY_KEYS}
          colors={MEMORY_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
        />
        <ChartCard
          icon={<HardDrive size={13} />}
          title="磁盘"
          value={
            isRealtime && node
              ? `${formatBytes(node.diskUsed)} / ${formatBytes(node.diskTotal)}`
              : data?.records.length
                ? `${formatBytes(data.records[data.records.length - 1]?.disk ?? 0)} / ${formatBytes(data.records[data.records.length - 1]?.disk_total ?? 0)}`
                : "—"
          }
          note="已用空间"
          points={points}
          keys={DISK_KEYS}
          colors={DISK_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          unit="%"
          spanGaps={connectNulls}
          axisKind="percent"
        />
        <ChartCard
          icon={<Network size={13} />}
          title="网络"
          value={
            isRealtime && node
              ? `${formatTrafficRateLabel(node.netDown)} / ${formatTrafficRateLabel(node.netUp)}`
              : data?.records.length
                ? `${formatTrafficRateLabel(data.records[data.records.length - 1]?.net_in ?? 0)} / ${formatTrafficRateLabel(data.records[data.records.length - 1]?.net_out ?? 0)}`
                : "—"
          }
          note={
            <span className="instance-overview-multi">
              <span className="inline-flex items-center gap-1"><ArrowDown size={11} />{isRealtime && node ? formatBytes(node.trafficDown) : data?.records.length ? formatBytes(data.records[data.records.length - 1]?.net_total_down ?? 0) : "—"}</span>
              <span className="inline-flex items-center gap-1"><ArrowUp size={11} />{isRealtime && node ? formatBytes(node.trafficUp) : data?.records.length ? formatBytes(data.records[data.records.length - 1]?.net_total_up ?? 0) : "—"}</span>
            </span>
          }
          points={points}
          keys={NETWORK_KEYS}
          colors={NETWORK_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="network"
          axisSize={78}
        />
        <ChartCard
          icon={<Workflow size={13} />}
          title="连接数"
          value={
            isRealtime && node
              ? `TCP ${node.connectionsTcp} / UDP ${node.connectionsUdp}`
              : data?.records.length
                ? `TCP ${Math.round(data.records[data.records.length - 1]?.connections ?? 0)} / UDP ${Math.round(data.records[data.records.length - 1]?.connections_udp ?? 0)}`
                : "—"
          }
          note="连接"
          points={points}
          keys={CONNECTION_KEYS}
          colors={CONNECTION_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="count"
        />
        <ChartCard
          icon={<Gauge size={13} />}
          title="进程"
          value={
            isRealtime && node
              ? node.process.toString()
              : data?.records.length
                ? Math.round(data.records[data.records.length - 1]?.process ?? 0).toString()
                : "—"
          }
          note={
            isRealtime && node
              ? `负载 ${node.load1.toFixed(2)} | ${node.load5.toFixed(2)} | ${node.load15.toFixed(2)}`
              : data?.records.length
                ? `负载 ${(data.records[data.records.length - 1]?.load ?? 0).toFixed(2)}`
                : "—"
          }
          points={points}
          keys={PROCESS_KEYS}
          colors={PROCESS_COLORS}
          width={w}
          height={h}
          resolvedAppearance={resolvedAppearance}
          rangeHours={hours}
          spanGaps={connectNulls}
          axisKind="count"
        />
      </div>
    </InstancePanel>
  );
}
