import { expect, test } from "vitest";
import {
  LETTER_PAGE_SETUP,
  cssFontFamilyStack,
  documentSheetGeometry,
  headerFooterHtmlForPage,
  leadingPageSetupMarker,
  pageChromeHtml,
  pageSetupMarkerHtml,
  sourceLayoutCssVariables,
  splitPageSetup,
} from "./documentPageSetup";

const SETUP = {
  ...LETTER_PAGE_SETUP,
  widthPt: 595.3,
  heightPt: 841.9,
  marginLeftPt: 90,
  headerHtml: '<p>Agreement<span class="document-tab document-tab-right document-tab-at-9000">\t</span>CONFIDENTIAL</p>',
  footerHtml: '<p>Page <span class="document-field-page">2</span> of <span class="document-field-pages">9</span></p>',
  firstHeaderHtml: "<p>LETTERHEAD</p>",
  firstFooterHtml: "",
};

test("the page-setup marker round-trips through HTML", () => {
  const marker = pageSetupMarkerHtml(SETUP);
  const { setup, markerHtml, bodyHtml } = splitPageSetup(`${marker}<p>Body</p>`);

  expect(markerHtml).toBe(marker);
  expect(bodyHtml).toBe("<p>Body</p>");
  expect(setup).toMatchObject({
    widthPt: 595.3,
    heightPt: 841.9,
    marginLeftPt: 90,
    marginRightPt: 72,
    paragraphAfterPx: LETTER_PAGE_SETUP.paragraphAfterPx,
    headerHtml: SETUP.headerHtml,
    footerHtml: SETUP.footerHtml,
    firstHeaderHtml: "<p>LETTERHEAD</p>",
    firstFooterHtml: "",
  });
  expect(leadingPageSetupMarker(`${marker}<section class="document-page"><p>x</p></section>`)).toBe(marker);
});

test("only the first marker counts and stray copies are dropped", () => {
  const marker = pageSetupMarkerHtml(SETUP);
  const second = pageSetupMarkerHtml({ ...SETUP, widthPt: 300 });
  const { setup, bodyHtml } = splitPageSetup(`${marker}<p>One</p>${second}<p>Two</p>`);

  expect(setup?.widthPt).toBe(595.3);
  expect(bodyHtml).toBe("<p>One</p><p>Two</p>");
  expect(splitPageSetup("<p>No setup</p>")).toEqual({ setup: null, markerHtml: "", bodyHtml: "<p>No setup</p>" });
});

test("damaged geometry falls back to usable Letter values", () => {
  const damaged = '<div class="document-page-setup" style="width: 5pt; height: abc; padding-left: 900pt"></div>';
  const { setup } = splitPageSetup(`${damaged}<p>x</p>`);

  expect(setup?.widthPt).toBe(144);
  expect(setup?.heightPt).toBe(792);
  expect(setup?.marginLeftPt).toBeLessThan(144 / 2);
});

test("headers and footers fill page fields and honor a distinct first page", () => {
  expect(headerFooterHtmlForPage(SETUP.footerHtml, 3, 12)).toBe(
    '<p>Page <span class="document-field-page">3</span> of <span class="document-field-pages">12</span></p>',
  );
  expect(pageChromeHtml(SETUP, 0)).toEqual({ header: "<p>LETTERHEAD</p>", footer: "" });
  expect(pageChromeHtml(SETUP, 1)).toEqual({ header: SETUP.headerHtml, footer: SETUP.footerHtml });
});

test("geometry and canvas variables use the shared preview scale", () => {
  const geometry = documentSheetGeometry(LETTER_PAGE_SETUP);
  expect(geometry.sheetWidthPx).toBeCloseTo(902.04, 1);
  expect(geometry.contentWidthPx).toBeCloseTo(689.8, 1);
  const variables = sourceLayoutCssVariables(LETTER_PAGE_SETUP);
  expect(variables["--source-pad-left"]).toBe("106.13px");
  expect(variables["--source-block-after"]).toBe("11.79px");
});

test("font stacks keep the source name first and stay within the sanitizer limit", () => {
  expect(cssFontFamilyStack("Calibri")).toBe("Calibri, Carlito, Arial, sans-serif");
  expect(cssFontFamilyStack("Univers 55 Roman")).toBe("'Univers 55 Roman', sans-serif");
  // Markup characters never reach CSS; names that cannot be expressed fall back.
  expect(cssFontFamilyStack("Font<script>")).toBe("Fontscript, sans-serif");
  expect(cssFontFamilyStack("Fünf Pro")).toBe("sans-serif");
  expect(cssFontFamilyStack("A Very Long Corporate Typeface Name That Keeps Going On").length).toBeLessThanOrEqual(120);
});
