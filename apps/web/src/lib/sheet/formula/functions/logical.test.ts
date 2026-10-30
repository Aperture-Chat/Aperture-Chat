import { describe, expect, it } from "vitest";
import { calc, recalculate } from "./testWorkbook";

const results = (formulas: string[], cells: Record<string, string | number | boolean> = {}) => formulas.map((formula) => calc(formula, cells));

describe("IF, IFERROR, IFNA, and IFS", () => {
  it("picks branches and only evaluates the branch it needs", () => {
    expect(results(['=IF(A1>1,"big","small")', "=IF(FALSE,1/0,2)", "=IFERROR(1/0,\"none\")", '=IFNA(NA(),"missing")', '=IFNA(1/0,"missing")'], { A1: 5 }))
      .toEqual(["big", 2, "none", "missing", "#DIV/0!"]);
  });

  it("IF broadcasts array branches like Excel: single rows and columns repeat, missing items are #N/A", () => {
    const read = recalculate({ Sheet1: { A1: "=IF({TRUE,FALSE,TRUE},{1,2},0)", A2: "=IF({TRUE;TRUE},{7})", A4: "=IF({TRUE,TRUE},{5,0})", A5: '=CHOOSE({1,2,1},{"a","b","c"},"z")' } });
    expect(["A1", "A2", "A4", "A5"].map(read)).toEqual([[[1, 0, "#N/A"]], [[7], [7]], [[5, 0]], [["a", "z", "c"]]]);
    const fallbacks = recalculate({ Sheet1: { A1: "=IFERROR({1,#N/A,#DIV/0!},{7,8,9})", A2: '=IFNA({1,#N/A,#DIV/0!},"none")' } });
    expect(["A1", "A2"].map(fallbacks)).toEqual([[[1, 8, 9]], [[1, "none", "#DIV/0!"]]]);
  });

  it("IFS returns the value for the first true test, or #N/A", () => {
    const grade = (score: number) => calc('=IFS(A1>=90,"A",A1>=80,"B",TRUE,"C")', { A1: score });
    expect([grade(95), grade(85), grade(10)]).toEqual(["A", "B", "C"]);
    expect(results(["=IFS(FALSE,1)", "=IFS(1/0,1)", "=IFS(TRUE,1,FALSE)"])).toEqual(["#N/A", "#DIV/0!", "#VALUE!"]);
  });

  it("IFS and IFNA work element by element on arrays", () => {
    const read = recalculate({ Sheet1: { A1: 1, A2: 5, A3: 9, B1: '=IFS(A1:A3>4,"big",TRUE,"small")', C1: '=IFNA(MATCH(A1:A3,{5,9},0),0)' } });
    expect(read("B1")).toEqual([["small"], ["big"], ["big"]]);
    expect(read("C1")).toEqual([[0], [1], [2]]);
  });
});

describe("AND, OR, XOR, and NOT", () => {
  it("skip text and blanks in references but reject typed text", () => {
    const cells = { A1: true, A2: "x", A4: 1 };
    expect(results(["=AND(TRUE,1)", "=AND(A1:A4)", "=OR(FALSE,0)", "=OR(A2:A3)", '=AND("x")', '=AND("true",1)'], cells)).toEqual([true, true, false, "#VALUE!", "#VALUE!", true]);
    expect(results(["=XOR(TRUE,TRUE,TRUE)", "=XOR(TRUE,TRUE)", "=NOT(0)", "=NOT(A2)", "=AND(TRUE,1/0)"], cells)).toEqual([true, false, true, "#VALUE!", "#DIV/0!"]);
  });

  it("NOT lifts over arrays", () => {
    expect(recalculate({ Sheet1: { A1: "=NOT({TRUE,FALSE})" } })("A1")).toEqual([[false, true]]);
  });

  it("TRUE() and FALSE() are functions too", () => {
    expect(results(["=TRUE()", "=FALSE()", "=TRUE(1)"])).toEqual([true, false, "#VALUE!"]);
  });
});

describe("SWITCH", () => {
  it("matches the first equal value, case-insensitively, with an optional default", () => {
    expect(results(['=SWITCH(2,1,"one",2,"two","other")', '=SWITCH(5,1,"one","other")', '=SWITCH(5,1,"one")', '=SWITCH("b","A",1,"B",2)', "=SWITCH(1/0,1,2)"]))
      .toEqual(["two", "other", "#N/A", 2, "#DIV/0!"]);
  });
});

describe("element-wise IFS and SWITCH", () => {
  it("give #N/A where nothing matches and use the default where there is one", () => {
    const read = recalculate({ Sheet1: { A1: 1, A2: 2, B1: '=IFS(A1:A2>5,"x")', C1: '=SWITCH({1,2,3},1,"a",2,"b")', C2: '=SWITCH({1,2,3},1,"a",2,"b","z")' } });
    expect(["B1", "C1", "C2"].map(read)).toEqual([[["#N/A"], ["#N/A"]], [["a", "b", "#N/A"]], [["a", "b", "z"]]]);
    expect(calc('=SWITCH(5,1,"one",5)')).toBe(5);
    expect(recalculate({ Sheet1: { A1: '=SWITCH({1,2,3},1,"a",2,"b",3)' } })("A1")).toEqual([["a", "b", 3]]);
  });
});

describe("LET", () => {
  it("binds names in order so later values see earlier names", () => {
    expect(results(["=LET(x,2,y,x*3,x+y)", "=LET(a,A1:A3,SUM(a)*2)", "=LET(x,1,LET(x,x+1,x*10))"], { A1: 1, A2: 2, A3: 3 })).toEqual([8, 12, 20]);
  });

  it("rejects missing calculations and non-name bindings", () => {
    expect(results(["=LET(x,1)", "=LET(1,2,3)", "=LET(x,1,y,2)"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!"]);
  });

  it("spills an array result", () => {
    expect(recalculate({ Sheet1: { A1: "=LET(v,{1;2;3},v*2)" } })("A1")).toEqual([[2], [4], [6]]);
  });
});
