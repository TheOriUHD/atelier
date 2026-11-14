/* global document -- a plain script in the page, before the bundle */
// The theme the owner picked in the panel (system, light or dark), applied before the first paint.
try {
  var theme = localStorage.getItem('atelier-admin-theme');
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme;
} catch {
  // No storage: follow the system.
}
