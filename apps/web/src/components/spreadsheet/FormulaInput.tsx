import clsx from "clsx";
import { type CSSProperties, type KeyboardEvent, forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  activeFunctionCall,
  formulaSegments,
  functionPrefixAt,
  signatureParts,
  suggestFunctions,
  toggleAbsoluteAt,
} from "../../lib/sheet/formulaEditing";

export type CommitDirection = "down" | "up" | "right" | "left" | "none" | "fill";

export type FormulaInputHandle = {
  focus: () => void;
  caret: () => number;
  /** Replaces text in [start, end) and puts the caret after it. */
  replaceRange: (start: number, end: number, text: string) => void;
  element: () => HTMLTextAreaElement | null;
};

type Props = {
  value: string;
  onChange: (value: string, caret: number) => void;
  onCommit: (direction: CommitDirection) => void;
  onCancel: () => void;
  onCaretChange?: (caret: number) => void;
  className?: string;
  ariaLabel: string;
  autoFocus?: boolean;
  /** Formula bar grows to show several lines; the cell editor grows sideways. */
  variant: "bar" | "cell";
  style?: CSSProperties;
  placeholder?: string;
  disabled?: boolean;
  /** Arrow keys commit and move (Excel's "Enter" mode for freshly typed cells). */
  arrowsCommit?: boolean;
};

/** A text input that colours each formula reference the way Excel does and
 * offers function names and argument hints as you type. A transparent
 * textarea sits over a mirror that draws the coloured text. */
export const FormulaInput = forwardRef<FormulaInputHandle, Props>(function FormulaInput(props, ref) {
  const { value, onChange, onCommit, onCancel, onCaretChange, variant, arrowsCommit } = props;
  const textarea = useRef<HTMLTextAreaElement>(null);
  const mirror = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(value.length);
  const [suggestIndex, setSuggestIndex] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const segments = useMemo(() => formulaSegments(value), [value]);
  const prefix = functionPrefixAt(value, caret);
  const suggestions = prefix && dismissed !== `${prefix.start}:${prefix.prefix}` ? suggestFunctions(prefix.prefix) : [];
  const call = suggestions.length ? null : activeFunctionCall(value, caret);

  useImperativeHandle(ref, () => ({
    focus: () => textarea.current?.focus(),
    caret: () => textarea.current?.selectionStart ?? value.length,
    replaceRange: (start, end, text) => {
      const next = value.slice(0, start) + text + value.slice(end);
      const position = start + text.length;
      onChange(next, position);
      requestAnimationFrame(() => {
        const node = textarea.current;
        if (!node) return;
        node.focus();
        node.setSelectionRange(position, position);
        setCaret(position);
      });
    },
    element: () => textarea.current,
  }), [value, onChange]);

  useEffect(() => {
    if (props.autoFocus) {
      const node = textarea.current;
      node?.focus();
      node?.setSelectionRange(node.value.length, node.value.length);
    }
  }, [props.autoFocus]);

  useEffect(() => setSuggestIndex(0), [prefix?.prefix]);

  useLayoutEffect(() => {
    const node = textarea.current;
    if (!node) return;
    if (variant === "cell") {
      node.style.width = "0px";
      node.style.width = `${Math.min(640, Math.max(node.scrollWidth + 4, 40))}px`;
    }
    node.style.height = "0px";
    node.style.height = `${node.scrollHeight}px`;
    if (mirror.current) mirror.current.scrollTop = node.scrollTop;
  }, [value, variant]);

  const reportCaret = () => {
    const position = textarea.current?.selectionStart ?? value.length;
    setCaret(position);
    onCaretChange?.(position);
  };

  const accept = (name: string) => {
    if (!prefix) return;
    const after = value.slice(caret);
    const insert = after.startsWith("(") ? name : `${name}(`;
    const next = value.slice(0, prefix.start) + insert + after;
    const position = prefix.start + insert.length;
    onChange(next, position);
    requestAnimationFrame(() => {
      textarea.current?.setSelectionRange(position, position);
      setCaret(position);
    });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (suggestions.length) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setSuggestIndex((index) => (index + (event.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if (event.key === "Tab" || (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey && suggestions[suggestIndex].name !== prefix?.prefix.toUpperCase())) {
        event.preventDefault();
        accept(suggestions[suggestIndex].name);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissed(`${prefix!.start}:${prefix!.prefix}`);
        return;
      }
    }
    if (event.key === "Enter" && (event.altKey || (variant === "bar" && event.shiftKey && event.altKey))) {
      event.preventDefault();
      const node = event.currentTarget;
      const start = node.selectionStart;
      const next = `${value.slice(0, start)}\n${value.slice(node.selectionEnd)}`;
      onChange(next, start + 1);
      requestAnimationFrame(() => node.setSelectionRange(start + 1, start + 1));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      onCommit(event.metaKey || event.ctrlKey ? "fill" : event.shiftKey ? "up" : "down");
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      onCommit(event.shiftKey ? "left" : "right");
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      onCancel();
      return;
    }
    if (event.key === "F4") {
      event.preventDefault();
      const toggled = toggleAbsoluteAt(value, event.currentTarget.selectionStart);
      onChange(toggled.text, toggled.caret);
      const node = event.currentTarget;
      requestAnimationFrame(() => node.setSelectionRange(toggled.caret, toggled.caret));
      return;
    }
    if (arrowsCommit && !value.startsWith("=") && ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key) && !event.shiftKey) {
      event.preventDefault();
      onCommit(event.key === "ArrowUp" ? "up" : event.key === "ArrowDown" ? "down" : event.key === "ArrowLeft" ? "left" : "right");
    }
    event.stopPropagation();
  };

  return (
    <div className={clsx("sheet-formula-input", `is-${variant}`, props.className)} style={props.style}>
      <div ref={mirror} className="sheet-formula-mirror" aria-hidden="true">
        {segments.map((segment, index) => (
          <span key={index} style={segment.color ? { color: segment.color } : undefined}>{segment.text}</span>
        ))}
        {"​"}
      </div>
      <textarea
        ref={textarea}
        value={value}
        rows={1}
        spellCheck={false}
        autoComplete="off"
        autoCapitalize="off"
        aria-label={props.ariaLabel}
        aria-autocomplete="list"
        aria-expanded={suggestions.length > 0}
        placeholder={props.placeholder}
        disabled={props.disabled}
        onChange={(event) => {
          onChange(event.target.value, event.target.selectionStart);
          setCaret(event.target.selectionStart);
        }}
        onKeyDown={onKeyDown}
        onKeyUp={reportCaret}
        onClick={reportCaret}
        onSelect={reportCaret}
        onScroll={(event) => { if (mirror.current) mirror.current.scrollTop = event.currentTarget.scrollTop; }}
      />
      {suggestions.length > 0 && (
        <ul className="sheet-function-suggestions" role="listbox" aria-label="Functions">
          {suggestions.map((item, index) => (
            <li
              key={item.name}
              role="option"
              aria-selected={index === suggestIndex}
              className={clsx(index === suggestIndex && "is-active")}
              onPointerDown={(event) => { event.preventDefault(); accept(item.name); }}
            >
              <strong>{item.name}</strong>
              <span>{item.spec.description}</span>
            </li>
          ))}
        </ul>
      )}
      {call && (
        <div className="sheet-function-hint" role="note">
          <strong>{call.name}</strong>(
          {signatureParts(call.spec.signature).map((part, index, parts) => (
            <span key={index} className={clsx(index === Math.min(call.argIndex, parts.length - 1) && "is-current")}>
              {part}{index < parts.length - 1 ? ", " : ""}
            </span>
          ))}
          )
        </div>
      )}
    </div>
  );
});
