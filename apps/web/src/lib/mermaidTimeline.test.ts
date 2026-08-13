import { expect, test } from "vitest";
import {
  parseMermaidTimeline,
  repairMermaidTimelineSource,
  renderTimelineFallbackSvg,
} from "./mermaidTimeline";

const LENR_TIMELINE = `timeline
    title Figure 6. Selected international and Chinese LENR milestones
    1989 : Fleischmann and Pons announce cold fusion
         : Worldwide replication campaign begins
         : First US DOE review is negative
    1990 : Tsinghua team reports precursor studies`;

test("repairMermaidTimelineSource inserts the required space before period colons", () => {
  const repaired = repairMermaidTimelineSource(
    "timeline\n1989: Fleischmann and Pons\n     : DOE: negative review",
  );
  expect(repaired).toContain("1989 : Fleischmann and Pons");
  expect(repaired).toContain(": DOE — negative review");
});

test("parseMermaidTimeline reads titles, periods, and continuation events", () => {
  const model = parseMermaidTimeline(LENR_TIMELINE);
  expect(model?.title).toBe("Figure 6. Selected international and Chinese LENR milestones");
  expect(model?.sections).toHaveLength(1);
  expect(model?.sections[0]?.periods).toEqual([
    {
      period: "1989",
      events: [
        "Fleischmann and Pons announce cold fusion",
        "Worldwide replication campaign begins",
        "First US DOE review is negative",
      ],
    },
    { period: "1990", events: ["Tsinghua team reports precursor studies"] },
  ]);
});

test("renderTimelineFallbackSvg draws a titled visual without mermaid.js", () => {
  const svg = renderTimelineFallbackSvg(LENR_TIMELINE, false, "sans-serif");
  expect(svg).toContain("<svg");
  expect(svg).toContain("Figure 6. Selected international and Chinese LENR milestones");
  expect(svg).toContain("Fleischmann and Pons announce cold fusion");
  expect(svg).not.toContain("foreignObject");
});

const LENR_TIMELINE_FIXTURE = `timeline
title Figure 6. Selected international and Chinese LENR milestones
1989 : Fleischmann and Pons announce cold fusion
: Worldwide replication campaign begins
: First US DOE review is negative
1990 : Tsinghua team reports precursor studies
1991 : Miles reports helium measurements in US Navy work
1990s : Japanese New Hydrogen Energy programme
: Continued US, Italian, Russian and Indian studies
2002 : ICCF-9 held at Tsinghua University in Beijing
: Chinese resonant-tunnelling papers presented
2004 : Second US DOE review remains inconclusive
2008 : Jiang team reports very-low-rate charged particles
2009 : CR-39 triple-track paper published internationally
2014 : China Institute team reports neutron bursts
2015 : Chinese Ni-H translated heat reports circulate
2019 : Google-supported Nature review reports no effect
2020 : NASA reports accelerator-assisted lattice fusion
: EU CleanHME project begins
2023 : US ARPA-E funds eight LENR test projects
2025 : CleanHME project ends
: Nature reports electrochemically enhanced beam fusion
2026 : Chinese LENR authors continue specialist-journal theory`;

test("the reported LENR timeline fixture parses every period and continuation", () => {
  const model = parseMermaidTimeline(LENR_TIMELINE_FIXTURE);
  expect(model?.title).toBe("Figure 6. Selected international and Chinese LENR milestones");
  const periods = model?.sections[0]?.periods ?? [];
  expect(periods.map((period) => period.period)).toEqual([
    "1989",
    "1990",
    "1991",
    "1990s",
    "2002",
    "2004",
    "2008",
    "2009",
    "2014",
    "2015",
    "2019",
    "2020",
    "2023",
    "2025",
    "2026",
  ]);
  expect(periods[0]?.events).toEqual([
    "Fleischmann and Pons announce cold fusion",
    "Worldwide replication campaign begins",
    "First US DOE review is negative",
  ]);
  expect(periods.at(-1)?.events).toEqual(["Chinese LENR authors continue specialist-journal theory"]);
  const svg = renderTimelineFallbackSvg(LENR_TIMELINE_FIXTURE, false, "sans-serif");
  expect(svg).toContain("NASA reports accelerator-assisted lattice fusion");
  expect(svg).toContain("2026");
});
