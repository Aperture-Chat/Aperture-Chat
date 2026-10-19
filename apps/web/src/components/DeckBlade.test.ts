import { expect, test } from "vitest";
import { DECK_BLADE_DEFAULT_WIDTH, DECK_BLADE_MIN_WIDTH, deckBladePlacement } from "./DeckBlade";

test("the blade docks at the editor seam and leaves the stage room", () => {
  expect(deckBladePlacement(DECK_BLADE_DEFAULT_WIDTH, 1440, 76)).toEqual({ left: 76, width: 380, full: false, min: DECK_BLADE_MIN_WIDTH, max: 720 });
  // A tablet keeps at least 280px of stage beside it.
  expect(deckBladePlacement(900, 768, 0)).toMatchObject({ left: 0, width: 488, full: false, max: 488 });
  expect(deckBladePlacement(120, 1024, 76).width).toBe(DECK_BLADE_MIN_WIDTH);
  expect(deckBladePlacement(Number.NaN, 1440, 76).width).toBe(DECK_BLADE_DEFAULT_WIDTH);
});

test("phones get the blade full-width over the editor", () => {
  expect(deckBladePlacement(380, 390, 0)).toEqual({ left: 0, width: 390, full: true, min: 390, max: 390 });
});
