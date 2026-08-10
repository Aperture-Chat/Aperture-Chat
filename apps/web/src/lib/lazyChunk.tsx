import { Component, lazy, type ComponentType, type ReactNode } from "react";

/* Lazy chunks are fetched by hashed filename, so a tab opened before a deploy
   can request a chunk that no longer exists; the SPA fallback answers with
   index.html and the import rejects ("unsupported MIME type"). Without
   handling, that rejection unmounts the entire app into a white screen. */

/** Lazy-load a chunk; on a failed import, reload once to pick up the current
    asset manifest. The once-per-chunk session flag prevents reload loops and
    is cleared again on any successful load, so a later genuine failure can
    still recover. If the retry also fails, the error propagates to the
    nearest LazyChunkBoundary instead of blanking the page. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own signature
export function lazyWithReload<T extends ComponentType<any>>(
  chunkName: string,
  importer: () => Promise<{ default: T }>,
) {
  const flag = `aperture-chunk-reload:${chunkName}`;
  return lazy(() =>
    importer().then(
      (module) => {
        sessionStorage.removeItem(flag);
        return module;
      },
      (error: unknown) => {
        if (sessionStorage.getItem(flag) === null) {
          sessionStorage.setItem(flag, new Date().toISOString());
          window.location.reload();
          // The page is reloading; keep Suspense's fallback up instead of
          // throwing into a tree that is about to be torn down.
          return new Promise<{ default: T }>(() => {});
        }
        throw error;
      },
    ),
  );
}

/** Error boundary for lazy panels: a failed chunk (or any render error in the
    wrapped subtree) collapses to an honest inline notice with a reload
    action, never a blank page. */
export class LazyChunkBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="drawer-card chunk-load-error" role="alert">
        <strong>{this.props.label} could not load</strong>
        <span>
          This is usually a stale browser tab after an update. Reload to fetch
          the current version.
        </span>
        <button
          className="secondary-button compact"
          type="button"
          onClick={() => window.location.reload()}
        >
          Reload page
        </button>
      </div>
    );
  }
}
