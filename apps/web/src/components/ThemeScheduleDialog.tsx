import { createPortal } from "react-dom";
import { Clock3, Moon, Sun, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { useModalFocus } from "../lib/useModalFocus";
import { validThemeSchedule, type ThemeSchedule } from "../lib/useThemeSchedule";
import { Toggle } from "./Primitives";

export function ThemeScheduleDialog({ schedule, onSave, onClose }: {
  schedule: ThemeSchedule;
  onSave: (schedule: ThemeSchedule) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(schedule);
  const ref = useRef<HTMLElement>(null);
  const titleId = useId();
  useModalFocus(ref, true, onClose);
  const valid = validThemeSchedule(draft);
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <section ref={ref} className="modal theme-schedule-modal" role="dialog" aria-modal="true"
        aria-labelledby={titleId} tabIndex={-1} onClick={(event) => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-icon"><Clock3 size={20} /></span>
          <div><h2 id={titleId}>Theme schedule</h2><p>A little lighter by day. A little darker at night.</p></div>
          <button type="button" className="icon-button" aria-label="Close theme schedule" onClick={onClose}><X size={17} /></button>
        </div>
        <form onSubmit={(event) => { event.preventDefault(); if (valid) { onSave(draft); onClose(); } }}>
          <div className="theme-schedule-enabled"><span>Switch automatically</span>
            <Toggle label="Switch automatically" checked={draft.enabled} onChange={(enabled) => setDraft({ ...draft, enabled })} />
          </div>
          <div className="theme-schedule-times">
            <label><span><Sun size={16} /> Light mode at</span><input type="time" required value={draft.light}
              onChange={(event) => setDraft({ ...draft, light: event.target.value })} /></label>
            <label><span><Moon size={16} /> Dark mode at</span><input type="time" required value={draft.dark}
              onChange={(event) => setDraft({ ...draft, dark: event.target.value })} /></label>
          </div>
          {!valid && <p className="composer-error" role="alert">Choose two different times.</p>}
          <p className="theme-schedule-hint">Uses this device’s local time, every day. Saved in this browser. You can still switch manually until the next scheduled change.</p>
          <div className="theme-schedule-actions">
            <button className="secondary-button" type="button" onClick={onClose}>Cancel</button>
            <button className="primary-button" type="submit" disabled={!valid}>Save schedule</button>
          </div>
        </form>
      </section>
    </div>, document.body
  );
}
