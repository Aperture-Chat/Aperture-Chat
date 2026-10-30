/** Starter workbooks for the Templates drawer. Each is described as the same
 * operations the AI assistant writes, so templates go through the exact
 * validation path AI changes do. All sample data is fictional. */

import { blankWorkbook, type Workbook } from "./sheetModel";
import { applySheetOps, type SheetOp } from "./sheetAi";

export type SheetTemplate = {
  id: string;
  name: string;
  description: string;
  ops: () => SheetOp[];
};

const HEADER = { bold: true, fill: "#087d8b", color: "#ffffff", valign: "middle" };
const TITLE = { bold: true, size: 16, color: "#087d8b" };
const SUBTLE = { italic: true, color: "#5c6b7a" };
const MONEY = "$#,##0.00";
const MONEY0 = "$#,##0";
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function title(sheet: string, text: string, note: string): SheetOp[] {
  return [
    { op: "set", sheet, range: "A1", values: [[text], [note]] },
    { op: "format", sheet, range: "A1", style: TITLE },
    { op: "format", sheet, range: "A2", style: SUBTLE },
    { op: "rowHeight", sheet, rows: "1:1", height: 34 },
  ];
}

const budget: SheetTemplate = {
  id: "budget",
  name: "Monthly budget",
  description: "Planned vs. actual spending by category, with totals, a variance flag, and a chart.",
  ops: () => {
    const categories: [string, number, number][] = [
      ["Housing", 1850, 1850], ["Utilities", 240, 262], ["Groceries", 620, 688], ["Transportation", 310, 274],
      ["Insurance", 280, 280], ["Dining out", 220, 305], ["Health", 150, 96], ["Subscriptions", 65, 72],
      ["Savings", 900, 900], ["Entertainment", 160, 118],
    ];
    const last = 5 + categories.length;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Budget" },
      ...title("Budget", "Monthly budget", "Enter your planned amounts and actual spending; totals and variance update automatically."),
      { op: "set", sheet: "Budget", range: "A4", values: [["Monthly income", 5600]] },
      { op: "format", sheet: "Budget", range: "A4", style: { bold: true } },
      { op: "format", sheet: "Budget", range: "B4", style: { format: MONEY0, bold: true, fill: "#fef3c7" } },
      { op: "set", sheet: "Budget", range: "A5", values: [["Category", "Planned", "Actual", "Difference", "% of plan"]] },
      ...categories.map(([name, plan, actual], index) => ({ op: "set", sheet: "Budget", range: `A${6 + index}`, values: [[name, plan, actual, `=B${6 + index}-C${6 + index}`, `=IFERROR(C${6 + index}/B${6 + index},0)`]] })),
      { op: "set", sheet: "Budget", range: `A${last + 1}`, values: [["Total", `=SUM(B6:B${last})`, `=SUM(C6:C${last})`, `=SUM(D6:D${last})`, `=IFERROR(C${last + 1}/B${last + 1},0)`]] },
      { op: "set", sheet: "Budget", range: `A${last + 3}`, values: [["Left after spending", `=B4-C${last + 1}`]] },
      { op: "table", sheet: "Budget", range: `A5:E${last}`, name: "BudgetLines", accent: 1, tone: "medium" },
      { op: "format", sheet: "Budget", range: `B6:D${last + 1}`, style: { format: MONEY0 } },
      { op: "format", sheet: "Budget", range: `E6:E${last + 1}`, style: { format: "0%" } },
      { op: "format", sheet: "Budget", range: `A${last + 1}:E${last + 1}`, style: { bold: true, border: "top" } },
      { op: "format", sheet: "Budget", range: `A${last + 3}:B${last + 3}`, style: { bold: true } },
      { op: "format", sheet: "Budget", range: `B${last + 3}`, style: { format: MONEY0 } },
      { op: "conditional", sheet: "Budget", range: `D6:D${last}`, rule: { type: "cell", op: "lt", value: "0", style: { fill: "#fde2e1", color: "#9b1c1c", bold: true } } },
      { op: "conditional", sheet: "Budget", range: `E6:E${last}`, rule: { type: "bar", color: "#087d8b" } },
      { op: "colWidth", sheet: "Budget", cols: "A", width: 170 },
      { op: "colWidth", sheet: "Budget", cols: "B:E", width: 110 },
      { op: "chart", sheet: "Budget", type: "bar", source: `A5:C${last}`, title: "Planned vs. actual", at: "G4", width: 480, height: 340, legend: "bottom" },
      { op: "freeze", sheet: "Budget", rows: 5 },
    ];
  },
};

const sales: SheetTemplate = {
  id: "sales",
  name: "Sales tracker",
  description: "Orders with live revenue, a regional summary with SUMIFS, a pivot table, and a chart.",
  ops: () => {
    const regions = ["North", "South", "East", "West"];
    const reps = ["Avery Chen", "Jordan Diaz", "Sam Patel", "Riley Brooks", "Morgan Lee"];
    const products = ["Starter", "Pro", "Enterprise"];
    const prices = { Starter: 49, Pro: 129, Enterprise: 499 } as Record<string, number>;
    const rows: (string | number)[][] = [];
    for (let i = 0; i < 36; i += 1) {
      const product = products[(i * 7) % 3];
      const month = (i % 12) + 1;
      rows.push([`2027-${String(month).padStart(2, "0")}-${String(((i * 5) % 26) + 2).padStart(2, "0")}`, regions[(i * 3) % 4], reps[(i * 2) % 5], product, ((i * 13) % 17) + 3, prices[product]]);
    }
    const last = rows.length + 1;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Orders" },
      { op: "set", sheet: "Orders", range: "A1", values: [["Date", "Region", "Rep", "Product", "Units", "Unit price", "Revenue"], ...rows.map((row, index) => [...row, `=E${index + 2}*F${index + 2}`])] },
      { op: "format", sheet: "Orders", range: `A2:A${last}`, style: { format: "mmm d, yyyy" } },
      { op: "format", sheet: "Orders", range: `F2:G${last}`, style: { format: MONEY0 } },
      { op: "table", sheet: "Orders", range: `A1:G${last}`, name: "Orders", accent: 2, tone: "medium" },
      { op: "colWidth", sheet: "Orders", cols: "A", width: 120 },
      { op: "colWidth", sheet: "Orders", cols: "B:D", width: 120 },
      { op: "colWidth", sheet: "Orders", cols: "E:G", width: 100 },
      { op: "freeze", sheet: "Orders", rows: 1 },
      { op: "addSheet", name: "Summary" },
      ...title("Summary", "Sales summary", "Totals by region from the Orders sheet."),
      { op: "set", sheet: "Summary", range: "A4", values: [["Region", "Revenue", "Orders", "Units", "Share"], ...regions.map((region, index) => [region, `=SUMIFS(Orders!$G$2:$G$${last},Orders!$B$2:$B$${last},A${5 + index})`, `=COUNTIF(Orders!$B$2:$B$${last},A${5 + index})`, `=SUMIFS(Orders!$E$2:$E$${last},Orders!$B$2:$B$${last},A${5 + index})`, `=IFERROR(B${5 + index}/$B$9,0)`]), ["Total", "=SUM(B5:B8)", "=SUM(C5:C8)", "=SUM(D5:D8)", "=SUM(E5:E8)"]] },
      { op: "format", sheet: "Summary", range: "A4:E4", style: HEADER },
      { op: "format", sheet: "Summary", range: "B5:B9", style: { format: MONEY0 } },
      { op: "format", sheet: "Summary", range: "E5:E9", style: { format: "0.0%" } },
      { op: "format", sheet: "Summary", range: "A9:E9", style: { bold: true, border: "top" } },
      { op: "colWidth", sheet: "Summary", cols: "A:E", width: 110 },
      { op: "chart", sheet: "Summary", type: "doughnut", source: "A4:B8", title: "Revenue by region", at: "G3", width: 380, height: 300, legend: "right" },
      { op: "pivot", source: `Orders!A1:G${last}`, sheet: "Pivot", at: "A3", rows: ["Rep"], columns: ["Product"], values: [{ field: "Revenue", agg: "sum" }] },
      { op: "set", sheet: "Pivot", range: "A1", values: [["Revenue by rep and product"]] },
      { op: "format", sheet: "Pivot", range: "A1", style: TITLE },
      { op: "colWidth", sheet: "Pivot", cols: "A:E", width: 120 },
      { op: "activateSheet", sheet: "Summary" },
    ];
  },
};

const projectPlan: SheetTemplate = {
  id: "project",
  name: "Project plan",
  description: "Tasks with owners, dates, a status dropdown, progress bars, and overdue highlighting.",
  ops: () => {
    const tasks: [string, string, string, string, string, number][] = [
      ["Kickoff and goals", "Avery", "2027-03-01", "2027-03-03", "Done", 1],
      ["Requirements", "Jordan", "2027-03-04", "2027-03-14", "Done", 1],
      ["Design review", "Sam", "2027-03-15", "2027-03-22", "In progress", 0.6],
      ["Build phase 1", "Riley", "2027-03-23", "2027-04-16", "In progress", 0.35],
      ["Security review", "Morgan", "2027-04-12", "2027-04-20", "Not started", 0],
      ["User testing", "Jordan", "2027-04-19", "2027-04-30", "Not started", 0],
      ["Launch plan", "Avery", "2027-04-26", "2027-05-05", "Blocked", 0.1],
      ["Launch", "Avery", "2027-05-06", "2027-05-07", "Not started", 0],
    ];
    const last = 4 + tasks.length;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Plan" },
      ...title("Plan", "Project plan", "Status, dates, and progress for each task. Overdue unfinished tasks turn red."),
      { op: "set", sheet: "Plan", range: "A4", values: [["Task", "Owner", "Start", "Due", "Days", "Status", "% complete"], ...tasks.map(([task, owner, start, end, status, pct], index) => [task, owner, start, end, `=D${5 + index}-C${5 + index}+1`, status, pct])] },
      { op: "table", sheet: "Plan", range: `A4:G${last}`, name: "Tasks", accent: 1, tone: "light" },
      { op: "format", sheet: "Plan", range: `C5:D${last}`, style: { format: "mmm d" } },
      { op: "format", sheet: "Plan", range: `G5:G${last}`, style: { format: "0%" } },
      { op: "validation", sheet: "Plan", range: `F5:F${last + 20}`, kind: "list", items: ["Not started", "In progress", "Blocked", "Done"] },
      { op: "conditional", sheet: "Plan", range: `G5:G${last}`, rule: { type: "bar", color: "#3d8b5a" } },
      { op: "conditional", sheet: "Plan", range: `F5:F${last}`, rule: { type: "text", op: "contains", text: "Blocked", style: { fill: "#fde2e1", color: "#9b1c1c", bold: true } } },
      { op: "conditional", sheet: "Plan", range: `F5:F${last}`, rule: { type: "text", op: "contains", text: "Done", style: { fill: "#dcfce7", color: "#166534" } } },
      { op: "conditional", sheet: "Plan", range: `A5:A${last}`, rule: { type: "formula", formula: "=AND($D5<TODAY(),$G5<1)", style: { color: "#b91c1c", bold: true } } },
      { op: "set", sheet: "Plan", range: `A${last + 2}`, values: [["Overall progress", `=AVERAGE(G5:G${last})`], ["Tasks done", `=COUNTIF(F5:F${last},"Done")&" of "&COUNTA(A5:A${last})`]] },
      { op: "format", sheet: "Plan", range: `A${last + 2}:A${last + 3}`, style: { bold: true } },
      { op: "format", sheet: "Plan", range: `B${last + 2}`, style: { format: "0%", bold: true } },
      { op: "colWidth", sheet: "Plan", cols: "A", width: 200 },
      { op: "colWidth", sheet: "Plan", cols: "B:G", width: 104 },
      { op: "freeze", sheet: "Plan", rows: 4, cols: 1 },
    ];
  },
};

const invoice: SheetTemplate = {
  id: "invoice",
  name: "Invoice",
  description: "A clean, printable invoice with line items, tax, and a balance due.",
  ops: () => {
    const items: [string, number, number][] = [
      ["Strategy workshop (half day)", 1, 1800],
      ["Research and interviews", 12, 140],
      ["Design system update", 18, 155],
      ["Project management", 6, 120],
    ];
    const first = 12;
    const last = first + items.length - 1;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Invoice" },
      { op: "gridlines", sheet: "Invoice", show: false },
      { op: "set", sheet: "Invoice", range: "A1", values: [["INVOICE"]] },
      { op: "format", sheet: "Invoice", range: "A1", style: { bold: true, size: 24, color: "#087d8b" } },
      { op: "rowHeight", sheet: "Invoice", rows: "1:1", height: 44 },
      { op: "set", sheet: "Invoice", range: "A3", values: [["Northwind Studio"], ["12 Harbor Way, Suite 4"], ["Portland, OR 97201"]] },
      { op: "format", sheet: "Invoice", range: "A3", style: { bold: true } },
      { op: "set", sheet: "Invoice", range: "D3", values: [["Invoice #", "INV-2027-014"], ["Date", "2027-03-31"], ["Due", "=E4+30"]] },
      { op: "format", sheet: "Invoice", range: "D3:D5", style: { bold: true, align: "right" } },
      { op: "format", sheet: "Invoice", range: "E4:E5", style: { format: "mmm d, yyyy", align: "right" } },
      { op: "format", sheet: "Invoice", range: "E3", style: { align: "right" } },
      { op: "set", sheet: "Invoice", range: "A7", values: [["Bill to"], ["Contoso Outdoor Co."], ["Attn: Accounts Payable"], ["88 Pine Street, Denver, CO 80202"]] },
      { op: "format", sheet: "Invoice", range: "A7", style: { bold: true, color: "#5c6b7a" } },
      { op: "set", sheet: "Invoice", range: `A${first - 1}`, values: [["Description", "", "Qty", "Rate", "Amount"], ...items.map(([name, qty, rate], index) => [name, "", qty, rate, `=C${first + index}*D${first + index}`])] },
      ...items.map((_, index) => ({ op: "merge", sheet: "Invoice", range: `A${first + index}:B${first + index}` })),
      { op: "merge", sheet: "Invoice", range: `A${first - 1}:B${first - 1}` },
      { op: "format", sheet: "Invoice", range: `A${first - 1}:E${first - 1}`, style: HEADER },
      { op: "format", sheet: "Invoice", range: `A${first}:E${last}`, style: { border: "bottom", borderColor: "#d9d9d9" } },
      { op: "format", sheet: "Invoice", range: `D${first}:E${last + 5}`, style: { format: MONEY } },
      { op: "set", sheet: "Invoice", range: `D${last + 2}`, values: [["Subtotal", `=SUM(E${first}:E${last})`], ["Tax rate", 0.07], ["Tax", `=E${last + 2}*E${last + 3}`], ["Balance due", `=E${last + 2}+E${last + 4}`]] },
      { op: "format", sheet: "Invoice", range: `E${last + 3}`, style: { format: "0.0%" } },
      { op: "format", sheet: "Invoice", range: `D${last + 2}:D${last + 5}`, style: { bold: true, align: "right" } },
      { op: "format", sheet: "Invoice", range: `D${last + 5}:E${last + 5}`, style: { bold: true, size: 12, fill: "#d6efef", border: "top" } },
      { op: "set", sheet: "Invoice", range: `A${last + 8}`, values: [["Thank you for your business. Payment is due within 30 days."]] },
      { op: "format", sheet: "Invoice", range: `A${last + 8}`, style: SUBTLE },
      { op: "colWidth", sheet: "Invoice", cols: "A", width: 210 },
      { op: "colWidth", sheet: "Invoice", cols: "B", width: 90 },
      { op: "colWidth", sheet: "Invoice", cols: "C", width: 70 },
      { op: "colWidth", sheet: "Invoice", cols: "D:E", width: 130 },
    ];
  },
};

const expenses: SheetTemplate = {
  id: "expenses",
  name: "Expense report",
  description: "Expenses with a category dropdown, totals by category, and a breakdown chart.",
  ops: () => {
    const categories = ["Travel", "Meals", "Lodging", "Supplies", "Software"];
    const lines: [string, string, string, number][] = [
      ["2027-02-03", "Travel", "Flight to client site", 412.4], ["2027-02-03", "Meals", "Team lunch", 86.25],
      ["2027-02-04", "Lodging", "Hotel, 2 nights", 389], ["2027-02-05", "Travel", "Rideshare", 42.8],
      ["2027-02-09", "Supplies", "Workshop materials", 64.9], ["2027-02-12", "Software", "Survey tool (monthly)", 49],
      ["2027-02-18", "Meals", "Client dinner", 214.6], ["2027-02-22", "Travel", "Train tickets", 96],
    ];
    const last = 4 + lines.length;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Expenses" },
      ...title("Expenses", "Expense report", "Pick a category for each expense; the summary and chart update on their own."),
      { op: "set", sheet: "Expenses", range: "A4", values: [["Date", "Category", "Description", "Amount"], ...lines] },
      { op: "table", sheet: "Expenses", range: `A4:D${last}`, name: "ExpenseLines", accent: 4, tone: "medium" },
      { op: "format", sheet: "Expenses", range: `A5:A${last}`, style: { format: "mmm d, yyyy" } },
      { op: "format", sheet: "Expenses", range: `D5:D${last + 1}`, style: { format: MONEY } },
      { op: "validation", sheet: "Expenses", range: `B5:B${last + 30}`, kind: "list", items: categories },
      { op: "set", sheet: "Expenses", range: `C${last + 1}`, values: [["Total", `=SUM(D5:D${last})`]] },
      { op: "format", sheet: "Expenses", range: `C${last + 1}:D${last + 1}`, style: { bold: true, border: "top" } },
      { op: "set", sheet: "Expenses", range: "F4", values: [["Category", "Total"], ...categories.map((category, index) => [category, `=SUMIF($B$5:$B$${last},F${5 + index},$D$5:$D$${last})`])] },
      { op: "format", sheet: "Expenses", range: "F4:G4", style: HEADER },
      { op: "format", sheet: "Expenses", range: `G5:G${4 + categories.length}`, style: { format: MONEY } },
      { op: "chart", sheet: "Expenses", type: "pie", source: `F4:G${4 + categories.length}`, title: "Spending by category", at: "I4", width: 360, height: 300, legend: "right" },
      { op: "colWidth", sheet: "Expenses", cols: "A:B", width: 112 },
      { op: "colWidth", sheet: "Expenses", cols: "C", width: 200 },
      { op: "colWidth", sheet: "Expenses", cols: "D", width: 100 },
      { op: "colWidth", sheet: "Expenses", cols: "F:G", width: 110 },
      { op: "freeze", sheet: "Expenses", rows: 4 },
    ];
  },
};

const loan: SheetTemplate = {
  id: "loan",
  name: "Loan calculator",
  description: "Payment, total interest, and a month-by-month amortization schedule with a balance chart.",
  ops: () => {
    const months = 60;
    const start = 11;
    const rows = Array.from({ length: months }, (_, i) => {
      const r = start + i;
      const prior = i === 0 ? "$B$4" : `F${r - 1}`;
      return [
        i + 1,
        `=MIN($B$7,${prior}*(1+$B$5/12))`,
        `=${prior}*$B$5/12`,
        `=B${r}-C${r}`,
        i === 0 ? `=D${r}` : `=E${r - 1}+D${r}`,
        `=MAX(0,${prior}-D${r})`,
      ];
    });
    const last = start + months - 1;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Loan" },
      ...title("Loan", "Loan calculator", "Change the amount, rate, or term; the schedule recalculates."),
      { op: "set", sheet: "Loan", range: "A4", values: [["Loan amount", 32000], ["Annual rate", 0.064], ["Term (years)", 5], ["Monthly payment", "=PMT(B5/12,B6*12,-B4)"], ["Total interest", `=SUM(C${start}:C${last})`]] },
      { op: "format", sheet: "Loan", range: "A4:A8", style: { bold: true } },
      { op: "format", sheet: "Loan", range: "B4:B6", style: { fill: "#fef3c7" } },
      { op: "format", sheet: "Loan", range: "B4", style: { format: MONEY0 } },
      { op: "format", sheet: "Loan", range: "B5", style: { format: "0.00%" } },
      { op: "format", sheet: "Loan", range: "B7:B8", style: { format: MONEY, bold: true } },
      { op: "note", cell: "B4", text: "Yellow cells are inputs." },
      { op: "set", sheet: "Loan", range: `A${start - 1}`, values: [["Month", "Payment", "Interest", "Principal", "Principal paid", "Balance"], ...rows] },
      { op: "format", sheet: "Loan", range: `A${start - 1}:F${start - 1}`, style: HEADER },
      { op: "format", sheet: "Loan", range: `B${start}:F${last}`, style: { format: MONEY } },
      { op: "colWidth", sheet: "Loan", cols: "A", width: 140 },
      { op: "colWidth", sheet: "Loan", cols: "B:F", width: 118 },
      { op: "chart", sheet: "Loan", type: "line", source: `E${start - 1}:F${last}`, title: "Principal paid vs. balance", at: "H3", width: 480, height: 290, legend: "bottom", xTitle: "Month" },
      { op: "freeze", sheet: "Loan", rows: start - 1 },
    ];
  },
};

const inventory: SheetTemplate = {
  id: "inventory",
  name: "Inventory tracker",
  description: "Stock levels with reorder alerts, stock value, and low-stock highlighting.",
  ops: () => {
    const items: [string, string, number, number, number][] = [
      ["SKU-1001", "Canvas tote", 142, 40, 6.8], ["SKU-1002", "Water bottle", 28, 50, 4.25],
      ["SKU-1003", "Notebook, A5", 315, 80, 2.1], ["SKU-1004", "Enamel pin set", 18, 25, 3.4],
      ["SKU-1005", "Hoodie, M", 46, 30, 18.5], ["SKU-1006", "Hoodie, L", 22, 30, 18.5],
      ["SKU-1007", "Sticker pack", 610, 150, 0.9], ["SKU-1008", "Desk mat", 12, 20, 11.75],
    ];
    const last = 4 + items.length;
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Inventory" },
      ...title("Inventory", "Inventory tracker", "Items at or below their reorder level are flagged for reordering."),
      { op: "set", sheet: "Inventory", range: "A4", values: [["SKU", "Item", "On hand", "Reorder at", "Unit cost", "Stock value", "Status"], ...items.map(([sku, name, qty, reorder, cost], index) => [sku, name, qty, reorder, cost, `=C${5 + index}*E${5 + index}`, `=IF(C${5 + index}<=D${5 + index},"Reorder","OK")`])] },
      { op: "table", sheet: "Inventory", range: `A4:G${last}`, name: "Stock", accent: 6, tone: "medium" },
      { op: "format", sheet: "Inventory", range: `E5:F${last + 1}`, style: { format: MONEY } },
      { op: "conditional", sheet: "Inventory", range: `G5:G${last}`, rule: { type: "text", op: "contains", text: "Reorder", style: { fill: "#fde2e1", color: "#9b1c1c", bold: true } } },
      { op: "conditional", sheet: "Inventory", range: `C5:C${last}`, rule: { type: "scale", min: "#f8696b", mid: "#ffeb84", max: "#63be7b" } },
      { op: "set", sheet: "Inventory", range: `E${last + 1}`, values: [["Total value", `=SUM(F5:F${last})`]] },
      { op: "set", sheet: "Inventory", range: `E${last + 2}`, values: [["Items to reorder", `=COUNTIF(G5:G${last},"Reorder")`]] },
      { op: "format", sheet: "Inventory", range: `E${last + 1}:F${last + 2}`, style: { bold: true } },
      { op: "format", sheet: "Inventory", range: `F${last + 2}`, style: { format: "0" } },
      { op: "colWidth", sheet: "Inventory", cols: "A", width: 100 },
      { op: "colWidth", sheet: "Inventory", cols: "B", width: 160 },
      { op: "colWidth", sheet: "Inventory", cols: "C:G", width: 104 },
      { op: "freeze", sheet: "Inventory", rows: 4 },
    ];
  },
};

const dashboard: SheetTemplate = {
  id: "dashboard",
  name: "KPI dashboard",
  description: "Monthly metrics with headline KPIs, month-over-month change, and trend charts.",
  ops: () => {
    const data = MONTHS.map((month, i) => [month, 182000 + i * 9400 + ((i * 3797) % 13000), 1180 + i * 46 + ((i * 53) % 70), 0.031 - i * 0.0011 + ((i * 7) % 5) * 0.0006]);
    return [
      { op: "renameSheet", sheet: "Sheet1", name: "Dashboard" },
      { op: "addSheet", name: "Data" },
      { op: "set", sheet: "Data", range: "A1", values: [["Month", "Revenue", "Customers", "Churn rate"], ...data] },
      { op: "format", sheet: "Data", range: "A1:D1", style: HEADER },
      { op: "format", sheet: "Data", range: "B2:B13", style: { format: MONEY0 } },
      { op: "format", sheet: "Data", range: "C2:C13", style: { format: "#,##0" } },
      { op: "format", sheet: "Data", range: "D2:D13", style: { format: "0.0%" } },
      { op: "colWidth", sheet: "Data", cols: "A:D", width: 112 },
      { op: "freeze", sheet: "Data", rows: 1 },
      { op: "activateSheet", sheet: "Dashboard" },
      { op: "gridlines", sheet: "Dashboard", show: false },
      ...title("Dashboard", "Company KPIs · 2027", "Headline numbers are the latest month; change is versus the month before."),
      { op: "set", sheet: "Dashboard", range: "A4", values: [["Revenue", "", "Customers", "", "Churn rate"], ["=INDEX(Data!B2:B13,COUNT(Data!B2:B13))", "", "=INDEX(Data!C2:C13,COUNT(Data!C2:C13))", "", "=INDEX(Data!D2:D13,COUNT(Data!D2:D13))"], ["=A5/INDEX(Data!B2:B13,COUNT(Data!B2:B13)-1)-1", "", "=C5/INDEX(Data!C2:C13,COUNT(Data!C2:C13)-1)-1", "", "=E5-INDEX(Data!D2:D13,COUNT(Data!D2:D13)-1)"]] },
      { op: "format", sheet: "Dashboard", range: "A4:E4", style: { bold: true, color: "#5c6b7a" } },
      { op: "format", sheet: "Dashboard", range: "A5:E5", style: { bold: true, size: 20, color: "#087d8b" } },
      { op: "format", sheet: "Dashboard", range: "A5", style: { format: MONEY0 } },
      { op: "format", sheet: "Dashboard", range: "C5", style: { format: "#,##0" } },
      { op: "format", sheet: "Dashboard", range: "E5", style: { format: "0.0%" } },
      { op: "format", sheet: "Dashboard", range: "A6:C6", style: { format: "+0.0%;-0.0%", italic: true } },
      { op: "format", sheet: "Dashboard", range: "E6", style: { format: "+0.00%;-0.00%", italic: true } },
      { op: "conditional", sheet: "Dashboard", range: "A6:C6", rule: { type: "cell", op: "lt", value: "0", style: { color: "#b91c1c" } } },
      { op: "conditional", sheet: "Dashboard", range: "A6:C6", rule: { type: "cell", op: "gte", value: "0", style: { color: "#15803d" } } },
      { op: "rowHeight", sheet: "Dashboard", rows: "5:5", height: 38 },
      { op: "colWidth", sheet: "Dashboard", cols: "A:E", width: 120 },
      { op: "chart", sheet: "Dashboard", type: "line", source: "Data!A1:B13", title: "Revenue by month", at: "A8", width: 520, height: 280, legend: "none" },
      // Chart data staged on the dashboard, as Excel dashboards do: one
      // rectangle per chart, linked to the Data sheet.
      { op: "set", sheet: "Dashboard", range: "A24", values: [["Chart data", "Customers"], ...MONTHS.map((_, i) => [`=Data!A${i + 2}`, `=Data!C${i + 2}`])] },
      { op: "format", sheet: "Dashboard", range: "A24:B24", style: { bold: true, color: "#5c6b7a" } },
      { op: "format", sheet: "Dashboard", range: "B25:B36", style: { format: "#,##0" } },
      { op: "chart", sheet: "Dashboard", type: "column", source: "A24:B36", title: "Customers by month", at: "G8", width: 460, height: 280, legend: "none" },
    ];
  },
};

export const SHEET_TEMPLATES: SheetTemplate[] = [budget, sales, projectPlan, invoice, expenses, loan, inventory, dashboard];

/** Builds a template workbook; returns any operations that were skipped so
 * tests can insist templates apply cleanly. */
export function buildSheetTemplate(template: SheetTemplate): { workbook: Workbook; warnings: string[] } {
  const result = applySheetOps(blankWorkbook(), "sheet-1", template.ops());
  return { workbook: result.workbook, warnings: result.warnings };
}
