// The parts of the client that are logic rather than paint: the shape of the
// fanned hand, the card guide, the extras panel, and leaving a room. Same
// trick as invite.test.js - the real <script> from index.html is run against a
// stubbed DOM, so these test the shipped code rather than a copy of it.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const SRC = HTML.match(/<script>([\s\S]*)<\/script>/)[1];

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };

function initialClasses(id) {
  const tag = new RegExp('<[^>]*\\bid="' + id + '"[^>]*>').exec(HTML);
  if (!tag) return [];
  const cls = /\bclass="([^"]*)"/.exec(tag[0]);
  return cls ? cls[1].split(/\s+/).filter(Boolean) : [];
}

function fakeEl(id) {
  const props = {};
  const el = {
    id, _cls: new Set(initialClasses(id)), _attr: {}, dataset: {}, children: [],
    textContent: '', value: '', disabled: false, scrollTop: 0, scrollHeight: 0,
    clientWidth: 0, offsetWidth: 0, offsetHeight: id === 'handbar' ? 210 : 0,
    onclick: null, onchange: null, type: '', checked: false, colSpan: 0, tagName: 'DIV',
    style: {_props: props, setProperty(k, v) { props[k] = v; }, getPropertyValue: k => props[k]},
    appendChild(c) { this.children.push(c); return c; },
    querySelectorAll() { return []; },
    setAttribute(k, v) { this._attr[k] = String(v); },
    getAttribute(k) { return this._attr[k]; },
    focus() { this.focused = true; },
    getClientRects: () => [],
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

const card = (id, c, k, n) => ({id, c, k, n});

/** A hand of seven with a known playable subset. */
const HAND = [
  card('c1', 'ember', 'num', 3),
  card('c2', 'ember', 'num', 7),
  card('c3', 'volt', 'num', 4),
  card('c4', 'frost', 'skip'),
  card('c5', 'vapor', 'hit2'),
  card('c6', null, 'wild'),
  card('c7', 'ember', 'snipe'),
];

function playView(over) {
  return {
    v: 3, phase: 'play', you: 'p1', isHost: true, yourTurn: true,
    players: [
      {id: 'p1', name: 'Ann', color: 'ember', count: 7, host: true, score: 0, out: false, quit: false},
      {id: 'p2', name: 'Bo', color: 'volt', count: 5, host: false, score: 0, out: false, quit: false},
    ],
    seats: ['p1', 'p2'], turnId: 'p1', dir: 1, color: 'ember',
    top: card('t1', 'ember', 'num', 5), drawCount: 40, pending: null, overload: false,
    winner: null, hand: HAND, playable: ['c1', 'c2', 'c6'],
    log: ['Hand 1 dealt.'], opts: Object.assign({}, over || {}),
    limit: 250, round: 1, history: [], lastRound: null, matchWinner: null,
  };
}

const ALL_ON = {snipe: true, mirror: true, overload: true, peek: true, gift: true, twin: true, trade: true, scramble: true, chain: true};
const ALL_OFF = {snipe: false, mirror: false, overload: false, peek: false, gift: false, twin: false, trade: false, scramble: false, chain: false};

function boot(handWidth) {
  const els = {};
  const store = {cb_name: 'Ann', cb_color: 'ember', cb_tok_ABC234: 'tok-1'};
  const calls = [];
  const ctx = {
    console: {log() {}, warn() {}, error() {}},
    setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
    addEventListener() {}, removeEventListener() {}, visualViewport: null,
    URLSearchParams, Math, JSON, Object, Array, String, Number, Boolean, Promise, Date, Error,
    document: {
      activeElement: null,
      getElementById: id => (els[id] = els[id] || fakeEl(id)),
      createElement: t => { const e = fakeEl('new'); e.tagName = String(t).toUpperCase(); return e; },
      createTextNode: t => ({textContent: String(t)}),
      createRange: () => ({selectNodeContents() {}}),
      querySelectorAll: () => [],
    },
    localStorage: {
      getItem: k => (store[k] === undefined ? null : store[k]),
      setItem: (k, v) => { store[k] = String(v); },
      removeItem: k => { delete store[k]; },
    },
    innerHeight: 844, innerWidth: 390,
    location: {origin: 'https://card-blast.example', pathname: '/', search: ''},
    history: {replaceState() {}},
    navigator: {clipboard: {writeText: async () => {}}},
    alert: m => { calls.push('alert:' + m); },
    getSelection: () => ({removeAllRanges() {}, addRange() {}}),
    fetch: async (url, opts) => {
      calls.push((opts && opts.method === 'POST' ? 'POST ' : 'GET ') + url);
      const body = {ok: true, view: playView(ALL_ON)};
      return {ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body)};
    },
  };
  ctx.window = ctx;
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC + '\n;globalThis.__T = {' +
    'applyView, showGuide, quitRoom, finishModal, cardMeaning, renderToggles, explainCard,' +
    'openModal, showScoresheet, askBlast, get modalDismissible(){return modalDismissible},' +
    'get room(){return room}, set room(v){room=v},' +
    'get view(){return view}, get pollTimer(){return pollTimer}' +
    '};', ctx, {filename: 'client.js'});
  // documentElement is where syncBarHeight parks the measured bar height.
  ctx.document.documentElement = fakeEl('documentElement');
  // The hand bar has a real width, so layoutHand can do its measuring. 348 is
  // roughly the usable width inside the bar on a 390pt phone.
  ctx.document.getElementById('hand').clientWidth = handWidth || 348;
  return {els, ctx, calls, store, T: ctx.__T};
}

/** Lays out a hand of n cards in a bar w wide and reports the geometry. */
function fan(n, w) {
  const b = boot(w);
  b.T.room = 'ABC234';
  const v = playView(ALL_ON);
  v.hand = [];
  for (let i = 0; i < n; i++) v.hand.push(card('f' + i, 'ember', 'num', i % 10));
  v.playable = ['f0'];
  b.T.applyView(v, true);
  const box = b.els['hand'];
  const cards = box.children;
  const cw = num(box.style._props['--cw']);
  const overlap = cards.length > 1 ? num(cards[1].style._props['--overlap']) : 0;
  const step = cw + overlap;
  // layoutHand reserves padding either side for the sideways swing of the
  // tilted end cards, so the usable width is what is left between them.
  const pad = num(box.style.paddingLeft || '0') || 0;
  return {
    b, cards, cw, overlap, step, pad,
    ch: num(box.style._props['--ch']),
    width: cards.length > 1 ? cw + (cards.length - 1) * step : cw,
    avail: (w || 348) - pad * 2,
    rots: cards.map(c => num(c.style._props['--rot'])),
    lifts: cards.map(c => num(c.style._props['--lift'])),
  };
}

const num = v => parseFloat(String(v));

// ------------------------------------------------------------------- the fan
// The promise is that the whole hand is on screen at once, at any hand size on
// any width, without sideways scrolling. These walk the real layout maths.
console.log('\nthe hand fans out');

// A phone in portrait, a phone in landscape, a tablet, a desktop.
const WIDTHS = [320, 348, 640, 834, 1100];
const SIZES = [1, 2, 6, 7, 12, 20, 30, 45];

{
  let worst = null, biggest = 0;
  WIDTHS.forEach(w => SIZES.forEach(n => {
    const f = fan(n, w);
    const slack = f.avail - f.width;
    if (worst === null || slack < worst.slack) worst = {w, n, slack, width: f.width, avail: f.avail};
    biggest = Math.max(biggest, f.cw);
    if (f.cards.length !== n) { fail++; console.log('  FAIL ' + n + ' cards at ' + w + 'px drew ' + f.cards.length); }
  }));
  check('every hand at every width fits without scrolling',
    worst.slack >= -0.5, JSON.stringify(worst));
  check('and the tilted end cards are inside the bar too',
    WIDTHS.every(w => SIZES.every(n => {
      const f = fan(n, w);
      return f.pad * 2 + f.width <= w + 0.5;
    })), 'a tilted card overhangs');
  check('and no card is drawn wider than a full-size one', biggest <= 96, String(biggest));
}

{
  const f = fan(7, 348);
  check('a starting hand keeps the cards a sensible size', f.cw >= 60, String(f.cw));
  check('cards keep their proportions', Math.abs(f.ch / f.cw - 131 / 91) < 0.02, f.ch + '/' + f.cw);
  check('the fan is symmetric about the middle',
    Math.abs(f.rots[0] + f.rots[6]) < 0.01, f.rots.join(','));
  check('the middle card is upright', Math.abs(f.rots[3]) < 0.01, String(f.rots[3]));
  check('it leans left to right', f.rots.every((r, i) => i === 0 || r > f.rots[i - 1]), f.rots.join(','));
  check('the outermost cards lean furthest', f.rots[0] < 0 && f.rots[6] > 0);
  check('nothing leans more than 13 degrees', f.rots.every(r => Math.abs(r) <= 13), f.rots.join(','));
  check('the ends of the fan sit lowest',
    Math.abs(f.lifts[0]) < 0.01 && Math.abs(f.lifts[6]) < 0.01, f.lifts.join(','));
  check('the middle of the fan rides highest',
    f.lifts[3] < f.lifts[2] && f.lifts[2] < f.lifts[1] && f.lifts[1] < f.lifts[0], f.lifts.join(','));
  check('cards stack left over right',
    f.cards.every((c, i) => Number(c.style.zIndex) === i + 1));
  check('the leftmost card is never pulled sideways',
    num(f.cards[0].style._props['--overlap']) === 0);
}

{
  const roomy = fan(3, 1100);
  check('a few cards on a wide screen simply sit side by side', roomy.overlap >= 0, String(roomy.overlap));
  const tight = fan(20, 348);
  check('a big hand overlaps to stay on screen', tight.overlap < 0, String(tight.overlap));
  check('and every card still shows a strip worth tapping',
    tight.step >= 10, 'step ' + tight.step.toFixed(1));
}

{
  const phone = fan(7, 320);
  const tablet = fan(7, 834);
  check('the same hand gets bigger cards on a tablet', tablet.cw > phone.cw, phone.cw + ' -> ' + tablet.cw);
  check('a tablet does not blow the cards up past full size', tablet.cw <= 96, String(tablet.cw));
}

{
  const huge = fan(45, 320);
  check('even a 45-card hand fits on the narrowest phone',
    huge.width <= huge.avail + 0.5, huge.width.toFixed(1) + ' in ' + huge.avail);
  check('cards shrink rather than spill off the side', huge.cw < fan(7, 320).cw);
  check('but never below a legible floor', huge.cw >= 46, String(huge.cw));
}

{
  // innerHeight in the harness is 844, a common phone.
  const f = fan(12, 348);
  check('the cards leave most of the screen for the table',
    f.ch <= 844 * 0.22, f.ch + 'px of 844');
  check('and are still big enough to read', f.cw >= 46, String(f.cw));
}

{
  const f = fan(1, 348);
  check('a single card sits straight', f.rots[0] === 0);
  check('and is not lifted', f.lifts[0] === 0);
}

{
  // The bar is fixed over the table, so the table has to reserve its height.
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  check('the table reserves room for the measured bar',
    b.ctx.document.documentElement.style._props['--bar-h'] === '210px',
    b.ctx.document.documentElement.style._props['--bar-h']);
}

// ------------------------------------------------------ tapping to find out
console.log('\ntapping a card you cannot play');
{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  const cards = b.els['hand'].children;
  const dead = cards.find(c => c.dataset.cardId === 'c4');   // a Skip, not playable
  const live = cards.find(c => c.dataset.cardId === 'c1');   // an Ember 3, playable

  check('an unplayable card is marked dead', dead._cls.has('dead'));
  check('but is not disabled, so it can still be tapped', dead.disabled === false);
  check('and says so to a screen reader', dead.getAttribute('aria-disabled') === 'true');
  check('it has something to do when tapped', typeof dead.onclick === 'function');
  check('a playable card is not marked disabled', live.getAttribute('aria-disabled') === undefined);

  dead.onclick();
  check('tapping it opens the explainer', b.els['modal']._cls.has('on'));
  check('the explainer names the card', b.els['mTitle'].textContent === 'SKIP', b.els['mTitle'].textContent);
  check('and says what it does',
    /loses their turn/i.test(b.els['mBody'].textContent), b.els['mBody'].textContent);
  check('and says why it will not go down',
    /Ember/.test(b.els['mChoices'].children[0].children[1].children[1].textContent),
    JSON.stringify(b.els['mChoices'].children.length));
}

{
  const b = boot();
  b.T.room = 'ABC234';
  const v = playView(ALL_ON);
  v.yourTurn = false;
  v.turnId = 'p2';
  b.T.applyView(v, true);
  const anyCard = b.els['hand'].children[0];
  anyCard.onclick();
  check('when it is not your turn the explainer says so',
    /Not your turn/i.test(b.els['mChoices'].children[0].children[1].children[0].textContent));
}

// ---------------------------------------------------------------- the guide
console.log('\nthe card guide');
{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.showGuide();
  const rows = b.els['mChoices'].children;
  const texts = rows.map(r => (r.children[1] ? r.children[1].children[0].textContent : r.textContent));
  check('the guide opens', b.els['modal']._cls.has('on'));
  check('it covers the seven core cards plus nine extras and a heading',
    rows.length === 7 + 1 + 9, String(rows.length));
  check('numbers are explained first', texts[0] === 'Numbers 0-9' || /Number/.test(texts[0]), texts[0]);
  check('the core actions are all there',
    ['SKIP', 'REVERSE', 'HIT 2', 'DISCARD ALL', 'WILD', 'WILD HIT FIRE'].every(t => texts.indexOf(t) !== -1),
    texts.join('|'));
  check('the extras are listed under a heading', texts.indexOf('Extras in this deck') !== -1);
  check('every listed extra is in the deck',
    ['SNIPE', 'MIRROR', 'OVERLOAD', 'PEEK', 'GIFT', 'TWIN', 'TRADE HANDS', 'SCRAMBLE', 'CHAIN REACTION']
      .every(t => texts.indexOf(t) !== -1), texts.join('|'));
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_OFF), true);
  b.T.showGuide();
  const rows = b.els['mChoices'].children;
  const texts = rows.map(r => (r.children[1] ? r.children[1].children[0].textContent : r.textContent));
  check('with the extras off only the core is described', rows.length === 7, String(rows.length));
  check('no heading for extras that are not there', texts.indexOf('Extras in this deck') === -1);
  check('and no extra is described', texts.indexOf('SNIPE') === -1);
}

// --------------------------------------------------------------- the extras
console.log('\nthe extras panel');
{
  const b = boot();
  b.T.room = 'ABC234';
  const v = playView(ALL_ON);
  v.phase = 'lobby';
  b.T.applyView(v, true);
  check('the full deck is 142 cards',
    /142 cards/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
  check('and reads as everything being in',
    /Everything in/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
  check('all nine extras get a toggle', b.els['toggles'].children.length === 9);
  check('"all on" is pointless when they are all on', b.els['extrasAll'].disabled === true);
  check('"core only" is still worth offering', b.els['extrasNone'].disabled === false);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  const v = playView(ALL_OFF);
  v.phase = 'lobby';
  b.T.applyView(v, true);
  check('the core deck is 112 cards',
    /112 cards/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
  check('and says so plainly',
    /Core deck only/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
  check('"core only" is pointless when they are all off', b.els['extrasNone'].disabled === true);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  const v = playView(Object.assign({}, ALL_ON, {trade: false, scramble: false, chain: false}));
  v.phase = 'lobby';
  b.T.applyView(v, true);
  check('switching the colourless extras off drops six cards',
    /136 cards/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
  check('the count is shown out of nine',
    /6 of 9 in/.test(b.els['extrasCount'].textContent), b.els['extrasCount'].textContent);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  const v = playView(ALL_ON);
  v.phase = 'lobby';
  v.isHost = false;
  b.T.applyView(v, true);
  check('a guest gets no quick switches', b.els['extrasQuick'].style.display === 'none');
  check('and cannot change a toggle', b.els['toggles'].children[0].children[0].disabled === true);
}

// ------------------------------------------------------------- getting out
// The bug this fixes: a forced-choice prompt hides the Cancel button, and the
// card guide used to reveal the modal without putting it back - so the guide
// opened with no way out, and Escape was gated on the same hidden button.
console.log('\nclosing a pop-up');
{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);

  // A forced choice first: this is what hid the button.
  b.T.askBlast();
  check('a forced choice offers no way out', b.T.modalDismissible === false);
  check('and hides both the close button and cancel',
    b.els['mCancel'].style.display === 'none' && b.els['mClose'].style.display === 'none');
  b.T.finishModal(false);

  // Now the guide, which is what used to trap you.
  b.T.showGuide();
  check('the guide that follows it can still be closed', b.T.modalDismissible === true);
  check('its cancel button is visible again',
    b.els['mCancel'].style.display === '', JSON.stringify(b.els['mCancel'].style.display));
  check('and so is the X', b.els['mClose'].style.display === '');
  b.els['mCancel'].onclick();
  check('the cancel button closes it', b.els['modal']._cls.has('on') === false);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.showGuide();
  b.els['mClose'].onclick();
  check('the X closes it', b.els['modal']._cls.has('on') === false);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.showGuide();
  b.els['modal'].onclick({target: b.els['modal']});
  check('tapping the dimmed backdrop closes it', b.els['modal']._cls.has('on') === false);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.showGuide();
  b.els['modal'].onclick({target: b.els['mChoices']});
  check('but tapping inside the sheet does not', b.els['modal']._cls.has('on') === true);
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.showGuide();
  b.els['modal'].onkeydown({key: 'Escape', preventDefault() {}});
  check('Escape closes it', b.els['modal']._cls.has('on') === false);
}

{
  // A forced choice must not be dismissible by the back door either.
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  b.T.askBlast();
  b.els['modal'].onclick({target: b.els['modal']});
  check('a forced choice ignores a backdrop tap', b.els['modal']._cls.has('on') === true);
  b.els['modal'].onkeydown({key: 'Escape', preventDefault() {}});
  check('and ignores Escape', b.els['modal']._cls.has('on') === true);
  b.T.finishModal(false);
}

{
  // Every read-only panel goes through the same door.
  ['showGuide', 'showScoresheet'].forEach(name => {
    const b = boot();
    b.T.room = 'ABC234';
    b.T.applyView(playView(ALL_ON), true);
    b.T.askBlast();
    b.T.finishModal(false);
    b.T[name]();
    check(name + ' can always be closed after a forced choice',
      b.T.modalDismissible === true && b.els['mCancel'].style.display === '');
  });
}

{
  const b = boot();
  b.T.room = 'ABC234';
  b.T.applyView(playView(ALL_ON), true);
  const dead = b.els['hand'].children.find(c => c.dataset.cardId === 'c4');
  b.T.askBlast();
  b.T.finishModal(false);
  dead.onclick();
  check('and so can a card explainer', b.T.modalDismissible === true);
  b.els['mClose'].onclick();
  check('which the X shuts', b.els['modal']._cls.has('on') === false);
}

// ---------------------------------------------------------------- leaving
console.log('\nleaving a room');
(async () => {
  {
    const b = boot();
    b.T.room = 'ABC234';
    b.T.applyView(playView(ALL_ON), true);
    const done = b.T.quitRoom();
    check('leaving asks first', b.els['modal']._cls.has('on'));
    check('and warns that the cards go back',
      /out of the match/i.test(b.els['mBody'].textContent), b.els['mBody'].textContent);
    b.T.finishModal(false);
    await done;
    check('saying no stays in the room', b.T.room === 'ABC234');
    check('and tells the server nothing', b.calls.every(c => c.indexOf('quit') === -1));
  }

  {
    const b = boot();
    b.T.room = 'ABC234';
    b.T.applyView(playView(ALL_ON), true);
    const done = b.T.quitRoom();
    b.T.finishModal(true);
    await done;
    check('saying yes tells the server',
      b.calls.some(c => c.indexOf('POST /api/room?action=quit') === 0), b.calls.join(' | '));
    check('the room is forgotten', b.T.room === '');
    check('the saved token is dropped so the link joins fresh',
      b.store['cb_tok_ABC234'] === undefined);
    check('it lands back on the home screen', b.els['screen-home']._cls.has('on'));
    check('the hand bar is put away', b.els['handbar'].style.display === 'none');
  }

  {
    const b = boot();
    b.T.room = 'ABC234';
    const v = playView(ALL_ON);
    v.phase = 'lobby';
    b.T.applyView(v, true);
    const done = b.T.quitRoom();
    check('leaving a lobby asks a gentler question',
      /taken out of this room/i.test(b.els['mBody'].textContent), b.els['mBody'].textContent);
    b.T.finishModal(true);
    await done;
    check('and still leaves', b.T.room === '');
  }

  {
    // The server going down is no reason to trap somebody in a room.
    const b = boot();
    b.ctx.fetch = async () => { throw new Error('offline'); };
    b.T.room = 'ABC234';
    b.T.applyView(playView(ALL_ON), true);
    const done = b.T.quitRoom();
    b.T.finishModal(true);
    await done;
    check('a failed call still gets you out', b.T.room === '');
  }

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
