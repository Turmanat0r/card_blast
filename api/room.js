// api/room.js
//
// The Card Blast game server. This replaces the earlier version of this file,
// which was a dumb key-value proxy — the browser held the deck, dealt the
// cards and judged its own moves, so anyone with devtools could read every
// hand in the room.
//
// Now the authoritative state lives here and in Redis, and the browser is
// treated as hostile:
//
//   - The deck, the deal and every rule run in api/_engine.js, server-side.
//     (Named with a leading underscore so Vercel neither routes to it nor
//     serves it as a static file.)
//   - A client sends *intents* ("play card c37 on Bob"), never state. The
//     engine re-validates each one against the server's own copy.
//   - Responses are redacted by engine.viewFor(): your hand in full, everyone
//     else's as a number, the draw pile as a length.
//   - Identity is a per-player token minted at join. Knowing the room code
//     lets you watch the public view; only the token holder gets that
//     player's hand, and only they can move for that player.
//
// What is still true: knowing the room code is enough to join while the lobby
// is open. That is deliberate for a zero-login party game.

const engine = require('./_engine.js');

const ROOM_RE = /^[A-Za-z0-9_-]{4,64}$/;
const ROOM_TTL_SECONDS = 60 * 60 * 12;  // idle rooms expire after 12h
const MAX_BODY_BYTES = 64 * 1024;       // intents are tiny; state never comes from the client
const MAX_WRITE_ATTEMPTS = 4;

// ------------------------------------------------------------------- plumbing
function bodyToString(req) {
  if (typeof req.body === 'string') return req.body;
  if (Buffer.isBuffer(req.body)) return req.body.toString('utf8');
  if (req.body && typeof req.body === 'object') return JSON.stringify(req.body);
  return '';
}

function readBody(req) {
  const text = bodyToString(req);
  if (Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES) throw new HttpError(413, 'payload too large');
  if (!text) return {};
  try { return JSON.parse(text); }
  catch (e) { throw new HttpError(400, 'body must be JSON'); }
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/**
 * Sends one command to the Redis REST API (Upstash's single-command form:
 * POST the command + args as a JSON array, get back {"result": ...}).
 * Accepts either the "KV_REST_API_*" or "UPSTASH_REDIS_REST_*" env var names
 * since different Vercel storage integrations use different ones.
 */
async function redisCmd(...args) {
  const base = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!base || !token) throw new HttpError(500, 'KV store is not configured (missing env vars)');
  const res = await fetch(base, {
    method: 'POST',
    headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
    body: JSON.stringify(args),
  });
  if (!res.ok) throw new HttpError(502, 'redis ' + args[0] + ' failed: HTTP ' + res.status);
  const json = await res.json();
  if (json.error) throw new HttpError(502, String(json.error));
  return json.result;
}

/**
 * Compare-and-set, so two moves landing at the same instant cannot silently
 * overwrite each other. The version key is bumped in the same atomic script as
 * the state write; a mismatch means someone else moved first and we re-read.
 */
const CAS_SCRIPT = [
  "local v = redis.call('GET', KEYS[2])",
  "if v == ARGV[1] or (not v and ARGV[1] == '0') then",
  "  redis.call('SET', KEYS[1], ARGV[2], 'EX', ARGV[4])",
  "  redis.call('SET', KEYS[2], ARGV[3], 'EX', ARGV[4])",
  "  return 1",
  "end",
  "return 0",
].join('\n');

const stateKey = room => 'cb:' + room + ':state';
const verKey   = room => 'cb:' + room + ':v';

async function loadState(room) {
  const raw = await redisCmd('GET', stateKey(room));
  if (raw === null || raw === undefined) return null;
  try { return JSON.parse(raw); }
  catch (e) { throw new HttpError(500, 'room state is corrupt'); }
}

async function casState(room, expectedVersion, state) {
  const next = String(expectedVersion + 1);
  state.v = expectedVersion + 1;
  const ok = await redisCmd(
    'EVAL', CAS_SCRIPT, '2', stateKey(room), verKey(room),
    String(expectedVersion), JSON.stringify(state), next, String(ROOM_TTL_SECONDS)
  );
  return ok === 1 || ok === '1';
}

/**
 * Read → apply → write, retrying if another player's move landed in between.
 * `fn` must be pure enough to re-run: it is handed a fresh copy of the state
 * each attempt.
 */
async function mutate(room, fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const state = await loadState(room);
    if (!state) throw new HttpError(404, 'no such room');
    const version = state.v || 0;
    const result = fn(state);
    if (await casState(room, version, state)) return {state, result};
    lastErr = new HttpError(409, 'someone else moved first — try again');
  }
  throw lastErr;
}

function randomToken() {
  const c = require('crypto');
  return c.randomBytes(18).toString('base64url');
}

function randomRoomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no confusable 0/O/1/I
  const bytes = require('crypto').randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const tokenOf = req => req.headers['x-cb-token'] || '';

// ------------------------------------------------------------------- handler
module.exports = async (req, res) => {
  try {
    const action = req.query.action;

    // ---- create a room ----
    if (req.method === 'POST' && action === 'create') {
      let code = null;
      for (let attempt = 0; attempt < 5; attempt++) {
        const candidate = randomRoomCode();
        if ((await redisCmd('GET', stateKey(candidate))) === null) { code = candidate; break; }
      }
      if (!code) throw new HttpError(503, 'could not allocate a room code');
      const state = engine.createState();
      await redisCmd('SET', stateKey(code), JSON.stringify(state), 'EX', String(ROOM_TTL_SECONDS));
      await redisCmd('SET', verKey(code), String(state.v), 'EX', String(ROOM_TTL_SECONDS));
      res.status(200).json({room: code});
      return;
    }

    const room = req.query.room;
    if (!ROOM_RE.test(room || '')) throw new HttpError(400, 'invalid room code');

    // ---- does this room exist? (used by the join screen) ----
    if (req.method === 'GET' && action === 'exists') {
      const state = await loadState(room);
      if (!state) { res.status(404).json({exists: false}); return; }
      res.status(200).json({exists: true, phase: state.phase, players: state.players.length});
      return;
    }

    // ---- join ----
    if (req.method === 'POST' && action === 'join') {
      const body = readBody(req);
      let issued = null;
      const {state} = await mutate(room, s => {
        issued = engine.addPlayer(s, body.name, body.color, randomToken);
        return issued;
      });
      res.status(200).json({
        room,
        playerId: issued.playerId,
        token: issued.token,
        view: engine.viewFor(state, issued.playerId),
      });
      return;
    }

    // ---- read the redacted view ----
    if (req.method === 'GET' && action === 'state') {
      const state = await loadState(room);
      if (!state) throw new HttpError(404, 'no such room');
      const pid = engine.playerIdForToken(state, tokenOf(req));
      res.status(200).json({view: engine.viewFor(state, pid)});
      return;
    }

    // Everything past here needs a token that resolves to a player. Identity is
    // resolved inside the transaction, against the same copy of the state the
    // move is applied to — one read instead of two, and no window where the
    // roster changes between the auth check and the write.
    let me = null;
    const authed = s => {
      const pid = engine.playerIdForToken(s, tokenOf(req));
      if (!pid) throw new HttpError(401, 'unknown player — rejoin the room');
      me = pid;
      return pid;
    };

    // ---- host: change which optional cards are in the deck ----
    if (req.method === 'POST' && action === 'opts') {
      const body = readBody(req);
      const {state} = await mutate(room, s => {
        authed(s);
        if (!engine.isHost(s, me)) throw new engine.GameError('Only the host can change the deck.');
        if (s.phase !== 'lobby') throw new engine.GameError('Too late — the game has started.');
        if (body.opts !== undefined) s.opts = engine.sanitizeOpts(body.opts);
        if (body.limit !== undefined) s.limit = engine.sanitizeLimit(body.limit);
      });
      res.status(200).json({view: engine.viewFor(state, me)});
      return;
    }

    // ---- host: deal ----
    // 'start'   first hand of a match, from the lobby
    // 'next'    the following hand, once a hand's scores are on the board
    // 'rematch' wipe the scoresheet and play a fresh match
    if (req.method === 'POST' && (action === 'start' || action === 'next' || action === 'rematch')) {
      const {state} = await mutate(room, s => {
        authed(s);
        if (!engine.isHost(s, me)) throw new engine.GameError('Only the host can deal.');
        if (action === 'start' && s.phase !== 'lobby') throw new engine.GameError('The match is already under way.');
        if (action === 'next' && s.phase !== 'round') throw new engine.GameError('That hand is still going.');
        if (action === 'rematch' && s.phase !== 'over') throw new engine.GameError('The match is still going.');
        if (action === 'rematch') engine.resetMatch(s);
        engine.startGame(s);
      });
      res.status(200).json({view: engine.viewFor(state, me)});
      return;
    }

    // ---- a move ----
    if (req.method === 'POST' && action === 'move') {
      const body = readBody(req);
      const {state, result} = await mutate(room, s => engine.applyMove(s, authed(s), body.move || {}));
      res.status(200).json({view: engine.viewFor(state, me), peek: result ? result.peek : null});
      return;
    }

    throw new HttpError(405, 'method not allowed');

  } catch (e) {
    // Rule violations are the player's problem and safe to explain; anything
    // else is ours and gets a generic status.
    if (e instanceof engine.GameError) { res.status(400).json({error: e.message}); return; }
    const status = e && e.status ? e.status : 502;
    res.status(status).json({error: (e && e.message) || 'upstream error'});
  }
};
