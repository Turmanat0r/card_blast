// Rule tests for the Card Blast engine. The engine is a plain module now that
// the rules live server-side, so these drive it directly — no DOM, no stubs.
const engine = require('../api/_engine.js');

// ---- deterministic randomness -------------------------------------------
const rolls = [];
const realRandom = Math.random;
Math.random = () => (rolls.length ? rolls.shift() : 0.99);

// ---- helpers -------------------------------------------------------------
let uid = 0;
const C = (c, k, n) => ({c, k, n, id: 'x' + (uid++)});
const NUM = (c, n) => C(c, 'num', n);

let tokenSeq = 0;
const seqToken = () => 'token' + (tokenSeq++) + 'aaaaaaaaaaaa';

/** Builds a state mid-game with exactly the hands a test needs. */
function setup(names, handsByName, extra) {
  const s = engine.createState();
  const ids = {};
  names.forEach(n => { ids[n] = engine.addPlayer(s, n, 'ember', seqToken).playerId; });

  s.phase = 'play';
  s.seats = names.map(n => ids[n]);
  s.hands = {};
  names.forEach(n => s.hands[ids[n]] = (handsByName[n] || []).slice());
  s.draw = Array.from({length: 40}, () => NUM('frost', 7));
  s.discard = [NUM('ember', 5)];
  s.color = 'ember';
  s.turn = 0;
  s.dir = 1;
  s.pending = null;
  s.overload = false;
  s.uncalled = {};
  s.winner = null;
  s.log = [];
  Object.assign(s, extra || {});
  return {s, ids};
}

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? '  -> ' + detail : '')); }
}
function throws(name, fn, match) {
  try { fn(); fail++; console.log('  FAIL ' + name + '  -> no error thrown'); }
  catch (e) {
    if (match && !new RegExp(match, 'i').test(e.message)) { fail++; console.log('  FAIL ' + name + '  -> wrong error: ' + e.message); }
    else { pass++; console.log('  ok   ' + name); }
  }
}

console.log('\nturn rotation');
{
  const rev = C('ember', 'rev');
  const {s, ids} = setup(['a', 'b'], {a: [rev, NUM('ember', 1)], b: [NUM('ember', 2)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: rev.id});
  check('reverse with 2 players acts as a skip', s.turn === 0, 'turn=' + s.turn);
}
{
  const rev = C('ember', 'rev');
  const {s, ids} = setup(['a', 'b', 'c'], {a: [rev, NUM('ember', 1)], b: [], c: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: rev.id});
  check('reverse with 3 players flips direction', s.dir === -1, 'dir=' + s.dir);
  check('reverse with 3 players passes backwards to c', s.turn === 2, 'turn=' + s.turn);
}
{
  const skip = C('ember', 'skip');
  const {s, ids} = setup(['a', 'b', 'c'], {a: [skip, NUM('ember', 1)], b: [], c: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: skip.id});
  check('skip jumps over b to c', s.turn === 2, 'turn=' + s.turn);
}

console.log('\nattacks');
{
  const h1 = C('ember', 'hit2'), h2 = C('frost', 'hit2');
  const {s, ids} = setup(['a', 'b', 'c'], {a: [h1, NUM('ember', 1)], b: [h2, NUM('ember', 2)], c: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: h1.id});
  check('hit 2 creates a 2-press debt', s.pending && s.pending.n === 2, JSON.stringify(s.pending));
  engine.applyMove(s, ids.b, {type: 'play', cardId: h2.id});
  check('hit 2 stacks to 4 presses', s.pending && s.pending.n === 4, JSON.stringify(s.pending));
  check('stacked debt now points at c', s.turn === 2, 'turn=' + s.turn);
}
{
  const h1 = C('ember', 'hit2'), mir = C('frost', 'mirror');
  const {s, ids} = setup(['a', 'b', 'c'], {a: [h1, NUM('ember', 1)], b: [mir, NUM('ember', 2)], c: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: h1.id});
  engine.applyMove(s, ids.b, {type: 'play', cardId: mir.id});
  check('mirror sends the attack back to a', s.turn === 0, 'turn=' + s.turn);
  check('mirror adds one press (2 -> 3)', s.pending && s.pending.n === 3, JSON.stringify(s.pending));
  check('mirror reassigns the attacker to b', s.pending && s.pending.from === ids.b);
}
{
  const h = C('ember', 'hit2'), junk = NUM('volt', 9);
  const {s, ids} = setup(['a', 'b'], {a: [h, NUM('ember', 1)], b: [junk, C('volt', 'skip')]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: h.id});
  check('under attack, unrelated cards are illegal', s.hands[ids.b].filter(c => engine.canPlay(s, c)).length === 0);
  throws('under attack, playing junk is rejected',
    () => engine.applyMove(s, ids.b, {type: 'play', cardId: junk.id}), 'cannot play');
}
{
  const ov = C('ember', 'overload');
  const {s, ids} = setup(['a', 'b'], {a: [ov, NUM('ember', 1)], b: [NUM('volt', 3)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: ov.id});
  check('overload arms the launcher', s.overload === true);
  rolls.push(0.5, 0);                    // band 1-2, sub-roll 0 => 1 card, doubled => 2
  engine.applyMove(s, ids.b, {type: 'press'});
  check('overloaded press fires double (1 -> 2)', s.hands[ids.b].length === 3, 'hand=' + s.hands[ids.b].length);
  check('overload is spent after one launch', s.overload === false);
}

console.log('\nhand manipulation');
{
  const da = C('ember', 'discardall');
  const {s, ids} = setup(['a', 'b'], {a: [da, NUM('ember', 3), NUM('ember', 8), NUM('volt', 4)], b: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: da.id});
  check('discard all dumps every card of that colour',
    s.hands[ids.a].length === 1 && s.hands[ids.a][0].c === 'volt');
}
{
  const tr = C(null, 'trade');
  const {s, ids} = setup(['a', 'b'], {a: [tr, NUM('ember', 3)], b: [NUM('volt', 1), NUM('volt', 2), NUM('volt', 5)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: tr.id, target: ids.b});
  check('trade hands swaps sizes (1 <-> 3)', s.hands[ids.a].length === 3 && s.hands[ids.b].length === 1);
  check('trade gives a the volt cards', s.hands[ids.a].every(c => c.c === 'volt'));
}
{
  const sc = C(null, 'scramble');
  const bMark = NUM('volt', 1), cMark = NUM('frost', 2);
  const {s, ids} = setup(['a', 'b', 'c'], {a: [sc, NUM('ember', 9)], b: [bMark], c: [cMark]});
  const before = s.seats.reduce((n, id) => n + s.hands[id].length, 0);
  engine.applyMove(s, ids.a, {type: 'play', cardId: sc.id});
  const after = s.seats.reduce((n, id) => n + s.hands[id].length, 0);
  check('scramble conserves every card', after === before - 1, before + ' -> ' + after);
  check("scramble moves b's hand to c", s.hands[ids.c].some(x => x.id === bMark.id));
  check("scramble moves c's hand to a", s.hands[ids.a].some(x => x.id === cMark.id));
}
{
  const gf = C('ember', 'gift'), keep = NUM('volt', 4);
  const {s, ids} = setup(['a', 'b'], {a: [gf, keep], b: []});
  engine.applyMove(s, ids.a, {type: 'play', cardId: gf.id, target: ids.b, giftCardId: keep.id});
  check('gift moves the chosen card to the target',
    s.hands[ids.b].length === 1 && s.hands[ids.b][0].id === keep.id);
  check('gift empties the giver and takes the hand', s.phase === 'round' && s.winner === ids.a, s.phase);
}
{
  const gf = C('ember', 'gift');
  const {s, ids} = setup(['a', 'b'], {a: [gf], b: [NUM('volt', 1)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: gf.id});
  check('gift as your last card simply takes the hand', s.phase === 'round' && s.winner === ids.a, s.phase);
}
{
  const pk = C('ember', 'peek');
  const secret = NUM('volt', 6);
  const {s, ids} = setup(['a', 'b'], {a: [pk, NUM('ember', 2)], b: [secret]});
  const out = engine.applyMove(s, ids.a, {type: 'play', cardId: pk.id, target: ids.b});
  check('peek returns the target hand to the mover', out.peek && out.peek.hand[0].id === secret.id);
  check('peek does not write the hand into shared state',
    JSON.stringify(s.log).indexOf(secret.id) === -1);
}

console.log('\nthe blast call');
{
  const c1 = NUM('ember', 3);
  const {s, ids} = setup(['a', 'b'], {a: [c1, NUM('volt', 7)], b: [NUM('volt', 1)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: c1.id});   // no callBlast
  check('staying quiet on one card flags you', s.uncalled[ids.a] === true);
  rolls.push(0.5, 0, 0.5, 0);
  engine.applyMove(s, ids.b, {type: 'catch', target: ids.a});
  check('catching adds two presses of cards', s.hands[ids.a].length === 3, 'hand=' + s.hands[ids.a].length);
  check('catching clears the flag', !s.uncalled[ids.a]);
}
{
  const c1 = NUM('ember', 3);
  const {s, ids} = setup(['a', 'b'], {a: [c1, NUM('volt', 7)], b: [NUM('volt', 1)]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: c1.id, callBlast: true});
  check('calling blast leaves you unflagged', !s.uncalled[ids.a]);
  throws('catching someone who called is rejected',
    () => engine.applyMove(s, ids.b, {type: 'catch', target: ids.a}), 'nothing to catch');
}

console.log('\nwinning');
{
  const last = NUM('ember', 3);
  const {s, ids} = setup(['a', 'b'], {a: [last], b: [NUM('volt', 1), C('volt', 'skip')]});
  engine.applyMove(s, ids.a, {type: 'play', cardId: last.id});
  // Emptying your hand ends the HAND. Whether the MATCH is over is decided by
  // the scoresheet — that is test/match.test.js's job.
  check('emptying your hand ends the hand', s.phase === 'round', s.phase);
  check('the winner of the hand is recorded', s.winner === ids.a);
  check('the winner is charged nothing', s.scores[ids.a] === 0, String(s.scores[ids.a]));
  check('the loser is charged for what they held (1+20)', s.scores[ids.b] === 21, String(s.scores[ids.b]));
  throws('no moves once the hand is over',
    () => engine.applyMove(s, ids.b, {type: 'press'}), 'not running');
}

console.log('\ndeck');
{
  const s = engine.createState();
  ['a', 'b', 'c', 'd'].forEach(n => engine.addPlayer(s, n, 'ember', seqToken));
  engine.startGame(s);
  const total = s.draw.length + s.discard.length + Object.values(s.hands).reduce((n, h) => n + h.length, 0);
  check('full deck is 142 cards', total === 142, String(total));
  check('everyone is dealt 7', Object.values(s.hands).every(h => h.length === 7));
  check('the starting card is a plain number', s.discard[0].k === 'num', s.discard[0].k);

  const bare = engine.createState();
  ['a', 'b'].forEach(n => engine.addPlayer(bare, n, 'ember', seqToken));
  bare.opts = engine.sanitizeOpts({});   // every optional card off
  engine.startGame(bare);
  const bareTotal = bare.draw.length + bare.discard.length + Object.values(bare.hands).reduce((n, h) => n + h.length, 0);
  // 76 numbers + 24 skip/rev/hit2 + 4 discard-all + 4 wild + 4 wild-hit-fire
  check('deck with all extras off is 112 cards', bareTotal === 112, String(bareTotal));
}

console.log('\nlobby');
{
  const s = engine.createState();
  const a = engine.addPlayer(s, 'Alice', 'volt', seqToken);
  engine.addPlayer(s, 'Bob', 'frost', seqToken);
  check('first player is the host', engine.isHost(s, a.playerId));
  throws('one player cannot start a game', () => { const t = engine.createState(); engine.addPlayer(t, 'Solo', 'ember', seqToken); engine.startGame(t); }, 'at least two');
  engine.startGame(s);
  throws('nobody can join after the deal', () => engine.addPlayer(s, 'Late', 'ember', seqToken), 'already started');
}

Math.random = realRandom;
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
