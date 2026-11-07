// The invite is in the fragment (#v1.<room>.<secret>.<meta>): it stays in this browser. This script only reads it to
// show who invited you, and hands it to the app; it makes no request.
(() => {
  const fragment = location.hash.replace(/^#/, '').trim();
  const [version, room, secret, meta] = fragment.split('.');
  const valid = version === 'v1' && /^[A-Za-z0-9_-]{22}$/.test(room || '') && /^[A-Za-z0-9_-]{43}$/.test(secret || '');
  const $ = (id) => document.getElementById(id);
  if (!valid) {
    $('join-invalid').hidden = false;
    return;
  }
  try {
    const text = new TextDecoder().decode(Uint8Array.from(atob(meta.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)));
    const info = JSON.parse(text);
    if (typeof info.hostName === 'string' && typeof info.title === 'string') {
      $('join-title').textContent = `${info.hostName.slice(0, 80)} invited you`;
      $('join-lead').textContent = `Work together in “${info.title.slice(0, 200) || 'Untitled'}”, in Atelier.`;
    }
  } catch {
    // An invite without a readable description still works.
  }
  const link = `atelier://join#${fragment}`;
  $('join-open').href = link;
  $('join-actions').hidden = false;
  $('join-hint').hidden = false;
  // Once, on its own: the browser asks before it opens the app.
  setTimeout(() => location.assign(link), 300);
})();
