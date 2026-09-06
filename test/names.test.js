// Checks the random-name pools in index.html.
//
// The cap is the point: the input has maxlength="14" and the server does
// slice(0, 14), so a longer entry would reach the table chopped in half. This
// pulls the real pools out of the shipping file rather than a copy.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const m = HTML.match(/const NAME_POOLS = (\{[\s\S]*?\n\});/);
if (!m) { console.error('could not find NAME_POOLS in index.html'); process.exit(1); }
const POOLS = vm.runInNewContext('(' + m[1] + ')');

const themes = HTML.match(/const POOL_THEME = (\{[^}]*\});/);
const THEME = vm.runInNewContext('(' + themes[1] + ')');

const MAX = 14;   // must match maxlength in the HTML and slice() in _engine.js
const SUITS = ['ember', 'volt', 'frost', 'vapor'];

let pass = 0, fail = 0;
const check = (n, c, d) => { if (c) { pass++; console.log('  ok   ' + n); } else { fail++; console.log('  FAIL ' + n + (d ? ' -> ' + d : '')); } };

console.log('\nname pools');
check('every suit has a pool', SUITS.every(s => Array.isArray(POOLS[s])), Object.keys(POOLS).join(','));
check('every suit has a theme label', SUITS.every(s => typeof THEME[s] === 'string'));

const all = [];
SUITS.forEach(s => (POOLS[s] || []).forEach(n => all.push({suit: s, name: n})));

const tooLong = all.filter(x => x.name.length > MAX);
check('no name exceeds ' + MAX + ' characters', tooLong.length === 0,
  tooLong.map(x => x.name + '(' + x.name.length + ')').join(', '));

const empty = all.filter(x => !x.name.trim());
check('no blank names', empty.length === 0);

const odd = all.filter(x => !/^[A-Za-z][A-Za-z' -]*$/.test(x.name));
check('names are plain letters (survive a round trip)', odd.length === 0, odd.map(x => x.name).join(', '));

const trimmed = all.filter(x => x.name !== x.name.trim());
check('no stray whitespace', trimmed.length === 0);

SUITS.forEach(s => {
  const pool = POOLS[s] || [];
  check(s + ' has enough names to feel random (>=10)', pool.length >= 10, String(pool.length));
  check(s + ' has no duplicates', new Set(pool).size === pool.length);
});

const seen = new Map();
all.forEach(x => { seen.set(x.name, (seen.get(x.name) || 0) + 1); });
const shared = [...seen.entries()].filter(([, n]) => n > 1);
check('no name appears in two suits', shared.length === 0, shared.map(([n]) => n).join(', '));

// The whole point of the feature: these must not read as people.
const HUMAN = ['daniel', 'sarah', 'john', 'mike', 'david', 'chris', 'alex', 'sam', 'james',
               'robert', 'mary', 'linda', 'emma', 'olivia', 'liam', 'noah'];
const humanish = all.filter(x => HUMAN.includes(x.name.toLowerCase()));
check('no common first names', humanish.length === 0, humanish.map(x => x.name).join(', '));

console.log('\n  ' + all.length + ' names across ' + SUITS.length + ' suits, longest is ' +
  Math.max(...all.map(x => x.name.length)) + ' chars');
console.log('\n' + pass + ' passed, ' + fail + ' failed\n');
process.exit(fail ? 1 : 0);
