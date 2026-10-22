/* Small behaviors, none of them required: the page reads fine without any of this. */
(function () {
  'use strict';
  var root = document.documentElement;
  var $ = function (selector, scope) {
    return (scope || document).querySelector(selector);
  };
  var $$ = function (selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  };

  // Header gets a hairline once the page has scrolled.
  var header = $('.site-header');
  var onScroll = function () {
    header.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // Theme: follow the system until the visitor picks one, then remember it on this device.
  var themeButton = $('#theme');
  var effectiveTheme = function () {
    return (
      root.getAttribute('data-theme') || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
    );
  };
  var labelTheme = function () {
    themeButton.setAttribute(
      'aria-label',
      effectiveTheme() === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme',
    );
  };
  labelTheme();
  themeButton.addEventListener('click', function () {
    var next = effectiveTheme() === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* storage can be blocked */
    }
    labelTheme();
  });

  // The download buttons say which system they are for; they open the download page, which picks the build.
  var platform =
    (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
  var mobile = /iPhone|iPad|Android/i.test(navigator.userAgent || '');
  var system = mobile
    ? ''
    : /mac/i.test(platform)
      ? 'macOS'
      : /win/i.test(platform)
        ? 'Windows'
        : /linux|x11/i.test(platform)
          ? 'Linux'
          : '';
  if (system) {
    $$('[data-download-label]').forEach(function (label) {
      label.textContent = 'Download for ' + system;
    });
  }
  // Shortcut keys are written for Windows and Linux; a Mac gets its own.
  if (system === 'macOS') {
    $$('kbd[data-mac]').forEach(function (key) {
      key.textContent = key.getAttribute('data-mac');
    });
  }

  // The rooms on the home page: a tab list with arrow-key movement. Only the shown capture loads first; the rest are
  // fetched when idle. (Other pages with tabs bring their own script.)
  if ($('#tab-note')) {
    var tabs = $$('[role="tab"]');
    var note = $('#tab-note');
    var select = function (tab, focus) {
      tabs.forEach(function (other) {
        var on = other === tab;
        other.setAttribute('aria-selected', on ? 'true' : 'false');
        other.tabIndex = on ? 0 : -1;
        var panel = document.getElementById(other.getAttribute('aria-controls'));
        if (panel) panel.hidden = !on;
      });
      var lead = document.createElement('strong');
      lead.textContent = tab.getAttribute('data-room') + '.';
      note.replaceChildren(lead, document.createTextNode(' ' + tab.getAttribute('data-note')));
      if (focus) tab.focus();
    };
    tabs.forEach(function (tab, index) {
      tab.addEventListener('click', function () {
        select(tab, false);
      });
      tab.addEventListener('keydown', function (event) {
        var to =
          event.key === 'ArrowRight'
            ? index + 1
            : event.key === 'ArrowLeft'
              ? index - 1
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? tabs.length - 1
                  : -1;
        if (to < 0) return;
        event.preventDefault();
        select(tabs[(to + tabs.length) % tabs.length], true);
      });
    });
    var warm = function () {
      $$('[role="tabpanel"] img[loading="lazy"]').forEach(function (img) {
        var preload = new Image();
        preload.sizes = img.sizes;
        preload.srcset = img.srcset;
        preload.src = img.currentSrc || img.src;
      });
    };
    if ('requestIdleCallback' in window) requestIdleCallback(warm, { timeout: 4000 });
    else window.setTimeout(warm, 2500);
  }

  // Quiet scroll entry.
  var items = $$('.reveal');
  if ('IntersectionObserver' in window && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    var seen = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('in');
          seen.unobserve(entry.target);
        });
      },
      { rootMargin: '0px 0px -8% 0px', threshold: 0.05 },
    );
    items.forEach(function (item) {
      seen.observe(item);
    });
  } else {
    items.forEach(function (item) {
      item.classList.add('in');
    });
  }
})();
