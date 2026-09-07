// lib/engine.js
//
// The authoritative rules of Card Blast. This module is the ONLY place the
// game is decided. It runs inside the serverless function, never in the
// browser, because the browser is not trustworthy: if the client could deal
// cards or judge a move, a player with devtools could deal themselves a
// winning hand or read everyone else's.
//
// Two rules keep that property intact — break either and hands stop being
// secret:
//
//   1. Nothing here trusts its caller. Every move is re-validated against the
//      server's own copy of the state: whose turn it is, whether the card is
//      really in that player's hand, whether it is really playable.
//   2. Full state never leaves this process. `viewFor()` is the only thing a
//      client is allowed to see, and it redacts every other hand down to a
//      count and the draw pile down to a length.
//
// It is a plain CommonJS module with no dependencies so the tests can require
// it directly.

const COLORS = ['ember', 'volt', 'frost', 'vapor'];

/**
 * Every kind of card. `optional:true` means the host can leave it out of the
 * deck from the lobby. Display names live in the client; what matters here is
 * which kinds exist and how many of each go into the deck.
 */
const KINDS = {
  num: {}, skip: {}, rev: {}, hit2: {}, discardall: {},
  // colour-matched extras
  snipe: {optional: true}, mirror: {optional: true}, overload: {optional: true},
  peek: {optional: true}, gift: {optional: true}, twin: {optional: true},
  // colourless
  wild: {}, wildfire: {},
  trade: {optional: true}, scramble: {optional: true}, chain: {optional: true},
};

const COLOURLESS = ['wild', 'wildfire', 'trade', 'scramble', 'chain'];
const OPTIONAL = Object.keys(KINDS).filter(k => KINDS[k].optional);
/** Cards that need the player to nominate a colour when played. */
const NEEDS_COLOR = ['wild', 'wildfire'];
/** Cards that need the player to nominate another player. */
const NEEDS_TARGET = ['snipe', 'peek', 'gift', 'trade'];

const MAX_PLAYERS = 8;
const MIN_PLAYERS = 2;
const HAND_SIZE = 7;

// ---------------------------------------------------------------- scoring
// A match is several hands. Whoever empties their hand takes the hand and
// scores nothing; everyone else adds up what they are still holding. Cross the
// limit and you are out of the match.
//
// Values follow the Uno convention — number cards at face value, coloured
// actions at 20, wilds at 50 — with our extras slotted in by colour: the
// colour-matched extras score like actions, the colourless ones like wilds.
const POINTS_ACTION = 20;
const POINTS_WILD = 50;

/** What one card is worth to whoever is caught holding it. */
function cardValue(card) {
  if (!card) return 0;
  if (card.k === 'num') return card.n;
  return COLOURLESS.indexOf(card.k) !== -1 ? POINTS_WILD : POINTS_ACTION;
}

/** Total value of a hand. */
function handValue(hand) {
  return (hand || []).reduce((n, c) => n + cardValue(c), 0);
}

// The limits the host can pick, and they are deliberately far below Uno's 500.
// Measured, not guessed: a player who loses a hand is left holding about 80
// points on average, so 500 would take roughly six losing hands to eliminate
// one player and ten or more to finish a match. These land a four-player match
// at a handful of hands. test/match.test.js keeps the arithmetic honest.
const LIMITS = [150, 250, 400, 600];
const DEFAULT_LIMIT = 250;

function sanitizeLimit(n) {
  const v = Math.round(Number(n));
  return LIMITS.indexOf(v) === -1 ? DEFAULT_LIMIT : v;
}

/** Has this player walked out? */
const hasQuit = (state, pid) => !!(state.quit && state.quit[pid]);

/** Players still in the match: not knocked out, and still in the room. */
function activePlayers(state) {
  return state.players.filter(p => !state.eliminated[p.id] && !hasQuit(state, p.id));
}

function defaultOpts() {
  const o = {};
  OPTIONAL.forEach(k => o[k] = true);
  return o;
}

/** Only known optional keys survive, and only as booleans. */
function sanitizeOpts(raw) {
  const o = {};
  OPTIONAL.forEach(k => o[k] = raw && typeof raw === 'object' ? !!raw[k] : true);
  return o;
}

// ---------------------------------------------------------------- randomness
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/**
 * One press of the launcher. Nearly half of all presses fire nothing at all,
 * and there is a rare burial at the top end — that spread is the personality
 * of the game.
 *
 * These weights are tuned, not arbitrary: they average ~1.5 cards per press.
 * Push the average much past 2 and the table injects cards faster than players
 * can shed them, which turns a 15-minute game into an hour. (Measured with
 * test/sim.js: 236 moves per game at ~2.0, 122 moves at ~1.5.)
 */
function fireCount() {
  const r = Math.random();
  if (r < 0.45) return 0;                                 // nothing — the good outcome
  if (r < 0.78) return 1 + Math.floor(Math.random() * 2); // 1-2
  if (r < 0.94) return 3 + Math.floor(Math.random() * 2); // 3-4
  return 5 + Math.floor(Math.random() * 5);               // 5-9, the burial
}

// ---------------------------------------------------------------------- deck
function buildDeck(opts) {
  const deck = [];
  let uid = 0;
  const add = card => { card.id = 'c' + (uid++); deck.push(card); };

  for (const c of COLORS) {
    add({c, k: 'num', n: 0});
    for (let n = 1; n <= 9; n++) { add({c, k: 'num', n}); add({c, k: 'num', n}); }
    for (const k of ['skip', 'rev', 'hit2']) { add({c, k}); add({c, k}); }
    add({c, k: 'discardall'});
    for (const k of ['snipe', 'mirror', 'overload', 'peek', 'gift', 'twin']) if (opts[k]) add({c, k});
  }
  for (let i = 0; i < 4; i++) { add({c: null, k: 'wild'}); add({c: null, k: 'wildfire'}); }
  for (const k of ['trade', 'scramble', 'chain']) if (opts[k]) { add({c: null, k}); add({c: null, k}); }

  return shuffle(deck);
}

// ------------------------------------------------------------------- lobby
function createState() {
  return {
    v: 1,
    phase: 'lobby',
    createdAt: Date.now(),
    players: [],       // seating order; the first one still here is the host
    opts: defaultOpts(),
    secrets: {},       // token -> playerId. NEVER leaves the server.
    quit: {},          // pid -> true once they have left the room
    log: [],

    // ---- the match, which outlives any one hand ----
    limit: DEFAULT_LIMIT,
    scores: {},        // pid -> running total
    eliminated: {},    // pid -> true once they cross the limit
    history: [],       // one entry per finished hand, for the scoresheet
    round: 0,
    matchWinner: null,
  };
}

/**
 * Adds a player and mints their token. The token is how the server knows who
 * is asking; without it a client can only ever see the public view.
 * @returns {{playerId:string, token:string}}
 */
function addPlayer(state, name, color, randomToken) {
  if (state.phase !== 'lobby') throw new GameError('The game has already started.');
  if (state.players.length >= MAX_PLAYERS) throw new GameError('This room is full.');

  const clean = String(name || '').trim().slice(0, 14) || 'Player';
  const id = 'p' + (state.players.length + 1) + '-' + randomToken().slice(0, 6);
  const token = randomToken();

  state.players.push({id, name: clean, color: COLORS.indexOf(color) === -1 ? 'ember' : color});
  state.secrets[token] = id;
  state.log.push(clean + ' joined.');
  return {playerId: id, token};
}

function playerIdForToken(state, token) {
  if (!token) return null;
  return state.secrets[token] || null;
}

/**
 * The host is the first player who is still in the room. Deriving it rather
 * than pinning it to players[0] means a host who quits mid-match hands the
 * job to the next seat instead of stranding the table with nobody to deal.
 */
function hostId(state) {
  const here = state.players.filter(p => !hasQuit(state, p.id));
  return here.length ? here[0].id : null;
}

const isHost = (state, pid) => !!pid && hostId(state) === pid;

// ------------------------------------------------------------------- dealing
/** Wipes the scoresheet so the table can start a brand new match. */
function resetMatch(state) {
  state.scores = {};
  state.eliminated = {};
  state.history = [];
  state.round = 0;
  state.matchWinner = null;
  state.winner = null;
}

/**
 * Deals one hand. Called for the first hand of a match and for every hand
 * after, so only players still in the match get cards.
 */
function startGame(state) {
  if (state.phase === 'play') throw new GameError('Already playing.');
  // Rooms created before scoring existed, and any hand-rolled state, get the
  // match fields filled in rather than blowing up.
  if (!state.scores) resetMatch(state);
  if (typeof state.limit !== 'number') state.limit = DEFAULT_LIMIT;

  const seats = activePlayers(state).map(p => p.id);
  if (seats.length < MIN_PLAYERS) throw new GameError('Need at least two players.');
  const draw = buildDeck(state.opts);
  const hands = {};
  seats.forEach(id => hands[id] = draw.splice(-HAND_SIZE));

  // Start on a plain number card so nobody eats an action before their first turn.
  let start = draw.pop();
  let guard = 0;
  while (start && start.k !== 'num' && guard++ < 400) { draw.unshift(start); start = draw.pop(); }

  state.phase = 'play';
  state.seats = seats;
  state.hands = hands;
  state.draw = draw;
  state.discard = [start];
  state.color = start.c;
  state.turn = 0;
  state.dir = 1;
  state.pending = null;
  state.overload = false;
  state.uncalled = {};
  state.winner = null;
  state.round = (state.round || 0) + 1;
  state.lastRound = null;
  state.log = ['Hand ' + state.round + ' dealt. ' + nameOf(state, seats[0]) + ' starts.'];
  return state;
}

/**
 * Ends a hand: everyone still holding cards adds them up, the totals move, and
 * anyone who has reached the limit drops out of the match. The hand's winner
 * scores nothing, so winning can never eliminate you.
 */
function endRound(state, winnerPid) {
  const deltas = {};
  state.seats.forEach(id => {
    deltas[id] = id === winnerPid ? 0 : handValue(state.hands[id]);
    state.scores[id] = (state.scores[id] || 0) + deltas[id];
  });

  const newlyOut = [];
  state.seats.forEach(id => {
    if (!state.eliminated[id] && state.scores[id] >= state.limit) {
      state.eliminated[id] = true;
      newlyOut.push(id);
    }
  });

  state.history.push({round: state.round, winner: winnerPid, deltas});
  state.lastRound = {winner: winnerPid, deltas, out: newlyOut};
  state.winner = winnerPid;

  logLine(state, nameOf(state, winnerPid) + ' takes hand ' + state.round + '.');
  newlyOut.forEach(id =>
    logLine(state, nameOf(state, id) + ' is out of the match on ' + state.scores[id] + '.'));

  // The hand's winner added zero, so there is always at least one survivor.
  const left = activePlayers(state);
  if (left.length <= 1) {
    state.phase = 'over';
    state.matchWinner = left.length ? left[0].id : winnerPid;
    logLine(state, nameOf(state, state.matchWinner) + ' wins the match.');
  } else {
    state.phase = 'round';
  }
}

/**
 * A player leaves the room for good.
 *
 * In the lobby they are erased - no seat, no score, nothing refers to them, so
 * the room should look as though they never arrived. Once the cards are out
 * they cannot be erased, because the scoresheet names them, so they are marked
 * instead and skipped everywhere `activePlayers` is consulted.
 *
 * Walking out mid-hand is a forfeit. Their cards go back into the pile (the
 * deck has to keep adding up), their seat is spliced out, and the turn is
 * rewound onto whoever should be playing now.
 */
function quitGame(state, pid) {
  const p = state.players.find(x => x.id === pid);
  if (!p) throw new GameError('You are not in this room.');
  if (hasQuit(state, pid)) throw new GameError('You have already left.');

  if (state.phase === 'lobby') {
    state.players = state.players.filter(x => x.id !== pid);
    Object.keys(state.secrets).forEach(t => { if (state.secrets[t] === pid) delete state.secrets[t]; });
    if (state.scores) delete state.scores[pid];
    logLine(state, p.name + ' left.');
    return;
  }

  if (!state.quit) state.quit = {};
  state.quit[pid] = true;
  logLine(state, p.name + ' left the game.');

  // Between hands, or after the match, there is no seat to unpick.
  if (state.phase !== 'play') return;

  const k = seatIdx(state, pid);
  if (k === -1) return;

  // Their hand returns to the pile, so no card is created or destroyed.
  state.draw = shuffle(state.draw.concat(state.hands[pid] || []));
  state.hands[pid] = [];
  delete state.uncalled[pid];

  const wasTheirTurn = state.turn === k;
  state.seats.splice(k, 1);

  // Splicing shifts every later seat down one. A seat before the current one
  // drags the turn with it; leaving on your own turn passes play along, which
  // is where the index already points when play runs forwards.
  if (k < state.turn) state.turn--;
  else if (wasTheirTurn && state.dir === -1) state.turn--;

  // Whatever was aimed at them leaves with them.
  if (wasTheirTurn) state.pending = null;

  const n = state.seats.length;
  if (n === 0) {                      // everyone walked out
    state.phase = 'over';
    state.winner = null;
    return;
  }
  state.turn = ((state.turn % n) + n) % n;

  // Last player at the table takes the hand by default.
  if (n === 1) endRound(state, state.seats[0]);
}

// -------------------------------------------------------------------- helpers
class GameError extends Error {}

const nameOf = (state, pid) => {
  const p = state.players.find(x => x.id === pid);
  return p ? p.name : 'Someone';
};
const seatIdx = (state, pid) => state.seats.indexOf(pid);
const topCard = state => state.discard[state.discard.length - 1];

function stepIdx(state, i, step) {
  const n = state.seats.length;
  return (((i + state.dir * step) % n) + n) % n;
}

function logLine(state, text) {
  state.log.push(text);
  if (state.log.length > 24) state.log.shift();
}

/**
 * Is this card playable right now? Under attack the options narrow hard:
 * stack another Hit 2, or Mirror it back.
 */
function canPlay(state, card) {
  if (state.phase !== 'play') return false;
  if (state.pending) {
    if (state.pending.kind === 'hit2') return card.k === 'hit2' || card.k === 'mirror';
    return card.k === 'mirror';           // Wild Hit Fire can only be mirrored
  }
  if (card.c === null) return true;       // colourless plays on anything
  if (card.c === state.color) return true;
  const t = topCard(state);
  if (card.k === 'num' && t.k === 'num' && card.n === t.n) return true;
  if (card.k !== 'num' && card.k === t.k) return true;
  return false;
}

// ------------------------------------------------------------------ launcher
function rollFire(state) {
  let n = fireCount();
  if (state.overload) { n *= 2; state.overload = false; }
  return n;
}

function reshuffle(state) {
  if (state.discard.length <= 1) return;
  const top = state.discard.pop();
  state.draw = shuffle(state.discard);
  state.discard = [top];
  logLine(state, 'The launcher reloads from the pile.');
}

function popDraw(state) {
  if (!state.draw.length) reshuffle(state);
  return state.draw.pop() || null;
}

function giveCards(state, pid, n) {
  let got = 0;
  for (let i = 0; i < n; i++) {
    const c = popDraw(state);
    if (!c) break;
    state.hands[pid].push(c);
    got++;
  }
  if (state.hands[pid].length !== 1) delete state.uncalled[pid];
  return got;
}

// ---------------------------------------------------------------- moves
/**
 * Applies one move on behalf of `pid`, validating everything. Throws GameError
 * with a player-readable message if the move is not legal.
 *
 * @param {object} state - authoritative state, mutated in place
 * @param {string} pid - the player the token resolved to
 * @param {object} move - {type:'play'|'press'|'catch', ...}
 * @returns {{peek?: Array}} extra data for the mover's eyes only
 */
function applyMove(state, pid, move) {
  if (state.phase !== 'play') throw new GameError('The game is not running.');
  if (!state.seats || state.seats.indexOf(pid) === -1) throw new GameError('You are not in this game.');
  if (state.seats[state.turn] !== pid) throw new GameError('It is not your turn.');

  switch (move && move.type) {
    case 'play':  return doPlay(state, pid, move);
    case 'press': return doPress(state, pid);
    case 'catch': return doCatch(state, pid, move);
    default: throw new GameError('Unknown move.');
  }
}

function doPlay(state, pid, move) {
  const hand = state.hands[pid];
  const i = hand.findIndex(c => c.id === move.cardId);
  if (i === -1) throw new GameError('That card is not in your hand.');
  const card = hand[i];
  if (!canPlay(state, card)) throw new GameError('You cannot play that right now.');

  // ---- validate the extras the move carries, before touching any state ----
  let color = null;
  if (NEEDS_COLOR.indexOf(card.k) !== -1) {
    if (COLORS.indexOf(move.color) === -1) throw new GameError('Pick a colour.');
    color = move.color;
  }

  const bareGift = card.k === 'gift' && hand.length === 1;
  let target = null;
  if (NEEDS_TARGET.indexOf(card.k) !== -1 && !bareGift) {
    if (typeof move.target !== 'string' || move.target === pid || state.seats.indexOf(move.target) === -1) {
      throw new GameError('Pick another player.');
    }
    target = move.target;
  }

  let giftCard = null;
  if (card.k === 'gift' && !bareGift) {
    const gi = hand.findIndex(c => c.id === move.giftCardId && c.id !== card.id);
    if (gi === -1) throw new GameError('Pick a card to give.');
    giftCard = hand[gi];
  }

  // ---- commit ----
  hand.splice(i, 1);
  state.discard.push(card);
  if (card.c) state.color = card.c;
  if (color) state.color = color;

  const me = nameOf(state, pid);
  const label = card.k === 'num' ? String(card.n) : card.k;
  logLine(state, me + ' played ' + (card.c ? card.c + ' ' : '') + label + '.');

  let advance = 1;
  let peek = null;

  switch (card.k) {
    case 'skip':
      advance = 2;
      logLine(state, nameOf(state, state.seats[stepIdx(state, state.turn, 1)]) + ' is skipped.');
      break;

    case 'rev':
      if (state.seats.length === 2) advance = 2;
      else { state.dir *= -1; advance = 1; }
      logLine(state, 'Play reverses direction.');
      break;

    case 'hit2':
      state.pending = {kind: 'hit2', n: (state.pending ? state.pending.n : 0) + 2, from: pid};
      logLine(state, nameOf(state, state.seats[stepIdx(state, state.turn, 1)]) + ' owes ' + state.pending.n + ' presses.');
      break;

    case 'wildfire':
      state.pending = {kind: 'fire', n: 1, from: pid};
      logLine(state, nameOf(state, state.seats[stepIdx(state, state.turn, 1)]) + ' must press until it fires.');
      break;

    case 'mirror':
      if (state.pending) {
        const back = state.pending.from;
        const backSeat = seatIdx(state, back);
        if (backSeat === -1) {
          // Whoever sent this has left the table, so there is nobody to bounce
          // it at. The attack dies with them and the mirror does what it does
          // with nothing pending. Without this the turn lands on seat -1.
          state.pending = null;
          if (state.seats.length === 2) advance = 2; else state.dir *= -1;
          logLine(state, nameOf(state, back) + ' had already left — the attack fizzles.');
        } else {
          state.pending = {kind: state.pending.kind, n: state.pending.n + 1, from: pid};
          state.turn = backSeat;
          advance = 0;
          logLine(state, 'Mirrored straight back at ' + nameOf(state, back) + '.');
        }
      } else {
        if (state.seats.length === 2) advance = 2; else state.dir *= -1;
        logLine(state, 'Direction mirrored.');
      }
      break;

    case 'discardall': {
      const dumped = hand.filter(c => c.c === card.c);
      state.hands[pid] = hand.filter(c => c.c !== card.c);
      dumped.forEach(c => state.discard.push(c));
      logLine(state, me + ' dumped ' + dumped.length + ' more ' + card.c + ' card' + (dumped.length === 1 ? '' : 's') + '.');
      break;
    }

    case 'snipe': {
      const got = giveCards(state, target, rollFire(state));
      logLine(state, 'Sniped ' + nameOf(state, target) + ' — ' + (got ? 'the launcher spat out ' + got + '.' : 'and it misfired. Nothing.'));
      break;
    }

    case 'overload':
      state.overload = true;
      logLine(state, 'The launcher is overloaded — next launch fires double.');
      break;

    case 'peek':
      // Returned to the mover alone; it is never written into shared state.
      peek = {player: target, name: nameOf(state, target), hand: state.hands[target].slice()};
      logLine(state, me + ' peeked at ' + nameOf(state, target) + "'s hand.");
      break;

    case 'gift': {
      if (bareGift) break;
      const gi = state.hands[pid].findIndex(c => c.id === giftCard.id);
      if (gi !== -1) {
        const moved = state.hands[pid].splice(gi, 1)[0];
        state.hands[target].push(moved);
        if (state.hands[target].length !== 1) delete state.uncalled[target];
      }
      logLine(state, me + ' gave a card to ' + nameOf(state, target) + '.');
      break;
    }

    case 'twin':
      advance = 0;
      logLine(state, me + ' goes again.');
      break;

    case 'trade': {
      const mine = state.hands[pid];
      state.hands[pid] = state.hands[target];
      state.hands[target] = mine;
      delete state.uncalled[pid];
      delete state.uncalled[target];
      logLine(state, me + ' swapped hands with ' + nameOf(state, target) + '.');
      break;
    }

    case 'scramble': {
      const order = state.seats.slice();
      const grabbed = order.map(id => state.hands[id]);
      order.forEach((id, idx) => {
        const from = (((idx - state.dir) % order.length) + order.length) % order.length;
        state.hands[id] = grabbed[from];
      });
      state.uncalled = {};
      logLine(state, 'SCRAMBLE — every hand moved one seat.');
      break;
    }

    case 'chain': {
      const bits = [];
      state.seats.forEach(id => {
        if (id === pid) return;
        bits.push(nameOf(state, id) + ' ' + giveCards(state, id, rollFire(state)));
      });
      logLine(state, 'Chain reaction — ' + bits.join(', ') + '.');
      break;
    }
  }

  // ---- hand won, then the blast call ----
  if (state.hands[pid].length === 0) {
    logLine(state, me + ' is out of cards.');
    endRound(state, pid);
    return {peek};
  }

  if (state.hands[pid].length === 1) {
    if (move.callBlast) { delete state.uncalled[pid]; logLine(state, me + ' called BLAST!'); }
    else state.uncalled[pid] = true;
  } else {
    delete state.uncalled[pid];
  }

  if (advance) state.turn = stepIdx(state, state.turn, advance);
  return {peek};
}

function doPress(state, pid) {
  let total = 0;
  const pend = state.pending;

  if (pend && pend.kind === 'fire') {
    // "keep pressing until cards actually launch" — capped so a freak run of
    // empty presses cannot spin forever.
    let tries = 0;
    while (total === 0 && tries < 25) { total += rollFire(state); tries++; }
  } else {
    const presses = pend ? pend.n : 1;
    for (let p = 0; p < presses; p++) total += rollFire(state);
  }

  const got = giveCards(state, pid, total);
  logLine(state, nameOf(state, pid) + ' pressed — ' + (got ? 'took ' + got + ' card' + (got === 1 ? '' : 's') + '.' : 'nothing came out.'));

  state.pending = null;
  delete state.uncalled[pid];
  state.turn = stepIdx(state, state.turn, 1);
  return {};
}

function doCatch(state, pid, move) {
  const t = move.target;
  if (t === pid || state.seats.indexOf(t) === -1) throw new GameError('No such player.');
  if (!state.uncalled[t] || state.hands[t].length !== 1) throw new GameError('There is nothing to catch.');

  const got = giveCards(state, t, rollFire(state) + rollFire(state));
  delete state.uncalled[t];
  logLine(state, nameOf(state, pid) + ' caught ' + nameOf(state, t) + ' — two presses, ' + got + ' card' + (got === 1 ? '' : 's') + '.');
  return {};
}

// ------------------------------------------------------------------ redaction
/**
 * The ONLY shape a client is allowed to receive. Everything secret is dropped
 * here: other people's cards become a count, the draw pile becomes a length,
 * and the token table is never mentioned.
 *
 * @param {object} state
 * @param {string|null} pid - viewer, or null for a spectator
 */
function viewFor(state, pid) {
  const view = {
    v: state.v,
    phase: state.phase,
    opts: state.opts,
    you: pid,
    isHost: isHost(state, pid),
    players: state.players.map(p => ({
      id: p.id,
      name: p.name,
      color: p.color,
      count: state.hands && state.hands[p.id] ? state.hands[p.id].length : 0,
      uncalled: !!(state.uncalled && state.uncalled[p.id] && state.hands[p.id] && state.hands[p.id].length === 1),
      host: hostId(state) === p.id,
      // Running total and whether they have dropped out — public by design,
      // the scoresheet is meant to be read across the table.
      score: (state.scores && state.scores[p.id]) || 0,
      out: !!(state.eliminated && state.eliminated[p.id]),
      quit: hasQuit(state, p.id),
    })),
    log: (state.log || []).slice(-12),

    // ---- the match ----
    limit: state.limit || DEFAULT_LIMIT,
    round: state.round || 0,
    history: state.history || [],       // per-hand deltas; card values, never cards
    lastRound: state.lastRound || null,
    matchWinner: state.matchWinner || null,
  };

  if (state.phase === 'lobby') return view;

  view.seats = state.seats;
  view.turnId = state.seats[state.turn];
  view.yourTurn = state.seats[state.turn] === pid;
  view.dir = state.dir;
  view.color = state.color;
  view.top = topCard(state);          // the discard top is face up anyway
  view.drawCount = state.draw.length;
  view.pending = state.pending ? {kind: state.pending.kind, n: state.pending.n, from: state.pending.from} : null;
  view.overload = state.overload;
  view.winner = state.winner;
  view.hand = (pid && state.hands[pid]) ? state.hands[pid] : [];
  // What the viewer is allowed to do, decided here rather than trusted from the client.
  view.playable = view.hand.filter(c => canPlay(state, c)).map(c => c.id);
  return view;
}

module.exports = {
  COLORS, KINDS, OPTIONAL, COLOURLESS, NEEDS_COLOR, NEEDS_TARGET,
  MIN_PLAYERS, MAX_PLAYERS, HAND_SIZE,
  GameError,
  LIMITS, DEFAULT_LIMIT, POINTS_ACTION, POINTS_WILD,
  defaultOpts, sanitizeOpts, sanitizeLimit, buildDeck, shuffle, fireCount,
  createState, addPlayer, playerIdForToken, isHost, hostId, startGame, quitGame,
  canPlay, applyMove, viewFor,
  cardValue, handValue, resetMatch, activePlayers, endRound,
  // exported for tests
  _internals: {stepIdx, giveCards, rollFire, topCard, nameOf, logLine},
};
