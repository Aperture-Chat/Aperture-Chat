import { describe, expect, it } from "vitest";
import { formatCellValue } from "../../numberFormat";
import { calc, recalculate } from "./testWorkbook";

const results = (formulas: string[], cells: Record<string, string | number | boolean> = {}) => formulas.map((formula) => calc(formula, cells));

describe("joining text", () => {
  const cells = { A1: "a", A2: "b", A4: "d" };

  it("CONCAT flattens ranges; CONCATENATE joins its arguments", () => {
    expect(results(['=CONCAT(A1:A4,"x")', "=CONCAT(1,TRUE)", '=CONCATENATE("a",1.5)', "=CONCAT(A1,1/0)"], cells)).toEqual(["abdx", "1TRUE", "a1.5", "#DIV/0!"]);
  });

  it("CONCATENATE lifts over a range", () => {
    expect(recalculate({ Sheet1: { ...cells, C1: '=CONCATENATE(A1:A2,"!")' } })("C1")).toEqual([["a!"], ["b!"]]);
  });

  it("TEXTJOIN can skip empties and cycle through delimiters", () => {
    expect(results(['=TEXTJOIN(", ",TRUE,A1:A4)', '=TEXTJOIN("-",FALSE,A1:A4)', '=TEXTJOIN({"-","+"},TRUE,"a","b","c")', '=TEXTJOIN("-",TRUE,1/0)'], cells))
      .toEqual(["a, b, d", "a-b--d", "a-b+c", "#DIV/0!"]);
  });
});

describe("slicing and case", () => {
  it("LEFT, RIGHT, MID, and LEN", () => {
    expect(results(['=LEFT("Excel",2)', '=LEFT("Excel")', '=RIGHT("Excel",3)', '=RIGHT("Excel")', '=MID("Excel",2,3)', '=MID("Excel",9,3)', '=LEN("héllo")', "=LEN(123.5)"]))
      .toEqual(["Ex", "E", "cel", "l", "xce", "", 5, 5]);
    expect(results(['=MID("abc",0,1)', '=LEFT("a",-1)', '=MID("abc",1,-1)', "=LEN(1/0)"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#DIV/0!"]);
  });

  it("zero and FALSE become their text, not empty text", () => {
    expect(results(["=LEN(0)", "=LEN(FALSE)", '=NOT("")'])).toEqual([1, 5, "#VALUE!"]);
  });

  it("lifting broadcasts a row against a column and pads mismatched arrays with #N/A", () => {
    const read = recalculate({ Sheet1: { A1: '=LEFT({"ab","cd"},{1;2})', A3: '=LEFT({"ab","cd","ef"},{1,2})', A4: '=LEFT({"a";"b";"c"},{1;2})' } });
    expect(["A1", "A3", "A4"].map(read)).toEqual([[["a", "c"], ["ab", "cd"]], [["a", "cd", "#N/A"]], [["a"], ["b"], ["#N/A"]]]);
  });

  it("LEFT lifts over a range so the result spills", () => {
    const read = recalculate({ Sheet1: { A1: "Alpha", A2: "Beta", A3: "Gamma", B1: "=LEFT(A1:A3,3)" } });
    expect(read("B1")).toEqual([["Alp"], ["Bet"], ["Gam"]]);
  });

  it("UPPER, LOWER, PROPER, TRIM, and CLEAN", () => {
    expect(results(['=UPPER("abc")', '=LOWER("ABC")', '=PROPER("this is a TITLE")', '=PROPER("2-way street")', '=TRIM("  a   b  ")', '=CLEAN(CHAR(7)&"a"&CHAR(10))']))
      .toEqual(["ABC", "abc", "This Is A Title", "2-Way Street", "a b", "a"]);
  });
});

describe("finding and replacing", () => {
  it("SUBSTITUTE replaces every match or one instance", () => {
    expect(results(['=SUBSTITUTE("a-b-c","-","+")', '=SUBSTITUTE("a-b-c","-","+",2)', '=SUBSTITUTE("abc","","x")', '=SUBSTITUTE("aaa","aa","b")', '=SUBSTITUTE("a-b","-","+",0)']))
      .toEqual(["a+b+c", "a-b+c", "abc", "ba", "#VALUE!"]);
  });

  it("REPLACE swaps characters by position", () => {
    expect(results(['=REPLACE("abcdef",2,3,"XY")', '=REPLACE("abc",0,1,"x")', '=REPLACE("abc",1,0,"x")', '=REPLACE("abc",2,0,"x")', '=REPLACE("abc",1,-1,"x")'])).toEqual(["aXYef", "#VALUE!", "xabc", "axbc", "#VALUE!"]);
  });

  it("FIND is case-sensitive; SEARCH is not and understands wildcards", () => {
    expect(results(['=FIND("c","abcabc")', '=FIND("C","abc")', '=FIND("c","abcabc",4)', '=FIND("","abc")', '=FIND("a","abc",9)'])).toEqual([3, "#VALUE!", 6, 1, "#VALUE!"]);
    expect(results(['=SEARCH("C","abc")', '=SEARCH("b?d","abcd")', '=SEARCH("x","abc")', '=SEARCH("~*","a*b")', '=SEARCH("b*","abcb",3)'])).toEqual([3, 2, "#VALUE!", 2, 4]);
  });
});

describe("numbers as text", () => {
  it("TEXT hands the format code to the cell formatter", () => {
    expect(calc('=TEXT(1234.567,"0.00")')).toBe(formatCellValue(1234.567, "0.00").text);
    expect(calc('=TEXT("12.5","0.00")')).toBe(formatCellValue(12.5, "0.00").text);
    expect(calc('=TEXT(1/0,"0")')).toBe("#DIV/0!");
  });

  it("VALUE and NUMBERVALUE read numbers, percents, and times", () => {
    expect(results(['=VALUE("1,234.5")', '=VALUE("12%")', '=VALUE("abc")', "=VALUE(TRUE)", "=VALUE(5)"])).toEqual([1234.5, 0.12, "#VALUE!", "#VALUE!", 5]);
    expect(calc('=VALUE("14:30")') as number).toBeCloseTo(14.5 / 24, 12);
    expect(results(['=NUMBERVALUE("1.234,5",",",".")', '=NUMBERVALUE("50%")', '=NUMBERVALUE(" 1 000 ")', '=NUMBERVALUE("1,5",",",",")', '=NUMBERVALUE("")'])).toEqual([1234.5, 0.5, 1000, "#VALUE!", 0]);
  });

  it("FIXED and DOLLAR round and add separators", () => {
    expect(results(["=FIXED(1234.567)", "=FIXED(1234.567,1,TRUE)", "=FIXED(-1234.567,-2)", "=FIXED(0.5,0)"])).toEqual(["1,234.57", "1234.6", "-1,200", "1"]);
    expect(results(["=DOLLAR(1234.567)", "=DOLLAR(-1234.567,1)", "=DOLLAR(5,0)"])).toEqual(["$1,234.57", "($1,234.6)", "$5"]);
  });
});

describe("characters", () => {
  it("REPT, EXACT, CHAR, CODE, UNICHAR, and UNICODE", () => {
    expect(results(['=REPT("ab",3)', '=REPT("a",-1)', '=EXACT("a","A")', '=EXACT("a","a")'])).toEqual(["ababab", "#VALUE!", false, true]);
    expect(results(["=CHAR(65)", "=CHAR(128)", "=CHAR(0)", '=CODE("A")', '=CODE("€")', '=CODE("")'])).toEqual(["A", "€", "#VALUE!", 65, 128, "#VALUE!"]);
    expect(results(["=UNICHAR(9731)", '=UNICODE("☃")', "=UNICHAR(0)", '=UNICODE("😀")'])).toEqual(["☃", 9731, "#VALUE!", 128512]);
  });
});

describe("TEXTBEFORE, TEXTAFTER, and TEXTSPLIT", () => {
  it("TEXTBEFORE and TEXTAFTER pick a delimiter instance from either end", () => {
    expect(results(['=TEXTBEFORE("a-b-c","-")', '=TEXTBEFORE("a-b-c","-",2)', '=TEXTBEFORE("a-b-c","-",-1)', '=TEXTBEFORE("abc","x")', '=TEXTBEFORE("abc","x",,,,"none")', '=TEXTBEFORE("aXb","x",1,1)']))
      .toEqual(["a", "a-b", "a-b", "#N/A", "none", "a"]);
    expect(results(['=TEXTAFTER("a-b-c","-")', '=TEXTAFTER("a-b-c","-",-1)', '=TEXTAFTER("abc","x",1,0,1)', '=TEXTBEFORE("abc","x",1,0,1)', '=TEXTAFTER("a-b","-",0)', '=TEXTAFTER("a-b+c",{"+","-"})']))
      .toEqual(["b-c", "c", "", "abc", "#VALUE!", "b+c"]);
  });

  it("TEXTSPLIT spills rows and columns and pads short rows", () => {
    const read = recalculate({ Sheet1: {
      A1: '=TEXTSPLIT("a,b;c,d",",",";")',
      A4: '=TEXTSPLIT("a,b,,c",",",,TRUE)',
      A6: '=TEXTSPLIT("a,b;c",",",";")',
      A9: '=TEXTSPLIT("a-b+c",{"-","+"})',
      A11: '=TEXTSPLIT("1;2",,";")',
    } });
    expect(read("A1")).toEqual([["a", "b"], ["c", "d"]]);
    expect(read("A4")).toEqual([["a", "b", "c"]]);
    expect(read("A6")).toEqual([["a", "b"], ["c", "#N/A"]]);
    expect(read("A9")).toEqual([["a", "b", "c"]]);
    expect(read("A11")).toEqual([["1"], ["2"]]);
  });
});

describe("edges", () => {
  it("zero-length slices and the first position", () => {
    expect(results(['=RIGHT("abc",0)', '=MID("abc",1,1)', '=MID("abc",1,0)', '=LEFT("abc",0)'])).toEqual(["", "a", "", ""]);
  });

  it("SUBSTITUTE instances at the start of the text", () => {
    expect(results(['=SUBSTITUTE("a-b","-","+",1)', '=SUBSTITUTE("-a-","-","+",1)', '=SUBSTITUTE("--","-","+",2)', '=SUBSTITUTE("-a","-","+",1)', '=SUBSTITUTE("a-b","-","+",3)']))
      .toEqual(["a+b", "+a-", "-+", "+a", "a-b"]);
  });

  it("FIND and SEARCH start positions run from 1 to the length of the text", () => {
    expect(results(['=FIND("c","abc",3)', '=FIND("c","abc",0)', '=FIND("","abc",3)', '=FIND("","abc",4)', '=SEARCH("C","abc",3)', '=SEARCH("c","abc",4)', '=SEARCH("","abc",2)']))
      .toEqual([3, "#VALUE!", 3, "#VALUE!", 3, "#VALUE!", 2]);
    expect(results(['=SEARCH("c","abc",0)', '=SEARCH("","abc",4)'])).toEqual(["#VALUE!", "#VALUE!"]);
  });

  it("FIXED and DOLLAR around zero and at the decimal limit", () => {
    expect(results(["=FIXED(0)", "=FIXED(0.25,1)", "=DOLLAR(0)", "=DOLLAR(0.25,1)", "=FIXED(1,128)", "=LEN(FIXED(1,127))"])).toEqual(["0.00", "0.3", "$0.00", "$0.3", "#VALUE!", 129]);
  });

  it("CHAR and CODE at the edges of Windows-1252", () => {
    expect(results(["=CODE(CHAR(1))", "=CODE(CHAR(127))", "=CHAR(159)", "=CODE(CHAR(160))", "=CODE(CHAR(255))", "=CHAR(256)", '=CODE("Ÿ")', '=CODE("Ā")'])).toEqual([1, 127, "Ÿ", 160, 255, "#VALUE!", 159, 63]);
  });

  it("delimiters: the longest wins, one at the very start counts, and an empty one marks an end", () => {
    const read = recalculate({ Sheet1: { A1: '=TEXTSPLIT("a--b",{"-","--"})', A2: '=TEXTSPLIT("-a","-")' } });
    expect(["A1", "A2"].map(read)).toEqual([[["a", "b"]], [["", "a"]]]);
    expect(results(['=TEXTBEFORE("abc","")', '=TEXTAFTER("abc","")', '=TEXTBEFORE("abc","",-1)', '=TEXTAFTER("abc","",-1)', '=TEXTBEFORE("abc","x",-1,0,1)', '=TEXTAFTER("abc","x",-1,0,1)']))
      .toEqual(["", "abc", "abc", "", "", "abc"]);
  });
});

describe("argument counts", () => {
  it("rejects too few or too many arguments", () => {
    expect(results(["=LEFT()", '=MID("a",1)', '=UPPER("a","b")', "=TEXTSPLIT()"])).toEqual(["#VALUE!", "#VALUE!", "#VALUE!", "#VALUE!"]);
  });
});
