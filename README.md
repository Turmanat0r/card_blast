# Card Blast

An Uno Attack–style shedding game for phones. Everyone joins a room with a
code and plays on their own device. Named Card Blast rather than the obvious
thing because UNO is a Mattel trademark — the rules aren't protected, the name
and artwork are.

```
index.html        the client: draws the table, asks for a move. Knows no rules.
api/room.js       HTTP layer: rooms, tokens, Redis, compare-and-set writes.
api/_engine.js    the actual rules. Deck, deal, legality, effects, redaction.
test/             four suites, no dependencies. See below.
```

## The deck (142 cards with everything switched on)

**Core — 112 cards**

| Card | Count | Effect |
|---|---|---|
| Numbers 0–9 | 76 | Match colour or number |
| Skip | 8 | Next player loses their turn |
| Reverse | 8 | Flip direction (acts as Skip with 2 players) |
| Hit 2 | 8 | Next player presses the launcher twice. Stacks |
| Discard All | 4 | Dump every card of that colour from your hand |
| Wild | 4 | Choose the colour |
| Wild Hit Fire | 4 | Choose the colour; next player presses until cards actually fire |

**Extras — 30 cards, each switchable off by the host in the lobby**

| Card | Count | Effect |
|---|---|---|
| Snipe | 4 | Pick *any* player — they press once |
| Mirror | 4 | Bounce an incoming attack back at the sender, +1 press. No attack pending? Reverses direction |
| Overload | 4 | The next launch fires **double** |
| Peek | 4 | Look at any player's hand |
| Gift | 4 | Hand one card of your choice to any player |
| Twin | 4 | Take another turn immediately |
| Trade Hands | 2 | Swap your whole hand with any player |
| Scramble | 2 | Every hand shifts one seat |
| Chain Reaction | 2 | Every other player presses once |

**The launcher** replaces the draw pile. One press fires 0–9 cards: 45% of the
time nothing at all, 6% of the time five or more. Those weights are tuned —
read the comment on `fireCount()` before changing them. Averaging much past 2
cards per press makes the table inject cards faster than players can shed
them, which turns a 15-minute game into an hour (measured: 236 moves per game
at ~2.0, 122 at ~1.5).

**Inviting people.** The lobby leads with **Send invite link**, which opens the
OS share sheet on a phone (pick Messages, WhatsApp, whatever), falls back to
the clipboard, and failing that selects the link in a box for a manual copy.
The link is `?room=CODE`, so opening it reshapes the home screen into a single
**Join the game** button — no code to read, type or paste. The room code is
still shown for reading aloud in the same room. A device that has played before
skips the screen entirely and lands at the table; a first-time visitor always
sees the name they were handed before joining.

**Your name sticks.** Name and colour are remembered on the device, so a
returning player sees "Playing as Sirocco" and a Change button rather than
setting up again. Opening a shared room link with a name already saved takes
you straight to the table.

**Names.** The home screen rolls you a random one from a pool themed to your
suit: Ember names are volcanoes, Volt storms, Frost glaciers, Vapor winds. Every
entry is a real place or weather term and never a person's name — which is why
the glacier list skips the many named after people. Type over it if you'd rather.
Entries must stay within 14 characters; `test/names.test.js` enforces it.

**Scoring.** A match is several hands. Whoever empties their hand takes it and
scores nothing; everyone else adds up what they are still holding — number
cards at face value, coloured actions at 20, wilds and the colourless extras at
50. Totals carry across hands, and reaching the knock-out score puts you out of
the match. Last player standing wins. Because the hand's winner adds zero,
winning a hand can never knock you out.

The host picks the knock-out score in the lobby. These are measured, not
guessed — a losing player is left holding about 80 points, so a whole deck
(2100 points) is worth far more than any one hand:

| Limit | Feel | Hands for four players |
|---|---|---|
| 150 | quick | ~4 |
| **250** | **standard (default)** | **~6** |
| 400 | long | ~9 |
| 600 | marathon | ~13 |

The scoresheet is a table of every hand, per player, with running totals — on
screen between hands, and behind the **Scores** button mid-hand.

**Leaving.** There is a **Leave** button in the lobby, at the table and on the
scoresheet. What it costs depends on when you press it:

| When | What happens |
|---|---|
| In the lobby | You are erased — no seat, no score, as though you never arrived |
| Mid-hand | A forfeit: your cards go back in the pile, your seat closes, and play carries on from whoever is next |
| Between hands | You sit out every hand from here; the scoresheet still names you |

Two things that would otherwise strand a table are handled explicitly. The host
is whoever is **first in the room and still in it**, so a host who walks out
hands the job to the next seat rather than leaving nobody able to deal. And an
attack aimed at a player who leaves goes with them, while a Mirror played at an
attack whose *sender* has left fizzles instead of bouncing at an empty seat —
`test/sim.js` found that one the moment its bots could quit.

**Looking cards up.** The **Cards** button at the table lists everything in
*this* deck and what it does, extras the host switched off left out. Tapping a
card you cannot play explains that card and why it will not go down, which is
the only way to ask the question mid-hand.

**Calling it.** Down to one card, you choose whether to call BLAST. Stay quiet
and any player can catch you on their turn — that costs you two presses.

## How hands stay secret

The browser is treated as hostile. It never holds the deck, never deals, and
never judges a move.

- **The state lives on the server.** `api/_engine.js` owns the deck and the
  rules; the authoritative blob sits in Redis and never leaves the function.
- **Clients get a redacted view.** `viewFor()` returns your hand in full,
  every other hand as a *count*, and the draw pile as a *length*. There is a
  test that serialises a player's view and asserts no other player's card id
  appears anywhere in it.
- **Clients send intents, not state.** "Play c37 on Bob" — and the engine
  re-validates it from scratch: your turn, your card, a legal card, a real
  target.
- **Identity is a token**, minted server-side at join and sent in an
  `x-cb-token` header (not the URL, so it stays out of history and shared
  links). Knowing the room code gets you the public view — names and counts.
  Only the token holder sees that player's hand or can move for them.
- **Writes are compare-and-set.** Each write bumps a version key inside the
  same atomic Lua script, so two moves landing together can't silently
  overwrite each other; the loser re-reads and retries.

What's deliberately *not* protected: while the lobby is open, anyone with the
room code can join. That's the point of a zero-login party game.

## Deploying

Zero-config Vercel: static `index.html` plus the `api/` folder, no build step.
`api/_engine.js` starts with an underscore so Vercel neither routes to it nor
serves it as a static file.

It needs a Redis store. In the Vercel project: **Storage → create or connect a
Redis/KV store**. `api/room.js` accepts either env var pair, so whichever the
integration provisions will work:

- `KV_REST_API_URL` + `KV_REST_API_TOKEN`, or
- `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`

Until one is connected every API call returns *"KV store is not configured"*.
Keys are namespaced `cb:<room>:*`, so this can share a store with another
project (Sketch Showdown uses `room:*`) without collisions. Rooms expire 12
hours after their last write.

## Tests

No dependencies, nothing to install — `node` and go. 344 assertions.

```sh
node test/rules.test.js       # 43 — turn order, every card's effect, winning
node test/security.test.js    # 43 — redaction, tokens, move validation
node test/api.test.js         # 36 — the real handler against a fake Redis
node test/names.test.js       # 16 — the random-name pools (incl. the 14-char cap)
node test/match.test.js       # 56 — card values, scoresheet, knock-outs, match length
node test/invite.test.js      # 29 — the invite-link flow, both ends
node test/quit.test.js        # 60 — leaving: seats, turn order, host handover
node test/client.test.js      # 61 — the fanned hand, the card guide, leaving
node test/sim.js 500          # fuzzer: 500 random games, 2-6 players
node test/sim.js 800 4        # 800 games pinned to 4 players
```

`security.test.js` is the suite that would have failed against the original
design, where the browser held the whole game blob.

`api.test.js` drives the actual serverless handler with an in-memory Redis
(including the compare-and-set script), so routing, host checks, tokens and
what really goes over the wire are all covered.

`sim.js` plays whole **matches**, not single hands, so scoring, knock-outs and
re-dealing to a shrinking table are all exercised. Its bots play **only from
the redacted view** — the same blob a browser
gets. That makes it two tests in one: it proves the view carries enough to
play the game (zero illegal proposals) while a leak check proves it carries
nothing more. It also checks that cards are never created or destroyed, that
the turn index stays in range, that every game terminates, and it prints the
win spread — lopsided results across seats would mean biased turn rotation.

Bots also walk out at random (about three games in a thousand moves), which is
what exercises seat removal from every turn position and direction, with
attacks pending, across thousands of games.

`invite.test.js` and `client.test.js` both run the **real `<script>` out of
`index.html`** against a stubbed DOM, so they test the shipped client rather
than a copy of it. Between them they cover the invite flow, the geometry of the
fanned hand, the card guide, the extras panel and every branch of leaving.

`test/smoke.js` plays a real game against the live deployment over HTTPS —
two players join a real room, the host deals, and it re-checks the secrecy
guarantee on the actual wire:

```sh
node test/smoke.js
```
