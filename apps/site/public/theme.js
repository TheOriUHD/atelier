/* Runs before first paint: apply an explicit theme choice, if there is one. Without one the page follows the system. */
(function () {
  var root = document.documentElement;
  root.classList.add('js');
  try {
    var saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') root.setAttribute('data-theme', saved);
  } catch {
    // Storage can be blocked; the page then simply follows the system.
  }
})();
