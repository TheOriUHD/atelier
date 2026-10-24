/**
 * Focus rings show only while the person moves through the app with Tab. Browsers also light one after any other key
 * (a shortcut, the keys of a screenshot) or a click in a text field, which left a blue frame on whatever had focus.
 * A Tab press sets `data-focus="tab"` on the root until the next click or touch; without it `--at-shadow-focus` is
 * nothing (styles.css), and every focus ring is drawn with that shadow.
 */
export function trackTabFocus(doc: Document = document): () => void {
  const root = doc.documentElement;
  const onKey = (e: KeyboardEvent) => {
    // Ctrl+Tab and ⌘Tab switch tabs or apps; Shift+Tab goes back.
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) root.dataset.focus = 'tab';
  };
  const onPointer = () => {
    delete root.dataset.focus;
  };
  doc.addEventListener('keydown', onKey, true);
  doc.addEventListener('pointerdown', onPointer, true);
  return () => {
    doc.removeEventListener('keydown', onKey, true);
    doc.removeEventListener('pointerdown', onPointer, true);
  };
}
