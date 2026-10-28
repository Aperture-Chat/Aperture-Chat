import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import { routeToPath } from "./appRoute";
import { useAppRoute, type PopInterceptor } from "./useAppRoute";

function Probe({ intercept }: { intercept?: PopInterceptor }) {
  const router = useAppRoute(intercept);
  return (
    <div>
      <output data-testid="path">{routeToPath(router.route)}</output>
      <output data-testid="unknown">{String(router.unknownPath)}</output>
      <button type="button" onClick={() => router.navigate({ kind: "admin", section: "groups" })}>
        go-admin
      </button>
      <button type="button" onClick={() => router.navigate({ kind: "library", section: "tools" }, { replace: true })}>
        replace-library
      </button>
      <button type="button" onClick={() => router.navigate({ kind: "chat", threadId: "t-2" })}>
        go-chat-thread
      </button>
    </div>
  );
}

afterEach(() => {
  window.history.pushState({}, "", "/");
});

test("reads the initial location and pushes or replaces history entries", () => {
  window.history.pushState({}, "", "/drafts/d-1");
  render(<Probe />);
  expect(screen.getByTestId("path")).toHaveTextContent("/drafts/d-1");
  expect(screen.getByTestId("unknown")).toHaveTextContent("false");

  const pushSpy = vi.spyOn(window.history, "pushState");
  const replaceSpy = vi.spyOn(window.history, "replaceState");
  act(() => screen.getByText("go-admin").click());
  expect(window.location.pathname).toBe("/admin/groups");
  expect(screen.getByTestId("path")).toHaveTextContent("/admin/groups");
  expect(pushSpy).toHaveBeenCalledTimes(1);

  act(() => screen.getByText("replace-library").click());
  expect(window.location.pathname).toBe("/library/tools");
  expect(replaceSpy).toHaveBeenCalledTimes(1);
  pushSpy.mockRestore();
  replaceSpy.mockRestore();
});

test("unknown paths fall back to chat and are flagged", () => {
  window.history.pushState({}, "", "/definitely-not-a-screen");
  render(<Probe />);
  expect(screen.getByTestId("path")).toHaveTextContent("/chat");
  expect(screen.getByTestId("unknown")).toHaveTextContent("true");
});

test("popstate updates the route when no interceptor is registered", () => {
  window.history.pushState({}, "", "/agents");
  render(<Probe />);
  act(() => {
    window.history.pushState({}, "", "/automations");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  expect(screen.getByTestId("path")).toHaveTextContent("/automations");
});

test("an interceptor can hold back/forward until it proceeds", () => {
  window.history.pushState({} , "", "/drafts");
  let pending: (() => void) | null = null;
  const intercept: PopInterceptor = (_next, proceed) => {
    pending = proceed;
  };
  render(<Probe intercept={intercept} />);
  act(() => {
    // Simulate the browser having moved to a previous entry.
    window.history.pushState({}, "", "/chat");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  // The URL is restored to the committed screen while the guard is open.
  expect(window.location.pathname).toBe("/drafts");
  expect(screen.getByTestId("path")).toHaveTextContent("/drafts");
  expect(pending).not.toBeNull();
  act(() => pending?.());
  expect(window.location.pathname).toBe("/chat");
  expect(screen.getByTestId("path")).toHaveTextContent("/chat");
});

test("retired Setup URL is replaced without adding a history entry", () => {
  window.history.pushState({}, "", "/platform/setup/?source=guide");
  const before = window.history.length;
  render(<Probe />);
  expect(window.location.pathname).toBe("/platform/org-settings");
  expect(window.location.search).toBe("?source=guide");
  expect(window.history.length).toBe(before);
  expect(screen.getByTestId("unknown")).toHaveTextContent("false");
});

test("a different screen opens at its top while moves within a screen keep the scroll", () => {
  // Narrow layouts scroll the document itself, and chat pins it to the newest
  // reply; that offset must not carry into the next screen.
  window.history.pushState({}, "", "/chat/t-1");
  const scroller = document.documentElement;
  Object.defineProperty(scroller, "scrollTop", { value: 480, writable: true, configurable: true });
  render(<Probe />);

  act(() => screen.getByText("go-chat-thread").click());
  expect(window.location.pathname).toBe("/chat/t-2");
  expect(scroller.scrollTop).toBe(480);

  act(() => screen.getByText("go-admin").click());
  expect(window.location.pathname).toBe("/admin/groups");
  expect(scroller.scrollTop).toBe(0);
  delete (scroller as { scrollTop?: number }).scrollTop;
});
