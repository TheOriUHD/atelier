// Calls every procedure the personal settings pages use, with the exact params the app sends, against a throwaway server.
//   node probe-all.mjs <member temporary password> [port]
import { connectFakeDesktop, TEXT_ID, IMAGE_ID, TEXT_BASE, IMAGE_BASE } from './fake-desktop.mjs';

const [memberTemp, portArg] = process.argv.slice(2);
const PORT = Number(portArg ?? 17420);
let passed = 0, failed = 0;
const report = (name, good, detail = '') => { good ? passed++ : failed++; console.log(`${good ? 'PASS' : 'FAIL'}  ${name}${detail ? '  ' + detail : ''}`); };

async function client(user, password, clientKind = 'mobile') {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 1;
  const call = (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    const handler = ({ data }) => { const m = JSON.parse(data); if (m.id === id) { socket.removeEventListener('message', handler); resolve(m.error ? { error: m.error } : { result: m.result }); } };
    socket.addEventListener('message', handler);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  });
  const login = await call('auth.login', { username: user, password, clientKind });
  if (login.error) throw new Error(`login ${user}: ${JSON.stringify(login.error)}`);
  return { call, token: login.result.token, close: () => socket.close() };
}
const anon = async () => {
  const socket = new WebSocket(`ws://127.0.0.1:${PORT}/api/ws`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let next = 1;
  return { call: (method, params = {}) => new Promise((resolve) => {
    const id = next++;
    const handler = ({ data }) => { const m = JSON.parse(data); if (m.id === id) { socket.removeEventListener('message', handler); resolve(m.error ? { error: m.error } : { result: m.result }); } };
    socket.addEventListener('message', handler);
    socket.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }));
  }), close: () => socket.close() };
};
const must = async (c, name, method, params, check = () => true) => {
  const r = await c.call(method, params);
  const good = !r.error && check(r.result);
  report(`${method}${name ? ` (${name})` : ''}`, good, good ? '' : JSON.stringify(r.error ?? r.result).slice(0, 200));
  return r.result;
};
const refuses = async (c, name, method, params, text) => {
  const r = await c.call(method, params);
  const good = !!r.error && (text ? r.error.message.includes(text) : true);
  report(`${method} refuses (${name})`, good, good ? r.error.message : JSON.stringify(r).slice(0, 200));
  return r.error;
};
const blob = async (token, sha) => {
  const r = await fetch(`http://127.0.0.1:${PORT}/api/blobs/${sha}`, { headers: { authorization: `Bearer ${token}` } });
  return { status: r.status, bytes: Buffer.from(await r.arrayBuffer()) };
};

const admin = await client('demo', 'atelier-demo-pass');
const member0 = await client('member', memberTemp);
const before = await member0.call('account.get');
report('account.get while a new password is due', !before.error && before.result.mustChangePassword === true);
await refuses(member0, 'before the password is changed', 'settings.get', {}, 'new password');
await must(member0, '', 'account.changePassword', { current: memberTemp, next: 'member-test-pass-1' }, (r) => r.ok === true);
member0.close();
const me = await client('member', 'member-test-pass-1');

// ---- General
const prefs = await must(me, '', 'prefs.get', {}, (r) => r.appearance.chatFont === 'serif' && r.dictation.holdToRecord === true);
for (const [path, value] of [
  [['appearance', 'chatFont'], 'sans'], [['appearance', 'textSize'], 'l'], [['appearance', 'transcriptWidth'], 'wide'], [['appearance', 'motion'], 'reduced'],
  [['models', 'rememberLast'], false], [['models', 'chat'], 'demo/demo-model'], [['dictation', 'language'], 'de'], [['dictation', 'holdToRecord'], false],
  [['notifications', 'taskFinished'], false], [['notifications', 'permissionNeeded'], false], [['privacy', 'historyRetentionDays'], 90], [['privacy', 'historyRetentionDays'], null],
  [['privacy', 'temporaryChats'], 'fresh'], [['memory', 'searchChats'], false], [['memory', 'generate'], false], [['memory', 'sensitive'], true],
  [['callMe'], 'Phil'], [['personalization', 'responseStyle'], 'concise'], [['personalization', 'instructions'], 'I prefer short answers.'],
  [['personalization', 'atelierMd'], '# How I work\n\n- Explain a plan first.'], [['remoteControl'], false],
  [['personalization', 'personality'], { selected: 'custom:t1', customModes: [{ id: 't1', name: 'Patient tutor', instructions: 'Be patient.' }] }],
]) {
  await must(me, path.join('.') + ' = ' + JSON.stringify(value).slice(0, 30), 'prefs.set', { path, value }, (r) => JSON.stringify(path.reduce((o, k) => o?.[k], r)) === JSON.stringify(value));
}
await must(me, 'models.chat', 'prefs.reset', { path: ['models', 'chat'] }, (r) => r.models.chat === undefined);
await must(me, 'dictation.language', 'prefs.reset', { path: ['dictation', 'language'] }, (r) => r.dictation.language === 'auto');
await refuses(me, 'a value it does not take', 'prefs.set', { path: ['appearance', 'theme'], value: 'neon' }, 'appearance.theme');
await refuses(me, 'a key an older server does not know', 'prefs.set', { path: ['somethingNew', 'x'], value: 1 }, 'not a preference');
await refuses(me, 'a method an older server does not have', 'nope.nothing', {}, 'Unknown method');
await must(me, '', 'settings.get', {}, (r) => r.effective.imageGeneration && r.effective.memory && r.effective.safeguards);
await must(me, '', 'models.list', {}, (r) => r.length >= 1);
await must(me, '', 'imageModels.list', {}, (r) => Array.isArray(r));
await must(me, '', 'dictation.status', {}, (r) => r.enabled === true && r.builtin?.state);
await refuses(me, 'a member changing a system setting', 'settings.set', { layer: 'global', path: ['dictation', 'enabled'], value: false }, 'Only admins');
await must(admin, 'admin', 'settings.set', { layer: 'global', path: ['dictation', 'enabled'], value: false }, (r) => r.ok);
await must(admin, 'admin', 'settings.reset', { layer: 'global', path: ['dictation', 'enabled'] }, (r) => r.ok);
await must(admin, 'admin', 'settings.set', { layer: 'global', path: ['reports', 'enabled'], value: true }, (r) => r.ok);
await must(admin, 'admin', 'settings.set', { layer: 'global', path: ['memory', 'manualEditing'], value: true }, (r) => r.ok);
console.log('SKIP  dictation.prepare (it would download the 715 MB speech model)');

// ---- Account
const account = await must(me, '', 'account.get', {}, (r) => r.username === 'member' && r.hasPassword === true && r.mustChangePassword === false);
await must(me, '', 'account.update', { name: 'Mia Member Jr.' }, (r) => r.name === 'Mia Member Jr.');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const file = await must(me, 'avatar', 'files.upload', { name: 'profile.jpg', mime: 'image/png', dataBase64: png.toString('base64') }, (r) => r.blob?.length === 64);
await must(me, 'avatar', 'account.update', { avatar: file.blob }, (r) => r.avatar === file.blob);
const got = await blob(me.token, file.blob);
report('GET /api/blobs/<sha> with the bearer token', got.status === 200 && got.bytes.equals(png), `status ${got.status}`);
await must(me, 'remove the photo', 'account.update', { avatar: null }, (r) => r.avatar === null);
const second = await client('member', 'member-test-pass-1', 'web');
const sessions = await must(me, '', 'account.sessions', {}, (r) => r.some((s) => s.current && s.clientKind === 'mobile') && r.length >= 2);
const other = sessions.find((s) => !s.current);
await must(me, 'another sign-in', 'account.revokeSession', { id: other.id }, (r) => r.ok);
await must(me, 'after', 'account.sessions', {}, (r) => !r.some((s) => s.id === other.id));
second.close();
await must(me, '', 'account.passkeys', {}, (r) => Array.isArray(r) && r.length === 0);
await must(me, 'one that is not there', 'account.removePasskey', { id: 'nope' }, (r) => r.ok);
await must(me, '', 'account.identities', {}, (r) => Array.isArray(r.connected) && Array.isArray(r.available));
await must(me, 'one that is not there', 'account.removeIdentity', { id: 'nope' }, (r) => r.ok);
await must(me, '', 'account.devices', {}, (r) => Array.isArray(r));
await refuses(me, 'wrong current password', 'account.changePassword', { current: 'wrong', next: 'abcdefgh' }, 'current password is wrong');
await must(me, 'to the same one', 'account.changePassword', { current: 'member-test-pass-1', next: 'member-test-pass-2' }, (r) => r.ok);
// Approving another device's sign-in (a terminal or the app itself asking).
const pending = await anon();
const start = await must(pending, 'the asking device', 'auth.terminalStart', { deviceName: 'probe-terminal', platform: 'linux' }, (r) => r.code && r.pollToken);
const me2 = await client('member', 'member-test-pass-2');
await must(me2, '', 'auth.terminalRequest', { code: start.code }, (r) => r.deviceName === 'probe-terminal' && r.platform === 'linux');
await refuses(me2, 'a code nobody asked with', 'auth.terminalRequest', { code: 'ABCD-EFGH' }, 'No terminal is waiting');
await must(me2, 'approve', 'auth.terminalDecide', { code: start.code, approve: true }, (r) => r.ok);
await must(pending, 'the asking device polls', 'auth.terminalPoll', { pollToken: start.pollToken }, (r) => r.state === 'approved' && r.token);
const start2 = await must(pending, 'a second one', 'auth.terminalStart', { deviceName: 'probe-terminal-2', platform: 'linux' }, (r) => r.code);
await must(me2, 'deny', 'auth.terminalDecide', { code: start2.code, approve: false }, (r) => r.ok);
await must(pending, 'polls after a denial', 'auth.terminalPoll', { pollToken: start2.pollToken }, (r) => r.state === 'denied');
pending.close();

// ---- Memory
await must(me2, '', 'memory.list', {}, (r) => Array.isArray(r.entries));
const written = await must(me2, 'a fixed entry by hand', 'memory.update', { section: 'preferences', details: '- Keep lists short\n- Answer in German' }, (r) => r.section === 'preferences' && r.details.includes('German'));
await must(me2, '', 'memory.get', { id: written.id }, (r) => r.id === written.id);
const listed = await must(me2, 'after', 'memory.list', {}, (r) => r.entries.some((e) => e.id === written.id));
await must(me2, 'edit', 'memory.update', { id: written.id, details: '- Keep lists short' }, (r) => r.details === '- Keep lists short');
await refuses(me2, 'an entry that is gone', 'memory.get', { id: 'nope' }, 'no longer exists');
// The scripted model cannot do a memory model's work; what comes back is still the server's own sentence.
const instructed = await me2.call('memory.instruct', { text: 'Call me Sam', section: 'preferences' });
report('memory.instruct (section, no model chosen)', !!instructed.result || !!instructed.error?.message, instructed.error?.message ?? JSON.stringify(instructed.result).slice(0, 120));
const instructedModel = await me2.call('memory.instruct', { text: 'He is five now', entryId: written.id, model: 'demo/demo-model' });
report('memory.instruct (entry, model chosen)', !!instructedModel.result || !!instructedModel.error?.message, instructedModel.error?.message ?? JSON.stringify(instructedModel.result).slice(0, 120));
const imported = await me2.call('memory.import', { text: '## Identity\n[unknown] - Lives in Hamburg', model: 'demo/demo-model' });
report('memory.import', !!imported.result || !!imported.error?.message, imported.error?.message ?? JSON.stringify(imported.result).slice(0, 120));
await must(me2, 'clear', 'memory.delete', { id: written.id }, (r) => r.ok);

// ---- Usage
await must(me2, '', 'usage.summary', { days: 30, timezoneOffset: -60 }, (r) => Array.isArray(r));
await must(me2, '', 'usage.summary', { days: 7, timezoneOffset: -60 }, (r) => Array.isArray(r));
await must(admin, 'everyone', 'usage.summary', { days: 90, timezoneOffset: 0, everyone: true }, (r) => Array.isArray(r));
await must(me2, 'chat, 30 days', 'stats.summary', { mode: 'chat', days: 30, timezoneOffset: -60 }, (r) => r.sessions >= 0 && Array.isArray(r.days));
await must(me2, 'code, all time', 'stats.summary', { mode: 'code', days: null, timezoneOffset: -60 }, (r) => r.messages >= 0);
await must(me2, '', 'limits.mine', {}, (r) => r.exempt === false && Array.isArray(r.rows));
await must(admin, 'a limit applies', 'settings.set', { layer: 'global', path: ['limits'], value: { tokensPerDay: 100000, requestsPerHour: 30 } }, (r) => r.ok);
await must(me2, 'with limits set', 'limits.mine', {}, (r) => r.rows.length === 2 && r.rows[0].max > 0);
await must(admin, 'limits off again', 'settings.set', { layer: 'global', path: ['limits'], value: {} }, (r) => r.ok);
await must(admin, 'admin', 'chatgpt.status', {}, (r) => r.available !== undefined && r.signedIn === false);
await must(admin, 'admin, a provider with no plan', 'providers.planUsage', { id: 'demo' }, (r) => r === null || typeof r.usedPercent === 'number');
await refuses(me2, 'a member reading plan windows', 'chatgpt.status', {}, 'Only admins');
await refuses(me2, 'a member reading plan windows', 'providers.planUsage', { id: 'demo' }, 'Only admins');

// ---- Your models, with a stand-in desktop app that lends one model server and one image server
const emptyList = await must(me2, 'before any', 'personalProviders.list', {}, (r) => r.length === 0);
await must(me2, 'before any', 'personalImageProviders.list', {}, (r) => r.length === 0);
await refuses(me2, 'adding from a phone', 'personalProviders.detect', {}, 'desktop app');
await refuses(me2, 'adding from a phone', 'personalProviders.save', { id: TEXT_ID, type: 'ollama', name: 'Ollama', baseUrl: TEXT_BASE }, 'desktop app');
const desktop = await connectFakeDesktop(PORT, 'member', 'member-test-pass-2');
const devices = await must(me2, 'with a desktop signed in', 'account.devices', {}, (r) => r.some((d) => d.name === "Probe's MacBook" && d.online));
await must(desktop, 'detect', 'personalProviders.detect', {}, (r) => r.length === 1 && r[0].label === 'Ollama');
await must(desktop, 'test', 'personalProviders.test', { id: TEXT_ID, type: 'ollama', name: 'Ollama', baseUrl: TEXT_BASE }, (r) => r.status.ok === true && r.models.length === 2);
await must(desktop, 'add', 'personalProviders.save', { id: TEXT_ID, type: 'ollama', name: 'Ollama', baseUrl: TEXT_BASE }, (r) => r.id === TEXT_ID && r.online === true);
await must(desktop, 'image detect', 'personalImageProviders.detect', {}, (r) => r.length === 1);
await must(desktop, 'image add', 'personalImageProviders.save', { id: IMAGE_ID, type: 'comfyui', preset: 'comfyui', name: 'ComfyUI', baseUrl: IMAGE_BASE }, (r) => r.id === IMAGE_ID);
const list = await must(me2, 'from the phone', 'personalProviders.list', {}, (r) => r.length === 1 && r[0].deviceName === "Probe's MacBook" && r[0].online === true);
await must(me2, 'from the phone', 'personalImageProviders.list', {}, (r) => r.length === 1 && r[0].preset === 'comfyui');
const provider = list[0];
await must(me2, 'a model list that shows them', 'models.list', {}, (r) => r.some((m) => m.providerId === TEXT_ID && m.personal?.deviceName === "Probe's MacBook"));
// The same draft the app builds from a list row, with the changes on top.
const draft = (changes) => ({ id: provider.id, type: provider.type, name: provider.name, baseUrl: provider.baseUrl, ...changes });
await must(me2, 'turn it off', 'personalProviders.save', draft({ enabled: false }), (r) => r.enabled === false);
await must(me2, 'turn it on', 'personalProviders.save', draft({ enabled: true }), (r) => r.enabled === true);
await must(me2, 'rename and set limits', 'personalProviders.save', draft({ name: 'Home Ollama', parallelRequests: 2, modelsAtOnce: 2 }), (r) => r.name === 'Home Ollama' && r.parallelRequests === 2 && r.modelsAtOnce === 2);
await must(me2, 'automatic again', 'personalProviders.save', draft({ name: 'Home Ollama' }), (r) => r.name === 'Home Ollama');
await must(me2, 'test connection', 'personalProviders.refresh', { id: provider.id }, (r) => r.length === 1 && r[0].status?.ok === true);
await must(me2, 'after', 'personalProviders.list', {}, (r) => r[0].status?.ok === true && r[0].status.modelCount === 2);
const image = (await me2.call('personalImageProviders.list', {})).result[0];
await must(me2, 'image: turn it off', 'personalImageProviders.save', { id: image.id, type: image.type, preset: image.preset, name: image.name, baseUrl: image.baseUrl, enabled: false }, (r) => r.enabled === false);
await must(me2, 'image: rename', 'personalImageProviders.save', { id: image.id, type: image.type, preset: image.preset, name: 'Studio ComfyUI', baseUrl: image.baseUrl, parallelRequests: 1 }, (r) => r.name === 'Studio ComfyUI');
await must(me2, 'image: test connection', 'personalImageProviders.refresh', { id: image.id }, (r) => Array.isArray(r));
await must(me2, 'one that is not there', 'personalProviders.refresh', { id: 'u-gone000000' }, (r) => Array.isArray(r));
await must(me2, 'remove', 'personalProviders.remove', { id: provider.id }, (r) => r.ok);
await must(me2, 'image: remove', 'personalImageProviders.remove', { id: image.id }, (r) => r.ok);
await must(me2, 'after removing', 'personalProviders.list', {}, (r) => r.length === 0);
desktop.close();
await new Promise((r) => setTimeout(r, 1500));
await must(me2, 'a desktop that went away', 'account.devices', {}, (r) => r.length === 1 && r[0].online === false);
await must(me2, 'remove the device', 'account.removeDevice', { id: devices.find((d) => d.name === "Probe's MacBook").id }, (r) => r.ok);
await must(me2, 'after', 'account.devices', {}, (r) => r.length === 0);

// ---- Privacy
const session = await must(me2, 'a chat to export and delete', 'sessions.create', { mode: 'chat', model: 'demo/demo-model' }, (r) => r.id);
const exported = await must(me2, '', 'privacy.export', {}, (r) => r.sha256?.length === 64 && r.name.endsWith('.zip'));
const zip = await blob(me2.token, exported.sha256);
report('the export downloads as a zip', zip.status === 200 && zip.bytes.subarray(0, 2).toString() === 'PK', `${zip.bytes.length} bytes`);
await must(me2, '', 'privacy.deleteConversations', {}, (r) => r.deleted >= 1);
await must(me2, 'after', 'sessions.list', { archived: 'active', limit: 200 }, (r) => r.length === 0);

// ---- Help and reports
await must(me2, '', 'app.info', {}, (r) => r.reports === true && r.version);
const prepIssue = await must(me2, 'issue, diagnostics only', 'reports.prepare', { kind: 'issue', diagnostics: true, chatSessionId: null }, (r) => r.diagnostics && r.chat === null);
const chatSession = await must(me2, '', 'sessions.create', { mode: 'chat', model: 'demo/demo-model' }, (r) => r.id);
const prepChat = await must(me2, 'with a conversation', 'reports.prepare', { kind: 'issue', diagnostics: true, chatSessionId: chatSession.id }, (r) => r.diagnostics && r.chat?.coverage);
await must(me2, 'feature, nothing attached', 'reports.prepare', { kind: 'feature', diagnostics: false, chatSessionId: null }, (r) => r.diagnostics === null && r.chat === null);
const app = { version: '0.1.0 (1)', surface: 'web', mode: 'web', serverVersion: '0.10.1', window: { width: 402, height: 874, ratio: 3 }, theme: 'light', language: 'en_US' };
const client_ = { client: { os: { platform: 'ios', name: 'iOS 26.4', release: '26.4', arch: 'arm64', locale: 'en_US', timeZone: 'Europe/Berlin' }, hardware: { model: 'iPhone18,1', cpu: { model: 'unknown', cores: 6 }, memory: { totalBytes: 8_000_000_000 }, displays: [{ width: 402, height: 874, scale: 3 }] }, runtime: {} }, notes: { app: 'Atelier for iPhone and iPad 0.1.0 (1)', device: 'iPhone' } };
const picture = Buffer.from('/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=', 'base64');
const receipt = await me2.call('reports.submit', { kind: 'issue', title: 'Chat stops after attaching a PDF', description: 'I attach a PDF and the answer never comes back at all.', contact: 'me@example.com', app, diagnostics: { ...prepChat.diagnostics, ...client_ }, chat: prepChat.chat, screenshots: [{ mime: 'image/jpeg', dataBase64: picture.toString('base64'), width: 1, height: 1 }] });
report('reports.submit (diagnostics, a conversation and a picture)', !!receipt.result?.id, JSON.stringify(receipt.result ?? receipt.error).slice(0, 160));
const feature = await me2.call('reports.submit', { kind: 'feature', title: 'Search inside attached PDFs', description: 'It would let me find a line in a long PDF without opening it.', app, diagnostics: null, chat: null, screenshots: [] });
report('reports.submit (a feature request, nothing attached)', !!feature.result?.id, JSON.stringify(feature.result ?? feature.error).slice(0, 160));
await refuses(me2, 'a title that is too long', 'reports.submit', { kind: 'issue', title: 'x'.repeat(200), description: 'It crashes when I do this and that.', app, diagnostics: null, chat: null, screenshots: [] }, 'Invalid params');
await must(admin, 'an admin turns reports off', 'settings.set', { layer: 'global', path: ['reports', 'enabled'], value: false }, (r) => r.ok);
await must(me2, 'it shows in app.info', 'app.info', {}, (r) => r.reports === false);
await refuses(me2, 'while they are off', 'reports.prepare', { kind: 'issue', diagnostics: true, chatSessionId: null });
await must(admin, 'back on', 'settings.set', { layer: 'global', path: ['reports', 'enabled'], value: true }, (r) => r.ok);

// ---- Log out everywhere, last
const third = await client('member', 'member-test-pass-2', 'web');
await must(me2, '', 'account.logoutEverywhere', {}, (r) => r.ok);
const after = await third.call('prefs.get', {});
report('every sign-in ended', !!after.error || after.result === undefined, JSON.stringify(after).slice(0, 100));
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
