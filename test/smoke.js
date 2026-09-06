// End-to-end smoke test against the live deployment: two players join a real
// room, the host deals, and they play a full game through the public HTTP API.
// Also re-checks the secrecy guarantee over the real wire.
const BASE = 'https://card-blast-turmanat0r.vercel.app/api/room';

async function api(action, {room, token, body, method} = {}) {
  const url = BASE + '?action=' + action + (room ? '&room=' + room : '');
  const headers = {};
  if (token) headers['x-cb-token'] = token;
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch(url, {method: method || (body ? 'POST' : 'GET'), headers, body: body ? JSON.stringify(body) : undefined});
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) {}
  return {status: res.status, data, text};
}

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };

(async () => {
  console.log('\ncreating a real room');
  const made = await api('create', {method: 'POST'});
  check('room created', made.status === 200 && made.data.room, JSON.stringify(made.data));
  const room = made.data.room;
  console.log('  room = ' + room);

  const alice = await api('join', {room, body: {name: 'Alice', color: 'volt'}});
  const bob = await api('join', {room, body: {name: 'Bob', color: 'frost'}});
  check('two players joined', alice.status === 200 && bob.status === 200);
  const A = alice.data.token, B = bob.data.token;

  console.log('\nhost authority over HTTPS');
  const badStart = await api('start', {room, token: B, method: 'POST'});
  check('non-host refused the deal', badStart.status === 400 && /only the host/i.test(badStart.data.error), JSON.stringify(badStart.data));

  const setLimit = await api('opts', {room, token: A, body: {limit: 150}});
  check('host set the knock-out score', setLimit.status === 200 && setLimit.data.view.limit === 150,
    String(setLimit.data && setLimit.data.view && setLimit.data.view.limit));

  const dealt = await api('start', {room, token: A, method: 'POST'});
  check('host dealt', dealt.status === 200 && dealt.data.view.phase === 'play', JSON.stringify(dealt.data).slice(0, 120));

  console.log('\nsecrecy over the real wire');
  const aView = await api('state', {room, token: A});
  const bView = await api('state', {room, token: B});
  const anon = await api('state', {room});
  const bIds = bView.data.view.hand.map(c => c.id);
  const leaked = bIds.filter(id => aView.text.includes('"' + id + '"'));
  check("Alice's response holds none of Bob's card ids", leaked.length === 0, leaked.join(','));
  check('each player got 7 of their own', aView.data.view.hand.length === 7 && bView.data.view.hand.length === 7);
  check('a stranger with the code gets no hand', anon.data.view.hand.length === 0);
  check('no token echoed back', !aView.text.includes(B));

  console.log('\nplaying a hand out');
  const tok = {}; tok[alice.data.playerId] = A; tok[bob.data.playerId] = B;
  let view = aView.data.view.yourTurn ? aView.data.view : bView.data.view;
  let moves = 0, presses = 0, plays = 0;

  while (view.phase === 'play' && moves < 900) {
    const me = view.turnId;
    const cur = await api('state', {room, token: tok[me]});
    view = cur.data.view;
    if (view.phase !== 'play') break;

    const playable = view.hand.filter(c => view.playable.includes(c.id));
    let move;
    if (playable.length) {
      const card = playable[Math.floor(Math.random() * playable.length)];
      move = {type: 'play', cardId: card.id};
      if (['wild', 'wildfire'].includes(card.k)) move.color = ['ember', 'volt', 'frost', 'vapor'][Math.floor(Math.random() * 4)];
      if (['snipe', 'peek', 'gift', 'trade'].includes(card.k)) {
        if (!(card.k === 'gift' && view.hand.length === 1)) {
          const other = view.players.find(p => p.id !== me && view.seats.includes(p.id));
          move.target = other.id;
          if (card.k === 'gift') move.giftCardId = view.hand.find(c => c.id !== card.id).id;
        }
      }
      if (view.hand.length === 2) move.callBlast = true;
      plays++;
    } else { move = {type: 'press'}; presses++; }

    const out = await api('move', {room, token: tok[me], body: {move}});
    if (out.status !== 200) { check('move accepted', false, JSON.stringify(out.data) + ' for ' + JSON.stringify(move)); break; }
    view = out.data.view;
    moves++;
  }

  console.log('\nscoring');
  check('the hand ended', view.phase === 'round' || view.phase === 'over', view.phase + ' after ' + moves + ' moves');
  const winner = view.players.find(p => p.id === view.winner);
  console.log('  ' + moves + ' moves (' + plays + ' plays, ' + presses + ' presses) — hand taken by ' + (winner && winner.name));
  check('the scoresheet gained a row', (view.history || []).length === 1, String((view.history || []).length));
  check('the hand winner was charged nothing', winner.score === 0, String(winner.score));
  const loser = view.players.find(p => p.id !== view.winner);
  check('the loser was charged for their hand', loser.score > 0, String(loser.score));
  check('the sheet matches the totals', view.history[0].deltas[loser.id] === loser.score);
  check('the sheet carries points, never card ids', JSON.stringify(view.history).indexOf('"c') === -1);

  console.log('\nnext hand');
  const badNext = await api('next', {room, token: B, method: 'POST'});
  check('a non-host cannot deal the next hand',
    badNext.status === 400 && /only the host/i.test(badNext.data.error), JSON.stringify(badNext.data));

  if (view.phase === 'round') {
    const nxt = await api('next', {room, token: A, method: 'POST'});
    check('the host deals the next hand', nxt.status === 200 && nxt.data.view.phase === 'play', JSON.stringify(nxt.data).slice(0, 110));
    check('it is hand 2', nxt.data.view.round === 2, String(nxt.data.view.round));
    check('scores carried across hands', nxt.data.view.players.find(p => p.id === loser.id).score === loser.score);
    check('a fresh seven cards', nxt.data.view.hand.length === 7, String(nxt.data.view.hand.length));
  }

  const late = await api('join', {room, body: {name: 'Carol', color: 'vapor'}});
  check('nobody can join a game in progress', late.status === 400, JSON.stringify(late.data));

  console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
  process.exit(fail ? 1 : 0);
})();
