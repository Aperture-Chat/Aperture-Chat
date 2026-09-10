import { flushSync } from "react-dom";
import { useCallback, useEffect, useRef, useState } from "react";

export type ThemeSchedule = { enabled: boolean; light: string; dark: string };
export const DEFAULT_THEME_SCHEDULE: ThemeSchedule = { enabled: false, light: "07:00", dark: "19:00" };
const SCHEDULE_KEY = "aperture-theme-schedule";
const MODE_KEY = "aperture-dark-mode";
const OVERRIDE_KEY = "aperture-theme-override-until";
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function validThemeSchedule(value: unknown): value is ThemeSchedule {
  if (!value || typeof value !== "object") return false;
  const s = value as ThemeSchedule;
  return typeof s.enabled === "boolean" && typeof s.light === "string" && typeof s.dark === "string"
    && TIME.test(s.light) && TIME.test(s.dark) && s.light !== s.dark;
}

function readSchedule(): ThemeSchedule {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SCHEDULE_KEY) || "null");
    if (validThemeSchedule(value)) return value;
  } catch { /* Storage may be unavailable. */ }
  return DEFAULT_THEME_SCHEDULE;
}

function read(key: string) {
  try { return localStorage.getItem(key); } catch { return null; }
}
function persist(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* Keep the active preference in memory. */ }
}

/** Use local calendar times so overnight schedules and daylight saving changes work. */
export function scheduledTheme(schedule: ThemeSchedule, now = new Date()) {
  const events = (["light", "dark"] as const).flatMap((mode) => [-1, 0, 1].map((day) => {
    const [hours, minutes] = schedule[mode].split(":").map(Number);
    const date = new Date(now);
    date.setDate(date.getDate() + day);
    date.setHours(hours, minutes, 0, 0);
    return { at: date.getTime(), dark: mode === "dark" };
  })).sort((a, b) => a.at - b.at);
  return {
    dark: events.filter((event) => event.at <= now.getTime()).at(-1)!.dark,
    next: events.find((event) => event.at > now.getTime())!.at,
  };
}

export function useThemeSchedule() {
  const [schedule, setSchedule] = useState(readSchedule);
  const overrideUntil = useRef(Number(read(OVERRIDE_KEY)) || 0);
  const [darkMode, setDarkMode] = useState(() => schedule.enabled && Date.now() >= overrideUntil.current
    ? scheduledTheme(schedule).dark : read(MODE_KEY) === "true");

  useEffect(() => { persist(MODE_KEY, String(darkMode)); }, [darkMode]);

  useEffect(() => {
    const apply = () => {
      if (schedule.enabled && Date.now() >= overrideUntil.current) {
        setDarkMode(scheduledTheme(schedule).dark);
      }
    };
    apply();
    const timer = window.setInterval(apply, 1000);
    window.addEventListener("focus", apply);
    document.addEventListener("visibilitychange", apply);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", apply);
      document.removeEventListener("visibilitychange", apply);
    };
  }, [schedule]);

  const saveSchedule = useCallback((next: ThemeSchedule) => {
    if (!validThemeSchedule(next)) return;
    overrideUntil.current = 0;
    persist(OVERRIDE_KEY, "0");
    persist(SCHEDULE_KEY, JSON.stringify(next));
    setSchedule(next);
  }, []);
  const toggleDarkMode = useCallback(() => {
    overrideUntil.current = schedule.enabled ? scheduledTheme(schedule).next : 0;
    persist(OVERRIDE_KEY, String(overrideUntil.current));
    const update = () => flushSync(() => setDarkMode((current) => !current));
    if (document.startViewTransition && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      document.startViewTransition(update);
    } else update();
  }, [schedule]);
  return { darkMode, schedule, saveSchedule, toggleDarkMode };
}
