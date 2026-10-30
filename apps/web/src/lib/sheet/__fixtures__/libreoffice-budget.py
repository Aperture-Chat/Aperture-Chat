"""Builds a synthetic LibreOffice workbook and saves it as .xlsx (fixture only)."""
import sys
import time
import uno
from com.sun.star.beans import PropertyValue
from com.sun.star.awt import Rectangle
from com.sun.star.table import BorderLine2, CellAddress

OUT = "/tmp/aperture-xlsx-work/out/lo-budget.xlsx"


def pv(name, value):
    item = PropertyValue()
    item.Name = name
    item.Value = value
    return item


def main(*args):
    desktop = XSCRIPTCONTEXT.getDesktop()
    build(desktop)


def build(desktop):
    global doc
    doc = desktop.loadComponentFromURL("private:factory/scalc", "_blank", 0, (pv("Hidden", True),))
    locale = uno.createUnoStruct("com.sun.star.lang.Locale")
    locale.Language = "en"
    locale.Country = "US"


    def fmt(code):
        formats = doc.NumberFormats
        key = formats.queryKey(code, locale, False)
        return key if key != -1 else formats.addNew(code, locale)


    sheets = doc.Sheets
    budget = sheets.getByIndex(0)
    budget.Name = "Budget"
    sheets.insertNewByName("Notes", 1)
    sheets.insertNewByName("Lookup", 2)
    notes = sheets.getByName("Notes")
    lookup = sheets.getByName("Lookup")

    c = budget.getCellRangeByName
    c("A1").String = "Team Budget"
    c("A1:E1").merge(True)
    c("A1").CharWeight = 150.0
    c("A1").CharHeight = 14
    c("A1").CharColor = 0x1F4E79
    c("A1").HoriJustify = uno.Enum("com.sun.star.table.CellHoriJustify", "CENTER")
    header = ["Item", "Q1", "Q2", "Total", "Share", "Due", "Status"]
    for index, label in enumerate(header):
        budget.getCellByPosition(index, 2).String = label
    head = c("A3:G3")
    head.CharWeight = 150.0
    head.CellBackColor = 0xDDEBF7
    line = BorderLine2()
    line.Color = 0x1F4E79
    line.LineWidth = 26
    line.OuterLineWidth = 26
    head.BottomBorder = line
    items = [("Laptops", 1200, 900), ("Software", 450.5, 480), ("Travel", 300, 75.25), ("Training", 99, 140)]
    for offset, (name, q1, q2) in enumerate(items):
        row = 3 + offset
        budget.getCellByPosition(0, row).String = name
        budget.getCellByPosition(1, row).Value = q1
        budget.getCellByPosition(2, row).Value = q2
        budget.getCellByPosition(3, row).Formula = f"=B{row + 1}+C{row + 1}"
        budget.getCellByPosition(4, row).Formula = f"=D{row + 1}/$D$8"
        budget.getCellByPosition(5, row).Value = 46022 + offset * 31
        budget.getCellByPosition(6, row).String = "Open" if offset % 2 == 0 else "Closed"
    c("A8").String = "Total"
    c("A8").CharWeight = 150.0
    for col in "BCD":
        c(f"{col}8").Formula = f"=SUM({col}4:{col}7)"
    c("B4:D8").NumberFormat = fmt("#,##0.00")
    c("E4:E7").NumberFormat = fmt("0.0%")
    c("F4:F7").NumberFormat = fmt("YYYY-MM-DD")
    c("A4:A7").IsTextWrapped = True
    c("A4:A7").ParaIndent = 353
    c("B3:G3").HoriJustify = uno.Enum("com.sun.star.table.CellHoriJustify", "RIGHT")
    c("A3").VertJustify = uno.Enum("com.sun.star.table.CellVertJustify", "TOP")
    c("A6").CharPosture = uno.Enum("com.sun.star.awt.FontSlant", "ITALIC")
    c("A7").CharUnderline = 1
    c("B7").CharStrikeout = 1
    c("C4").CharFontName = "Georgia"
    budget.Columns.getByIndex(0).Width = 3800
    budget.Columns.getByIndex(7).IsVisible = False
    budget.Rows.getByIndex(1).Height = 900
    budget.TabColor = 0x087D8B
    budget.Annotations.insertNew(CellAddress(0, 0, 3), "Synthetic note for the laptops line")

    lookup.getCellRangeByName("A1").String = "Open"
    lookup.getCellRangeByName("A2").String = "Closed"
    lookup.getCellRangeByName("A3").String = "Blocked"
    lookup.IsVisible = False

    status = c("G4:G7")
    validation = status.Validation
    validation.Type = uno.Enum("com.sun.star.sheet.ValidationType", "LIST")
    validation.Formula1 = "$Lookup.$A$1:$A$3"
    validation.ShowErrorMessage = True
    validation.ErrorMessage = "Pick a listed status"
    status.Validation = validation
    amounts = c("B4:B7")
    validation = amounts.Validation
    validation.Type = uno.Enum("com.sun.star.sheet.ValidationType", "DECIMAL")
    validation.setOperator(uno.Enum("com.sun.star.sheet.ConditionOperator", "BETWEEN"))
    validation.Formula1 = "0"
    validation.Formula2 = "5000"
    validation.ShowErrorMessage = True
    amounts.Validation = validation

    totals = c("D4:D7")
    conditional = totals.ConditionalFormat
    conditional.addNew((
        pv("Operator", uno.Enum("com.sun.star.sheet.ConditionOperator", "GREATER")),
        pv("Formula1", "1000"),
        pv("StyleName", "Good"),
    ))
    totals.ConditionalFormat = conditional

    ranges = doc.DatabaseRanges
    ranges.addNewByName("BudgetFilter", c("A3:G7").RangeAddress)
    ranges.getByName("BudgetFilter").AutoFilter = True

    notes.getCellRangeByName("A1").String = "Synthetic notes — café ünïcode"
    notes.getCellRangeByName("A2").Formula = "=1/0"
    notes.getCellRangeByName("A3").Formula = '=UPPER("mixed")'
    notes.getCellRangeByName("A4").Formula = "=TRUE()"
    notes.getCellRangeByName("A5").Formula = "=$Budget.D8*2"
    notes.getCellRangeByName("B1").Value = 1
    notes.getCellRangeByName("B2").Value = 2
    notes.getCellRangeByName("C1").Formula = "=B1*10"
    notes.getCellRangeByName("C2").Formula = "=B2*10"

    charts = budget.Charts
    charts.addNewByName("Spend", Rectangle(1000, 5500, 12000, 7000), (c("A3:C7").RangeAddress,), True, True)
    chart = charts.getByName("Spend").EmbeddedObject
    chart.HasMainTitle = True
    chart.Title.String = "Quarterly spend"
    charts.addNewByName("Mix", Rectangle(14000, 5500, 9000, 7000), (c("A4:B7").RangeAddress,), False, True)
    pie = charts.getByName("Mix").EmbeddedObject
    pie.setDiagram(pie.createInstance("com.sun.star.chart.PieDiagram"))
    pie.HasLegend = True

    controller = doc.CurrentController
    if controller is not None:
        controller.setActiveSheet(budget)
        controller.freezeAtPosition(1, 3)

    doc.storeToURL(uno.systemPathToFileUrl(OUT), (pv("FilterName", "Calc Office Open XML"),))
    doc.close(True)
    print("saved", OUT)

    open("/tmp/aperture-xlsx-work/out/done.txt", "w").write("ok")


g_exportedScripts = (main,)
