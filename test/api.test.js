// End-to-end tests for api/room.js — the layer that actually enforces secrecy
// in production. Redis is faked in memory (including the compare-and-set Lua
// script), so this exercises the real handler: routing, tokens, host checks,
// versioning, and what genuinely goes out over the wire.
process.env.KV_REST_API_URL = 'https://fake.local';
process.env.KV_REST_API_TOKEN = 'fake-token';

// ---- fake Upstash REST ------------------------------------------------------
const store = new Map();
const reply = result => ({ok: true, status: 200, json: async () => ({result})});

global.fetch = async (url, opts) => {
  const args = JSON.parse(opts.body);
  const cmd = String(args[0]).toUpperCase();
  if (cmd === 'GET') return reply(store.has(args[1]) ? store.get(args[1]) : null);
  if (cmd === 'SET') { store.set(args[1], args[2]); return reply('OK'); }
  if (cmd === 'EVAL') {
    // args: EVAL script numkeys stateKey verKey expected stateJson next ttl
    const [, , , k1, k2, expected, stateJson, next] = args;
    const cur = store.has(k2) ? store.get(k2) : null;
    if (cur === expected || (cur === null && expected === '0')) {
      store.set(k1, stateJson);
      store.set(k2, next);
      return reply(1);
    }
    return reply(0);
  }
  throw new Error('fake redis got unexpected command ' + cmd);
};

const handler = require('../api/room.js');

/** Drives the serverless handler like Vercel would. */
function call(method, action, opts) {
  opts = opts || {};
  const req = {
    method,
    query: Object.assign({action}, opts.room ? {room: opts.room} : {}),
    headers: opts.token ? {'x-cb-token': opts.token} : {},
    body: opts.body ? JSON.stringify(opts.body) : '',
  };
  const out = {status: 200, body: null};
  const res = {
    status(c) { out.status = c; return res; },
    json(o) { out.body = o; return res; },
    send(s) { out.body = s; return res; },
    setHeader() { return res; },
    end() { return res; },
  };
  return handler(req, res).then(() => out);
}

let pass = 0, fail = 0;
const check = (name, cond, detail) => {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
};

(async () => {
console.log('\ncreating and joining');
const made = await call('POST', 'create');
check('create returns 200', made.status === 200, String(made.status));
const room = made.body.room;
check('create returns a room code', /^[A-Z2-9]{6}$/.test(room || ''), String(room));

const missing = await call('GET', 'exists', {room: 'ZZZZZZ'});
check('a room that does not exist reports 404', missing.status === 404);

const there = await call('GET', 'exists', {room});
check('a real room reports exists', there.status === 200 && there.body.exists === true);

const alice = await call('POST', 'join', {room, body: {name: 'Alice', color: 'volt'}});
check('join returns 200', alice.status === 200, JSON.stringify(alice.body));
check('join mints a token', typeof alice.body.token === 'string' && alice.body.token.length >= 20);
check('join returns a player id', typeof alice.body.playerId === 'string');
const aTok = alice.body.token;

const bob = await call('POST', 'join', {room, body: {name: 'Bob', color: 'frost'}});
const bTok = bob.body.token;
check('a second player can join', bob.status === 200 && bob.body.playerId !== alice.body.playerId);
check('the two tokens differ', aTok !== bTok);

console.log('\nhost authority');
const badStart = await call('POST', 'start', {room, token: bTok});
check('a non-host cannot deal', badStart.status === 400 && /only the host/i.test(badStart.body.error), JSON.stringify(badStart.body));

const badOpts = await call('POST', 'opts', {room, token: bTok, body: {opts: {snipe: false}}});
check('a non-host cannot change the deck', badOpts.status === 400 && /only the host/i.test(badOpts.body.error));

const setOpts = await call('POST', 'opts', {room, token: aTok, body: {opts: {snipe: false, evil: 'x'}}});
check('the host can change the deck', setOpts.status === 200);
check('unknown option keys never reach the state', setOpts.body.view.opts.evil === undefined);
check('the host’s choice is applied', setOpts.body.view.opts.snipe === false);

console.log('\nauthentication');
const noTok = await call('POST', 'start', {room});
check('a move with no token is rejected', noTok.status === 401, String(noTok.status));
const fakeTok = await call('POST', 'start', {room, token: 'totally-made-up-token'});
check('a move with a forged token is rejected', fakeTok.status === 401);

console.log('\ndealing');
const dealt = await call('POST', 'start', {room, token: aTok});
check('the host can deal', dealt.status === 200 && dealt.body.view.phase === 'play', JSON.stringify(dealt.body).slice(0, 120));
check('the dealer sees their own 7 cards', dealt.body.view.hand.length === 7);

console.log('\nwhat actually goes over the wire');
const aState = await call('GET', 'state', {room, token: aTok});
const bState = await call('GET', 'state', {room, token: bTok});
const anon = await call('GET', 'state', {room});

const aWire = JSON.stringify(aState.body);
const bHandIds = bState.body.view.hand.map(c => c.id);
const leaked = bHandIds.filter(id => aWire.indexOf('"' + id + '"') !== -1);
check('Alice’s response contains none of Bob’s card ids', leaked.length === 0, leaked.join(','));
check('Bob still gets his own 7 cards', bState.body.view.hand.length === 7);
check('each player sees a different hand',
  JSON.stringify(aState.body.view.hand) !== JSON.stringify(bState.body.view.hand));
check('the wire carries no draw pile', aState.body.view.draw === undefined && aWire.indexOf('"draw"') === -1);
check('the wire carries no hands map', aState.body.view.hands === undefined);
check('the wire carries no token table', aWire.indexOf('secrets') === -1 && aWire.indexOf(bTok) === -1);
check('a stranger with the room code gets no hand', anon.body.view.hand.length === 0);
check('a stranger still sees the player list', anon.body.view.players.length === 2);

console.log('\nmoves');
const view = aState.body.view;
const first = view.yourTurn ? {tok: aTok, v: view} : {tok: bTok, v: bState.body.view};
const second = view.yourTurn ? {tok: bTok, v: bState.body.view} : {tok: aTok, v: view};

const outOfTurn = await call('POST', 'move', {room, token: second.tok, body: {move: {type: 'press'}}});
check('a player cannot move out of turn', outOfTurn.status === 400 && /not your turn/i.test(outOfTurn.body.error), JSON.stringify(outOfTurn.body));

const stealCard = second.v.hand[0].id;
const forged = await call('POST', 'move', {room, token: first.tok, body: {move: {type: 'play', cardId: stealCard}}});
check('a player cannot play a card from another hand',
  forged.status === 400 && /not in your hand/i.test(forged.body.error), JSON.stringify(forged.body));

const before = JSON.parse(store.get('cb:' + room + ':v'));
const pressed = await call('POST', 'move', {room, token: first.tok, body: {move: {type: 'press'}}});
check('a legal press is accepted', pressed.status === 200, JSON.stringify(pressed.body).slice(0, 120));
const after = JSON.parse(store.get('cb:' + room + ':v'));
check('the version advances on a write', after === before + 1, before + ' -> ' + after);
check('the turn moved on', pressed.body.view.turnId !== first.v.you);

console.log('\nstale writes');
// Simulate another player having moved since we read: bump the version key so
// the compare-and-set inside mutate() no longer matches on the first attempt.
const bumped = await call('POST', 'move', {room, token: second.tok, body: {move: {type: 'press'}}});
check('the next player can then move', bumped.status === 200, JSON.stringify(bumped.body).slice(0, 100));

console.log('\njoining a game in progress');
const late = await call('POST', 'join', {room, body: {name: 'Carol', color: 'vapor'}});
check('nobody can join once the cards are dealt',
  late.status === 400 && /already started/i.test(late.body.error), JSON.stringify(late.body));

console.log('\nbad input');
const badRoom = await call('GET', 'state', {room: 'no spaces allowed!'});
check('an invalid room code is rejected', badRoom.status === 400);
const badAction = await call('POST', 'frobnicate', {room, token: aTok});
check('an unknown action is rejected', badAction.status === 405 || badAction.status === 400, String(badAction.status));
const badMove = await call('POST', 'move', {room, token: first.tok, body: {move: {type: 'teleport'}}});
check('an unknown move type is rejected', badMove.status === 400);

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
})().catch(e => { console.error('CRASH:', e.stack); process.exit(1); });
