// Scoring and elimination: card values, the running scoresheet, knock-outs,
// and how long a match actually lasts at each limit.
const engine = require('../api/_engine.js');
const crypto = require('crypto');
const token = () => crypto.randomBytes(18).toString('base64url');
const pick = a => a[Math.floor(Math.random() * a.length)];

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };
function throws(name, fn, match) {
  try { fn(); fail++; console.log('  FAIL ' + name + ' -> no error'); }
  catch (e) {
    if (match && !new RegExp(match, 'i').test(e.message)) { fail++; console.log('  FAIL ' + name + ' -> ' + e.message); }
    else { pass++; console.log('  ok   ' + name); }
  }
}

function table(n, limit) {
  const s = engine.createState();
  const ids = [];
  for (let i = 0; i < n; i++) ids.push(engine.addPlayer(s, 'P' + i, engine.COLORS[i % 4], token).playerId);
  if (limit) s.limit = limit;
  return {s, ids};
}

console.log('\ncard values');
{
  check('a number card is worth its face value', engine.cardValue({k: 'num', n: 7, c: 'ember'}) === 7);
  check('a zero is worth nothing', engine.cardValue({k: 'num', n: 0, c: 'volt'}) === 0);
  check('a coloured action is 20', engine.cardValue({k: 'skip', c: 'ember'}) === 20);
  check('an extra like Snipe scores as an action', engine.cardValue({k: 'snipe', c: 'frost'}) === 20);
  check('a wild is 50', engine.cardValue({k: 'wild', c: null}) === 50);
  check('Wild Hit Fire is 50', engine.cardValue({k: 'wildfire', c: null}) === 50);
  check('a colourless extra scores as a wild', engine.cardValue({k: 'scramble', c: null}) === 50);
  check('a missing card is worth nothing', engine.cardValue(null) === 0);

  const hand = [{k: 'num', n: 9}, {k: 'num', n: 3}, {k: 'skip'}, {k: 'wild', c: null}];
  check('a hand adds up (9+3+20+50 = 82)', engine.handValue(hand) === 82, String(engine.handValue(hand)));
  check('an empty hand is zero', engine.handValue([]) === 0);

  const deck = engine.buildDeck(engine.defaultOpts());
  check('the full deck is worth 2100', engine.handValue(deck) === 2100, String(engine.handValue(deck)));
}

console.log('\nend of a hand');
{
  const {s, ids} = table(3, 250);
  engine.startGame(s);
  check('the first hand is hand 1', s.round === 1, String(s.round));

  // Force a known finish: P0 plays their last card, the others hold known hands.
  const last = {c: 'ember', k: 'num', n: 5, id: 'last1'};
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top'}];
  s.color = 'ember';
  s.turn = 0;
  s.hands[ids[0]] = [last];
  s.hands[ids[1]] = [{k: 'num', n: 9}, {k: 'skip'}];              // 29
  s.hands[ids[2]] = [{k: 'wild', c: null}, {k: 'num', n: 4}];     // 54
  engine.applyMove(s, ids[0], {type: 'play', cardId: last.id});

  check('the hand ends, the match does not', s.phase === 'round', s.phase);
  check('the winner of the hand is recorded', s.winner === ids[0]);
  check('the winner scores nothing', s.scores[ids[0]] === 0, String(s.scores[ids[0]]));
  check('a loser is charged for what they held (29)', s.scores[ids[1]] === 29, String(s.scores[ids[1]]));
  check('the other loser too (54)', s.scores[ids[2]] === 54, String(s.scores[ids[2]]));
  check('nobody is knocked out yet', engine.activePlayers(s).length === 3);
  check('the scoresheet gained a row', s.history.length === 1);
  check('the row records the hand winner', s.history[0].winner === ids[0]);
  check('the row records each delta', s.history[0].deltas[ids[2]] === 54);

  const before = s.scores[ids[1]];
  engine.startGame(s);
  check('the next hand deals', s.phase === 'play' && s.round === 2, s.phase + ' r' + s.round);
  check('scores carry across hands', s.scores[ids[1]] === before);
  check('everyone gets a fresh 7', s.seats.every(id => s.hands[id].length === 7));
}

console.log('\nknock-out');
{
  const {s, ids} = table(3, 250);
  engine.startGame(s);
  s.scores[ids[1]] = 240;                       // one bad hand from going out
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top'}];
  s.color = 'ember';
  s.turn = 0;
  const last = {c: 'ember', k: 'num', n: 5, id: 'last2'};
  s.hands[ids[0]] = [last];
  s.hands[ids[1]] = [{k: 'num', n: 9}, {k: 'num', n: 6}];   // 15 -> 255, over
  s.hands[ids[2]] = [{k: 'num', n: 2}];                     // 2
  engine.applyMove(s, ids[0], {type: 'play', cardId: last.id});

  check('crossing the limit knocks you out', s.eliminated[ids[1]] === true, JSON.stringify(s.scores));
  check('the knock-out is reported', (s.lastRound.out || []).indexOf(ids[1]) !== -1);
  check('players under the limit stay in', !s.eliminated[ids[2]] && !s.eliminated[ids[0]]);
  check('two players still in', engine.activePlayers(s).length === 2);

  engine.startGame(s);
  check('a knocked-out player is not dealt in', s.seats.indexOf(ids[1]) === -1, s.seats.join(','));
  check('the remaining two are seated', s.seats.length === 2);
  check('a knocked-out player cannot move',
    (() => { try { engine.applyMove(s, ids[1], {type: 'press'}); return false; } catch (e) { return /not in this game|not your turn/i.test(e.message); } })());
}

console.log('\nexactly on the limit');
{
  const {s, ids} = table(2, 150);
  engine.startGame(s);
  s.scores[ids[1]] = 140;
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top'}];
  s.color = 'ember';
  s.turn = 0;
  const last = {c: 'ember', k: 'num', n: 5, id: 'last3'};
  s.hands[ids[0]] = [last];
  s.hands[ids[1]] = [{k: 'num', n: 6}, {k: 'num', n: 4}];   // exactly 150
  engine.applyMove(s, ids[0], {type: 'play', cardId: last.id});
  check('reaching the limit exactly is out', s.eliminated[ids[1]] === true, String(s.scores[ids[1]]));
  check('last player standing wins the match', s.phase === 'over' && s.matchWinner === ids[0], s.phase);
}

console.log('\nwinning a hand can never knock you out');
{
  const {s, ids} = table(2, 150);
  engine.startGame(s);
  s.scores[ids[0]] = 149;                       // one point from the edge
  s.discard = [{c: 'ember', k: 'num', n: 5, id: 'top'}];
  s.color = 'ember';
  s.turn = 0;
  const last = {c: 'ember', k: 'num', n: 5, id: 'last4'};
  s.hands[ids[0]] = [last];
  s.hands[ids[1]] = [{k: 'num', n: 1}];
  engine.applyMove(s, ids[0], {type: 'play', cardId: last.id});
  check('the hand winner adds zero and survives on 149', !s.eliminated[ids[0]], String(s.scores[ids[0]]));
}

console.log('\nlimits and resets');
{
  check('the default limit is one of the offered ones', engine.LIMITS.indexOf(engine.DEFAULT_LIMIT) !== -1);
  check('an off-menu limit falls back to the default', engine.sanitizeLimit(9999) === engine.DEFAULT_LIMIT);
  check('junk falls back to the default', engine.sanitizeLimit('abc') === engine.DEFAULT_LIMIT);
  check('an offered limit is kept', engine.sanitizeLimit(400) === 400);

  const {s, ids} = table(2, 150);
  engine.startGame(s);
  s.scores[ids[0]] = 100;
  s.eliminated[ids[1]] = true;
  s.history.push({round: 1, winner: ids[0], deltas: {}});
  engine.resetMatch(s);
  check('a reset clears the scores', Object.keys(s.scores).length === 0);
  check('a reset brings everyone back', Object.keys(s.eliminated).length === 0);
  check('a reset empties the scoresheet', s.history.length === 0 && s.round === 0);

  const solo = table(2, 150);
  engine.startGame(solo.s);
  solo.s.eliminated[solo.ids[1]] = true;
  solo.s.phase = 'round';
  throws('a hand cannot be dealt to one player', () => engine.startGame(solo.s), 'at least two');
}

console.log('\nthe scoresheet is visible to everyone (it is meant to be read)');
{
  const {s, ids} = table(3, 250);
  engine.startGame(s);
  s.scores[ids[1]] = 87;
  const v = engine.viewFor(s, ids[0]);
  check('the view carries the limit', v.limit === 250);
  check('the view carries every score', v.players.find(p => p.id === ids[1]).score === 87);
  check('the view carries the hand number', v.round === 1);
  check('the view carries the history array', Array.isArray(v.history));
  // ...but still no cards.
  const wire = JSON.stringify(v);
  const others = s.hands[ids[1]].map(c => c.id).concat(s.hands[ids[2]].map(c => c.id));
  check('scoring did not leak anyone’s cards',
    others.every(id => wire.indexOf('"' + id + '"') === -1));
}

console.log('\nhow long a match runs (measured, 30 matches each)');
{
  function decide(view) {
    const playable = view.hand.filter(c => view.playable.indexOf(c.id) !== -1);
    if (!playable.length || Math.random() > 0.97) return {type: 'press'};
    const card = pick(playable);
    const move = {type: 'play', cardId: card.id};
    if (engine.NEEDS_COLOR.indexOf(card.k) !== -1) move.color = pick(engine.COLORS);
    if (engine.NEEDS_TARGET.indexOf(card.k) !== -1) {
      if (!(card.k === 'gift' && view.hand.length === 1)) {
        move.target = pick(view.seats.filter(id => id !== view.you));
        if (card.k === 'gift') {
          const rest = view.hand.filter(c => c.id !== card.id);
          if (!rest.length) return {type: 'press'};
          move.giftCardId = pick(rest).id;
        }
      }
    }
    if (view.hand.length === 2) move.callBlast = Math.random() < 0.7;
    return move;
  }

  function playMatch(n, limit) {
    const {s} = table(n, limit);
    engine.startGame(s);
    let hands = 0, guard = 0;
    while (s.phase !== 'over' && guard++ < 300) {
      let moves = 0;
      while (s.phase === 'play' && moves++ < 20000) {
        const actor = s.seats[s.turn];
        engine.applyMove(s, actor, decide(engine.viewFor(s, actor)));
      }
      hands++;
      if (s.phase === 'round') engine.startGame(s);
    }
    return {hands, finished: s.phase === 'over', s};
  }

  engine.LIMITS.forEach(limit => {
    const runs = [];
    for (let i = 0; i < 30; i++) runs.push(playMatch(4, limit));
    const avg = runs.reduce((a, r) => a + r.hands, 0) / runs.length;
    check('limit ' + limit + ': every match finishes', runs.every(r => r.finished));
    check('limit ' + limit + ': one winner left standing',
      runs.every(r => engine.activePlayers(r.s).length === 1));
    console.log('         ~' + avg.toFixed(1) + ' hands for 4 players');
  });

  // The default should be a sitting, not an afternoon.
  const def = [];
  for (let i = 0; i < 30; i++) def.push(playMatch(4, engine.DEFAULT_LIMIT).hands);
  const avgDef = def.reduce((a, b) => a + b, 0) / def.length;
  check('the default limit lands between 3 and 9 hands', avgDef >= 3 && avgDef <= 9, avgDef.toFixed(1));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
