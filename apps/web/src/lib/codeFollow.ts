import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** The vertical scroll measurements of a code block's own scroll area. */
export type ScrollMeasure = { scrollHeight: number; clientHeight: number; scrollTop: number };

/** Whether newly streamed lines pull the view down. `anchor` is the lowest
 * position seen since following last held: growth and the pin only ever move
 * the view down, so landing above it means the reader scrolled up. */
export type FollowState = { paused: boolean; anchor: number };

/** Within this distance of the bottom the reader counts as at the bottom. */
const BOTTOM_BAND = 48;
/** An upward move larger than this is the reader's intent, not rounding. */
const INTENT = 4;

function distanceToBottom(m: ScrollMeasure) {
  return m.scrollHeight - m.scrollTop - m.clientHeight;
}

/** A block that does not overflow, or already shows its last lines, follows
 * growth; a long block opened at its top (an old reply) stays put. */
export function followOnMount(m: ScrollMeasure): FollowState {
  return { paused: distanceToBottom(m) >= BOTTOM_BAND, anchor: m.scrollTop };
}

/** Reader intent, as the chat follows it: returning near the bottom resumes,
 * scrolling up above the anchor pauses. */
export function followOnScroll(state: FollowState, m: ScrollMeasure): FollowState {
  if (distanceToBottom(m) < BOTTOM_BAND) return { paused: false, anchor: m.scrollTop };
  return { paused: state.paused || m.scrollTop < state.anchor - INTENT, anchor: Math.max(state.anchor, m.scrollTop) };
}

/** Streaming only ever adds text at the end; an edit or a swapped version
 * changes earlier text and must not move the view. */
export function isAppend(previous: string, next: string) {
  return next.length > previous.length && next.startsWith(previous);
}

/** Pin only appended growth that left a gap below a following reader. */
export function shouldPin(paused: boolean, appended: boolean, m: ScrollMeasure) {
  return !paused && appended && distanceToBottom(m) > 1;
}

/** Keeps a code block's own scroll area on its last lines while `text`
 * grows by appending, the way the chat follows a streaming reply. Never
 * scrolls on mount, never touches horizontal scroll, never animates. */
export function useFollowCodeTail(ref: RefObject<HTMLElement | null>, text: string) {
  const follow = useRef<FollowState | null>(null);
  const previous = useRef(text);

  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    if (!follow.current) {
      follow.current = followOnMount(element);
      return;
    }
    const appended = isAppend(previous.current, text);
    previous.current = text;
    if (!appended) {
      // Other code took this view's place (the canvas moved to another file
      // or version): judge it afresh, as on mount, without moving it.
      follow.current = followOnMount(element);
      return;
    }
    if (!shouldPin(follow.current.paused, appended, element)) return;
    // Browsers clamp to the true bottom; vertical only, and never animated.
    element.scrollTop = element.scrollHeight;
    follow.current = { paused: false, anchor: element.scrollTop };
  }, [ref, text]);

  useEffect(() => {
    const element = ref.current;
    if (!element) return undefined;
    const onScroll = () => {
      if (follow.current) follow.current = followOnScroll(follow.current, element);
    };
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, [ref]);
}
