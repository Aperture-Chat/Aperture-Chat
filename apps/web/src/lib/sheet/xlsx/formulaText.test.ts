import { describe, expect, it } from "vitest";
import { absoluteRef, prepareFormula } from "./formulaText";

const fileFormula = (formula: string) => prepareFormula(formula)?.text ?? null;

describe("formulas as Excel stores them", () => {
  it("prefixes newer functions so Excel does not show #NAME?", () => {
    expect(fileFormula("XLOOKUP(A2,Data!A:A,Data!B:B)")).toBe("_xlfn.XLOOKUP(A2,Data!A:A,Data!B:B)");
    expect(fileFormula("FILTER(A2:C9,B2:B9=\"East\")")).toBe("_xlfn._xlws.FILTER(A2:C9,B2:B9=\"East\")");
    expect(fileFormula("sum(ifs(A1>1,1,TRUE,2), 3)")).toBe("SUM(_xlfn.IFS(A1>1,1,TRUE,2), 3)");
  });

  it("leaves text, references, and already-prefixed names alone", () => {
    expect(fileFormula("\"XLOOKUP(\"&A1")).toBe("\"XLOOKUP(\"&A1");
    expect(fileFormula("_xlfn.XLOOKUP(1,A:A,B:B)")).toBe("_xlfn.XLOOKUP(1,A:A,B:B)");
    expect(fileFormula("'Q1 Data'!B2*Rates")).toBe("'Q1 Data'!B2*Rates");
  });

  it("writes this-row table references in the file's [#This Row] form", () => {
    expect(fileFormula("Sales[@Revenue]*2")).toBe("Sales[[#This Row],[Revenue]]*2");
    expect(fileFormula("Sales[@[Unit Price]]")).toBe("Sales[[#This Row],[Unit Price]]");
    expect(fileFormula("SUM(Sales[Revenue])")).toBe("SUM(Sales[Revenue])");
    expect(fileFormula("Sales[[#This Row],[Revenue]]")).toBe("Sales[[#This Row],[Revenue]]");
    expect(fileFormula("COUNTA(Sales[@])")).toBe("COUNTA(Sales[#This Row])");
  });

  it("names the table for references written without one, as the file requires", () => {
    expect(prepareFormula("[@Qty]*[@[Unit Price]]", "Sales")?.text).toBe("Sales[[#This Row],[Qty]]*Sales[[#This Row],[Unit Price]]");
    expect(prepareFormula("SUBTOTAL(109,[Qty])", "Sales")?.text).toBe("SUBTOTAL(109,Sales[Qty])");
    expect(prepareFormula("Other[@Qty]", "Sales")?.text).toBe("Other[[#This Row],[Qty]]");
    // Outside a table such a reference cannot be written to the file.
    expect(prepareFormula("[@Qty]")).toBeNull();
  });

  it("reports formulas Excel could not read", () => {
    expect(fileFormula("SUM(A1:")).toBeNull();
    expect(fileFormula("1+\"open")).toBeNull();
  });
});

describe("absolute references", () => {
  it("anchors cells, columns, and rows and quotes sheet names", () => {
    expect(absoluteRef("Regional sales", "B2:D9")).toBe("'Regional sales'!$B$2:$D$9");
    expect(absoluteRef("Data", "A:C")).toBe("Data!$A:$C");
    expect(absoluteRef("Data", "C4")).toBe("Data!$C$4");
    expect(absoluteRef(null, "2:4")).toBe("$2:$4");
  });
});

describe("prepared formulas", () => {
  it("knows which formulas can return arrays", () => {
    expect(prepareFormula("A1:A3*2")).toEqual({ text: "A1:A3*2", mayArray: true });
    expect(prepareFormula("SUM(A1:A3)")).toEqual({ text: "SUM(A1:A3)", mayArray: false });
    expect(prepareFormula("SUM(")).toBeNull();
  });

  it("treats a function the engine does not know as possibly array-valued", () => {
    // Excel computes it on open; written plainly it would gain an implicit "@".
    expect(prepareFormula("1+NOTAFUNCTIONYET(A1)")?.mayArray).toBe(true);
    expect(prepareFormula("IF(A1>1,SUM(A1:A3),0)")?.mayArray).toBe(false);
  });
});
