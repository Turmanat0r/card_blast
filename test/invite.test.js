// The invite-link flow, driven through the real client script in index.html
// with a stubbed DOM. Covers both ends: the link the host hands out, and what
// happens to whoever opens it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SRC = HTML.match(/<script>([\s\S]*)<\/script>/)[1];
const IDS = [...HTML.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };

/** Whatever classes the real markup puts on this element to begin with. */
function initialClasses(id) {
  const tag = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>').exec(HTML);
  if (!tag) return [];
  const cls = /\bclass="([^"]*)"/.exec(tag[0]);
  return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
}

function fakeEl(id) {
  const el = {
    id, _cls: new Set(initialClasses(id)), style: {setProperty() {}}, dataset: {}, children: [],
    textContent: '', value: '', disabled: false, offsetWidth: 0, scrollTop: 0, scrollHeight: 0,
    onclick: null, onchange: null, oninput: null, type: '', checked: false, colSpan: 0,
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    focus() { this.focused = true; },
    setSelectionRange() { this.selected = true; },
  };
  let h = '';
  Object.defineProperty(el, 'innerHTML', {
    get: () => h, set: v => { h = v; if (v === '') el.children.length = 0; },
  });
  el.classList = {
    add: (...c) => c.forEach(x => el._cls.add(x)),
    remove: (...c) => c.forEach(x => el._cls.delete(x)),
    toggle: (c, on) => { if (on === undefined) el._cls.has(c) ? el._cls.delete(c) : el._cls.add(c); else if (on) el._cls.add(c); else el._cls.delete(c); },
    contains: c => el._cls.has(c),
  };
  return el;
}

const LOBBY_VIEW = room => ({
  v: 2, phase: 'lobby', you: 'p1-abc', isHost: false,
  players: [{id: 'p0-host', name: 'Krakatoa', color: 'ember', count: 0, host: true, score: 0, out: false},
            {id: 'p1-abc', name: 'Sirocco', color: 'vapor', count: 0, host: false, score: 0, out: false}],
  log: [], opts: {}, limit: 250, round: 0, history: [], lastRound: null, matchWinner: null,
});

/** Boots the real client with a given URL and saved-name state. */
function boot({search = '', savedName = null} = {}) {
  const els = {};
  const store = {cb_name: savedName, cb_color: 'vapor'};
  const calls = [];
  let shared = null, copied = null;

  const ctx = {
    console: {log() {}, warn() {}, error() {}},
    setTimeout: (fn) => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    URLSearchParams, Math, JSON, Object, Array, String, Number, Boolean, Promise, Date, Error,
    document: {
      getElementById: id => (els[id] = els[id] || fakeEl(id)),
      createElement: () => fakeEl('new'),
      createTextNode: t => ({textContent: String(t)}),
      createRange: () => ({selectNodeContents() {}}),
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
    },
    location: {origin: 'https://card-blast.example', pathname: '/', search},
    navigator: {
      clipboard: {writeText: async t => { copied = t; }},
      share: async o => { shared = o; },
    },
    alert: m => { calls.push('alert:' + m); },
    getSelection: () => ({removeAllRanges() {}, addRange() {}}),
    fetch: async (url, opts) => {
      calls.push((opts && opts.method === 'POST' ? 'POST ' : 'GET ') + url);
      const action = /action=([a-z_]+)/.exec(url)[1];
      const room = (/room=([A-Z0-9]+)/.exec(url) || [])[1] || 'ZZZZZZ';
      const body = {
        create: {room: 'NEW123'},
        exists: {exists: true, phase: 'lobby', players: 1},
        join: {room, playerId: 'p1-abc', token: 'tok-1', view: LOBBY_VIEW(room)},
        state: {view: LOBBY_VIEW(room)},
      }[action] || {view: LOBBY_VIEW(room)};
      return {ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)};
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;globalThis.__T = {inviteLink, get room(){return room}, set room(v){room=v}};', ctx, {filename: 'client.js'});
  return {els, ctx, calls, store, shared: () => shared, copied: () => copied, T: ctx.__T};
}

const shown = els => Object.keys(els).filter(k => k.startsWith('screen-') && els[k]._cls.has('on'));

console.log('\nthe link the host hands out');
{
  const b = boot();
  b.T.room = 'ABC234';
  const link = b.T.inviteLink();
  check('the link points at this app', link.startsWith('https://card-blast.example/'), link);
  check('the link carries the room code', link.indexOf('room=ABC234') !== -1, link);
  check('the link needs no other setup', link === 'https://card-blast.example/?room=ABC234', link);
}
{
  const b = boot();
  b.T.room = 'ABC234';
  b.els['shareBtn'].onclick.call(b.els['shareBtn']);
  // navigator.share exists here, so the OS share sheet is what should be used.
  setTimeout(() => {}, 0);
}

console.log('\nopening the link as a new player');
{
  const b = boot({search: '?room=WXYZ78'});
  // Nothing navigates: they stay put and are asked to confirm, rather than
  // being dropped into a room under a name they never saw.
  const wentSomewhere = shown(b.els).filter(s => s !== 'screen-home');
  check('stays on the home screen instead of auto-joining', wentSomewhere.length === 0, wentSomewhere.join(','));
  check('the join button is offered', b.els['inviteJoinBtn'].style.display === '');
  check('"start a new room" gets out of the way', b.els['createBtn'].style.display === 'none');
  check('the code entry panel is hidden', b.els['joinPanel'].style.display === 'none');
  check('the separator is hidden too', b.els['joinSep'].style.display === 'none');
  check('the room is named on screen', (b.els['homeLede'].textContent || '').indexOf('WXYZ78') !== -1,
    b.els['homeLede'].textContent);
  check('a name was rolled for them', (b.els['nameIn'].value || '').length > 0, b.els['nameIn'].value);
  check('no join request fired yet', b.calls.filter(c => /action=join/.test(c)).length === 0, b.calls.join(' | '));
  check('the code box is still prefilled as a fallback', b.els['codeIn'].value === 'WXYZ78');
}

console.log('\nchanging your mind about the invite');
{
  const b = boot({search: '?room=WXYZ78'});
  b.els['inviteOtherLink'].onclick({preventDefault() {}});
  check('the normal home screen comes back', b.els['createBtn'].style.display === '');
  check('the code panel returns', b.els['joinPanel'].style.display === '');
  check('the invite button goes away', b.els['inviteJoinBtn'].style.display === 'none');
}

console.log('\nopening the link when this device has played before');
(async () => {
  const b = boot({search: '?room=WXYZ78', savedName: 'Sirocco'});
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));

  const joined = b.calls.filter(c => /action=join/.test(c));
  check('it joins without being asked', joined.length === 1, b.calls.join(' | '));
  check('it joins the room from the link', joined[0].indexOf('room=WXYZ78') !== -1, joined[0]);
  check('the saved name is used', b.store.cb_name === 'Sirocco');
  check('it lands in the lobby, past the home screen',
    shown(b.els).indexOf('screen-lobby') !== -1, shown(b.els).join(','));
  check('the token is remembered for next time', b.store['cb_tok_WXYZ78'] === 'tok-1', JSON.stringify(b.store));

  console.log('\nthe lobby shows the link, not just a code');
  check('the link is on screen and selectable',
    b.els['linkOut'].value === 'https://card-blast.example/?room=WXYZ78', b.els['linkOut'].value);
  check('the code is still shown for reading aloud', b.els['lobbyCode'].textContent === 'WXYZ78');

  console.log('\nmarkup');
  ['shareBtn', 'copyLinkBtn', 'linkOut', 'inviteJoinBtn', 'inviteOtherLink', 'joinPanel', 'joinSep']
    .forEach(id => check('#' + id + ' exists in the page', IDS.indexOf(id) !== -1));

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
