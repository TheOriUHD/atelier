// Input inside the page, for a browser whose extensions have no debugger (Firefox): functions run in the page with
// scripting.executeScript, so each must be self-contained (no imports, no closures over this module, only its arguments).
//
// Events made by a script are "untrusted": the page's own listeners get them (React, Vue and plain handlers alike), but the
// browser does nothing by itself for them, so the default actions a person's click or key would have (following a link,
// ticking a box, submitting a form, typing, moving the focus, scrolling) are done here as well. Typing goes through the
// browser's own edit command, which the page sees as real typing.

/** A chord as pagePress takes it (keys.ts `Chord`, the modifier bits spelled out). */
export interface PageChord {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
  alt: boolean;
  ctrl: boolean;
  meta: boolean;
  shift: boolean;
}

/**
 * Clicks like a person: pointer and mouse events where the click lands, the focus, then the element's own click (which
 * follows a link, ticks a box, opens a menu or submits a form). By ref (scrolled into view first) or at a point in the
 * viewport. Where it clicked, or null when there is nothing there.
 */
export function pageClick(target: { ref?: number; x?: number; y?: number; count: number }): { x: number; y: number } | null {
  const deepest = (px: number, py: number): Element | null => {
    let found = document.elementFromPoint(px, py);
    while (found?.shadowRoot) {
      const inner = found.shadowRoot.elementFromPoint(px, py);
      if (!inner || inner === found) break;
      found = inner;
    }
    return found;
  };
  let el: Element | null;
  let x: number;
  let y: number;
  if (target.ref !== undefined) {
    const named = document.querySelector(`[data-atelier-ref="${target.ref}"]`);
    if (!named) return null;
    named.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const box = named.getBoundingClientRect();
    x = Math.round(box.left + box.width / 2);
    y = Math.round(box.top + box.height / 2);
    // What is on top there gets the events, as for a real click (a span inside the button), unless it is something else
    // covering the element (a banner): then the element itself, which is what was asked for.
    const top = deepest(x, y);
    el = top && (named.contains(top) || top.contains(named)) ? top : named;
  } else {
    if (target.x === undefined || target.y === undefined) return null;
    x = target.x;
    y = target.y;
    el = deepest(x, y);
    if (!el) return null;
  }
  const at = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y, view: window, button: 0 };
  const pointer = (type: string, buttons: number) => el!.dispatchEvent(new PointerEvent(type, { ...at, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true }));
  const mouse = (type: string, buttons: number, detail: number) => el!.dispatchEvent(new MouseEvent(type, { ...at, buttons, detail }));
  pointer('pointerover', 0);
  mouse('mouseover', 0, 0);
  pointer('pointermove', 0);
  mouse('mousemove', 0, 0);
  const count = Math.max(1, target.count);
  for (let n = 1; n <= count; n++) {
    const down = pointer('pointerdown', 1) && mouse('mousedown', 1, n);
    // A page that cancels mousedown keeps the focus where it was, as with a real click.
    if (down) {
      const focusable = el.closest('input, textarea, select, button, a[href], summary, [tabindex], [contenteditable=""], [contenteditable="true"]') as HTMLElement | null;
      focusable?.focus({ preventScroll: true });
      // A tab in the background may not take the focus: what was clicked is where typing and keys go next.
      (window as unknown as { __atelierFocus?: Element }).__atelierFocus = focusable ?? el;
    }
    pointer('pointerup', 0);
    mouse('mouseup', 0, n);
    if (el instanceof HTMLElement) el.click();
    else mouse('click', 0, n);
  }
  if (count >= 2) mouse('dblclick', 0, 2);
  return { x, y };
}

/**
 * Types `text` where the focus is: through the browser's edit command, which the page sees as typing (beforeinput and
 * input events, its undo history), else by setting a field's value the way frameworks notice. False when the focus is not
 * in a field or an editable area.
 */
export function pageInsertText(text: string, ref: number | null = null): boolean {
  const editable = (e: Element | null | undefined): e is HTMLElement => !!e && e.isConnected && (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || (e as HTMLElement).isContentEditable);
  // The element named, else where the focus is, else what was clicked last (a background tab may not take the focus).
  const named = ref !== null ? document.querySelector(`[data-atelier-ref="${ref}"]`) : null;
  const remembered = (window as unknown as { __atelierFocus?: Element }).__atelierFocus;
  const el = [named, document.activeElement, remembered].find(editable);
  if (!el) return false;
  const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
  if (document.activeElement !== el) el.focus({ preventScroll: true });
  const before = field ? field.value : el.textContent;
  // A line break in a field is Enter, which pagePress handles: here only the text of the line.
  if (document.activeElement === el && document.execCommand('insertText', false, text) && (field ? field.value : el.textContent) !== before) return true;
  if (!field) {
    // An editable area that didn't take the focus: the text goes in at the end (or over its selection), as input.
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
    const selection = getSelection();
    const range = selection && selection.rangeCount && el.contains(selection.getRangeAt(0).commonAncestorContainer) ? selection.getRangeAt(0) : null;
    if (range) {
      range.deleteContents();
      range.insertNode(document.createTextNode(text));
      range.collapse(false);
    } else el.append(document.createTextNode(text));
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    return true;
  }
  const proto = field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
  const setValue = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  let start = field.value.length;
  let end = start;
  try {
    start = field.selectionStart ?? start;
    end = field.selectionEnd ?? end;
  } catch {
    // Fields without a selection (number, email) take the text at the end.
  }
  const next = field.value.slice(0, start) + text + field.value.slice(end);
  field.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text }));
  // The prototype's setter, not the property: React keeps its own copy of the value and only notices a change made this way.
  if (setValue) setValue.call(field, next);
  else field.value = next;
  try {
    field.setSelectionRange(start + text.length, start + text.length);
  } catch {
    // See above.
  }
  field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
  return true;
}

/**
 * Presses a key or a chord where the focus is: keydown, keypress and keyup for the page's own handlers, and, unless the page
 * cancelled the keydown, what the key does by itself: Enter submits a form, follows a link or presses a button, Space
 * presses a button or ticks a box, Tab moves the focus, Backspace and Delete delete, arrows and Page keys scroll or move
 * the cursor, Ctrl/⌘ with A, Z, Y, X and C select all, undo, redo, cut and copy. What it did, for the result.
 */
export function pagePress(chord: PageChord): string {
  // Where the focus is, else what was clicked last (a background tab may not take the focus), else the page.
  const remembered = (window as unknown as { __atelierFocus?: Element }).__atelierFocus;
  const el = (document.activeElement && document.activeElement !== document.body ? document.activeElement : remembered?.isConnected ? remembered : document.body) as HTMLElement;
  const init = {
    key: chord.key,
    code: chord.code,
    keyCode: chord.keyCode,
    which: chord.keyCode,
    altKey: chord.alt,
    ctrlKey: chord.ctrl,
    metaKey: chord.meta,
    shiftKey: chord.shift,
    bubbles: true,
    cancelable: true,
    composed: true,
  };
  const proceed = el.dispatchEvent(new KeyboardEvent('keydown', init));
  let did = proceed ? '' : 'the page handled it';
  if (proceed) {
    const field = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el : null;
    const editable = !!field || el.isContentEditable;
    const shortcut = chord.ctrl || chord.meta;
    const edit = (command: string, value?: string) => document.execCommand(command, false, value);
    // Text into the focused field: the edit command, else the value set the way frameworks notice (as pageInsertText).
    const insert = (text: string) => {
      const before = field ? field.value : el.textContent;
      if (edit('insertText', text) && (field ? field.value : el.textContent) !== before) return;
      if (!field) return;
      const setValue = Object.getOwnPropertyDescriptor(field instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype, 'value')?.set;
      let start = field.value.length;
      let end = start;
      try {
        start = field.selectionStart ?? start;
        end = field.selectionEnd ?? end;
      } catch {
        // No cursor in this kind of field: at the end.
      }
      const next = field.value.slice(0, start) + text + field.value.slice(end);
      if (setValue) setValue.call(field, next);
      else field.value = next;
      try {
        field.setSelectionRange(start + text.length, start + text.length);
      } catch {
        // See above.
      }
      field.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }));
    };
    const press = () => {
      el.click();
      did = 'pressed';
    };
    const scroll = (top: number) => {
      let box: HTMLElement | null = el === document.body ? null : el;
      while (box && !(box.scrollHeight > box.clientHeight && /(auto|scroll|overlay)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
      (box ?? window).scrollBy({ top, behavior: 'instant' });
      did = 'scrolled';
    };
    const page = Math.round(innerHeight * 0.85);
    const key = chord.key;
    const lower = key.length === 1 ? key.toLowerCase() : key;
    if (shortcut && lower === 'a') {
      if (field) field.select();
      else edit('selectAll');
      did = 'selected all';
    } else if (shortcut && (lower === 'z' || lower === 'y')) {
      edit(lower === 'z' && !chord.shift ? 'undo' : 'redo');
      did = lower === 'z' && !chord.shift ? 'undone' : 'redone';
    } else if (shortcut && (lower === 'x' || lower === 'c')) {
      edit(lower === 'x' ? 'cut' : 'copy');
      did = lower === 'x' ? 'cut' : 'copied';
    } else if (shortcut) {
      did = 'sent to the page';
    } else if (key === 'Enter') {
      if (field instanceof HTMLInputElement) {
        // A form's implicit submission: as if its submit button were pressed (its own submit handlers run).
        const form = field.form;
        if (form) {
          const submitter = form.querySelector('button:not([type]), button[type=submit], input[type=submit], input[type=image]') as HTMLElement | null;
          if (submitter) form.requestSubmit(submitter as HTMLButtonElement);
          else form.requestSubmit();
          did = 'submitted the form';
        }
      } else if (editable) {
        el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: 13 }));
        if (field) insert('\n');
        else edit('insertParagraph');
        did = 'new line';
      } else if (el.matches('a[href], button, summary, [role=button], [role=link], [role=menuitem], [role=tab], input[type=submit], input[type=button]')) press();
    } else if (key === ' ' && !editable) {
      if (el.matches('button, summary, input[type=checkbox], input[type=radio], [role=button], [role=checkbox], [role=switch], [role=menuitem], [role=tab]')) press();
      else scroll(chord.shift ? -page : page);
    } else if (key === 'Tab') {
      const order = [...document.querySelectorAll<HTMLElement>('a[href], button, input:not([type=hidden]), select, textarea, summary, [tabindex], [contenteditable=""], [contenteditable="true"]')].filter(
        (e) => e.tabIndex >= 0 && !(e as HTMLButtonElement).disabled && e.getClientRects().length > 0,
      );
      const at = order.indexOf(el);
      const next = order[(at + (chord.shift ? -1 : 1) + order.length) % order.length];
      next?.focus();
      did = 'moved the focus';
    } else if (key === 'Backspace' || key === 'Delete') {
      if (editable) {
        edit(key === 'Backspace' ? 'delete' : 'forwardDelete');
        did = 'deleted';
      }
    } else if (editable && field && ['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(key)) {
      try {
        const position = key === 'Home' ? 0 : key === 'End' ? field.value.length : Math.max(0, Math.min(field.value.length, (field.selectionStart ?? 0) + (key === 'ArrowLeft' ? -1 : 1)));
        field.setSelectionRange(position, position);
        did = 'moved the cursor';
      } catch {
        // A field without a cursor.
      }
    } else if (!editable && ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End'].includes(key)) {
      const amount = { ArrowDown: 60, ArrowUp: -60, PageDown: page, PageUp: -page, Home: -1e9, End: 1e9 }[key] ?? 0;
      scroll(amount);
    } else if (chord.text && editable) {
      el.dispatchEvent(new KeyboardEvent('keypress', { ...init, charCode: chord.text.charCodeAt(0) }));
      insert(chord.text);
      did = 'typed';
    }
  }
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return did;
}

/**
 * Scrolls by `dy` pixels where the target is (an element by ref, a point, or the page): a wheel event first, for pages that
 * scroll by themselves (maps, carousels), then the nearest scrollable box (or the page) unless the page cancelled it.
 */
export function pageScroll(target: { ref?: number; x?: number; y?: number; dy: number }): boolean {
  let el: Element | null = null;
  if (target.ref !== undefined) el = document.querySelector(`[data-atelier-ref="${target.ref}"]`);
  else if (target.x !== undefined && target.y !== undefined) el = document.elementFromPoint(target.x, target.y);
  const point = el ? el.getBoundingClientRect() : null;
  const clientX = target.x ?? (point ? point.left + point.width / 2 : innerWidth / 2);
  const clientY = target.y ?? (point ? point.top + point.height / 2 : innerHeight / 2);
  const proceed = (el ?? document.documentElement).dispatchEvent(new WheelEvent('wheel', { deltaY: target.dy, deltaMode: 0, clientX, clientY, bubbles: true, cancelable: true, composed: true }));
  if (!proceed) return true;
  let box = el as HTMLElement | null;
  while (box && box !== document.documentElement && !(box.scrollHeight > box.clientHeight && /(auto|scroll|overlay)/.test(getComputedStyle(box).overflowY))) box = box.parentElement;
  if (box && box !== document.documentElement && box !== document.body) box.scrollBy({ top: target.dy, behavior: 'instant' });
  else window.scrollBy({ top: target.dy, behavior: 'instant' });
  return true;
}

/** The viewport's size in CSS pixels, for a screenshot of what is in view. */
export function viewportSize(): { width: number; height: number } {
  return { width: innerWidth, height: innerHeight };
}
