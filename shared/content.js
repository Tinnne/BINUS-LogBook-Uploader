(function () {
    'use strict';

    /* ============================================================
       BINUS Logbook Uploader — Firefox content script
       Injects an "Upload CSV" button into the Learning Plan page
       and fills daily logbook entries via the site's own API.
       ============================================================ */

    // ─── Configuration ──────────────────────────────────────────
    const BASE_URL = 'https://activity-enrichment.apps.binus.ac.id';
    const CSS_ID = 'binus-logbook-uploader-style';
    let isRunning = false;

    // ─── Initialization ─────────────────────────────────────────
    function init() {
        if (!window.location.pathname.includes('/LearningPlan/StudentIndex')) return;
        injectUI();
    }

    // ─── UI Injection ───────────────────────────────────────────
    function injectUI() {
        if (!document.getElementById(CSS_ID)) {
            var style = document.createElement('style');
            style.id = CSS_ID;
            style.textContent = [
                '#binus-lbu-root { all: initial; position: fixed;',
                '  z-index: 99999; bottom: 24px; right: 24px;',
                '  font-family: sans-serif; font-size: 14px;',
                '  line-height: 1.4; color: #333; }',
                '#binus-lbu-btn { display: inline-flex; align-items: center;',
                '  gap: 6px; padding: 10px 18px; background: #2645B8;',
                '  color: #fff; border: none; border-radius: 8px;',
                '  font-size: 14px; font-weight: 600; cursor: pointer;',
                '  box-shadow: 0 2px 12px rgba(38,69,184,0.35);',
                '  transition: opacity .2s; }',
                '#binus-lbu-btn:hover { opacity: .85; }',
                '#binus-lbu-btn:disabled { opacity: .5; cursor: not-allowed; }',
                '#binus-lbu-panel { display: none; margin-top: 8px;',
                '  padding: 14px 16px; background: #fff; border-radius: 8px;',
                '  box-shadow: 0 4px 20px rgba(0,0,0,0.15);',
                '  border: 1px solid #e0e0e0; max-width: 380px;',
                '  word-wrap: break-word; }',
                '#binus-lbu-panel.visible { display: block; }',
                '#binus-lbu-status { margin-bottom: 6px; }',
                '#binus-lbu-status.error { color: #d12f2e; }',
                '#binus-lbu-status.success { color: #2e7d32; }',
                '#binus-lbu-progress { font-size: 13px; color: #666; }',
                '#binus-lbu-progress-bar { width: 100%; height: 4px;',
                '  background: #eee; border-radius: 2px;',
                '  margin-top: 6px; overflow: hidden; }',
                '#binus-lbu-progress-fill { height: 100%; width: 0%;',
                '  background: #2645B8; border-radius: 2px;',
                '  transition: width .3s; }'
            ].join('\n');
            document.head.appendChild(style);
        }
        if (document.getElementById('binus-lbu-root')) return;
        var root = document.createElement('div');
        root.id = 'binus-lbu-root';
        root.innerHTML = [
            '<button id="binus-lbu-btn">📋 Upload CSV</button>',
            '<div id="binus-lbu-panel">',
            '  <div id="binus-lbu-status">Ready</div>',
            '  <div id="binus-lbu-progress"></div>',
            '  <div id="binus-lbu-progress-bar" style="display:none">',
            '    <div id="binus-lbu-progress-fill"></div>',
            '  </div>',
            '</div>'
        ].join('');
        document.body.appendChild(root);
        document.getElementById('binus-lbu-btn').addEventListener('click', onUploadClick);
    }

    // ─── File Selection ─────────────────────────────────────────
    function onUploadClick() {
        if (isRunning) return;
        var tab = document.querySelector('.logBookTab');
        if (tab && !tab.classList.contains('current')) {
            setStatus('Switch to the Log Book tab first.', 'error');
            return;
        }
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.csv,.tsv,.yaml,.yml';
        input.addEventListener('change', async function(e) {
            var file = e.target.files[0];
            if (!file) return;
            var text = await file.text();
            var isYaml = /\.(yaml|yml)$/i.test(file.name);
            var entries;
            try {
                entries = isYaml ? yamlToEntries(text) : parseCSV(text);
            } catch (perr) {
                setStatus('Error: ' + (perr.message || perr), 'error');
                return;
            }
            if (entries.length === 0) {
                setStatus('No valid entries found in ' + (isYaml ? 'YAML' : 'CSV') + '.', 'error');
                return;
            }
            await uploadEntries(entries);
        });
        input.click();
    }

    // ─── Single-pass CSV Parser ──────────────────────────────
    // ponytail: exported for tests only; test harness stubs window.document
    function parseCSVRows(rows) {
        if (rows.length < 2) return [];
        var hdr = rows[0];
        var ci = {
            date: hdr.findIndex(function(c) { return /date/i.test(c); }),
            clockIn: hdr.findIndex(function(c) { return /clock/i.test(c); }),
            clockOut: hdr.findIndex(function(c) { return /clock\s*out/i.test(c); }),
            activity: hdr.findIndex(function(c) { return /activity/i.test(c); }),
            desc: hdr.findIndex(function(c) { return /desc/i.test(c); }),
        };
        console.log('[LBU] CSV header:', hdr, 'colIdx:', ci);
        if (ci.date === -1) return [];
        var out = [];
        for (var r = 1; r < rows.length; r++) {
            var f = rows[r];
            var ds = (f[ci.date] || '').trim();
            if (!ds) continue;
            var act = ci.activity >= 0 ? (f[ci.activity] || '').trim() : '';
            var desc = ci.desc >= 0 ? (f[ci.desc] || '').trim() : '';
            var isOff = act === '' || act.toUpperCase() === 'OFF';
            out.push({
                dateStr: ds,
                clockIn: isOff ? 'OFF' : (ci.clockIn >= 0 ? (f[ci.clockIn] || '').trim() : ''),
                clockOut: isOff ? 'OFF' : (ci.clockOut >= 0 ? (f[ci.clockOut] || '').trim() : ''),
                activity: act,
                description: desc,
                explicitOff: isOff,
            });
        }
        return out;
    }

    var CSV_TEXT = [];
    function parseCSV(text) {
        CSV_TEXT = [];
        var rows = [], row = [], field = '';
        var inQ = false, hasData = false;
        function pushF() { row.push(field); if (field.trim()) hasData = true; field = ''; }
        function pushR() { pushF(); if (hasData && row.length) { rows.push(row), CSV_TEXT.push(row); } row = []; hasData = false; }
        for (var i = 0; i < text.length; i++) {
            var c = text[i];
            if (c === '"') { inQ = !inQ; continue; }
            if (c === '\r') continue;
            if (c === '\n' && !inQ) { pushR(); continue; }
            if (c === ',' && !inQ) { pushF(); continue; }
            field += c;
        }
        if (field || row.length) pushR();
        window.__lbuCSVRows = CSV_TEXT;
        return parseCSVRows(rows);
    }

    // ─── Minimal YAML Parser ────────────────────────────────────
    // ponytail: subset parser — block maps/sequences, plain/quoted scalars,
    // comments; no anchors, block scalars (| >), or inline flow ({..} [..]
    // values degrade to strings). Covers the logbook file format only.
    function stripComment(s) {
        var q = null;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (q) { if (c === q) q = null; continue; }
            if (c === '"' || c === "'") { q = c; continue; }
            if (c === '#' && (i === 0 || s[i - 1] === ' ')) return s.slice(0, i).trim();
        }
        return s.trim();
    }

    function scalarValue(s) {
        s = s.trim();
        if (!s || s === '~' || /^(null|Null|NULL)$/.test(s)) return null;
        if (s === '[]') return [];
        if (/^(true|True|TRUE)$/.test(s)) return true;
        if (/^(false|False|FALSE)$/.test(s)) return false;
        if (/^[-+]?\d+(\.\d+)?$/.test(s)) return Number(s);
        if (s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'");
        if (s[0] === '"' && s[s.length - 1] === '"') return s.slice(1, -1);
        return s;
    }

    function splitKey(s) {
        var q = null;
        for (var i = 0; i < s.length; i++) {
            var c = s[i];
            if (q) { if (c === q) q = null; continue; }
            if (c === '"' || c === "'") { q = c; continue; }
            if (c === ':') {
                var after = s.slice(i + 1);
                if (after === '' || after.charAt(0) === ' ')
                    return { key: String(scalarValue(s.slice(0, i))), rest: after.trim() };
            }
        }
        return null;
    }

    function parseYAML(text) {
        var lines = [], p = 0;
        var rawLines = String(text).split(/\r?\n/);
        for (var li = 0; li < rawLines.length; li++) {
            var rawLine = rawLines[li].replace(/\t/g, '    ');
            var txt = stripComment(rawLine);
            if (!txt || txt === '---' || txt === '...') {
                lines.push({ indent: -1, raw: '', text: '' }); // struct-invisible
                continue;
            }
            var indent = rawLine.length - rawLine.replace(/^ +/, '').length;
            lines.push({ indent: indent, raw: rawLine, text: txt });
        }
        function fail(msg) { throw new Error('YAML parse: ' + msg); }
        function at(i) { return i < lines.length ? lines[i] : null; }
        function skipJunk() {
            while (p < lines.length && (lines[p].indent < 0 || lines[p].text === '')) p++;
        }

        // Block scalar: '>' folded / '|' literal, optional chomp (-/+) and
        // explicit indent digits (e.g. >2). ponytail: preserves deeper lines
        // and blank-line paragraph breaks; no exotic indentation cases.
        function parseBlockScalar(parentIndent, indicator) {
            var m = indicator.match(/^([>|])\s*([+-]?\d*)$/);
            if (!m) fail('bad block indicator: "' + indicator + '"');
            var literal = m[1] === '|';
            var flags = m[2] || '';
            var keep = flags.indexOf('+') >= 0, strip = flags.indexOf('-') >= 0;
            var digits = flags.replace(/[+-]/g, '');
            var explicit = digits !== '' ? parseInt(digits, 10) : null;

            var consumed = 0, content = [];
            for (;;) {
                var l = at(p + consumed);
                if (!l) break;
                if (l.indent < 0 || l.raw.trim() === '') {
                    content.push({ blank: true, indent: 0, raw: '' });
                    consumed++;
                    continue;
                }
                if (l.indent <= parentIndent) break;
                content.push({ blank: false, indent: l.indent, raw: l.raw });
                consumed++;
            }
            var eff = explicit;
            if (eff == null)
                for (var i0 = 0; i0 < content.length; i0++)
                    if (!content[i0].blank) { eff = content[i0].indent; break; }
            if (eff == null) eff = parentIndent + 2;

            var trailing = 0;
            while (content.length && content[content.length - 1].blank) { content.pop(); trailing++; }

            var body = '', breaks = 0, prevMore = false;
            // folding: a run of n line breaks → (n-1) '\n' (1 break → ' ');
            // breaks touching a more-indented line stay literal '\n'.
            for (var i = 0; i < content.length; i++) {
                var c = content[i];
                if (c.blank) { breaks++; continue; }
                var more = c.indent > eff;
                if (body !== '') {
                    if (literal || prevMore || more) body += new Array(breaks + 1).join('\n');
                    else if (breaks === 1) body += ' ';
                    else body += new Array(breaks).join('\n');
                }
                body += c.raw.slice(Math.min(eff, c.indent));
                breaks = 1; prevMore = more;
            }
            p += consumed;
            if (body === '') return '';
            if (keep) return body + '\n' + new Array(trailing + 1).join('\n');
            return body + (strip ? '' : '\n');
        }

        function parseNode(indent) {
            skipJunk();
            var l = at(p);
            if (!l || l.indent < indent) return null;
            if (l.indent > indent) fail('unexpected indent: "' + l.text + '"');
            if (l.text === '-' || l.text.slice(0, 2) === '- ') return parseSeq(indent);
            if (splitKey(l.text)) return parseMap(indent);
            p++;
            return scalarValue(l.text);
        }

        function parseSeq(indent) {
            var arr = [];
            for (;;) {
                skipJunk();
                var l = at(p);
                if (!l || l.indent < indent) break;
                if (l.indent > indent) fail('bad indent in sequence: "' + l.text + '"');
                var t = l.text;
                if (t !== '-' && t.slice(0, 2) !== '- ') break;
                var rest = t === '-' ? '' : t.slice(1).replace(/^ +/, '');
                p++;
                if (rest) {
                    // `- key: v` → item is a map whose keys align right after the dash
                    var itemIndent = indent + (t.length - rest.length);
                    lines.splice(p, 0, { indent: itemIndent, raw: rest, text: rest });
                    arr.push(parseNode(itemIndent));
                } else {
                    skipJunk();
                    var n = at(p);
                    arr.push(n && n.indent > indent ? parseNode(n.indent) : null);
                }
            }
            return arr;
        }

        function parseMap(indent) {
            var obj = {};
            for (;;) {
                skipJunk();
                var l = at(p);
                if (!l || l.indent < indent) break;
                if (l.indent > indent) fail('bad indent in mapping: "' + l.text + '"');
                var kv = splitKey(l.text);
                if (!kv) fail('expected "key: value": "' + l.text + '"');
                p++;
                if (kv.rest) {
                    if (kv.rest === '>' || kv.rest === '|' || /^[>|]\s*[+-]?\d*$/.test(kv.rest))
                        obj[kv.key] = parseBlockScalar(indent, kv.rest);
                    else
                        obj[kv.key] = scalarValue(kv.rest);
                    continue;
                }
                skipJunk();
                var n = at(p);
                obj[kv.key] = n && n.indent > indent ? parseNode(n.indent) : null;
            }
            return obj;
        }

        if (!lines.length) return null;
        skipJunk();
        if (p >= lines.length) return null;
        return parseNode(lines[p].indent);
    }

    // ─── YAML → normalized entries ──────────────────────────────
    // Same shape the CSV parser emits, plus explicitOff. Dates are
    // YYYY-MM-DD (CSV-style "Tue, 1 Sep 2026" still accepted).
    function yamlToEntries(text) {
        var doc = parseYAML(text);
        if (!doc || typeof doc !== 'object' || Array.isArray(doc))
            throw new Error('YAML: expected a top-level mapping');
        var seq = doc.logbook == null ? [] : doc.logbook;
        if (!Array.isArray(seq)) throw new Error('YAML: "logbook" must be a list');
        var dft = (doc.defaults && typeof doc.defaults === 'object') ? doc.defaults : {};
        var dIn = dft['clock-in'] != null ? String(dft['clock-in']).trim() : '';
        var dOut = dft['clock-out'] != null ? String(dft['clock-out']).trim() : '';
        var out = [];
        for (var i = 0; i < seq.length; i++) {
            var it = seq[i];
            if (!it || typeof it !== 'object') continue;
            var act = it.activity == null ? '' : String(it.activity).trim();
            var isOff = act === '' || act.toUpperCase() === 'OFF';
            out.push({
                dateStr: it.date == null ? '' : String(it.date).trim(),
                clockIn: isOff ? 'OFF' : (it['clock-in'] != null ? String(it['clock-in']).trim() : dIn),
                clockOut: isOff ? 'OFF' : (it['clock-out'] != null ? String(it['clock-out']).trim() : dOut),
                activity: act,
                description: it.description == null ? '' : String(it.description).trim(),
                explicitOff: isOff,
            });
        }
        return out;
    }

    // ─── Date Helpers ───────────────────────────────────────────
    var MONTH_MAP = {
        Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06',
        Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12',
    };

    function csvDateToKey(str) {
        var m = str.match(/(\d{1,2})\s+(\w{3})\s+(\d{4})/);
        if (!m) return null;
        return m[3] + '-' + (MONTH_MAP[m[2]] || '??') + '-' + m[1].padStart(2, '0');
    }

    // Entry dates: YAML YYYY-MM-DD (quotes stripped) or CSV "Tue, 1 Sep 2026"
    function entryDateToKey(dateStr) {
        var s = String(dateStr).trim().replace(/^['"]+|['"]+$/g, '');
        var m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (m) {
            var mo = +m[2], day = +m[3];
            return (mo >= 1 && mo <= 12 && day >= 1 && day <= 31) ? s : null;
        }
        return csvDateToKey(s);
    }

    function apiDateToKey(dateVal) {
        if (typeof dateVal !== 'string') dateVal = String(dateVal);
        var m = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (m) return m[1] + '-' + m[2] + '-' + m[3];
        var tm = dateVal.match(/\/Date\((\d+)\)/);
        if (tm) {
            var d = new Date(parseInt(tm[1], 10));
            if (!isNaN(d.getTime())) {
                return d.getUTCFullYear() + '-' +
                    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getUTCDate()).padStart(2, '0');
            }
        }
        var d = new Date(dateVal);
        if (isNaN(d.getTime())) return null;
        return d.getFullYear() + '-' +
            String(d.getMonth() + 1).padStart(2, '0') + '-' +
            String(d.getDate()).padStart(2, '0');
    }

    function getDayOfWeek(dateVal) {
        if (typeof dateVal === 'string') {
            var m = dateVal.match(/^(\d{4})-(\d{2})-(\d{2})/);
            if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])).getUTCDay();
            var tm = dateVal.match(/\/Date\((\d+)\)/);
            if (tm) return new Date(+tm[1]).getUTCDay();
        }
        var d = new Date(dateVal);
        return isNaN(d.getTime()) ? -1 : d.getDay();
    }

    // ─── DOM: get headerID from the selected month tab ────────────
    function getSelectedMonthHeaderID(monthsData) {
        // Find which month tab the user has open (has class="current" in #monthTab)
        var currentTab = document.querySelector('#monthTab li.current a');
        if (currentTab) {
            var onclick = currentTab.getAttribute('onclick') || '';
            var m = onclick.match(/tabClick\('([^']+)'\)/);
            if (m) {
                console.log('[LBU] Using active tab headerID:', m[1]);
                return m[1];
            }
        }
        // Fallback: use data.lbid from API
        if (monthsData && monthsData.lbid) {
            console.log('[LBU] Fallback to API lbid:', monthsData.lbid);
            return monthsData.lbid;
        }
        return null;
    }

    

    // ─── Helper: pad clock time to HH:MM AM/PM format ──────
    function padClockTime(t) {
        if (!t || t === 'OFF') return t;
        var m = t.match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
        return m ? m[1].padStart(2, '0') + ':' + m[2] + ' ' + m[3].toUpperCase() : t;
    }

    // ─── Main Upload Logic ──────────────────────────────────────
    async function uploadEntries(csvEntries) {
        isRunning = true;
        toggleUI(true);
        try {
            // Get months from API
            var monthsData = await apiGet('/LogBook/GetMonths', { logBookId: '' });
            if (!monthsData || !monthsData.data || monthsData.data.length === 0) {
                setStatus('Cannot load months. Is your LP finalized?', 'error');
                return;
            }
            var headerID = getSelectedMonthHeaderID(monthsData);
            if (!headerID) {
                setStatus('Could not determine current month tab.', 'error');
                return;
            }
            // Fetch logbook entries for that month
            var params = new URLSearchParams();
            params.set('logBookHeaderID', headerID);
            var lbData = await apiPost('/LogBook/GetLogBook', params);
            if (!lbData || !lbData.data) {
                setStatus('Cannot load logbook entries.', 'error');
                return;
            }
            var apiEntries = lbData.data;
            var flagjuly = !!lbData.flagjulyactive;
            var total = apiEntries.length;

            console.log('[LBU] API returned ' + total + ' entries');
            for (var d = 0; d < Math.min(3, total); d++) {
                console.log('  ' + d + ': date=', apiEntries[d].date,
                    'acceptanceID=', apiEntries[d].acceptanceID,
                    'key="' + apiDateToKey(apiEntries[d].date) + '"',
                    'dow=', getDayOfWeek(apiEntries[d].date));
            }

            var plan = planUploads(apiEntries, csvEntries);
            var filled = 0, markedOff = 0, skipped = 0, errors = 0;
            showProgressBar(true);
            for (var i = 0; i < plan.length; i++) {
                var p = plan[i];
                var ok;
                if (p.action === 'off') {
                    console.log('[LBU] OFF ' + p.dateKey + ' (' + p.reason + ')');
                    ok = await rawSaveEntry(headerID, p.id, p.date, 'OFF', 'OFF', 'OFF', 'OFF', flagjuly);
                    if (ok) markedOff++; else errors++;
                } else if (p.action === 'fill') {
                    console.log('[LBU] FILL ' + p.dateKey + ' => ' + p.activity);
                    ok = await rawSaveEntry(headerID, p.id, p.date,
                        padClockTime(p.clockIn) || 'OFF', padClockTime(p.clockOut) || 'OFF',
                        p.activity, p.description, flagjuly);
                    if (ok) filled++; else errors++;
                } else {
                    console.log('[LBU] SKIP ' + p.dateKey + ' (' + p.reason + ')');
                    skipped++;
                }
                updateProgressBar(filled + markedOff + skipped + errors, total);
            }

            var msg = 'Done!<br>' +
                filled + ' filled, ' + markedOff + ' OFF (Sat or gap), ' +
                skipped + ' skipped' + (errors ? ', ' + errors + ' errors' : '');
            setStatus(msg, errors ? 'error' : 'success');
        } catch (err) {
            setStatus('Error: ' + (err.message || err), 'error');
        } finally {
            isRunning = false;
            toggleUI(false);
        }
    }

    // ─── Upload planner (pure, testable) ─────────────────────────
    // Decides per API row: off / fill / skip. No DOM, no fetch.
    // Rules:
    //   acceptanceID 1/3/4 → skip; Sunday → skip; Saturday → OFF.
    //   explicit OFF entry → OFF. CSV: blank/empty row → explicit OFF.
    //   Explicit OFF weekdays gapped by exactly 1 weekday → OFF.
    //   Unmatched weekdays otherwise → skip.
    function planUploads(apiEntries, csvEntries) {
        var byKey = {};
        for (var i = 0; i < csvEntries.length; i++) {
            if (csvEntries[i].explicitOff) continue;
            var k0 = entryDateToKey(csvEntries[i].dateStr);
            if (k0 && byKey[k0]) throw new Error('Duplicate logbook entry for date ' + k0);
            byKey[k0] = csvEntries[i];
        }
        for (var j = 0; j < csvEntries.length; j++) {
            var e = csvEntries[j];
            var key = entryDateToKey(e.dateStr);
            if (key) byKey[key] = e;
        }
        // Gap fill: undefined dates BETWEEN two consecutive records (any
        // kind) default to OFF. No tail rule — a mid-month partial write
        // (records just end) leaves later weekdays alone unless explicitly
        // listed (ponytail: bounded-by-next-record, per spec).
        var recs = [];
        for (var k = 0; k < csvEntries.length; k++) {
            var ok1 = entryDateToKey(csvEntries[k].dateStr);
            if (ok1) recs.push(ok1);
        }
        recs.sort();
        var gapDates = {};
        for (var g = 0; g + 1 < recs.length; g++) {
            var am = recs[g].match(/^(\d{4})-(\d{2})-(\d{2})$/);
            var bm = recs[g + 1].match(/^(\d{4})-(\d{2})-(\d{2})$/);
            if (!am || !bm) continue; // cross-month/invalid neighbors: no gap fill
            var a = new Date(Date.UTC(+am[1], +am[2] - 1, +am[3]));
            var b = new Date(Date.UTC(+bm[1], +bm[2] - 1, +bm[3]));
            for (var d = new Date(a.getTime() + 864e5); d < b; d.setUTCDate(d.getUTCDate() + 1)) {
                gapDates[d.getUTCFullYear() + '-' +
                    String(d.getUTCMonth() + 1).padStart(2, '0') + '-' +
                    String(d.getUTCDate()).padStart(2, '0')] = true;
            }
        }

        var plan = [];
        for (var r = 0; r < apiEntries.length; r++) {
            var row = apiEntries[r];
            var dateKey = apiDateToKey(row.date);
            if (!dateKey) { plan.push({ action: 'skip', dateKey: '?', reason: 'unparseable date' }); continue; }
            if (row.acceptanceID === 1 || row.acceptanceID === 3 || row.acceptanceID === 4)
                { plan.push({ action: 'skip', dateKey: dateKey, reason: 'accepted' }); continue; }
            var dow = getDayOfWeek(row.date);
            if (dow === 0) { plan.push({ action: 'skip', dateKey: dateKey, reason: 'sunday' }); continue; }
            if (dow === 6) { plan.push({ action: 'off', dateKey: dateKey, reason: 'saturday', id: row.id, date: row.date }); continue; }

            var e2 = byKey[dateKey];
            if (e2 && !e2.explicitOff)
                plan.push({ action: 'fill', dateKey: dateKey, id: row.id, date: row.date,
                    clockIn: e2.clockIn, clockOut: e2.clockOut,
                    activity: e2.activity || '', description: e2.description || '' });
            else if (e2 || gapDates[dateKey])
                plan.push({ action: 'off', dateKey: dateKey, reason: e2 ? 'explicit OFF' : 'gap', id: row.id, date: row.date });
            else
                plan.push({ action: 'skip', dateKey: dateKey, reason: 'no entry' });
        }
        return plan;
    }

    // ─── API Helpers ────────────────────────────────────────────
    async function apiGet(endpoint, params) {
        var url = BASE_URL + endpoint + '?' + new URLSearchParams(params).toString();
        var resp = await fetch(url, {
            credentials: 'include',
            headers: { 'X-Requested-With': 'XMLHttpRequest' }
        });
        if (!resp.ok) throw new Error('GET ' + endpoint + ' => ' + resp.status);
        return resp.json();
    }

    async function apiPost(endpoint, bodyParams) {
        var resp = await fetch(BASE_URL + endpoint, {
            method: 'POST',
            credentials: 'include',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'X-Requested-With': 'XMLHttpRequest'
            },
            body: bodyParams.toString()
        });
        if (!resp.ok) throw new Error('POST ' + endpoint + ' => ' + resp.status);
        return resp.json();
    }

    async function rawSaveEntry(headerID, entryID, date, clockIn, clockOut, activity, description, flagjuly) {
        var body = new URLSearchParams();
        body.append('model[ID]', entryID || '');
        body.append('model[LogBookHeaderID]', headerID);
        body.append('model[Date]', typeof date === 'string' ? date : '');
        body.append('model[Activity]', activity);
        body.append('model[ClockIn]', clockIn);
        body.append('model[ClockOut]', clockOut);
        body.append('model[Description]', description);
        body.append('model[flagjulyactive]', String(flagjuly));
        console.log('[LBU] POST /LogBook/StudentSave body=' + body.toString().slice(0, 150));
        try {
            var resp = await fetch(BASE_URL + '/LogBook/StudentSave', {
                method: 'POST',
                credentials: 'include',
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'X-Requested-With': 'XMLHttpRequest'
                },
                body: body.toString()
            });
            if (!resp.ok) { var errText = await resp.text(); console.log('[LBU] Save error body:', errText.slice(0, 200)); return false; }
            var data = await resp.json();
            console.log('[LBU] Save JSON:', JSON.stringify(data).slice(0, 200));
            return data && data.json !== false;
        } catch (e) {
            console.log('[LBU] Save exception:', e.message);
            return false;
        }
    }

    // ─── UI Helpers ─────────────────────────────────────────────
    function setStatus(html, type) {
        var el = document.getElementById('binus-lbu-status');
        if (!el) return;
        el.innerHTML = html;
        el.className = type || '';
        var panel = document.getElementById('binus-lbu-panel');
        if (panel) panel.classList.add('visible');
    }

    function toggleUI(disabled) {
        var btn = document.getElementById('binus-lbu-btn');
        if (btn) {
            btn.disabled = disabled;
            btn.textContent = disabled ? 'Uploading...' : 'Upload CSV';
        }
    }

    function showProgressBar(show) {
        var bar = document.getElementById('binus-lbu-progress-bar');
        if (bar) bar.style.display = show ? 'block' : 'none';
    }

    function updateProgressBar(current, total) {
        var fill = document.getElementById('binus-lbu-progress-fill');
        if (fill) fill.style.width = (total > 0 ? Math.round((current / total) * 100) : 0) + '%';
        var text = document.getElementById('binus-lbu-progress');
        if (text) text.textContent = current + ' / ' + total;
    }

    // ─── Start ──────────────────────────────────────────────────
    // ponytail: test seam — node harness passes a sandbox and skips boot
    if (typeof window.__LBU_TEST__ === 'undefined') {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', init);
        } else {
            init();
        }
    } else {
        window.__LBU = {
            parseCSVRows: parseCSVRows, parseCSV: parseCSV,
            parseYAML: parseYAML, yamlToEntries: yamlToEntries,
            csvDateToKey: csvDateToKey, entryDateToKey: entryDateToKey,
            apiDateToKey: apiDateToKey, getDayOfWeek: getDayOfWeek,
            padClockTime: padClockTime, planUploads: planUploads,
        };
    }

})();
