import { useId } from "react";
import { type ChartData, niceTicks } from "../../lib/sheet/chartData";
import { formatCellValue } from "../../lib/sheet/numberFormat";
import { seriesColor } from "../../lib/sheet/palette";
import type { SheetChart } from "../../lib/sheet/sheetModel";

type Props = { chart: SheetChart; data: ChartData | null; width: number; height: number };

const AXIS_FONT = 11;

function label(value: number, format?: string): string {
  if (format && !/[dmyhs]/i.test(format.replace(/"[^"]*"/g, ""))) return formatCellValue(value, format).text;
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${Number((value / 1e9).toPrecision(3))}B`;
  if (abs >= 1e6) return `${Number((value / 1e6).toPrecision(3))}M`;
  if (abs >= 1e4) return `${Number((value / 1e3).toPrecision(3))}K`;
  return String(Number(value.toPrecision(6)));
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
}

/** Draws a chart as SVG with the workbook palette, sized to its frame. The
 * same series and colours go into the .xlsx chart part on export. */
export function SheetChartView({ chart, data, width, height }: Props) {
  const titleId = useId();
  if (!data) {
    return (
      <svg className="sheet-chart-svg" width={width} height={height} role="img" aria-label="Chart with no data">
        <text x={width / 2} y={height / 2} textAnchor="middle" className="sheet-chart-empty">Pick a data range with numbers to chart.</text>
      </svg>
    );
  }
  const title = chart.title?.trim();
  const legend = chart.legend;
  const radial = chart.type === "pie" || chart.type === "doughnut";
  const legendItems = radial ? data.categories.map((name, index) => ({ name, color: pieColor(data, index) })) : data.series.map((series) => ({ name: series.name, color: series.color }));
  const top = title ? 34 : 12;
  const legendRight = legend === "right" ? Math.min(170, width * 0.3) : 0;
  const legendBottom = legend === "bottom" ? 30 : 0;
  const legendTop = legend === "top" ? 26 : 0;
  const plot = { x: 12, y: top + legendTop, w: width - 24 - legendRight, h: height - top - legendTop - legendBottom - 12 };

  return (
    <svg className="sheet-chart-svg" width={width} height={height} role="img" aria-labelledby={titleId}>
      <title id={titleId}>{`${title || "Chart"}: ${chart.type} chart of ${data.series.map((series) => series.name).join(", ")}`}</title>
      <rect className="sheet-chart-bg" x={0.5} y={0.5} width={width - 1} height={height - 1} rx={10} />
      {title && <text className="sheet-chart-title" x={width / 2} y={22} textAnchor="middle">{truncate(title, Math.floor(width / 8))}</text>}
      {radial ? <RadialPlot chart={chart} data={data} plot={plot} /> : <CartesianPlot chart={chart} data={data} plot={plot} />}
      {legend !== "none" && <Legend items={legendItems} position={legend} width={width} height={height} top={top} reserved={legendRight} />}
    </svg>
  );
}

/** Pie and doughnut slices take one accent per category. */
function pieColor(_data: ChartData, index: number): string {
  return seriesColor(index);
}

function Legend({ items, position, width, height, top, reserved }: { items: { name: string; color: string }[]; position: string; width: number; height: number; top: number; reserved: number }) {
  if (position === "right") {
    return (
      <g className="sheet-chart-legend">
        {items.slice(0, Math.floor((height - top) / 18)).map((item, index) => (
          <g key={`${item.name}-${index}`} transform={`translate(${width - reserved + 4}, ${top + 10 + index * 18})`}>
            <rect width={10} height={10} rx={2} fill={item.color} />
            <text x={15} y={9}>{truncate(item.name, Math.floor((reserved - 20) / 6.5))}</text>
          </g>
        ))}
      </g>
    );
  }
  const y = position === "top" ? top + 6 : height - 20;
  const slot = Math.max(60, Math.min(150, (width - 24) / Math.max(1, items.length)));
  const visible = items.slice(0, Math.max(1, Math.floor((width - 24) / slot)));
  const start = (width - visible.length * slot) / 2;
  return (
    <g className="sheet-chart-legend">
      {visible.map((item, index) => (
        <g key={`${item.name}-${index}`} transform={`translate(${start + index * slot}, ${y})`}>
          <rect width={10} height={10} rx={2} fill={item.color} />
          <text x={15} y={9}>{truncate(item.name, Math.floor((slot - 20) / 6.5))}</text>
        </g>
      ))}
    </g>
  );
}

type Plot = { x: number; y: number; w: number; h: number };

function CartesianPlot({ chart, data, plot }: { chart: SheetChart; data: ChartData; plot: Plot }) {
  const horizontal = chart.type === "bar";
  const stacked = Boolean(chart.stacked) && chart.type !== "scatter" && chart.type !== "line";
  const count = data.categories.length;
  const values = data.series.flatMap((series) => series.values.filter((value): value is number => value !== null));
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (stacked) {
    const sums = data.categories.map((_, index) => data.series.reduce((total, series) => total + Math.max(0, series.values[index] ?? 0), 0));
    const negatives = data.categories.map((_, index) => data.series.reduce((total, series) => total + Math.min(0, series.values[index] ?? 0), 0));
    max = Math.max(0, ...sums);
    min = Math.min(0, ...negatives);
  }
  if (chart.type === "line" || chart.type === "scatter") {
    if (values.length && Math.min(...values) > 0 && Math.min(...values) > (Math.max(...values) - Math.min(...values)) * 2) min = Math.min(...values);
  }
  const ticks = niceTicks(min, max, Math.max(2, Math.floor((horizontal ? plot.w : plot.h) / 48)));
  const lo = ticks[0];
  const hi = ticks[ticks.length - 1];
  const axisLabelWidth = Math.max(...ticks.map((tick) => label(tick, data.valueFormat).length)) * 6.6 + 8;
  const yTitle = chart.yTitle ? 16 : 0;
  const xTitle = chart.xTitle ? 16 : 0;
  const categoryBand = horizontal ? Math.min(120, Math.max(...data.categories.map((item) => item.length), 1) * 6.4 + 10) : 0;
  const inner = {
    x: plot.x + yTitle + (horizontal ? categoryBand : axisLabelWidth),
    y: plot.y + 4,
    w: plot.w - yTitle - (horizontal ? categoryBand : axisLabelWidth) - 6,
    h: plot.h - 22 - xTitle - 4,
  };
  if (inner.w < 20 || inner.h < 20) return null;
  const scale = (value: number) => (hi === lo ? 0 : (value - lo) / (hi - lo));
  const valuePos = (value: number) => (horizontal ? inner.x + scale(value) * inner.w : inner.y + inner.h - scale(value) * inner.h);
  const zero = valuePos(Math.max(lo, Math.min(hi, 0)));
  const xs = data.xValues?.filter((value): value is number => value !== null) ?? [];
  const xTicks = chart.type === "scatter" && xs.length ? niceTicks(Math.min(...xs), Math.max(...xs), Math.max(2, Math.floor(inner.w / 70))) : null;
  const slot = (horizontal ? inner.h : inner.w) / Math.max(1, count);
  const categoryPos = (index: number) => {
    if (xTicks && data.xValues) {
      const value = data.xValues[index] ?? 0;
      return inner.x + ((value - xTicks[0]) / (xTicks[xTicks.length - 1] - xTicks[0] || 1)) * inner.w;
    }
    return (horizontal ? inner.y : inner.x) + slot * index + slot / 2;
  };
  const labelEvery = Math.max(1, Math.ceil((count * 54) / Math.max(1, horizontal ? inner.h * 2 : inner.w)));

  return (
    <g>
      {ticks.map((tick) => (
        <g key={tick} className="sheet-chart-grid">
          {horizontal ? (
            <>
              <line x1={valuePos(tick)} x2={valuePos(tick)} y1={inner.y} y2={inner.y + inner.h} />
              <text x={valuePos(tick)} y={inner.y + inner.h + 15} textAnchor="middle" className="sheet-chart-axis">{label(tick, data.valueFormat)}</text>
            </>
          ) : (
            <>
              <line x1={inner.x} x2={inner.x + inner.w} y1={valuePos(tick)} y2={valuePos(tick)} />
              <text x={inner.x - 6} y={valuePos(tick) + 4} textAnchor="end" className="sheet-chart-axis">{label(tick, data.valueFormat)}</text>
            </>
          )}
        </g>
      ))}
      {xTicks && xTicks.map((tick) => {
        const x = inner.x + ((tick - xTicks[0]) / (xTicks[xTicks.length - 1] - xTicks[0] || 1)) * inner.w;
        return <text key={`x-${tick}`} x={x} y={inner.y + inner.h + 15} textAnchor="middle" className="sheet-chart-axis">{label(tick)}</text>;
      })}
      {!xTicks && data.categories.map((category, index) => (index % labelEvery === 0 ? (
        horizontal ? (
          <text key={`c-${index}`} x={inner.x - 6} y={categoryPos(index) + 4} textAnchor="end" className="sheet-chart-axis">{truncate(category, 18)}</text>
        ) : (
          <text key={`c-${index}`} x={categoryPos(index)} y={inner.y + inner.h + 15} textAnchor="middle" className="sheet-chart-axis">{truncate(category, Math.max(3, Math.floor((slot * labelEvery) / 6.5)))}</text>
        )
      ) : null))}
      <line className="sheet-chart-baseline" x1={horizontal ? zero : inner.x} x2={horizontal ? zero : inner.x + inner.w} y1={horizontal ? inner.y : zero} y2={horizontal ? inner.y + inner.h : zero} />
      {chart.type === "column" || chart.type === "bar" ? (
        <Bars data={data} stacked={stacked} horizontal={horizontal} slot={slot} categoryPos={categoryPos} valuePos={valuePos} zero={zero} showValues={Boolean(chart.showValues)} />
      ) : (
        <Lines data={data} stacked={stacked} area={chart.type === "area"} scatter={chart.type === "scatter"} categoryPos={categoryPos} valuePos={valuePos} zero={zero} showValues={Boolean(chart.showValues)} />
      )}
      {chart.yTitle && <text className="sheet-chart-axis-title" transform={`translate(${plot.x + 10}, ${inner.y + inner.h / 2}) rotate(-90)`} textAnchor="middle">{truncate(chart.yTitle, 40)}</text>}
      {chart.xTitle && <text className="sheet-chart-axis-title" x={inner.x + inner.w / 2} y={plot.y + plot.h - 2} textAnchor="middle">{truncate(chart.xTitle, 60)}</text>}
    </g>
  );
}

type BarProps = {
  data: ChartData;
  stacked: boolean;
  horizontal: boolean;
  slot: number;
  categoryPos: (index: number) => number;
  valuePos: (value: number) => number;
  zero: number;
  showValues: boolean;
};

function Bars({ data, stacked, horizontal, slot, categoryPos, valuePos, zero, showValues }: BarProps) {
  const groups = stacked ? 1 : data.series.length;
  const band = slot * 0.72;
  const thickness = Math.max(2, band / groups);
  return (
    <g>
      {data.categories.map((_, index) => {
        let positive = 0;
        let negative = 0;
        return data.series.map((series, s) => {
          const value = series.values[index];
          if (value === null) return null;
          let from = 0;
          let to = value;
          if (stacked) {
            from = value >= 0 ? positive : negative;
            to = from + value;
            if (value >= 0) positive = to;
            else negative = to;
          }
          const a = stacked ? valuePos(from) : zero;
          const b = valuePos(to);
          const offset = categoryPos(index) - band / 2 + (stacked ? 0 : s * thickness);
          const rect = horizontal
            ? { x: Math.min(a, b), y: offset, width: Math.max(1, Math.abs(b - a)), height: thickness - 1 }
            : { x: offset, y: Math.min(a, b), width: thickness - 1, height: Math.max(1, Math.abs(b - a)) };
          return (
            <g key={`${index}-${s}`}>
              <rect className="sheet-chart-bar" {...rect} rx={Math.min(3, thickness / 4)} fill={series.color}>
                <title>{`${series.name} · ${data.categories[index]}: ${formatCellValue(value, series.format).text}`}</title>
              </rect>
              {showValues && (
                <text className="sheet-chart-value" x={horizontal ? rect.x + rect.width + 4 : rect.x + rect.width / 2} y={horizontal ? rect.y + rect.height / 2 + 4 : rect.y - 4} textAnchor={horizontal ? "start" : "middle"}>
                  {label(value, series.format)}
                </text>
              )}
            </g>
          );
        });
      })}
    </g>
  );
}

type LineProps = {
  data: ChartData;
  stacked: boolean;
  area: boolean;
  scatter: boolean;
  categoryPos: (index: number) => number;
  valuePos: (value: number) => number;
  zero: number;
  showValues: boolean;
};

function Lines({ data, stacked, area, scatter, categoryPos, valuePos, zero, showValues }: LineProps) {
  const running = data.categories.map(() => 0);
  return (
    <g>
      {data.series.map((series, s) => {
        const points: { x: number; y: number; value: number; index: number }[] = [];
        const bases: number[] = [];
        series.values.forEach((value, index) => {
          if (value === null) return;
          const base = stacked ? running[index] : 0;
          const top = base + value;
          if (stacked) running[index] = top;
          bases.push(valuePos(base));
          points.push({ x: categoryPos(index), y: valuePos(top), value, index });
        });
        if (!points.length) return null;
        const path = points.map((point, index) => `${index ? "L" : "M"}${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(" ");
        const areaPath = area
          ? `${path} ${points.slice().reverse().map((point, index) => `L${point.x.toFixed(1)},${(stacked ? bases[points.length - 1 - index] : zero).toFixed(1)}`).join(" ")} Z`
          : "";
        return (
          <g key={series.name + s}>
            {area && <path className="sheet-chart-area" d={areaPath} fill={series.color} />}
            {!scatter && <path className="sheet-chart-line" d={path} stroke={series.color} />}
            {(scatter || points.length <= 40) && points.map((point) => (
              <circle key={point.index} className="sheet-chart-dot" cx={point.x} cy={point.y} r={scatter ? 4 : 3} fill={series.color}>
                <title>{`${series.name} · ${data.categories[point.index]}: ${formatCellValue(point.value, series.format).text}`}</title>
              </circle>
            ))}
            {showValues && points.map((point) => (
              <text key={`v-${point.index}`} className="sheet-chart-value" x={point.x} y={point.y - 7} textAnchor="middle">{label(point.value, series.format)}</text>
            ))}
          </g>
        );
      })}
    </g>
  );
}

function RadialPlot({ chart, data, plot }: { chart: SheetChart; data: ChartData; plot: Plot }) {
  const series = data.series[0];
  const values = series.values.map((value) => Math.max(0, value ?? 0));
  const total = values.reduce((sum, value) => sum + value, 0);
  const radius = Math.max(10, Math.min(plot.w, plot.h) / 2 - 6);
  const cx = plot.x + plot.w / 2;
  const cy = plot.y + plot.h / 2;
  const hole = chart.type === "doughnut" ? radius * 0.55 : 0;
  if (!total) return <text x={cx} y={cy} textAnchor="middle" className="sheet-chart-empty">No positive values to chart.</text>;
  let angle = -Math.PI / 2;
  return (
    <g>
      {values.map((value, index) => {
        if (!value) return null;
        const sweep = (value / total) * Math.PI * 2;
        const start = angle;
        const end = angle + sweep;
        angle = end;
        const large = sweep > Math.PI ? 1 : 0;
        const point = (r: number, a: number) => `${(cx + r * Math.cos(a)).toFixed(2)},${(cy + r * Math.sin(a)).toFixed(2)}`;
        const full = sweep >= Math.PI * 2 - 1e-6;
        const d = full
          ? `M${point(radius, start)} A${radius},${radius} 0 1 1 ${point(radius, start + Math.PI)} A${radius},${radius} 0 1 1 ${point(radius, start)} Z`
          : hole
            ? `M${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} L${point(hole, end)} A${hole},${hole} 0 ${large} 0 ${point(hole, start)} Z`
            : `M${cx},${cy} L${point(radius, start)} A${radius},${radius} 0 ${large} 1 ${point(radius, end)} Z`;
        const mid = start + sweep / 2;
        const share = value / total;
        return (
          <g key={index}>
            <path className="sheet-chart-slice" d={d} fill={pieColor(data, index)}>
              <title>{`${data.categories[index]}: ${formatCellValue(value, series.format).text} (${(share * 100).toFixed(1)}%)`}</title>
            </path>
            {(chart.showValues || share >= 0.06) && (
              <text className="sheet-chart-slice-label" x={cx + (hole ? (radius + hole) / 2 : radius * 0.62) * Math.cos(mid)} y={cy + (hole ? (radius + hole) / 2 : radius * 0.62) * Math.sin(mid) + 4} textAnchor="middle">
                {chart.showValues ? label(value, series.format) : `${Math.round(share * 100)}%`}
              </text>
            )}
          </g>
        );
      })}
    </g>
  );
}
