// Secrecy and validation tests — the reason the rules moved server-side.
//
// These are the tests that would have failed against the old design, where the
// browser held the whole game blob. They assert two things: a player's view
// never contains anyone else's cards, and the engine never takes a client's
// word for what is legal.
const crypto = require('crypto');
const engine = require('../api/_engine.js');

const realToken = () => crypto.randomBytes(18).toString('base64url');

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

/** A real dealt game with three players. */
function game() {
  const s = engine.createState();
  const alice = engine.addPlayer(s, 'Alice', 'volt', realToken);
  const bob   = engine.addPlayer(s, 'Bob', 'frost', realToken);
  const carol = engine.addPlayer(s, 'Carol', 'vapor', realToken);
  engine.startGame(s);
  return {s, alice, bob, carol};
}

const idsIn = cards => cards.map(c => c.id);

console.log('\nredaction — what a player can see');
{
  const {s, alice, bob, carol} = game();
  const view = engine.viewFor(s, alice.playerId);
  const wire = JSON.stringify(view);

  check('your own hand is present in full', view.hand.length === 7);
  check('your own cards are real card objects', view.hand.every(c => c.id && c.k));

  const others = idsIn(s.hands[bob.playerId]).concat(idsIn(s.hands[carol.playerId]));
  const leaked = others.filter(id => wire.indexOf('"' + id + '"') !== -1);
  check('no other player’s card ids appear anywhere in the view',
    leaked.length === 0, leaked.join(','));

  const drawLeak = idsIn(s.draw).filter(id => wire.indexOf('"' + id + '"') !== -1);
  check('no draw-pile card ids appear in the view', drawLeak.length === 0, drawLeak.slice(0, 3).join(','));

  check('other players are reduced to a count', view.players.every(p => typeof p.count === 'number'));
  check('the counts are still accurate',
    view.players.find(p => p.id === bob.playerId).count === 7);
  check('the draw pile is reduced to a length', typeof view.drawCount === 'number');
  check('the view carries no hands map', view.hands === undefined);
  check('the view carries no draw array', view.draw === undefined);
  check('the view carries no token table', view.secrets === undefined && wire.indexOf('secret') === -1);

  const tokens = [alice.token, bob.token, carol.token];
  check('no token appears in any view', tokens.every(t => wire.indexOf(t) === -1));
}

console.log('\nredaction — what a stranger with the room code can see');
{
  const {s, alice} = game();
  const spectator = engine.viewFor(s, null);
  const wire = JSON.stringify(spectator);
  check('a tokenless viewer gets no hand', spectator.hand.length === 0);
  const anyHand = Object.values(s.hands).flat().map(c => c.id);
  const leaked = anyHand.filter(id => wire.indexOf('"' + id + '"') !== -1);
  check('a tokenless viewer sees nobody’s cards', leaked.length === 0, leaked.slice(0, 3).join(','));
  check('a tokenless viewer still sees names and counts', spectator.players.length === 3);
}

console.log('\nidentity');
{
  const {s, alice, bob} = game();
  check('a valid token resolves to its player', engine.playerIdForToken(s, alice.token) === alice.playerId);
  check('tokens are not interchangeable', engine.playerIdForToken(s, bob.token) === bob.playerId);
  check('a bogus token resolves to nobody', engine.playerIdForToken(s, 'not-a-real-token') === null);
  check('an empty token resolves to nobody', engine.playerIdForToken(s, '') === null);
  check('tokens are long enough to not be guessable', alice.token.length >= 20);
  check('two players never share a token', alice.token !== bob.token);
}

console.log('\nmove validation — the client is not trusted');
{
  const {s, alice, bob} = game();
  const bobsCard = s.hands[bob.playerId][0];

  throws('you cannot move out of turn',
    () => engine.applyMove(s, bob.playerId, {type: 'press'}), 'not your turn');

  throws('you cannot play a card you do not hold',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: bobsCard.id}), 'not in your hand');

  throws('you cannot play a card that does not exist',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: 'c9999'}), 'not in your hand');

  throws('you cannot send an unknown move type',
    () => engine.applyMove(s, alice.playerId, {type: 'teleport'}), 'unknown move');

  throws('a player not in the game cannot move',
    () => engine.applyMove(s, 'p99-fake', {type: 'press'}), 'not in this game');
}
{
  // Illegal card: give Alice a card that cannot match, and prove the engine
  // rejects it even though the client asked nicely.
  const {s, alice} = game();
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top1'}];
  s.color = 'ember';
  const junk = {c: 'volt', k: 'num', n: 9, id: 'junk1'};
  s.hands[alice.playerId] = [junk];
  throws('an unplayable card is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: junk.id}), 'cannot play');
}
{
  const {s, alice, bob} = game();
  const wild = {c: null, k: 'wild', id: 'w1'};
  s.hands[alice.playerId] = [wild, {c: 'ember', k: 'num', n: 1, id: 'k1'}];
  throws('a wild with no colour is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: wild.id}), 'pick a colour');
  throws('a wild with an invented colour is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: wild.id, color: 'chartreuse'}), 'pick a colour');
  engine.applyMove(s, alice.playerId, {type: 'play', cardId: wild.id, color: 'frost'});
  check('a wild with a real colour is accepted', s.color === 'frost');
}
{
  const {s, alice, bob} = game();
  const trade = {c: null, k: 'trade', id: 't1'};
  s.hands[alice.playerId] = [trade, {c: 'ember', k: 'num', n: 1, id: 'k2'}];
  throws('targeting yourself is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: trade.id, target: alice.playerId}), 'another player');
  throws('targeting a stranger is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: trade.id, target: 'p42-nope'}), 'another player');
  throws('targeting nobody is rejected',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: trade.id}), 'another player');
}
{
  const {s, alice, bob} = game();
  const gift = {c: 'ember', k: 'gift', id: 'g1'};
  s.hands[alice.playerId] = [gift, {c: 'ember', k: 'num', n: 1, id: 'k3'}];
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top2'}];
  s.color = 'ember';
  const bobsCard = s.hands[bob.playerId][0];
  throws('you cannot gift a card out of someone else’s hand',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: gift.id, target: bob.playerId, giftCardId: bobsCard.id}), 'card to give');
  throws('you cannot gift the gift card itself',
    () => engine.applyMove(s, alice.playerId, {type: 'play', cardId: gift.id, target: bob.playerId, giftCardId: gift.id}), 'card to give');
}
{
  const {s, alice, bob} = game();
  throws('you cannot catch someone who is not on one card',
    () => engine.applyMove(s, alice.playerId, {type: 'catch', target: bob.playerId}), 'nothing to catch');
  throws('you cannot catch yourself',
    () => engine.applyMove(s, alice.playerId, {type: 'catch', target: alice.playerId}), 'no such player');
}

console.log('\nhost authority');
{
  const s = engine.createState();
  const a = engine.addPlayer(s, 'Alice', 'volt', realToken);
  const b = engine.addPlayer(s, 'Bob', 'frost', realToken);
  check('the first player is the host', engine.isHost(s, a.playerId));
  check('a later player is not the host', !engine.isHost(s, b.playerId));
  check('a stranger is not the host', !engine.isHost(s, 'p9-nope'));
}

console.log('\noption sanitising');
{
  const clean = engine.sanitizeOpts({snipe: true, mirror: false, evilKey: 'rm -rf', __proto__: {x: 1}});
  check('unknown option keys are dropped', clean.evilKey === undefined);
  check('known options survive', clean.snipe === true && clean.mirror === false);
  check('every optional card gets a boolean', engine.OPTIONAL.every(k => typeof clean[k] === 'boolean'));
  check('a non-object is handled', typeof engine.sanitizeOpts(null).snipe === 'boolean');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
