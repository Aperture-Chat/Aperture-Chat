/** Package-level parts: [Content_Types].xml, relationships, document
 * properties, workbook.xml, and the dynamic-array metadata Excel 365 writes. */

import { splitSheetQualifiedRef } from "../address";
import { sheetByName, type Workbook } from "../sheetModel";
import type { ExportContext } from "./context";
import { absoluteRef } from "./formulaText";
import { attrs, escapeXml, NS, plainText, XML_HEADER } from "./xml";

const RT = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CT = "application/vnd.openxmlformats-officedocument";

export const CONTENT_TYPES = {
  workbook: `${CT}.spreadsheetml.sheet.main+xml`,
  worksheet: `${CT}.spreadsheetml.worksheet+xml`,
  theme: `${CT}.theme+xml`,
  styles: `${CT}.spreadsheetml.styles+xml`,
  sharedStrings: `${CT}.spreadsheetml.sharedStrings+xml`,
  metadata: `${CT}.spreadsheetml.sheetMetadata+xml`,
  table: `${CT}.spreadsheetml.table+xml`,
  drawing: `${CT}.drawing+xml`,
  chart: `${CT}.drawingml.chart+xml`,
  comments: `${CT}.spreadsheetml.comments+xml`,
  core: "application/vnd.openxmlformats-package.core-properties+xml",
  app: `${CT}.extended-properties+xml`,
} as const;

export type Part = { name: string; xml: string; contentType?: string };

/** One .rels part; ids are assigned in the order targets are added. */
export class Relationships {
  private readonly items: string[] = [];

  add(type: string, target: string): string {
    const id = `rId${this.items.length + 1}`;
    this.items.push(`<Relationship Id="${id}" Type="${RT}/${type}" Target="${escapeXml(target)}"/>`);
    return id;
  }

  get size(): number {
    return this.items.length;
  }

  xml(): string {
    return `${XML_HEADER}<Relationships xmlns="${NS.pkgRel}">${this.items.join("")}</Relationships>`;
  }
}

export function contentTypesXml(parts: Part[]): string {
  const overrides = parts
    .filter((part) => part.contentType)
    .map((part) => `<Override PartName="/${part.name}" ContentType="${part.contentType}"/>`)
    .join("");
  return (
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Default Extension="vml" ContentType="${CT}.vmlDrawing"/>` +
    `${overrides}</Types>`
  );
}

export const ROOT_RELS =
  `${XML_HEADER}<Relationships xmlns="${NS.pkgRel}">` +
  `<Relationship Id="rId1" Type="${RT}/officeDocument" Target="xl/workbook.xml"/>` +
  `<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>` +
  `<Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/>` +
  `</Relationships>`;

function w3cDate(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function corePropsXml(title: string, now: Date): string {
  const stamp = w3cDate(now);
  return (
    `${XML_HEADER}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" ` +
    `xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" ` +
    `xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">` +
    `<dc:title>${escapeXml(plainText(title))}</dc:title><dc:creator>Aperture Chat</dc:creator>` +
    `<dcterms:created xsi:type="dcterms:W3CDTF">${stamp}</dcterms:created>` +
    `<dcterms:modified xsi:type="dcterms:W3CDTF">${stamp}</dcterms:modified>` +
    `</cp:coreProperties>`
  );
}

export const APP_PROPS =
  `${XML_HEADER}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" ` +
  `xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">` +
  `<Application>Aperture Chat</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop>` +
  `<LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged>` +
  `</Properties>`;

/** The XLDAPR metadata type that marks cm="1" cells as dynamic arrays. */
export const DYNAMIC_ARRAY_METADATA =
  `${XML_HEADER}<metadata xmlns="${NS.main}" xmlns:xda="http://schemas.microsoft.com/office/spreadsheetml/2017/dynamicarray">` +
  `<metadataTypes count="1"><metadataType name="XLDAPR" minSupportedVersion="120000" copy="1" pasteAll="1" pasteValues="1" ` +
  `merge="1" splitFirst="1" rowColShift="1" clearFormats="1" clearComments="1" assign="1" coerce="1" cellMeta="1"/></metadataTypes>` +
  `<futureMetadata name="XLDAPR" count="1"><bk><extLst><ext uri="{bdbb8cdc-fa1e-496e-a857-3c3f30c029c3}">` +
  `<xda:dynamicArrayProperties fDynamic="1" fCollapsed="0"/></ext></extLst></bk></futureMetadata>` +
  `<cellMetadata count="1"><bk><rc t="1" v="0"/></bk></cellMetadata>` +
  `</metadata>`;

export type WorkbookSheetEntry = { name: string; relId: string; hidden: boolean };
export type FilterDatabase = { sheetIndex: number; ref: string };

function userNamesXml(ctx: ExportContext): string[] {
  const workbook: Workbook = ctx.workbook;
  const { names = [] } = workbook;
  return names.flatMap((name) => {
    if (/^_xlnm\./i.test(name.name)) {
      ctx.log.add(`The name "${name.name}" is reserved by Excel and was left out.`);
      return [];
    }
    const { sheet, ref } = splitSheetQualifiedRef(name.ref);
    const target = sheet === null ? workbook.sheets[0] : sheetByName(workbook, sheet);
    if (!target) ctx.log.add(`The name "${name.name}" points at a missing sheet and exports as #REF!.`);
    const formula = target ? absoluteRef(target.name, ref) : "#REF!";
    return [`<definedName name="${escapeXml(name.name)}">${escapeXml(formula)}</definedName>`];
  });
}

export function workbookXml(ctx: ExportContext, sheets: WorkbookSheetEntry[], activeTab: number, filters: FilterDatabase[]): string {
  const sheetList = sheets
    .map((sheet, index) => `<sheet${attrs({ name: plainText(sheet.name), sheetId: index + 1, state: sheet.hidden ? "hidden" : undefined })} r:id="${sheet.relId}"/>`)
    .join("");
  const filterNames = filters.map(
    (filter) => `<definedName name="_xlnm._FilterDatabase" localSheetId="${filter.sheetIndex}" hidden="1">${escapeXml(filter.ref)}</definedName>`,
  );
  const names = [...userNamesXml(ctx), ...filterNames];
  return (
    `${XML_HEADER}<workbook xmlns="${NS.main}" xmlns:r="${NS.rel}">` +
    `<workbookPr/>` +
    `<bookViews><workbookView xWindow="0" yWindow="0" windowWidth="28800" windowHeight="15000" activeTab="${activeTab}"/></bookViews>` +
    `<sheets>${sheetList}</sheets>` +
    (names.length ? `<definedNames>${names.join("")}</definedNames>` : "") +
    `<calcPr calcId="191029" fullCalcOnLoad="1"/>` +
    `</workbook>`
  );
}
