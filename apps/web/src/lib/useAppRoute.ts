import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { DEFAULT_ROUTE, parsePath, routeToPath, type AppRoute } from "./appRoute";

const listeners = new Set<() => void>();

function emit() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readPathname() {
  return window.location.pathname;
}

function serverPathname() {
  return "/";
}

/**
 * Query parameters carried along with in-app navigation. `persona` is a
 * dev-only sign-in selector and the OAuth return keys are single-use, so none
 * of them may be written back into history. The fragment is always dropped.
 */
const TRANSIENT_QUERY_KEYS = ["persona", "connector_oauth", "message"];

function carriedSearch(): string {
  const params = new URLSearchParams(window.location.search);
  for (const key of TRANSIENT_QUERY_KEYS) params.delete(key);
  const query = params.toString();
  return query ? `?${query}` : "";
}

export type NavigateOptions = { replace?: boolean };

/**
 * Called on browser back/forward before the route is applied. The URL has
 * already moved, so the hook first restores the committed path; `proceed`
 * pushes the requested path again once the caller is satisfied.
 */
export type PopInterceptor = (next: AppRoute, proceed: () => void) => void;

export type AppRouter = {
  route: AppRoute;
  /** True when the current URL was not a recognized workspace path. */
  unknownPath: boolean;
  pathname: string;
  navigate: (route: AppRoute, options?: NavigateOptions) => void;
  back: () => void;
};

/**
 * Dependency-free router over the History API. Only the pathname is
 * written: `#sso_*` fragments and `?persona=` are consumed by App before this
 * hook ever navigates, and they must never be pushed back into history.
 */
export function useAppRoute(interceptPop?: PopInterceptor): AppRouter {
  const pathname = useSyncExternalStore(subscribe, readPathname, serverPathname);
  const interceptRef = useRef<PopInterceptor | undefined>(interceptPop);
  interceptRef.current = interceptPop;
  const committedPathRef = useRef(pathname);

  useEffect(() => {
    committedPathRef.current = pathname;
  }, [pathname]);

  useEffect(() => {
    function onPopState() {
      const next = readPathname();
      const intercept = interceptRef.current;
      if (!intercept || next === committedPathRef.current) {
        emit();
        return;
      }
      // Put the address bar back on the committed screen so a cancelled
      // navigation guard leaves URL and UI consistent.
      window.history.pushState({}, "", committedPathRef.current);
      intercept(parsePath(next) ?? DEFAULT_ROUTE, () => {
        window.history.pushState({}, "", next);
        emit();
      });
    }
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const parsed = useMemo(() => parsePath(pathname), [pathname]);

  const navigate = useCallback((route: AppRoute, options: NavigateOptions = {}) => {
    const path = routeToPath(route);
    if (path === readPathname()) {
      if (options.replace) return;
      emit();
      return;
    }
    const url = `${path}${carriedSearch()}`;
    if (options.replace) window.history.replaceState({}, "", url);
    else window.history.pushState({}, "", url);
    emit();
  }, []);

  useEffect(() => {
    if (/^\/platform\/setup\/?$/.test(pathname)) {
      navigate({ kind: "platform", section: "org-settings" }, { replace: true });
    }
  }, [pathname, navigate]);

  const back = useCallback(() => {
    window.history.back();
  }, []);

  return {
    route: parsed ?? DEFAULT_ROUTE,
    unknownPath: parsed === null,
    pathname,
    navigate,
    back,
  };
}
