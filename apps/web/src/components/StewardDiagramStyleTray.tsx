import { Check, RotateCcw } from "lucide-react";
import type { KeyboardEvent } from "react";
import { STEWARD_DIAGRAM_THEMES, stewardDiagramPalette, type StewardDiagramThemeId } from "../lib/diagramThemes";
import type { StewardDiagramConnector, StewardDiagramCorners, StewardDiagramModel } from "../lib/stewardDiagram";
import { resetStewardLayout, stewardHasManualLayout, withStewardChartStyle } from "../lib/stewardDiagramEdits";
import { RailSwitch } from "./RailSwitch";

const CONNECTORS: Array<{ value: StewardDiagramConnector; label: string; tooltip: string }> = [
  { value: "elbow", label: "Elbow", tooltip: "Right-angle arrows with soft corners" },
  { value: "curved", label: "Curved", tooltip: "Smooth curved arrows" },
  { value: "straight", label: "Straight", tooltip: "Direct lines between boxes" },
];

const CORNERS: Array<{ value: StewardDiagramCorners; label: string; tooltip: string }> = [
  { value: "rounded", label: "Rounded", tooltip: "Rounded box corners" },
  { value: "square", label: "Square", tooltip: "Crisp, squared box corners" },
];

/** A tiny card in the theme's colors: header band, body, an arrow. */
function ThemeSample({ theme, dark }: { theme: StewardDiagramThemeId; dark: boolean }) {
  const palette = stewardDiagramPalette(theme, dark);
  return (
    <svg viewBox="0 0 64 38" aria-hidden="true" className="sdc-theme-sample">
      <rect x="0.5" y="0.5" width="63" height="37" rx="6" fill={palette.canvas} stroke={palette.node.border} />
      <rect x="6" y="6" width="30" height="26" rx="4" fill={dark ? palette.node.fill : palette.canvas} stroke={palette.node.border} />
      <path d="M6 10a4 4 0 0 1 4-4h22a4 4 0 0 1 4 4v3H6z" fill={palette.ink} />
      <circle cx="11" cy="20" r="1.6" fill={palette.series[0]} />
      <rect x="15" y="19" width="15" height="2" rx="1" fill={palette.muted} opacity="0.5" />
      <rect x="15" y="25" width="11" height="2" rx="1" fill={palette.muted} opacity="0.5" />
      <path d="M36 19 H48 V30 H54" fill="none" stroke={palette.edgeStrong} strokeWidth="1.6" strokeLinecap="round" />
      <path d="M53 27.5 L57 30 L53 32.5 z" fill={palette.edgeStrong} />
    </svg>
  );
}

/** Theme swatches as a radio group; arrow keys walk the themes. */
function ThemePicker({
  current,
  dark,
  onPick,
}: {
  current: StewardDiagramThemeId;
  dark: boolean;
  onPick: (theme: StewardDiagramThemeId) => void;
}) {
  const index = Math.max(0, STEWARD_DIAGRAM_THEMES.findIndex((theme) => theme.id === current));

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const step = THEME_KEY_STEPS[event.key];
    if (!step) return;
    event.preventDefault();
    const next = (index + step + STEWARD_DIAGRAM_THEMES.length) % STEWARD_DIAGRAM_THEMES.length;
    onPick(STEWARD_DIAGRAM_THEMES[next]!.id);
    event.currentTarget.querySelectorAll<HTMLButtonElement>("button")[next]?.focus();
  }

  return (
    <div className="sdc-theme-grid" role="radiogroup" aria-label="Diagram theme" onKeyDown={onKeyDown}>
      {STEWARD_DIAGRAM_THEMES.map((theme) => {
        const selected = theme.id === current;
        return (
          <button
            key={theme.id}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            className={`sdc-theme${selected ? " is-active" : ""}`}
            data-tooltip={`${theme.name} theme`}
            onClick={() => onPick(theme.id)}
          >
            <ThemeSample theme={theme.id} dark={dark} />
            <span>
              {selected && <Check size={11} aria-hidden="true" />}
              {theme.name}
            </span>
          </button>
        );
      })}
    </div>
  );
}

const THEME_KEY_STEPS: Record<string, number> = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };

/** Chart-wide styling, opened from the diagram toolbar: theme, connector
 * shape, corner style, and a reset for dragged boxes and bent arrows.
 * Every choice applies and saves immediately. */
export function StewardDiagramStyleTray({
  model,
  dark,
  onChange,
}: {
  model: StewardDiagramModel;
  dark: boolean;
  onChange: (next: StewardDiagramModel) => void;
}) {
  const current = model.theme ?? "aperture";
  return (
    <div className="sdc-style-tray" role="group" aria-label="Diagram style">
      <div className="sdc-style-section">
        <span className="sdc-style-label">Theme</span>
        <ThemePicker
          current={current}
          dark={dark}
          onPick={(theme) => {
            if (theme !== current) onChange(withStewardChartStyle(model, { theme }));
          }}
        />
      </div>
      <div className="sdc-style-controls">
        <div className="sdc-style-section">
          <span className="sdc-style-label">Connectors</span>
          <RailSwitch
            ariaLabel="Connector style"
            options={CONNECTORS}
            value={model.connector ?? "elbow"}
            onChange={(connector) => onChange(withStewardChartStyle(model, { connector }))}
          />
        </div>
        <div className="sdc-style-section">
          <span className="sdc-style-label">Corners</span>
          <RailSwitch
            ariaLabel="Corner style"
            options={CORNERS}
            value={model.corners ?? "rounded"}
            onChange={(corners) => onChange(withStewardChartStyle(model, { corners }))}
          />
        </div>
        <button
          type="button"
          className="secondary-button compact sdc-reset-layout"
          disabled={!stewardHasManualLayout(model)}
          data-tooltip="Put every dragged box back in its row and straighten bent arrows"
          onClick={() => onChange(resetStewardLayout(model))}
        >
          <RotateCcw size={13} />
          Reset layout
        </button>
      </div>
    </div>
  );
}
