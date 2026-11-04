/**
 * Where a caret belongs after someone else's edit replaced the editor's text:
 * text added or removed before it moves it, text after it does not. Pairs
 * with caretTextOffset / placeCaretAtTextOffset in editorRanges.ts.
 */
export function shiftedCaretOffset(offset: number, oldText: string, newText: string): number {
  let prefix = 0;
  const shortest = Math.min(oldText.length, newText.length);
  while (prefix < shortest && oldText[prefix] === newText[prefix]) prefix += 1;
  if (offset <= prefix) return offset;
  let suffix = 0;
  while (suffix < shortest - prefix && oldText[oldText.length - 1 - suffix] === newText[newText.length - 1 - suffix]) {
    suffix += 1;
  }
  if (offset >= oldText.length - suffix) return Math.max(prefix, offset + newText.length - oldText.length);
  // Inside the text that changed: the end of its replacement.
  return newText.length - suffix;
}
