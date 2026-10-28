/** What the deck blade shows: the layout gallery (add a slide or change the
 * current one) and the picture panel for a slide's picture. Both are
 * presentational; the workspace owns the deck, every action, and the slide
 * miniatures (drawn in the deck's own theme). */

import {
  useLayoutEffect,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import { Globe2, Image as ImageIcon, Sparkles, Trash2, Upload } from "lucide-react";
import { DECK_PREVIEW_WIDTH_PX } from "../lib/deck/deckGeometry";
import {
  DECK_LAYOUT_LABELS,
  DECK_PICTURE_LAYOUTS,
  SUPPORTED_DECK_LAYOUTS,
  type DeckSlideLayout,
} from "../lib/deck/deckModel";

/** Layout groups, in the order the gallery lists them. */
export const DECK_LAYOUT_GROUPS: Array<{ name: string; layouts: DeckSlideLayout[] }> = [
  { name: "Openers", layouts: ["title", "section"] },
  { name: "Content", layouts: ["title-bullets", "two-column"] },
  { name: "Pictures", layouts: ["image-bullets", "image-caption"] },
  { name: "Highlights", layouts: ["statement", "big-number", "quote", "closing"] },
];

/** What each layout is for, shown as the gallery's tooltips. */
export const DECK_LAYOUT_DESCRIPTIONS: Record<DeckSlideLayout, string> = {
  title: "A cover slide: the deck's title and a subtitle.",
  section: "A divider that opens a new part of the deck.",
  "title-bullets": "A title with a bulleted list, for most content slides.",
  "two-column": "A title over two bulleted columns, for comparisons.",
  "image-caption": "A title, a large picture, and a caption under it.",
  quote: "One quotation with its attribution.",
  chart: "A title over a chart.",
  closing: "A closing message: next steps, thanks, or questions.",
  statement: "One big idea in large type, with a supporting line.",
  "big-number": "A single figure, large, with what it measures.",
  "image-bullets": "A picture beside a title and bullets.",
};

/** Scales every live slide miniature in `root` to its card's width. */
function useMiniatureScale() {
  const ref = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const root = ref.current;
    if (!root) return undefined;
    const apply = () => {
      const preview = root.querySelector<HTMLElement>(".deck-layout-option-preview");
      const width = preview?.clientWidth ?? 0;
      if (width > 0) root.style.setProperty("--deck-option-scale", String(width / DECK_PREVIEW_WIDTH_PX));
    };
    apply();
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(apply);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);
  return ref;
}

/** Arrow keys move between menu items by where they sit on screen, so the
 * gallery's grid navigates like a grid. */
function moveInMenu(event: ReactKeyboardEvent<HTMLElement>) {
  const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft", "Home", "End"];
  if (!keys.includes(event.key)) return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>("[role='menuitem']:not(:disabled)"));
  if (!items.length) return;
  event.preventDefault();
  const current = items.indexOf(document.activeElement as HTMLElement);
  let next = current < 0 ? 0 : current;
  if (event.key === "Home") next = 0;
  else if (event.key === "End") next = items.length - 1;
  else if (event.key === "ArrowRight") next = Math.min(items.length - 1, next + 1);
  else if (event.key === "ArrowLeft") next = Math.max(0, next - 1);
  else if (current >= 0) {
    const from = items[current].getBoundingClientRect();
    const down = event.key === "ArrowDown";
    let best = -1;
    let bestScore = Infinity;
    items.forEach((item, index) => {
      const rect = item.getBoundingClientRect();
      const dy = down ? rect.top - from.bottom : from.top - rect.bottom;
      if (dy < -1) return;
      const score = dy * 4 + Math.abs(rect.left - from.left);
      if (score < bestScore) {
        bestScore = score;
        best = index;
      }
    });
    // No measurable layout (tests): fall back to list order.
    next = best >= 0 && best !== current ? best : down ? Math.min(items.length - 1, current + 1) : Math.max(0, current - 1);
  }
  items[next].focus();
  items[next].scrollIntoView?.({ block: "nearest" });
}

type LayoutOptionProps = {
  layout: DeckSlideLayout;
  current: boolean;
  tooltip: string;
  renderPreview: (layout: DeckSlideLayout) => ReactNode;
  onPick: (layout: DeckSlideLayout) => void;
};

function LayoutOption({ layout, current, tooltip, renderPreview, onPick }: LayoutOptionProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className="deck-layout-option"
      aria-current={current}
      data-tooltip={tooltip}
      onClick={() => onPick(layout)}
    >
      <span className="deck-layout-option-preview" aria-hidden="true">
        <span className="deck-thumb-scale">{renderPreview(layout)}</span>
      </span>
      <span className="deck-layout-option-label">{DECK_LAYOUT_LABELS[layout]}</span>
    </button>
  );
}

type GalleryProps = {
  mode: "add" | "switch";
  currentLayout: DeckSlideLayout | null;
  /** A miniature of a layout in the deck's theme. */
  renderPreview: (layout: DeckSlideLayout) => ReactNode;
  onPick: (layout: DeckSlideLayout) => void;
};

/** Every layout as a live miniature in the deck's theme, grouped, with jump
 * chips to each group. */
export function DeckLayoutGallery({ mode, currentLayout, renderPreview, onPick }: GalleryProps) {
  const ref = useMiniatureScale();
  const groups = DECK_LAYOUT_GROUPS.map((group) => ({
    ...group,
    layouts: group.layouts.filter((layout) => SUPPORTED_DECK_LAYOUTS.includes(layout)),
  })).filter((group) => group.layouts.length);

  function jumpTo(name: string) {
    const target = ref.current?.querySelector<HTMLElement>(`[data-gallery-group="${name}"]`);
    target?.scrollIntoView?.({ block: "start", behavior: "smooth" });
    target?.querySelector<HTMLElement>("[role='menuitem']")?.focus({ preventScroll: true });
  }

  return (
    <div className="deck-layout-gallery-panel" ref={ref}>
      <nav className="deck-blade-jumps" aria-label="Layout groups">
        {groups.map((group) => (
          <button key={group.name} type="button" onClick={() => jumpTo(group.name)}>
            {group.name}
          </button>
        ))}
      </nav>
      <div
        className="deck-layout-menu"
        role="menu"
        aria-label={mode === "add" ? "Add a slide" : "Switch this slide's layout"}
        onKeyDown={moveInMenu}
      >
        {groups.map((group) => (
          <div
            className="deck-layout-menu-group"
            role="group"
            aria-label={`${group.name} layouts`}
            key={group.name}
            data-gallery-group={group.name}
          >
            <span className="deck-layout-menu-heading">{group.name}</span>
            {group.layouts.map((layout) => (
              <LayoutOption
                key={layout}
                layout={layout}
                current={mode === "switch" && currentLayout === layout}
                tooltip={DECK_LAYOUT_DESCRIPTIONS[layout]}
                renderPreview={renderPreview}
                onPick={onPick}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

export type DeckWebImageChoice = { url: string; caption: string; source: string };

export type DeckPictureView = {
  label: string;
  /** Picture box on the 960×540 slide. */
  w: number;
  h: number;
  src: string;
  alt: string;
};

type PictureProps = {
  /** The slide's picture, or null when its layout holds none. */
  picture: DeckPictureView | null;
  prompt: string;
  onPromptChange: (value: string) => void;
  working: false | "upload" | "web" | "generate";
  error: string | null;
  webResults: DeckWebImageChoice[] | null;
  onUpload: () => void;
  onDropFile: (file: File) => void;
  onFindWeb: () => void;
  onPickWeb: (choice: DeckWebImageChoice) => void;
  /** Null when generation is available; otherwise why it is not. */
  generateUnavailable: string | null;
  generatorName: string | null;
  onAltFocus: () => void;
  onAltChange: (alt: string) => void;
  onAltBlur: () => void;
  onRemove: () => void;
  /** Shown instead of the tools when the slide's layout holds no picture. */
  noPlaceholder: null | {
    reason: string;
    renderPreview: (layout: DeckSlideLayout) => ReactNode;
    onSwitch: (layout: DeckSlideLayout) => void;
  };
};

/** One slide's picture: see what is in it, and fill it from this device, the
 * web, or an image model. */
export function DeckPicturePanel({
  picture,
  prompt,
  onPromptChange,
  working,
  error,
  webResults,
  onUpload,
  onDropFile,
  onFindWeb,
  onPickWeb,
  generateUnavailable,
  generatorName,
  onAltFocus,
  onAltChange,
  onAltBlur,
  onRemove,
  noPlaceholder,
}: PictureProps) {
  const gallery = useMiniatureScale();
  const [dragOver, setDragOver] = useState(false);

  if (noPlaceholder || !picture) {
    return (
      <div className="deck-picture-panel">
        {noPlaceholder && (
          <>
            <p className="deck-blade-note">{noPlaceholder.reason}</p>
            <div className="deck-layout-gallery-panel" ref={gallery}>
              <div className="deck-layout-menu" role="menu" aria-label="Layouts with a picture" onKeyDown={moveInMenu}>
                <div className="deck-layout-menu-group" role="group" aria-label="Layouts with a picture">
                  <span className="deck-layout-menu-heading">Switch to a layout with a picture</span>
                  {DECK_PICTURE_LAYOUTS.map((layout) => (
                    <LayoutOption
                      key={layout}
                      layout={layout}
                      current={false}
                      tooltip={`${DECK_LAYOUT_DESCRIPTIONS[layout]} Your text moves with the slide.`}
                      renderPreview={noPlaceholder.renderPreview}
                      onPick={noPlaceholder.onSwitch}
                    />
                  ))}
                </div>
              </div>
            </div>
          </>
        )}
      </div>
    );
  }

  const busy = Boolean(working);
  // The preview keeps the picture box's own shape, within the blade.
  const ratio = Math.max(0.4, Math.min(2.4, picture.w / Math.max(1, picture.h)));

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragOver(false);
    const file = Array.from(event.dataTransfer?.files ?? []).find((item) => item.type.startsWith("image/"));
    if (file && !busy) onDropFile(file);
  }

  return (
    <div className="deck-picture-panel">
      <div
        className={`deck-picture-drop ${dragOver ? "is-over" : ""} ${picture.src ? "has-image" : ""}`}
        style={{ aspectRatio: String(ratio), width: `min(100%, ${Math.round(210 * ratio)}px)` }}
        onDragOver={(event) => {
          if (busy) return;
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
      >
        {picture.src ? (
          <img src={picture.src} alt={picture.alt} />
        ) : (
          <span className="deck-picture-drop-empty">
            <ImageIcon size={22} aria-hidden="true" />
            <span>{dragOver ? "Drop to place it" : `Drop a picture for ${picture.label.toLowerCase()} here`}</span>
          </span>
        )}
      </div>
      <button
        type="button"
        className="deck-image-upload"
        data-blade-initial=""
        data-tooltip="Choose a PNG, JPEG, WebP, or GIF from this device"
        disabled={busy}
        onClick={onUpload}
      >
        <Upload size={14} />
        {working === "upload" ? "Reading picture…" : picture.src ? "Replace from this device" : "Upload from this device"}
      </button>
      <section className="deck-blade-section" aria-label="Find or generate a picture">
        <label className="deck-blade-field">
          <span>Or describe the picture</span>
          <input
            type="text"
            aria-label="Picture description"
            value={prompt}
            disabled={busy}
            placeholder="Boston skyline at dusk"
            onChange={(event) => onPromptChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                event.preventDefault();
                if (prompt.trim() && !busy) onFindWeb();
              }
            }}
          />
        </label>
        <div className="deck-blade-actions">
          <button
            type="button"
            data-tooltip="Search the web for pictures matching this description"
            disabled={busy || !prompt.trim()}
            onClick={onFindWeb}
          >
            <Globe2 size={14} />
            {working === "web" ? "Searching…" : "Find web images"}
          </button>
          <button
            type="submit"
            data-tooltip={generateUnavailable ?? `Generate a picture with ${generatorName ?? "the image model"}`}
            disabled={busy || !prompt.trim() || Boolean(generateUnavailable)}
          >
            <Sparkles size={14} />
            {working === "generate" ? "Generating…" : "Generate AI picture"}
          </button>
        </div>
        {generateUnavailable && <p className="deck-blade-hint">{generateUnavailable}</p>}
        {error && (
          <p className="document-link-error" role="alert">
            {error}
          </p>
        )}
        {webResults && webResults.length > 0 && (
          <div className="deck-web-results" role="group" aria-label="Web image results">
            {webResults.map((result) => (
              <button
                key={result.url}
                type="button"
                className="deck-web-result"
                aria-label={`Use ${result.caption}`}
                data-tooltip={`${result.caption} · ${result.source}`}
                disabled={busy}
                onClick={() => onPickWeb(result)}
              >
                <img src={result.url} alt="" loading="lazy" />
                <span>{result.caption}</span>
              </button>
            ))}
          </div>
        )}
      </section>
      {picture.src && (
        <section className="deck-blade-section" aria-label="This picture">
          <label className="deck-blade-field">
            <span>Alt text</span>
            <input
              type="text"
              aria-label="Picture alt text"
              value={picture.alt}
              placeholder="Describe the picture for screen readers"
              disabled={busy}
              onFocus={onAltFocus}
              onChange={(event) => onAltChange(event.target.value)}
              onBlur={onAltBlur}
            />
          </label>
          <p className="deck-blade-hint">Read aloud by screen readers and kept in the PowerPoint export.</p>
          <button type="button" className="deck-blade-danger" disabled={busy} onClick={onRemove}>
            <Trash2 size={14} />
            Remove picture
          </button>
        </section>
      )}
    </div>
  );
}

