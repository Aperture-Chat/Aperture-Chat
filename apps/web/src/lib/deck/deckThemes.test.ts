import { expect, test } from "vitest";
import { DECK_DESIGNS, defaultDeckTheme, deckThemeDesign, serializeSlideDeck, blankSlideDeck } from "./deckModel";
import { DECK_THEME_PRESETS, deckThemePresetActive, deckThemeWithPreset } from "./deckThemes";

const preset = (name: string) => {
  const found = DECK_THEME_PRESETS.find((item) => item.name === name);
  if (!found) throw new Error(name);
  return found;
};

test("every design has exactly one theme, and the classic one is the deck default", () => {
  expect(DECK_THEME_PRESETS.map((item) => item.design).sort()).toEqual([...DECK_DESIGNS].sort());
  const aperture = preset("Aperture");
  expect(aperture.colors).toEqual(defaultDeckTheme().colors);
  expect(aperture.fonts).toEqual(defaultDeckTheme().fonts);
});

test("applying a theme swaps design, colors, and type but keeps the brand logo and pictures", () => {
  const brand = {
    ...defaultDeckTheme(),
    logo: { dataUrl: "data:image/png;base64,AAAA", widthPx: 4, heightPx: 3 },
    backgroundLibrary: { bg1: "data:image/png;base64,BBBB" },
  };
  const midnight = deckThemeWithPreset(brand, preset("Midnight"));
  expect(deckThemeDesign(midnight)).toBe("orbit");
  expect(midnight.colors.background).toBe("#122033");
  expect(midnight.sourceLabel).toBe("Midnight");
  expect(midnight.logo).toEqual(brand.logo);
  expect(midnight.backgroundLibrary).toEqual(brand.backgroundLibrary);

  // Back to the classic theme: the design key goes away entirely, so the deck
  // is byte-identical to one that never had a design.
  const classic = deckThemeWithPreset(midnight, preset("Aperture"));
  expect("design" in classic).toBe(false);
  expect(serializeSlideDeck({ ...blankSlideDeck("x"), theme: classic })).not.toContain('"design"');
});

test("a theme card reads as chosen only when the deck wears its design and its colors", () => {
  const states = DECK_THEME_PRESETS.map((item) => deckThemeWithPreset(defaultDeckTheme(), item));
  states.forEach((theme, index) => {
    const active = DECK_THEME_PRESETS.filter((item) => deckThemePresetActive(theme, item)).map((item) => item.name);
    expect(active).toEqual([DECK_THEME_PRESETS[index].name]);
  });
  // A deck saved before designs existed, in the old rust palette: classic
  // design, but not the Aperture colors, so no card is chosen.
  const oldPalette = { ...defaultDeckTheme(), colors: { ...defaultDeckTheme().colors, accent1: "#a44932", background: "#faf4e8" } };
  expect(DECK_THEME_PRESETS.filter((item) => deckThemePresetActive(oldPalette, item))).toEqual([]);
  // Same design and accent with another background is not the theme either.
  const otherBackground = { ...defaultDeckTheme(), colors: { ...defaultDeckTheme().colors, background: "#000000" } };
  expect(deckThemePresetActive(otherBackground, preset("Aperture"))).toBe(false);
});
