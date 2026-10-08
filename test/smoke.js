// Throwaway smoke test for shared/content.js logic (CSV parser + date helpers).
// Run: node test/smoke.js
'use strict';
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '..', 'shared', 'content.js'), 'utf8');

function loadSandbox(extra) {
  const window = Object.assign({ __LBU_TEST__: true }, extra);
  vm.runInNewContext(src, { window, document: { readyState: 'complete' }, console, URL });
  return window;
}

let failed = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) { failed++; console.log('FAIL', name, '=>', JSON.stringify(actual), 'want', JSON.stringify(expected)); }
  else console.log('ok  ', name);
}

const w = loadSandbox();
check('test API exported', typeof w.__LBU.parseCSV, 'function');

const api = w.__LBU;

// ── parseCSVRows (rows → entries) ──
check('parseCSVRows', api.parseCSVRows([
  ['Date', 'Clock In', 'Clock Out', 'Activity', 'Description'],
  ['Tue, 1 Sep 2026', '8:26 AM', '5:31 PM', 'Scraping', '- run'],
  ['Wed, 2 Sep 2026', '9:00 AM', '  ', 'Dashboard', ''],
  ['', '', '', '', ''],
]), [
  { dateStr: 'Tue, 1 Sep 2026', clockIn: '8:26 AM', clockOut: '5:31 PM', activity: 'Scraping', description: '- run', explicitOff: false},
  { dateStr: 'Wed, 2 Sep 2026', clockIn: '9:00 AM', clockOut: '', activity: 'Dashboard', description: '', explicitOff: false },
]);

// ── parseCSV (raw text: quoting, CRLF) ──
const w2 = loadSandbox();
const text = 'date,activity\r\n"Tue, 1 Sep 2026","Scraping, dashboard"\r\n';
const parsed = w2.__LBU.parseCSV(text);
check('quoted rows split on commas inside quotes', w2.__lbuCSVRows, [['date', 'activity'], ['Tue, 1 Sep 2026', 'Scraping, dashboard']]);
check('parseCSV entries', parsed, [
  { dateStr: 'Tue, 1 Sep 2026', clockIn: '', clockOut: '', activity: 'Scraping, dashboard', description: '', explicitOff: false },
]);

// ── date helpers ──
check('csvDateToKey', api.csvDateToKey('Tue, 1 Sep 2026'), '2026-09-01');
check('csvDateToKey unknown month', api.csvDateToKey('1 Foo 2026'), '2026-??-01');
check('apiDateToKey ISO', api.apiDateToKey('2026-09-01T00:00:00'), '2026-09-01');
check('apiDateToKey /Date(ms)/', api.apiDateToKey('/Date(1789234000000)/'), new Date(1789234000000).toISOString().slice(0, 10));
check('apiDateToKey junk', api.apiDateToKey('nonsense'), null);
check('getDayOfWeek Sat', api.getDayOfWeek('2026-09-05'), 6);
check('getDayOfWeek Sun', api.getDayOfWeek('2026-09-06'), 0);
check('padClockTime pads hour', api.padClockTime('8:26 AM'), '08:26 AM');
check('padClockTime OFF passthrough', api.padClockTime('OFF'), 'OFF');
check('padClockTime junk passthrough', api.padClockTime('x'), 'x');

// ── YAML subset parser ──
const doc = api.parseYAML([
  "defaults:",
  "  clock-in: '9:00 AM'",
  "  clock-out: '6:00 AM' # office hours",
  "logbook:",
  "  - date: 2026-10-05",
  "    activity: 'Refactor project'",
  "    description: 'Day shift'",
  "  - date: 2026-10-06",
  "    activity: null # OFF",
  "    clock-in: '8:00 AM'",
  "  - date: 2026-10-07",
  "    activity: Test",
  "    clock-in: \"10:30 PM\"",
].join('\n'));
check('yaml top-level keys', Object.keys(doc), ['defaults', 'logbook']);
check('yaml defaults', doc.defaults, { 'clock-in': '9:00 AM', 'clock-out': '6:00 AM' });
check('yaml seq len', doc.logbook.length, 3);
check('yaml item0', doc.logbook[0], { date: '2026-10-05', activity: 'Refactor project', description: 'Day shift' });
check('yaml null activity', doc.logbook[1].activity, null);
check('yaml dquoted scalar', doc.logbook[2]['clock-in'], '10:30 PM');
check('yaml comment strip quoted hash', api.parseYAML("a: 'x # y'\nb: 2").a, 'x # y');
check('yaml int value', api.parseYAML('a: 42').a, 42);
check('yaml inline seq item map', api.parseYAML('logbook:\n  - date: 2026-10-05\n    activity: A').logbook,
  [{ date: '2026-10-05', activity: 'A' }]);
check('yaml number unquoted date kept as string', api.parseYAML('a: 2026-10-05').a, '2026-10-05');

// ── block scalars (sept.yaml format: description: >) ──
check('folded joins lines with spaces',
  api.parseYAML('a: >\n  line one\n  line two\n').a, 'line one line two\n');
check('folded blank line becomes single newline',
  api.parseYAML('a: >\n  one\n\n  two\n').a, 'one\ntwo\n');
check('folded strip chomp drops trailing newline',
  api.parseYAML('a: >-\n  one\n  two\n').a, 'one one'.replace('one one', 'one two'));
check('folded two blank lines two newlines',
  api.parseYAML('a: >\n  one\n\n\n  two\n').a, 'one\n\ntwo\n');
check('literal preserves internal newlines',
  api.parseYAML('a: |\n  one\n  two\n').a, 'one\ntwo\n');
check('literal blank lines preserved',
  api.parseYAML('a: |\n  one\n\n  two\n').a, 'one\n\ntwo\n');
check('more-indented line kept literal with extra indent',
  api.parseYAML('a: >\n  normal\n    deep here\n  normal2\n').a, 'normal\n  deep here\nnormal2\n');
check('block content hash not a comment',
  api.parseYAML('a: >\n  text # not a comment\n').a, 'text # not a comment\n');
check('empty block scalar', api.parseYAML('a: >\nb: 2\n').a, '');
check('block then sibling key', api.parseYAML('defaults:\n  a: >\n    x\n    y\n  b: 3\n').defaults,
  { a: 'x y\n', b: 3 });
check('seq item with folded desc',
  api.parseYAML('log:\n  - d: 1\n    desc: >\n      para one\n      more\n  - d: 2\n').log,
  [{ d: 1, desc: 'para one more\n' }, { d: 2 }]);

// sept.yaml shape end-to-end (defaults apply, folded description, no quotes)
const sept = api.yamlToEntries([
  'defaults:',
  "  clock-in: '9:00 AM'",
  "  clock-out: '6:00 PM'",
  'logbook:',
  '  - date: 2026-09-01',
  '    activity: Creating initial code',
  '    description: >',
  '      Started with reading documentation,',
  '      then started testing locally.',
  '',
  '      Second paragraph.',
].join('\n'));
check('sept-style entry', sept[0], {
  dateStr: '2026-09-01', clockIn: '9:00 AM', clockOut: '6:00 PM',
  activity: 'Creating initial code',
  description: 'Started with reading documentation, then started testing locally.\nSecond paragraph.',
  explicitOff: false,
});

// ── yamlToEntries normalization ──
const ye = api.yamlToEntries([
  'defaults:',
  "  clock-in: '9:00 AM'",
  "  clock-out: '6:00 AM'",
  'logbook:',
  '  - date: 2026-10-05',
  "    activity: 'Refactor project'",
  "    description: 'Starting out the day'",
  '  - date: 2026-10-06',
  '    activity: null',
  '  - date: 2026-10-07',
  "    activity: 'Test refactor'",
  "    clock-in: '10:00 AM'",
].join('\n'));
check('yamlToEntries default times applied', [ye[0].clockIn, ye[0].clockOut], ['9:00 AM', '6:00 AM']);
check('yamlToEntries explicit OFF', ye[1], { dateStr: '2026-10-06', clockIn: 'OFF', clockOut: 'OFF', activity: '', description: '', explicitOff: true });
check('yamlToEntries per-item override', [ye[2].clockIn, ye[2].clockOut], ['10:00 AM', '6:00 AM']);
check('yamlToEntries empty logbook', api.yamlToEntries('logbook: []'), []);
let threw = false;
try {
  api.planUploads([], api.yamlToEntries('logbook:\n  - date: 2026-10-05\n    activity: A\n  - date: 2026-10-05\n    activity: B'));
} catch (e) { threw = /Duplicate/.test(e.message); }
check('planner duplicate date rejected', threw, true);

// ── planUploads (pure planner) ──
// Oct 2026: 01 Thu, 02 Fri, 03 Sat, 04 Sun, 05 Mon, 06 Tue, 07 Wed,
// 08 Thu, 09 Fri, 10 Sat, 11 Sun, 12 Mon … 15 Thu, 16 Fri, 17 Sat, 18 Sun, 19 Mon
const oct = (d) => `2026-10-${String(d).padStart(2, '0')}`;
function row(d) { return { id: 'e' + d, date: oct(d), acceptanceID: 0 }; }

const entries = api.yamlToEntries([
  'logbook:',
  '  - date: 2026-10-01', // Thu
  '    activity: Work A',
  '  - date: 2026-10-02', // Fri
  '    activity: Work B',
  '  - date: 2026-10-06', // Tue
  '    activity: Work C',
  '  - date: 2026-10-07', // Wed, explicit OFF → gap 10-08 becomes OFF
  '    activity: null',
  '  - date: 2026-10-15', // Thu
  '    activity: Work D',
  '  # 09 Fri / 16 Fri / 19+ weekdays after the last record: untouched (skip)',
].join('\n'));
const plan = api.planUploads(
  [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 15, 16, 19].map(row), entries);
const acts = {};
plan.forEach(p => { acts[p.dateKey] = p.action; });

check('plan fill', [acts['2026-10-01'], acts['2026-10-02']], ['fill', 'fill']);
check('plan saturday off', acts['2026-10-03'], 'off');
check('plan sunday skip', acts['2026-10-04'], 'skip');
check('plan unmatched weekday inside block becomes gap OFF (10-05 between records)', acts['2026-10-05'], 'off');
check('plan fill', acts['2026-10-06'], 'fill');
check('plan explicit OFF honored', acts['2026-10-07'], 'off');
check('plan gap OFF between records', acts['2026-10-08'], 'off');
check('plan friday inside block becomes gap OFF (10-09 between records)', acts['2026-10-09'], 'off');
check('plan saturday off', acts['2026-10-10'], 'off');
check('plan fill after gap', acts['2026-10-15'], 'fill');
check('plan trailing weekday skip', acts['2026-10-16'], 'skip');
check('plan trailing weekday skip', acts['2026-10-19'], 'skip');

// acceptance-ID skip still wins
const aPlan = api.planUploads([{ id: 'a', date: oct(1), acceptanceID: 3 }], entries);
check('plan accepted skip', aPlan[0].action, 'skip');

// ── CSV path: blank activity row = explicit OFF, gap rule identical ──
const csvBlanks = api.parseCSV('Date,Clock In,Clock Out,Activity,Description\n"Tue, 6 Oct 2026",9:00 AM,5:00 PM,Work,\n"Wed, 7 Oct 2026",,,,');
check('csv blank row explicit OFF', [csvBlanks[0].explicitOff, csvBlanks[1].explicitOff], [false, true]);
const csvPlan = api.planUploads([row(6), row(7), row(8)], csvBlanks);
check('csv plan fill + explicit OFF + tail skip (not between records)',
  [csvPlan[0].action, csvPlan[1].action, csvPlan[2].action], ['fill', 'off', 'skip']);

process.exitCode = failed ? 1 : 0;
console.log(failed ? failed + ' FAILED' : 'all passed');