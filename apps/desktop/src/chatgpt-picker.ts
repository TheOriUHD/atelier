/**
 * Drives ChatGPT's model picker from inside the page: the "Thinking effort" pill in the composer opens a menu with the
 * model's name and a "Power" slider whose stops are Instant, Medium, High and (on the higher plans) Extra High and Pro,
 * and the model list behind the name. The slider is a keyboard control that says where it is in a status line ("6 High,
 * 3 of 5."), which is what is read and what the arrow keys move. The window stays hidden, where real mouse and key events
 * do not arrive, so the pointer and key events are sent to the page's own elements (checked on chatgpt.com).
 *
 * Like the Markdown converter this is a string that runs in the page. It avoids template literals.
 */
export const PICKER_SCRIPT = String.raw`
const picker = (() => {
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const mouse = (type) => ({ bubbles: true, cancelable: true, button: 0, buttons: type === 'pointerdown' || type === 'mousedown' ? 1 : 0 });
  const tap = (element) => {
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const init = mouse(type);
      element.dispatchEvent(type.startsWith('pointer') ? new PointerEvent(type, { ...init, pointerType: 'mouse', isPrimary: true, pointerId: 1 }) : new MouseEvent(type, init));
    }
  };
  const key = (name) => (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: name, code: name, bubbles: true, cancelable: true }));
  const until = async (test, ms = 4000) => {
    const end = Date.now() + ms;
    for (;;) {
      const value = test();
      if (value) return value;
      if (Date.now() > end) return null;
      await sleep(60);
    }
  };

  const pill = () => document.querySelector('button[aria-label="Select ChatGPT model"]');
  const menu = () => document.querySelector('[role="menu"]');
  const reading = () => {
    const text = ((menu() && menu().querySelector('[role="status"]')) || { textContent: '' }).textContent.trim();
    const match = /^(\S+) (.+), (\d+) of (\d+)\.?(.*)$/.exec(text);
    return match ? { short: match[1], label: match[2], index: Number(match[3]), count: Number(match[4]), locked: /locked/i.test(match[5]) } : null;
  };
  const radios = () => [...(menu() ? menu().querySelectorAll('[role="menuitemradio"]') : [])];
  const current = () => { const on = radios().find((radio) => radio.getAttribute('aria-checked') === 'true'); return on ? on.textContent.trim() : ''; };

  const open = async () => {
    if (!menu()) {
      const button = pill();
      if (!button) return false;
      tap(button);
    }
    return !!(await until(() => menu() && reading()));
  };
  const close = async () => {
    if (menu()) { key('Escape'); await until(() => !menu(), 2000); }
  };

  const chooseModel = async (name) => {
    if (current() === name) return true;
    const row = menu() && menu().querySelector('[role="menuitem"][aria-label="Select model"]');
    if (!row) return false;
    tap(row);
    await sleep(250);
    const target = radios().find((radio) => radio.textContent.trim() === name);
    if (!target) return false;
    tap(target);
    return !!(await until(() => current() === name && reading()));
  };

  // Moves the slider to a stop by its place; true when it stands there.
  const moveTo = async (index) => {
    for (let step = 0; step < 12; step++) {
      const now = reading();
      if (!now) return false;
      if (now.index === index) return true;
      const power = menu().querySelector('[role="menuitem"][aria-label="Power"]');
      if (!power) return false;
      power.focus();
      key(now.index < index ? 'ArrowRight' : 'ArrowLeft');
      if (!(await until(() => { const after = reading(); return after && after.index !== now.index; }, 1500))) return false;
    }
    return false;
  };

  return {
    /** Sets the model (by its name in the list) and the stop (by its place and name); the menu is closed afterwards. */
    async apply(name, index, label) {
      if (!(await open())) return 'missing';
      try {
        if (name && !(await chooseModel(name))) return 'model:' + name;
        if (index) {
          if (!(await moveTo(index))) return 'stop:' + label;
          const now = reading();
          if (!now || now.label.toLowerCase() !== String(label).toLowerCase()) return 'stop:' + label + ' (the page shows ' + (now ? now.label : 'nothing') + ')';
          if (now.locked) return 'locked:' + label;
        }
        return 'ok';
      } finally {
        await close();
      }
    },
    /** The models the account lists, each with its stops (and whether a stop is locked); the selection is put back. */
    async scan() {
      if (!(await open())) return null;
      try {
        const names = radios().map((radio) => radio.textContent.trim()).filter(Boolean);
        const start = { name: current(), index: (reading() || {}).index };
        const models = [];
        for (const name of names) {
          if (!(await chooseModel(name))) continue;
          if (!(await moveTo(1))) continue;
          const stops = [];
          for (let guard = 0; guard < 12; guard++) {
            const now = reading();
            if (!now) break;
            stops.push({ label: now.label, locked: now.locked });
            if (now.index >= now.count) break;
            if (!(await moveTo(now.index + 1))) break;
          }
          models.push({ name, short: (reading() || {}).short || name, stops });
        }
        if (start.name) await chooseModel(start.name);
        if (start.index) await moveTo(start.index);
        return models;
      } finally {
        await close();
      }
    },
  };
})();
`;
