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
    windows: { arm64: 'windows', x64: 'windows' },
    linux: { arm64: 'linux-deb-arm64', x64: 'linux-deb-x64' },
  };

  var size = function (bytes) {
    return bytes >= 1e9 ? (bytes / 1e9).toFixed(1) + ' GB' : Math.round(bytes / 1e6) + ' MB';
  };

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
        var asset = release && release.assets[kind];
        var link = $('[data-link]', row);
        if (asset) {
          link.href = asset.url;
          $('[data-size]', row).textContent = size(asset.size);
        }
        row.classList.toggle('is-lead', kind === leadKind);
      });
      var primary = $('[data-primary]', panel);
      var asset = release && release.assets[leadKind];
      var label = $('[data-primary-label]', panel);
      var meta = $('[data-primary-meta]', panel);
      label.textContent =
        os === 'macos'
          ? 'Download for ' + (leadKind === 'macos-arm64' ? 'Apple silicon' : 'Intel')
          : os === 'linux'
            ? 'Download the ' + (arch === 'arm64' ? 'ARM64' : 'x86-64') + ' .deb'
            : 'Download for Windows';
      // A platform a release left out keeps an earlier build: its own file name says which version it is.
      var built = asset && /\d+\.\d+\.\d+(?:-(?!arm64|amd64)[A-Za-z0-9.]+)?/.exec(asset.name);
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
