import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scheduledTheme, useThemeSchedule, validThemeSchedule } from "./useThemeSchedule";

const schedule = { enabled: true, light: "07:00", dark: "19:00" };
beforeEach(() => { localStorage.clear(); vi.useFakeTimers(); vi.setSystemTime(new Date(2026, 8, 10, 18, 59, 59)); });
afterEach(() => { vi.useRealTimers(); });

describe("theme schedule", () => {
  it("switches exactly at each local time, including overnight and reversed schedules", () => {
    expect(scheduledTheme(schedule, new Date(2026, 8, 10, 6, 59)).dark).toBe(true);
    expect(scheduledTheme(schedule, new Date(2026, 8, 10, 7, 0)).dark).toBe(false);
    expect(scheduledTheme(schedule, new Date(2026, 8, 10, 19, 0)).dark).toBe(true);
    expect(scheduledTheme({ ...schedule, light: "19:00", dark: "07:00" }, new Date(2026, 8, 10, 12)).dark).toBe(true);
  });
  it("rejects equal, missing, and malformed times", () => {
    for (const value of [null, {}, { ...schedule, dark: "07:00" }, { ...schedule, dark: "24:00" }, { ...schedule, light: "9:00" }]) {
      expect(validThemeSchedule(value)).toBe(false);
    }
  });
  it("applies a saved schedule, persists manual overrides, and resumes at the next switch", () => {
    localStorage.setItem("aperture-theme-schedule", JSON.stringify(schedule));
    const first = renderHook(useThemeSchedule);
    expect(first.result.current.darkMode).toBe(false);
    act(() => first.result.current.toggleDarkMode());
    expect(first.result.current.darkMode).toBe(true);
    first.unmount();
    const next = renderHook(useThemeSchedule);
    expect(next.result.current.darkMode).toBe(true);
    act(() => { vi.advanceTimersByTime(1000); });
    expect(next.result.current.darkMode).toBe(true);
    act(() => { vi.setSystemTime(new Date(2026, 8, 11, 7)); window.dispatchEvent(new Event("focus")); });
    expect(next.result.current.darkMode).toBe(false);
    next.unmount();
  });
  it("applies a newly enabled schedule immediately and stops switching when disabled", () => {
    const { result, unmount } = renderHook(useThemeSchedule);
    act(() => result.current.saveSchedule(schedule));
    act(() => vi.advanceTimersByTime(1000));
    expect(result.current.darkMode).toBe(true);
    act(() => result.current.saveSchedule({ ...schedule, enabled: false }));
    act(() => { vi.setSystemTime(new Date(2026, 8, 11, 7)); window.dispatchEvent(new Event("focus")); });
    expect(result.current.darkMode).toBe(true);
    unmount();
  });
  it("falls back safely for corrupted storage", () => {
    localStorage.setItem("aperture-theme-schedule", '{broken');
    const { result, unmount } = renderHook(useThemeSchedule);
    expect(result.current.schedule.enabled).toBe(false);
    unmount();
  });
});
