/** Synthetic structure charts whose default rendering is pinned by hash in
 * stewardDiagram.test.ts: charts without theme, position, bend, connector, or
 * corner fields must keep drawing exactly as they did before those existed. */

export const PIN_FIXTURES: Record<string, string> = {
  estate: JSON.stringify({
    title: "Harlan Estate Plan",
    subtitle: "Missouri residents · $80M estimated net worth",
    tag: "Confidential — attorney work product",
    rows: [
      [
        { id: "alden", title: "ALDEN L. HARLAN", subtitle: "Settlor · Grantor", variant: "banner" },
        { id: "dana", title: "DANA L. HARLAN", subtitle: "Settlor · Grantor", variant: "banner", bullets: ["Trustee"] },
      ],
      [
        {
          id: "brt",
          title: "ALDEN L. HARLAN REVOCABLE TRUST",
          subtitle: "2017 · Kansas law",
          bullets: ["Settlor & Trustee: Alden", "At death: residue to Dana outright"],
          footer: { text: "SUBJECT TO ESTATE TAX", tone: "neutral" },
        },
        {
          id: "slat",
          title: "2021 SLAT FBO DANA",
          subtitle: "Jan. 21, 2021 · Missouri law",
          bullets: ["Grantor: Alden · Trustee: Dana"],
          footer: { text: "NOT SUBJECT TO ESTATE TAX · GST EXEMPT", tone: "positive" },
          note: "Reciprocal trust doctrine — watch item",
        },
      ],
      [{ id: "kids", title: "FOUR CHILDREN", subtitle: "Quinn · Riley · Jordan · Casey", footer: { text: "Beneficiaries", tone: "warning" } }],
    ],
    edges: [
      { from: "alden", to: "brt", kind: "primary" },
      { from: "alden", to: "slat", kind: "primary", label: "funds" },
      { from: "dana", to: "slat", kind: "inactive" },
      { from: "brt", to: "kids", kind: "contingent", label: "if disclaimed" },
      { from: "slat", to: "kids", kind: "contingent" },
    ],
    legend: [
      { kind: "primary", label: "Completed transfer / funded" },
      { kind: "contingent", label: "Contingent / at-death transfer" },
      { kind: "inactive", label: "Executed, not active" },
    ],
    footnote: "2026 exemption: $15M per person / $30M per couple.",
  }),
  rowRoutes: JSON.stringify({
    title: "Order pipeline",
    rows: [
      [
        { id: "intake", title: "Intake", bullets: ["Web form", "Phone"] },
        { id: "review", title: "Review", bullets: ["Credit check"] },
        { id: "ship", title: "Ship", bullets: ["Carrier pickup"] },
      ],
      [{ id: "archive", title: "Archive", subtitle: "Seven-year retention" }],
    ],
    edges: [
      { from: "intake", to: "review", label: "submitted" },
      { from: "review", to: "ship" },
      { from: "intake", to: "ship", kind: "contingent", label: "expedite" },
      { from: "ship", to: "intake", kind: "inactive" },
      { from: "archive", to: "review", label: "audit" },
    ],
  }),
  plain: JSON.stringify({
    rows: [[{ id: "solo", title: "Only box" }], [{ id: "next", title: "Next box", bullets: ["One", "Two"] }]],
    edges: [{ from: "solo", to: "next" }],
  }),
};
