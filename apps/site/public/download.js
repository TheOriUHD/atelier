/*
 * The download page. The page works without this (every build links to the newest release); this picks the visitor's
 * system and the right build for it, lets them choose another, and fills in the version, sizes and file addresses
 * from /releases.json (apps/site/scripts/releases.mjs writes it).
 */
(function () {
  'use strict';
  var $ = function (selector, scope) {
    return (scope || document).querySelector(selector);
  };
  var $$ = function (selector, scope) {
    return Array.prototype.slice.call((scope || document).querySelectorAll(selector));
  };

  var tabs = $$('[role="tab"][data-os]');
  var panels = {};
  $$('.os-panel').forEach(function (panel) {
    panels[panel.getAttribute('data-os')] = panel;
  });

  // What this computer is. The processor is only known to browsers that share it (Chromium); the rest get the common
  // answer for the system and the visitor can pick.
  var agent = navigator.userAgentData;
  var platform = (agent && agent.platform) || navigator.platform || navigator.userAgent || '';
  var mobile = /iPhone|iPad|Android/i.test(navigator.userAgent || '');
  var detected = mobile
    ? null
    : /mac/i.test(platform)
      ? 'macos'
      : /win/i.test(platform)
        ? 'windows'
        : /linux|x11|cros/i.test(platform)
          ? 'linux'
          : null;
  var arch = detected === 'macos' ? 'arm64' : 'x64';

  var release = null;
  var current = detected || 'macos';

  var SYSTEM = { macos: 'macOS', windows: 'Windows', linux: 'Linux' };
  // Which build each system leads with, by processor.
  var LEAD = {
    macos: { arm64: 'macos-arm64', x64: 'macos-x64' },
    windows: { arm64: 'windows-arm64', x64: 'windows-x64' },
    linux: { arm64: 'linux-deb-arm64', x64: 'linux-deb-x64' },
  };

  var size = function (bytes) {
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
  };

  // Releases up to 0.3.1 have one Windows installer for both processors, under the kind 'windows'.
  function assetFor(kind) {
    var assets = (release && release.assets) || {};
    return assets[kind] || (/^windows-/.test(kind) ? assets.windows : undefined);
  }

  function lead(os) {
    return LEAD[os][arch];
  }

  function fill() {
    $$('.os-panel').forEach(function (panel) {
      var os = panel.getAttribute('data-os');
      var leadKind = lead(os);
      var rows = $$('[data-build]', panel);
      // One build is the big button already; the list would only repeat it.
      var single = rows.length === 1;
      $('.builds', panel).hidden = single;
      rows.forEach(function (row) {
        var kind = row.getAttribute('data-build');
        var asset = assetFor(kind);
        var link = $('[data-link]', row);
        if (asset) {
          link.href = asset.url;
          $('[data-size]', row).textContent = size(asset.size);
        }
        row.classList.toggle('is-lead', kind === leadKind);
      });
      var primary = $('[data-primary]', panel);
      var asset = assetFor(leadKind);
      var label = $('[data-primary-label]', panel);
      var meta = $('[data-primary-meta]', panel);
      label.textContent =
        os === 'macos'
          ? 'Download for ' + (leadKind === 'macos-arm64' ? 'Apple silicon' : 'Intel')
          : os === 'linux'
            ? 'Download the ' + (arch === 'arm64' ? 'ARM64' : 'x86-64') + ' .deb'
            : 'Download for Windows (' + (arch === 'arm64' ? 'ARM64' : 'x64') + ')';
      // A platform a release left out keeps an earlier build: its own file name says which version it is.
      var built = asset && /\d+\.\d+\.\d+(?:-(?!arm64|amd64|x64)[A-Za-z0-9.]+)?/.exec(asset.name);
      var facts = asset ? [built ? built[0] : release.version, size(asset.size)] : [];
      if (single) facts.push(rows[0].getAttribute('data-summary'));
      if (asset) primary.href = asset.url;
      meta.textContent = facts.join(' · ');
      // The file's name in the install commands.
      $$('[data-file]', panel).forEach(function (el) {
        var named = release && release.assets[el.getAttribute('data-file')];
        if (named) el.textContent = named.name;
      });
    });
    if (release) {
      $('#version-line').textContent = 'Version ' + release.version + (release.prerelease ? ', prerelease.' : ', beta.');
      var notes = $('#notes-link');
      if (notes && release.releaseUrl) notes.href = release.releaseUrl;
    }
  }

  function select(os, focus, keepHash) {
    current = os;
    tabs.forEach(function (tab) {
      var on = tab.getAttribute('data-os') === os;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    Object.keys(panels).forEach(function (key) {
      panels[key].hidden = key !== os;
    });
    if (!keepHash && window.history && history.replaceState) history.replaceState(null, '', '#' + os);
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      select(tab.getAttribute('data-os'), false, false);
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
      select(tabs[(to + tabs.length) % tabs.length].getAttribute('data-os'), true, false);
    });
  });

  // Atelier CLI: the install command for this system (Windows has its own), and copy buttons.
  var cliTabs = $$('[role="tab"][data-cli]');
  function selectCli(which, focus) {
    cliTabs.forEach(function (tab) {
      var on = tab.getAttribute('data-cli') === which;
      tab.setAttribute('aria-selected', on ? 'true' : 'false');
      tab.tabIndex = on ? 0 : -1;
      if (on && focus) tab.focus();
    });
    $$('[data-cli-panel]').forEach(function (panel) {
      panel.hidden = panel.getAttribute('data-cli-panel') !== which;
    });
  }
  cliTabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      selectCli(tab.getAttribute('data-cli'), false);
    });
    tab.addEventListener('keydown', function (event) {
      if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
      event.preventDefault();
      selectCli(cliTabs[(index + 1) % cliTabs.length].getAttribute('data-cli'), true);
    });
  });
  if (cliTabs.length) selectCli(detected === 'windows' ? 'windows' : 'unix', false);
  $$('[data-copy]').forEach(function (button) {
    // Where the browser won't copy, the command is selected for the visitor to copy.
    var select = function () {
      var code = button.parentNode && $('code', button.parentNode);
      var selection = window.getSelection && window.getSelection();
      if (!code || !selection) return;
      var range = document.createRange();
      range.selectNodeContents(code);
      selection.removeAllRanges();
      selection.addRange(range);
    };
    button.addEventListener('click', function () {
      if (!navigator.clipboard || !navigator.clipboard.writeText) return select();
      navigator.clipboard.writeText(button.getAttribute('data-copy')).then(function () {
        button.classList.add('copied');
        button.setAttribute('aria-label', 'Copied');
        setTimeout(function () {
          button.classList.remove('copied');
          button.setAttribute('aria-label', 'Copy the command');
        }, 1600);
      }, select);
    });
  });

  // What to download: the switch beside the heading, and the bar that keeps it at the top once the heading has scrolled
  // away. Its highlight follows the section being read (Desktop app, Atelier CLI, Atelier Server).
  var header = $('.site-header');
  var bar = $('.dl-bar');
  var head = $('.dl-head');
  var switches = $$('.dl-choose');
  var sections = ['desktop', 'cli', 'server']
    .map(function (id) {
      return document.getElementById(id);
    })
    .filter(Boolean);
  var reading = null;
  var barShown = false;
  // The page ships it hidden, so a stale stylesheet or no script never leaves it standing open; it unfolds from here.
  if (bar) bar.hidden = false;
  switches.forEach(function (nav) {
    var glide = document.createElement('span');
    glide.className = 'glide';
    glide.setAttribute('aria-hidden', 'true');
    nav.insertBefore(glide, nav.firstChild);
    nav.classList.add('has-glide');
  });
  function placeGlide(nav) {
    var chip = $('.choice.is-here', nav);
    var glide = $('.glide', nav);
    if (!chip || !glide || !chip.offsetWidth) return;
    glide.style.width = chip.offsetWidth + 'px';
    glide.style.transform = 'translateX(' + chip.offsetLeft + 'px)';
  }
  function mark(id) {
    switches.forEach(function (nav) {
      $$('.choice', nav).forEach(function (chip) {
        var on = chip.getAttribute('href') === '#' + id;
        chip.classList.toggle('is-here', on);
        if (on) chip.setAttribute('aria-current', 'true');
        else chip.removeAttribute('aria-current');
      });
      placeGlide(nav);
    });
  }
  function follow() {
    if (!sections.length) return;
    // The section whose top has passed a line a third of the way down, or the last one at the end of the page.
    var line = window.innerHeight * 0.34;
    var id = sections[0].id;
    sections.forEach(function (section) {
      if (section.getBoundingClientRect().top <= line) id = section.id;
    });
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) id = sections[sections.length - 1].id;
    if (id !== reading) {
      reading = id;
      mark(id);
    }
    if (bar && head && header) {
      var shown = head.getBoundingClientRect().bottom < $('.bar', header).offsetHeight;
      if (shown !== barShown) {
        barShown = shown;
        header.classList.toggle('has-bar', shown);
        bar.inert = !shown;
      }
    }
  }
  var queued = false;
  window.addEventListener(
    'scroll',
    function () {
      if (queued) return;
      queued = true;
      window.requestAnimationFrame(function () {
        queued = false;
        follow();
      });
    },
    { passive: true },
  );
  window.addEventListener('resize', function () {
    switches.forEach(placeGlide);
    follow();
  });
  // Fonts change the chips' widths once they arrive.
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(function () {
      switches.forEach(placeGlide);
    });
  }
  follow();

  // A link can ask for a system (/download/#windows); otherwise the detected one, otherwise macOS.
  var asked = (location.hash || '').replace('#', '');
  var start = SYSTEM[asked] ? asked : current;
  select(start, false, true);
  fill();

  if (agent && agent.getHighEntropyValues) {
    agent
      .getHighEntropyValues(['architecture'])
      .then(function (hints) {
        if (!hints.architecture) return;
        arch = /arm/i.test(hints.architecture) ? 'arm64' : 'x64';
        fill();
      })
      .catch(function () {
        /* the common answer stands */
      });
  }

  fetch('/releases.json', { credentials: 'same-origin' })
    .then(function (response) {
      return response.ok ? response.json() : null;
    })
    .then(function (data) {
      if (data && data.assets) {
        release = data;
        fill();
      }
    })
    .catch(function () {
      /* the links to the newest release stand */
    });
})();
