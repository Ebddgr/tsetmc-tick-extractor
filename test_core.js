// Test harness: eval the shipped <script id="core"> block and check it against the live API.
const fs = require('fs');
const html = fs.readFileSync(__dirname + '/tsetmc_tick_extractor.html', 'utf8');
const m = html.match(/<script id="core">([\s\S]*?)<\/script>/);
if (!m) { console.error('core script block not found'); process.exit(1); }
(0, eval)(m[1]); // indirect eval → globals; core declares consts at script scope
// wrap: consts are scoped to eval — re-eval capturing via appended export shim
const shim = m[1] + `\n;globalThis.__core = { eachDay, tickToRow, toCsv, fetchDayTicks, DAY_HEADER, COMBINED_HEADER, pad6, fmtTime, dowName, todayYmd, fetchInstrument };`;
(0, eval)(shim);
const C = globalThis.__core;

(async () => {
  let fail = 0;
  const check = (name, cond, extra) => {
    console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
    if (!cond) fail++;
  };

  // date range builder
  const days = C.eachDay('20261017', '20261022', true);
  check('eachDay skips Thu/Fri', JSON.stringify(days.map(d => d.date)) === JSON.stringify(['20261017', '20261018', '20261019', '20261020', '20261021']), days.map(d => d.date).join(','));
  const daysAll = C.eachDay('20261017', '20261019', false);
  check('eachDay inclusive without skip', daysAll.length === 3 && daysAll[2].weekend === false);
  check('dowName(20261019) is Mon', C.dowName('20261019') === 'Mon', C.dowName('20261019'));

  // formatting
  check('pad6', C.pad6(83000) === '083000' && C.pad6(175953) === '175953');
  check('fmtTime', C.fmtTime('083000') === '08:30:00');

  // live: trading days — tick count & volume must equal the official daily table (verified)
  const expected = { '20261019': [6183, 118757193], '20261021': [6990, 151075813] };
  for (const [d, [nTrades, nVol]] of Object.entries(expected)) {
    const t1 = await C.fetchDayTicks('53251602435454519', d);
    check(d + ' tick count = ' + nTrades, t1.length === nTrades, t1.length);
    const vol = t1.reduce((s, t) => s + t.qTitTran, 0);
    check(d + ' volume = ' + nVol.toLocaleString(), vol === nVol, vol);
  }
  const t1 = await C.fetchDayTicks('53251602435454519', '20261019');
  check('sorted oldest→newest (first nTran=1)', t1[0].nTran === 1, 'first=' + t1[0].nTran);

  // row + csv
  const row = C.tickToRow('20261019', t1[0]);
  check('tickToRow shape', row.length === 6 && row[0] === '20261019' && row[1] === 1 && /^\d{6}$/.test(row[2]) && typeof row[3] === 'number' && typeof row[4] === 'number', JSON.stringify(row));
  const csv = C.toCsv(C.COMBINED_HEADER, [row]);
  check('csv header + BOM', csv.startsWith('\uFEFFdate,trade_no,time_hhmmss,price_rial,volume_shares,canceled\r\n'));
  check('csv row line', csv.split('\r\n')[1] === row.join(','), csv.split('\r\n')[1]);

  // live: non-trading day (Thursday) → empty
  const t2 = await C.fetchDayTicks('53251602435454519', '20261015');
  check('20261015 (Thu) empty', Array.isArray(t2) && t2.length === 0, t2.length);

  // instrument metadata
  const inst = await C.fetchInstrument('53251602435454519');
  check('fetchInstrument name', inst && /كيان/.test(inst.lVal30 || ''), inst && inst.lVal18AFC);

  console.log(fail ? `\n${fail} FAILURES` : '\nALL PASS');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('HARNESS ERROR', e); process.exit(1); });
