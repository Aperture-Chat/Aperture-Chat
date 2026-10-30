/** Charts as DrawingML chart parts (xl/charts/chartN.xml) plus the sheet's
 * drawing part that anchors them. Series point at the source range on its
 * sheet and carry caches of the engine's values, so the chart draws before
 * Excel recalculates. Element order follows the chart schema exactly. */

import { cellKey, parseCellKey, parseRangeRef, splitSheetQualifiedRef, type CellPoint, type CellRange } from "../address";
import { isError, type Scalar } from "../formula/values";
import { formatCellValue } from "../numberFormat";
import { seriesColor } from "../palette";
import { sheetByName, type Sheet, type SheetChart } from "../sheetModel";
import { effectiveStyle } from "../sheetOps";
import type { ExportContext } from "./context";
import { absoluteRef } from "./formulaText";
import { attrs, escapeXml, NS, plainText, rgb, XML_HEADER } from "./xml";

const EMU_PER_PX = 9525;
const CAT_AX = 500000001;
const VAL_AX = 500000002;

type Source = { sheet: Sheet; range: CellRange };
type Ref = { formula: string; range: CellRange };
type Series = { name: Ref | null; categories: Ref | null; values: Ref };

function chartSource(ctx: ExportContext, sheet: Sheet, chart: SheetChart): Source | null {
  const { sheet: sheetName, ref } = splitSheetQualifiedRef(chart.source);
  const target = sheetName === null ? sheet : sheetByName(ctx.workbook, sheetName);
  const range = parseRangeRef(ref);
  return target && range ? { sheet: target, range } : null;
}

function refOf(source: Source, range: CellRange): Ref {
  const text = range.r1 === range.r2 && range.c1 === range.c2 ? cellKey(range.r1, range.c1) : `${cellKey(range.r1, range.c1)}:${cellKey(range.r2, range.c2)}`;
  return { formula: absoluteRef(source.sheet.name, text), range };
}

/** Series by columns: header row names them, the first column is categories.
 * By rows the roles swap. A one-line source is a single unnamed-category series. */
export function chartSeries(source: Source, chart: SheetChart): Series[] {
  const { r1, c1, r2, c2 } = source.range;
  const byRows = chart.seriesBy === "rows";
  const lines = byRows ? r2 - r1 : c2 - c1;
  const depth = byRows ? c2 - c1 : r2 - r1;
  const hasCategories = lines >= 1;
  const hasNames = depth >= 1;
  const start = hasNames ? 1 : 0;
  /** Line `index` (a row or column of the source) from offset `from` to its end. */
  const line = (index: number, from: number): CellRange =>
    byRows ? { r1: r1 + index, c1: c1 + from, r2: r1 + index, c2 } : { r1: r1 + from, c1: c1 + index, r2, c2: c1 + index };
  const head = (index: number): CellRange => {
    const whole = line(index, 0);
    return { r1: whole.r1, c1: whole.c1, r2: whole.r1, c2: whole.c1 };
  };
  const series: Series[] = [];
  for (let index = hasCategories ? 1 : 0; index <= lines; index += 1) {
    series.push({
      name: hasNames ? refOf(source, head(index)) : null,
      categories: hasCategories ? refOf(source, line(0, start)) : null,
      values: refOf(source, line(index, start)),
    });
  }
  return series;
}

function cellsOf(ctx: ExportContext, sheet: Sheet, range: CellRange): { value: Scalar; format?: string }[] {
  const out: { value: Scalar; format?: string }[] = [];
  for (let row = range.r1; row <= range.r2; row += 1) {
    for (let col = range.c1; col <= range.c2; col += 1) {
      out.push({ value: ctx.engine.value(sheet.id, row, col), format: effectiveStyle(sheet, row, col)?.format });
    }
  }
  return out;
}

function pointText(value: Scalar, format: string | undefined): string {
  if (value === null) return "";
  if (isError(value)) return value.code;
  return plainText(formatCellValue(value, format).text);
}

function strRef(ctx: ExportContext, sheet: Sheet, ref: Ref): string {
  const cells = cellsOf(ctx, sheet, ref.range);
  const points = cells
    .map((cell, index) => `<c:pt idx="${index}"><c:v>${escapeXml(pointText(cell.value, cell.format))}</c:v></c:pt>`)
    .join("");
  return `<c:strRef><c:f>${escapeXml(ref.formula)}</c:f><c:strCache><c:ptCount val="${cells.length}"/>${points}</c:strCache></c:strRef>`;
}

function numRef(ctx: ExportContext, sheet: Sheet, ref: Ref): string {
  const cells = cellsOf(ctx, sheet, ref.range);
  const format = cells.find((cell) => typeof cell.value === "number")?.format ?? "General";
  const points = cells
    .map((cell, index) => (Number.isFinite(cell.value) ? `<c:pt idx="${index}"><c:v>${cell.value}</c:v></c:pt>` : ""))
    .join("");
  return (
    `<c:numRef><c:f>${escapeXml(ref.formula)}</c:f><c:numCache><c:formatCode>${escapeXml(format)}</c:formatCode>` +
    `<c:ptCount val="${cells.length}"/>${points}</c:numCache></c:numRef>`
  );
}

/** Categories that are all numbers (or dates) stay numeric; anything else is text. */
function categoryRef(ctx: ExportContext, sheet: Sheet, ref: Ref): string {
  const values = cellsOf(ctx, sheet, ref.range).map((cell) => cell.value).filter((value) => value !== null);
  return values.length && values.every((value) => typeof value === "number") ? numRef(ctx, sheet, ref) : strRef(ctx, sheet, ref);
}

const solidFill = (color: string) => `<a:solidFill><a:srgbClr val="${rgb(color)}"/></a:solidFill>`;

function richText(text: string, options: { size?: number; vertical?: boolean } = {}): string {
  const body = options.vertical ? `<a:bodyPr rot="-5400000" vert="horz"/>` : `<a:bodyPr/>`;
  const size = options.size ? ` sz="${options.size}"` : "";
  return (
    `<c:tx><c:rich>${body}<a:lstStyle/><a:p><a:pPr><a:defRPr${size} b="0"/></a:pPr>` +
    `<a:r><a:rPr lang="en-US"${size} b="0"/><a:t>${escapeXml(plainText(text))}</a:t></a:r></a:p></c:rich></c:tx>`
  );
}

function titleXml(text: string | undefined, options: { size?: number; vertical?: boolean } = {}): string {
  return text ? `<c:title>${richText(text, options)}<c:overlay val="0"/></c:title>` : "";
}

const DATA_LABELS =
  `<c:dLbls><c:showLegendKey val="0"/><c:showVal val="1"/><c:showCatName val="0"/>` +
  `<c:showSerName val="0"/><c:showPercent val="0"/><c:showBubbleSize val="0"/></c:dLbls>`;

type SeriesContext = { ctx: ExportContext; sheet: Sheet; chart: SheetChart };

function seriesHead(sc: SeriesContext, series: Series, index: number): string {
  const name = series.name ? `<c:tx>${strRef(sc.ctx, sc.sheet, series.name)}</c:tx>` : "";
  return `<c:idx val="${index}"/><c:order val="${index}"/>${name}`;
}

/** One `<c:ser>`: head, the type's own styling, then the data refs in schema order. */
function serXml(sc: SeriesContext, series: Series, index: number, style: string, scatter = false, tail = ""): string {
  const [catTag, valTag] = scatter ? ["c:xVal", "c:yVal"] : ["c:cat", "c:val"];
  const categories = series.categories ? `<${catTag}>${categoryRef(sc.ctx, sc.sheet, series.categories)}</${catTag}>` : "";
  const values = `<${valTag}>${numRef(sc.ctx, sc.sheet, series.values)}</${valTag}>`;
  return `<c:ser>${seriesHead(sc, series, index)}${style}${categories}${values}${tail}</c:ser>`;
}

function barSeries(sc: SeriesContext, series: Series, index: number): string {
  return serXml(sc, series, index, `<c:spPr>${solidFill(seriesColor(index))}</c:spPr><c:invertIfNegative val="0"/>`);
}

function lineSeries(sc: SeriesContext, series: Series, index: number): string {
  const line = `<c:spPr><a:ln w="28575" cap="rnd">${solidFill(seriesColor(index))}<a:round/></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`;
  return serXml(sc, series, index, line, false, `<c:smooth val="0"/>`);
}

function areaSeries(sc: SeriesContext, series: Series, index: number): string {
  return serXml(sc, series, index, `<c:spPr>${solidFill(seriesColor(index))}</c:spPr>`);
}

/** Pie and doughnut slices take the accents point by point. */
function pieSeries(sc: SeriesContext, series: Series, index: number): string {
  const { r1, c1, r2, c2 } = series.values.range;
  const count = (r2 - r1 + 1) * (c2 - c1 + 1);
  const outline = `<a:ln><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill></a:ln>`;
  const points = Array.from({ length: count }, (_, point) => `<c:dPt><c:idx val="${point}"/><c:bubble3D val="0"/><c:spPr>${solidFill(seriesColor(point))}${outline}</c:spPr></c:dPt>`);
  return serXml(sc, series, index, points.join(""));
}

function scatterSeries(sc: SeriesContext, series: Series, index: number): string {
  const color = seriesColor(index);
  const style = `<c:spPr><a:ln w="25400"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/><c:spPr>${solidFill(color)}<a:ln>${solidFill(color)}</a:ln></c:spPr></c:marker>`;
  return serXml(sc, series, index, style, true, `<c:smooth val="0"/>`);
}

type AxisOptions = {
  id: number;
  cross: number;
  position: "b" | "l";
  title?: string;
  kind: "cat" | "val";
  gridlines?: boolean;
  crossBetween?: "between" | "midCat";
  /** "low" keeps labels at the plot's edge when values go negative. */
  labels?: "low" | "nextTo";
};

function axisXml(axis: AxisOptions): string {
  const { labels = "nextTo", crossBetween = "between" } = axis;
  const tag = axis.kind === "cat" ? "c:catAx" : "c:valAx";
  const shared =
    `<c:axId val="${axis.id}"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/>` +
    `<c:axPos val="${axis.position}"/>${axis.gridlines ? "<c:majorGridlines/>" : ""}` +
    titleXml(axis.title, { size: 1000, vertical: axis.position === "l" }) +
    `<c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="out"/><c:minorTickMark val="none"/>` +
    `<c:tickLblPos val="${labels}"/><c:crossAx val="${axis.cross}"/><c:crosses val="autoZero"/>`;
  const tail = axis.kind === "cat"
    ? `<c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/>`
    : `<c:crossBetween val="${crossBetween}"/>`;
  return `<${tag}>${shared}${tail}</${tag}>`;
}

/** Category and value axes; xTitle labels the horizontal one, yTitle the vertical. */
function categoryAxes(chart: SheetChart): string {
  const horizontalBars = chart.type === "bar";
  const cat: AxisOptions = { id: CAT_AX, cross: VAL_AX, kind: "cat", position: horizontalBars ? "l" : "b", title: horizontalBars ? chart.yTitle : chart.xTitle, labels: "low" };
  const val: AxisOptions = { id: VAL_AX, cross: CAT_AX, kind: "val", position: horizontalBars ? "b" : "l", title: horizontalBars ? chart.xTitle : chart.yTitle, gridlines: true };
  return axisXml(cat) + axisXml(val);
}

function scatterAxes(chart: SheetChart): string {
  return (
    axisXml({ id: CAT_AX, cross: VAL_AX, kind: "val", position: "b", title: chart.xTitle, crossBetween: "midCat", labels: "low" }) +
    axisXml({ id: VAL_AX, cross: CAT_AX, kind: "val", position: "l", title: chart.yTitle, gridlines: true, crossBetween: "midCat" })
  );
}

const AXIS_IDS = `<c:axId val="${CAT_AX}"/><c:axId val="${VAL_AX}"/>`;

type SeriesWriter = (sc: SeriesContext, series: Series, index: number) => string;
type PlotParts = { series: string; labels: string; chart: SheetChart };

function barPlot({ series, labels, chart }: PlotParts): string {
  const direction = chart.type === "bar" ? "bar" : "col";
  const grouping = chart.stacked ? "stacked" : "clustered";
  const overlap = chart.stacked ? `<c:overlap val="100"/>` : "";
  return `<c:barChart><c:barDir val="${direction}"/><c:grouping val="${grouping}"/><c:varyColors val="0"/>${series}${labels}<c:gapWidth val="150"/>${overlap}${AXIS_IDS}</c:barChart>${categoryAxes(chart)}`;
}

const grouping = (chart: SheetChart) => `<c:grouping val="${chart.stacked ? "stacked" : "standard"}"/>`;

const PLOTS: Record<SheetChart["type"], { series: SeriesWriter; plot: (parts: PlotParts) => string }> = {
  column: { series: barSeries, plot: barPlot },
  bar: { series: barSeries, plot: barPlot },
  line: {
    series: lineSeries,
    plot: ({ series, labels, chart }) => `<c:lineChart>${grouping(chart)}<c:varyColors val="0"/>${series}${labels}<c:marker val="1"/>${AXIS_IDS}</c:lineChart>${categoryAxes(chart)}`,
  },
  area: {
    series: areaSeries,
    plot: ({ series, labels, chart }) => `<c:areaChart>${grouping(chart)}<c:varyColors val="0"/>${series}${labels}${AXIS_IDS}</c:areaChart>${categoryAxes(chart)}`,
  },
  pie: {
    series: pieSeries,
    plot: ({ series, labels }) => `<c:pieChart><c:varyColors val="1"/>${series}${labels}<c:firstSliceAng val="0"/></c:pieChart>`,
  },
  doughnut: {
    series: pieSeries,
    plot: ({ series, labels }) => `<c:doughnutChart><c:varyColors val="1"/>${series}${labels}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`,
  },
  scatter: {
    series: scatterSeries,
    plot: ({ series, labels, chart }) => `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${series}${labels}${AXIS_IDS}</c:scatterChart>${scatterAxes(chart)}`,
  },
};

function plotXml(sc: SeriesContext, series: Series[]): string {
  const kind = PLOTS[sc.chart.type];
  const written = series.map((item, index) => kind.series(sc, item, index)).join("");
  return kind.plot({ series: written, labels: sc.chart.showValues ? DATA_LABELS : "", chart: sc.chart });
}

const LEGEND_POSITIONS = { right: "r", bottom: "b", top: "t" } as const;

function legendXml(chart: SheetChart): string {
  if (chart.legend === "none") return "";
  return `<c:legend><c:legendPos val="${LEGEND_POSITIONS[chart.legend]}"/><c:overlay val="0"/></c:legend>`;
}

/** The chart part and its anchor cell, or null (with a warning) when its
 * source range or anchor cannot be found. */
export function chartXml(ctx: ExportContext, sheet: Sheet, chart: SheetChart): { xml: string; at: CellPoint } | null {
  const source = chartSource(ctx, sheet, chart);
  const at = parseCellKey(chart.at);
  if (!source || !at) {
    ctx.log.add(`A chart on ${sheet.name} points at a missing range (${chart.source}) and was left out.`);
    return null;
  }
  const all = chartSeries(source, chart);
  const series = chart.type === "pie" ? all.slice(0, 1) : all;
  const sc: SeriesContext = { ctx, sheet: source.sheet, chart };
  const title = chart.title ? titleXml(chart.title, { size: 1400 }) : `<c:autoTitleDeleted val="1"/>`;
  const xml =
    XML_HEADER +
    `<c:chartSpace xmlns:c="${NS.chart}" xmlns:a="${NS.drawingMain}" xmlns:r="${NS.rel}">` +
    `<c:date1904 val="0"/><c:lang val="en-US"/><c:roundedCorners val="0"/>` +
    `<c:chart>${title}<c:plotArea><c:layout/>${plotXml(sc, series)}</c:plotArea>${legendXml(chart)}` +
    `<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart>` +
    `<c:spPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:ln><a:noFill/></a:ln></c:spPr>` +
    `</c:chartSpace>`;
  return { xml, at };
}

export type PlacedChart = { chart: SheetChart; at: CellPoint; relId: string; frameId: number };

function anchorXml({ chart, at, relId, frameId }: PlacedChart): string {
  return (
    `<xdr:oneCellAnchor>` +
    `<xdr:from><xdr:col>${at.col}</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${at.row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>` +
    `<xdr:ext cx="${chart.w * EMU_PER_PX}" cy="${chart.h * EMU_PER_PX}"/>` +
    `<xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr${attrs({ id: frameId + 1, name: `Chart ${frameId}` })}/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr>` +
    `<xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm>` +
    `<a:graphic><a:graphicData uri="${NS.chart}"><c:chart xmlns:c="${NS.chart}" r:id="${relId}"/></a:graphicData></a:graphic>` +
    `</xdr:graphicFrame><xdr:clientData/></xdr:oneCellAnchor>`
  );
}

export function drawingXml(charts: PlacedChart[]): string {
  return (
    XML_HEADER +
    `<xdr:wsDr xmlns:xdr="${NS.sheetDrawing}" xmlns:a="${NS.drawingMain}" xmlns:r="${NS.rel}">` +
    charts.map(anchorXml).join("") +
    `</xdr:wsDr>`
  );
}
