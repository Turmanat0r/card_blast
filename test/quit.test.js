// Leaving the room. The awkward case is walking out mid-hand: a seat vanishes
// from under the turn index, an attack may be aimed at the leaver, and their
// cards have to go somewhere or the deck stops adding up.
process.env.KV_REST_API_URL = 'https://fake.local';
process.env.KV_REST_API_TOKEN = 'fake-token';

const engine = require('../api/_engine.js');
const crypto = require('crypto');
const token = () => crypto.randomBytes(18).toString('base64url');

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };
function throws(name, fn, match) {
  try { fn(); fail++; console.log('  FAIL ' + name + ' -> no error'); }
  catch (e) {
    if (match && !new RegExp(match, 'i').test(e.message)) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
    else { pass++; console.log('  ok   ' + name); }
  }
}

/** A table of n players, dealt unless `lobby` is set. */
function table(n, lobby) {
  const s = engine.createState();
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(engine.addPlayer(s, 'P' + i, engine.COLORS[i % 4], token).playerId);
  if (!lobby) engine.startGame(s);
  return {s, ids};
}

const countCards = s =>
  s.draw.length + s.discard.length + Object.keys(s.hands).reduce((n, k) => n + s.hands[k].length, 0);

// ------------------------------------------------------------------ the lobby
console.log('\nleaving the lobby');
{
  const {s, ids} = table(3, true);
  engine.quitGame(s, ids[1]);
  check('the player is gone from the roster', s.players.length === 2);
  check('the two who stayed are still seated in order',
    s.players.map(p => p.id).join() === [ids[0], ids[2]].join());
  check('their token no longer resolves', engine.playerIdForToken(s, ids[1]) === null);
  check('nobody is marked as having quit, they were erased',
    Object.keys(s.quit || {}).length === 0);
  check('the log says so', s.log.some(l => /P1 left/.test(l)));
  check('the lobby is still a lobby', s.phase === 'lobby');
}

{
  const s = engine.createState();
  const a = engine.addPlayer(s, 'Host', 'ember', token);
  const b = engine.addPlayer(s, 'Guest', 'volt', token);
  check('the first player is the host', engine.isHost(s, a.playerId));
  engine.quitGame(s, a.playerId);
  check('the host leaving hands the room to the next player', engine.isHost(s, b.playerId));
  check('the old host is not the host any more', engine.isHost(s, a.playerId) === false);
}

{
  const {s, ids} = table(2, true);
  engine.quitGame(s, ids[0]);
  throws('a lobby of one cannot deal', () => engine.startGame(s), 'at least two');
}

// ---------------------------------------------------------------- mid-hand
console.log('\nwalking out mid-hand');
{
  const {s, ids} = table(4);
  const deck = countCards(s);
  s.turn = 0;
  engine.quitGame(s, ids[2]);
  check('the deck still adds up', countCards(s) === deck, countCards(s) + ' != ' + deck);
  check('their hand is empty', s.hands[ids[2]].length === 0);
  check('their seat is gone', s.seats.indexOf(ids[2]) === -1);
  check('three seats remain', s.seats.length === 3);
  check('the turn still belongs to P0', s.seats[s.turn] === ids[0]);
  check('they are marked as having quit', s.quit[ids[2]] === true);
  check('they stay on the roster, the scoresheet names them', s.players.length === 4);
  check('they are no longer an active player',
    engine.activePlayers(s).map(p => p.id).indexOf(ids[2]) === -1);
}

{
  const {s, ids} = table(4);
  s.turn = 3; s.dir = 1;
  engine.quitGame(s, ids[1]);
  check('a seat leaving ahead of the turn drags the turn back', s.seats[s.turn] === ids[3]);
}

{
  const {s, ids} = table(4);
  s.turn = 1; s.dir = 1;
  engine.quitGame(s, ids[1]);
  check('leaving on your own turn passes play to the next seat', s.seats[s.turn] === ids[2]);
}

{
  const {s, ids} = table(4);
  s.turn = 1; s.dir = -1;
  engine.quitGame(s, ids[1]);
  check('play still runs backwards when the leaver was on turn', s.seats[s.turn] === ids[0]);
}

{
  const {s, ids} = table(4);
  s.turn = 0; s.dir = -1;
  engine.quitGame(s, ids[0]);
  check('leaving from seat zero backwards wraps to the last seat', s.seats[s.turn] === ids[3]);
}

{
  const {s, ids} = table(4);
  s.turn = 3; s.dir = 1;
  engine.quitGame(s, ids[3]);
  check('leaving from the last seat forwards wraps to the first', s.seats[s.turn] === ids[0]);
  check('the turn index stays in range', s.turn >= 0 && s.turn < s.seats.length);
}

{
  const {s, ids} = table(3);
  s.turn = 1;
  s.pending = {kind: 'hit', n: 4, from: ids[0]};
  engine.quitGame(s, ids[1]);
  check('an attack aimed at the leaver leaves with them', s.pending === null);
}

{
  const {s, ids} = table(3);
  s.turn = 0;
  s.pending = {kind: 'hit', n: 2, from: ids[2]};
  engine.quitGame(s, ids[1]);
  check('an attack on somebody else survives', !!s.pending && s.pending.n === 2);
}

{
  const {s, ids} = table(3);
  s.uncalled[ids[1]] = true;
  engine.quitGame(s, ids[1]);
  check('a leaver cannot still be caught', !s.uncalled[ids[1]]);
}

// -------------------------------------------------- quitting down to one
console.log('\nquitting down to the last player');
{
  const {s, ids} = table(3);
  engine.quitGame(s, ids[0]);
  check('two left, the hand goes on', s.phase === 'play' && s.seats.length === 2);
  engine.quitGame(s, ids[1]);
  check('the last player takes the hand', s.winner === ids[2], String(s.winner));
  check('and wins the match, being the only one left',
    s.phase === 'over' && s.matchWinner === ids[2]);
  check('the scoresheet gained a row', s.history.length === 1);
  check('the leavers were not charged for the hand they abandoned',
    s.history[0].deltas[ids[0]] === undefined && s.history[0].deltas[ids[1]] === undefined);
}

// --------------------------------------------------------- between hands
console.log('\nleaving between hands');
{
  const {s, ids} = table(3);
  engine.endRound(s, ids[0]);
  check('the hand is scored', s.phase === 'round');
  engine.quitGame(s, ids[1]);
  check('they are marked', s.quit[ids[1]] === true);
  check('the seats are untouched, that hand is history', s.seats.length === 3);
  engine.startGame(s);
  check('the next hand deals only to the two who stayed', s.seats.length === 2);
  check('the leaver got no cards', (s.hands[ids[1]] || []).length === 0);
}

{
  const {s, ids} = table(3);
  engine.endRound(s, ids[0]);
  engine.quitGame(s, ids[1]);
  engine.quitGame(s, ids[2]);
  throws('a table of one cannot deal the next hand', () => engine.startGame(s), 'at least two');
}

// A Mirror bounces a pending attack back at whoever sent it. If that player
// has since walked out there is no seat to bounce to, and the turn used to
// land on seat -1. The fuzzer found this the moment bots could quit.
console.log('\nmirroring an attack from someone who left');
{
  const {s, ids} = table(4);
  // P1 is on turn and owes P0 two presses; P0 then walks out. The attack has
  // to stay (it is not aimed at the leaver) with nobody left to bounce it at.
  s.turn = 1;
  s.pending = {kind: 'hit2', n: 2, from: ids[0]};
  engine.quitGame(s, ids[0]);
  const now = s.seats[s.turn];
  check('the attack outlived the player who sent it', !!s.pending && s.pending.from === ids[0]);
  const mirror = {id: 'mirror-gone', c: s.color, k: 'mirror'};
  s.hands[now].push(mirror);
  engine.applyMove(s, now, {type: 'play', cardId: mirror.id});
  check('the turn index survives the bounce', s.turn >= 0 && s.turn < s.seats.length, String(s.turn));
  check('the attack fizzles rather than chasing a ghost', s.pending === null);
  check('the log explains why', s.log.some(l => /had already left/.test(l)));
}

{
  const {s, ids} = table(4);
  s.turn = 1;
  s.pending = {kind: 'hit2', n: 2, from: ids[0]};
  const now = s.seats[s.turn];
  const mirror = {id: 'mirror-live', c: s.color, k: 'mirror'};
  s.hands[now].push(mirror);
  engine.applyMove(s, now, {type: 'play', cardId: mirror.id});
  check('a normal mirror still bounces back at a seated sender', s.seats[s.turn] === ids[0]);
  check('and adds one to the attack', !!s.pending && s.pending.n === 3, JSON.stringify(s.pending));
}

// ----------------------------------------------------------------- rules
console.log('\nwhat is not allowed');
{
  const {s, ids} = table(3);
  engine.quitGame(s, ids[0]);
  throws('you cannot leave twice', () => engine.quitGame(s, ids[0]), 'already left');
  throws('you cannot leave a room you are not in', () => engine.quitGame(s, 'p9-nobody'), 'not in this room');
}

{
  const {s, ids} = table(3);
  engine.quitGame(s, ids[0]);
  throws('a leaver cannot still play', () => engine.applyMove(s, ids[0], {type: 'press'}), 'not in this game');
}

{
  const {s, ids} = table(3);
  s.turn = 0;
  engine.quitGame(s, ids[1]);
  const view = engine.viewFor(s, ids[0]);
  check('the view flags who has left', view.players.find(p => p.id === ids[1]).quit === true);
  check('everyone else is not flagged', view.players.find(p => p.id === ids[0]).quit === false);
  check('the view still lists them, so the scoresheet can name them', view.players.length === 3);
  check('no leak in a view taken after a quit',
    JSON.stringify(view).indexOf(s.hands[ids[2]][0].id) === -1);
}

// ------------------------------------------------------------- over HTTP
console.log('\nover the wire');
const store = new Map();
const reply = result => ({ok: true, status: 200, json: async () => ({result})});
global.fetch = async (url, opts) => {
  const args = JSON.parse(opts.body);
  const cmd = String(args[0]).toUpperCase();
  if (cmd === 'GET') return reply(store.has(args[1]) ? store.get(args[1]) : null);
  if (cmd === 'SET') { store.set(args[1], args[2]); return reply('OK'); }
  if (cmd === 'EVAL') {
    const [, , , k1, k2, expected, stateJson, next] = args;
    const cur = store.has(k2) ? store.get(k2) : null;
    if (cur === expected || (cur === null && expected === '0')) {
      store.set(k1, stateJson); store.set(k2, next); return reply(1);
    }
    return reply(0);
  }
  throw new Error('unexpected redis command ' + cmd);
};

const handler = require('../api/room.js');
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
    status(c) { out.status = c; return res; }, json(o) { out.body = o; return res; },
    send(s) { out.body = s; return res; }, setHeader() { return res; }, end() { return res; },
  };
  return handler(req, res).then(() => out);
}

(async () => {
  const room = (await call('POST', 'create')).body.room;
  const a = (await call('POST', 'join', {room, body: {name: 'Ann', color: 'ember'}})).body;
  const b = (await call('POST', 'join', {room, body: {name: 'Bo', color: 'volt'}})).body;
  const c = (await call('POST', 'join', {room, body: {name: 'Cy', color: 'frost'}})).body;

  const noTok = await call('POST', 'quit', {room});
  check('quitting needs a token', noTok.status === 401, String(noTok.status));

  const left = await call('POST', 'quit', {room, token: c.token});
  check('a player can leave the lobby', left.status === 200 && left.body.ok === true);

  const again = await call('POST', 'quit', {room, token: c.token});
  check('their token is dead afterwards', again.status === 401, String(again.status));

  const seen = await call('GET', 'state', {room, token: a.token});
  check('the roster shrank', seen.body.view.players.length === 2);

  await call('POST', 'start', {room, token: a.token});
  const mid = await call('POST', 'quit', {room, token: b.token});
  check('a player can leave mid-hand', mid.status === 200, String(mid.status));
  check('the hand ended with one player left', mid.body.view.phase === 'over');

  const ghost = await call('POST', 'move', {room, token: b.token, body: {move: {type: 'press'}}});
  check('a leaver cannot move afterwards', ghost.status === 400, String(ghost.status));

  // A host walking out must not strand the table with nobody able to deal.
  const room2 = (await call('POST', 'create')).body.room;
  const h = (await call('POST', 'join', {room: room2, body: {name: 'Host', color: 'ember'}})).body;
  const g1 = (await call('POST', 'join', {room: room2, body: {name: 'G1', color: 'volt'}})).body;
  await call('POST', 'join', {room: room2, body: {name: 'G2', color: 'frost'}});
  await call('POST', 'start', {room: room2, token: h.token});
  await call('POST', 'quit', {room: room2, token: h.token});
  const now = await call('GET', 'state', {room: room2, token: g1.token});
  check('the host job passed to the next player', now.body.view.isHost === true);
  const opts = await call('POST', 'opts', {room: room2, token: g1.token, body: {limit: 150}});
  check('the new host is refused for the phase, not for being the wrong player',
    opts.status === 400 && /too late/i.test(opts.body.error || ''), JSON.stringify(opts.body));

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
