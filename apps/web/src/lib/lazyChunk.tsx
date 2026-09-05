import { Component, createContext, createElement, lazy, useContext, type ComponentProps, type ComponentType, type LazyExoticComponent, type ReactNode } from "react";

const ChunkRetryContext = createContext<object>({});

/** Optional panels can fail after a deploy replaces their hashed assets, or
 * during a temporary network outage. Keep the workspace mounted so its
 * unsent text and staged files survive. Each explicit boundary retry gets a
 * fresh React.lazy instance because React otherwise caches an import failure.
 * The existing export name remains compatible with the panel call sites. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors React.lazy's own signature
export function lazyWithReload<T extends ComponentType<any>>(
  chunkName: string,
  importer: () => Promise<{ default: T }>,
) {
  // A stable token outside Suspense survives an initially suspended render;
  // useMemo inside the suspended component would not guarantee that cache.
  const attempts = new WeakMap<object, LazyExoticComponent<T>>();
  function RecoverableChunk(props: ComponentProps<T>) {
    const token = useContext(ChunkRetryContext);
    let chunk = attempts.get(token);
    if (!chunk) {
      chunk = lazy(importer);
      attempts.set(token, chunk);
    }
    return createElement(chunk as ComponentType<ComponentProps<T>>, props);
  }
  RecoverableChunk.displayName = `RecoverableChunk(${chunkName})`;
  return RecoverableChunk;
}

/** A failed optional panel never forces navigation or unmounts the surrounding
 * workspace. Retry handles temporary failures; reload is an explicit choice
 * when an older tab needs the current asset manifest. */
export class LazyChunkBoundary extends Component<
  { label: string; children: ReactNode },
  { failed: boolean; retryToken: object }
> {
  state = { failed: false, retryToken: {} };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) {
      return <ChunkRetryContext.Provider value={this.state.retryToken}>{this.props.children}</ChunkRetryContext.Provider>;
    }
    return (
      <div className="drawer-card chunk-load-error" role="alert">
        <strong>{this.props.label} could not load</strong>
        <span>
          You can keep working in the rest of the app. Try again, or reload if this tab was open during an update.
          Save or copy unfinished work before reloading.
        </span>
        <button
          className="secondary-button compact"
          type="button"
          onClick={() => this.setState({ failed: false, retryToken: {} })}
        >
          Try again
        </button>
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
