// Random-game fuzzer for the Card Blast engine.
//
// The bots deliberately play from `viewFor()` alone — the same redacted blob a
// browser receives — and never touch the authoritative state. That makes this
// two tests in one: it shoves thousands of games through the rules looking for
// crashes and stuck states, and it proves the redacted view actually contains
// enough to play, while a leak check confirms it contains nothing more.
//
//   node test/sim.js            500 matches, 2-6 players
//   node test/sim.js 800 4      800 matches, pinned to 4 players
const engine = require('../api/_engine.js');
const crypto = require('crypto');

const N_GAMES = parseInt(process.argv[2] || '500', 10);
const FIXED = parseInt(process.argv[3] || '0', 10);
const token = () => crypto.randomBytes(18).toString('base64url');
const pick = a => a[Math.floor(Math.random() * a.length)];

const stats = {games: 0, moves: [], plays: 0, presses: 0, catches: 0, maxHand: 0, stuck: 0, rejected: 0, leaks: 0, hands: [], quits: 0};

// How often a bot rage-quits mid-hand. Low on purpose: the point is to hit the
// seat-removal path from every turn position and direction across many games,
// not to end matches early. Only fires with three or more still seated, so a
// quit never empties the table - that path has its own tests.
const QUIT_RATE = 0.003;

function totalCards(s) {
  return s.draw.length + s.discard.length + s.seats.reduce((n, id) => n + s.hands[id].length, 0);
}

/** Nothing in the view may name a card held by anyone else, or in the pile. */
function leakCheck(s, pid) {
  const wire = JSON.stringify(engine.viewFor(s, pid));
  const foreign = s.seats.filter(id => id !== pid).flatMap(id => s.hands[id].map(c => c.id)).concat(s.draw.map(c => c.id));
  return foreign.filter(id => wire.indexOf('"' + id + '"') !== -1);
}

/** Decide a move using only what the view exposes. */
function decide(view) {
  // Only seated players are legal targets; knocked-out ones still appear in
  // the player list but are out of the hand.
  const others = view.players.filter(p => p.id !== view.you && view.seats.indexOf(p.id) !== -1);

  // Catch anyone sitting quietly on one card — the view flags them.
  const quiet = others.find(p => p.uncalled && p.count === 1);
  if (quiet && Math.random() < 0.5) return {type: 'catch', target: quiet.id};

  const playable = view.hand.filter(c => view.playable.indexOf(c.id) !== -1);
  if (!playable.length || Math.random() > 0.97) return {type: 'press'};

  const card = pick(playable);
  const move = {type: 'play', cardId: card.id};
  if (engine.NEEDS_COLOR.indexOf(card.k) !== -1) move.color = pick(engine.COLORS);
  if (engine.NEEDS_TARGET.indexOf(card.k) !== -1) {
    if (card.k === 'gift' && view.hand.length === 1) { /* bare gift: no target needed */ }
    else {
      move.target = pick(others).id;
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

for (let g = 0; g < N_GAMES; g++) {
  const n = FIXED || 2 + (g % 5);
  const s = engine.createState();
  const seats = [];
  for (let i = 0; i < n; i++) seats.push(engine.addPlayer(s, 'P' + i, engine.COLORS[i % 4], token).playerId);

  // A host would switch some extras off; do that at random.
  const opts = {};
  engine.OPTIONAL.forEach(k => opts[k] = Math.random() < 0.8);
  s.opts = engine.sanitizeOpts(opts);
  engine.startGame(s);

  let deckSize = totalCards(s);
  let moves = 0, hands = 0;

  // A match is several hands, so this plays the whole thing: the inner loop is
  // one hand, and the outer loop re-deals until somebody wins the match. That
  // exercises scoring, knock-outs and re-dealing to a shrinking table.
  while (s.phase !== 'over' && moves < 12000) {
  while (s.phase === 'play' && moves < 12000) {
    const actor = s.seats[s.turn];
    const view = engine.viewFor(s, actor);

    if (!view.yourTurn) throw new Error('view disagrees with state about whose turn it is');
    if (moves % 25 === 0) {
      const leaked = leakCheck(s, actor);
      if (leaked.length) { stats.leaks += leaked.length; throw new Error('LEAK in view: ' + leaked.slice(0, 3).join(',')); }
    }

    // Someone walks out. Doing it here means it lands at every point in the
    // turn order, under both directions, with attacks pending.
    if (s.seats.length >= 3 && Math.random() < QUIT_RATE) {
      const victim = s.seats[Math.floor(Math.random() * s.seats.length)];
      const seatsBefore = s.seats.length;
      engine.quitGame(s, victim);
      stats.quits++;
      if (s.seats.length !== seatsBefore - 1) throw new Error('a quit did not free a seat');
      if (totalCards(s) !== deckSize) throw new Error(`CARD LEAK on quit game ${g}: ${totalCards(s)} != ${deckSize}`);
      if (s.phase === 'play' && (s.turn < 0 || s.turn >= s.seats.length)) throw new Error('BAD TURN INDEX after quit ' + s.turn);
      if (s.seats.indexOf(victim) !== -1) throw new Error('a leaver kept their seat');
      continue;
    }

    const move = decide(view);
    const beforeTurn = s.turn, beforeCount = s.hands[actor].length;

    try { engine.applyMove(s, actor, move); }
    catch (e) {
      // A bot playing from the view should never propose an illegal move.
      stats.rejected++;
      console.log('  rejected: ' + move.type + ' -> ' + e.message);
      engine.applyMove(s, actor, {type: 'press'});
    }

    if (move.type === 'play') stats.plays++;
    else if (move.type === 'press') stats.presses++;
    else stats.catches++;

    if (s.phase === 'play' && s.turn === beforeTurn && s.hands[actor].length === beforeCount && move.type !== 'catch') stats.stuck++;
    if (totalCards(s) !== deckSize) throw new Error(`CARD LEAK game ${g} move ${moves}: ${totalCards(s)} != ${deckSize}`);
    if (s.turn < 0 || s.turn >= s.seats.length) throw new Error('BAD TURN INDEX ' + s.turn);
    s.seats.forEach(id => { stats.maxHand = Math.max(stats.maxHand, s.hands[id].length); });
    moves++;
  }

    // The hand ended. Score it, then deal the next one if the match goes on.
    if (s.phase === 'round' || s.phase === 'over') hands++;
    if (s.phase === 'round') {
      const seatedBefore = s.seats.length;
      engine.startGame(s);
      deckSize = totalCards(s);   // fresh deck each hand
      if (s.seats.length > seatedBefore) throw new Error('a knocked-out player came back');
    }
  }

  if (s.phase !== 'over') { console.log(`match ${g} (${n}p): unfinished after ${moves} moves`); stats.stuck += 1000; }
  if (engine.activePlayers(s).length !== 1) { console.log(`match ${g}: ${engine.activePlayers(s).length} survivors`); stats.stuck += 1000; }
  if (s.matchWinner && s.quit && s.quit[s.matchWinner]) { console.log(`match ${g}: a leaver won`); stats.stuck += 1000; }
  stats.games++;
  stats.moves.push(moves);
  stats.hands.push(hands);
}

const avg = stats.moves.reduce((a, b) => a + b, 0) / stats.moves.length;
const avgHands = stats.hands.reduce((a, b) => a + b, 0) / stats.hands.length;
console.log('matches played   :', stats.games);
console.log('hands/match      :', avgHands.toFixed(1));
console.log('moves/match      :', avg.toFixed(1));
console.log('longest match    :', Math.max(...stats.moves), 'moves');
console.log('shortest match   :', Math.min(...stats.moves), 'moves');
console.log('plays/presses    :', stats.plays, '/', stats.presses, '  catches:', stats.catches);
console.log('biggest hand     :', stats.maxHand, 'cards');
console.log('mid-hand quits   :', stats.quits);
console.log('no-progress turns:', stats.stuck);
console.log('illegal proposals:', stats.rejected);
console.log('view leaks       :', stats.leaks);
process.exit(stats.stuck || stats.rejected || stats.leaks ? 1 : 0);
