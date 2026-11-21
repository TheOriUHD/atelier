// The media kit: the banner color tabs, and the copy buttons. Nothing is sent anywhere.
(() => {
  const tabs = [...document.querySelectorAll('[role="tab"]')];
  const select = (tab, focus) => {
    for (const t of tabs) {
      const on = t === tab;
      t.setAttribute('aria-selected', String(on));
      t.tabIndex = on ? 0 : -1;
      const panel = document.getElementById(t.getAttribute('aria-controls'));
      if (panel) panel.hidden = !on;
    }
    if (focus) tab.focus();
  };
  if (tabs.length) {
    select(tabs[0], false);
    tabs.forEach((tab, i) => {
      tab.addEventListener('click', () => select(tab, false));
      tab.addEventListener('keydown', (e) => {
        const to = e.key === 'ArrowRight' ? tabs[(i + 1) % tabs.length] : e.key === 'ArrowLeft' ? tabs[(i + tabs.length - 1) % tabs.length] : null;
        if (to) {
          e.preventDefault();
          select(to, true);
        }
      });
    });
  }

  for (const button of document.querySelectorAll('.copy')) {
    button.addEventListener('click', async () => {
      const text = button.dataset.copy ?? document.querySelector(button.dataset.copyFrom)?.textContent ?? '';
      try {
        await navigator.clipboard.writeText(text.trim());
      } catch {
        return;
      }
      const was = button.textContent;
      button.textContent = 'Copied';
      button.classList.add('is-done');
      setTimeout(() => {
        button.textContent = was;
        button.classList.remove('is-done');
      }, 1500);
    });
  }
})();
