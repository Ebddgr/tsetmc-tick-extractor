#!/usr/bin/env node
"use strict";
/**
 * tsetmc_ticks.js — extract trade-by-trade (tick) data for a TSETMC instrument.
 *
 * Zero dependencies, Node 18+ (uses global fetch).
 *
 * Usage:
 *   node tsetmc_ticks.js <InsCode> [--from YYYYMMDD] [--to YYYYMMDD]
 *                        [--out DIR] [--delay MS] [--limit N] [--force]
 *
 *   InsCode is the numeric instrument id from the page URL, e.g.
 *   https://old.tsetmc.com/Loader.aspx?ParTree=151311&i=53251602435454519
 *   -> InsCode = 53251602435454519
 *
 * Endpoints used (verified 2026-10):
 *   Ticks (one row per executed trade, newest first):
 *     GET https://cdn.tsetmc.com/api/Trade/GetTradeHistory/{InsCode}/{YYYYMMDD}/false
 *     -> { "tradeHistory": [ { nTran, hEven, pTran, qTitTran, canceled, ... }, ... ] }
 *     ("/false" returns the complete log; "/true" returns a filtered subset.)
 *
 *   Daily calendar (official OHLC + volume per trading day, newest first):
 *     GET https://old.tsetmc.com/tsev2/data/Export-txt.aspx?t=i&a=1&b=0&i={InsCode}
 *
 * Be polite: TSETMC rate-limits aggressive clients. Keep --delay at ~1500 ms
 * or higher and cache the CSVs (re-runs skip existing files unless --force).
 */

const fs = require("fs");
const path = require("path");

const BASE_CDN = "https://cdn.tsetmc.com";
const BASE_OLD = "https://old.tsetmc.com";
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36";
const REQUEST_TIMEOUT_MS = 30000;
const MAX_RETRIES = 4;

// ---------------------------------------------------------------- utilities

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--from") args.from = argv[++i];
    else if (a === "--to") args.to = argv[++i];
    else if (a === "--out") args.out = argv[++i];
    else if (a === "--delay") args.delay = Number(argv[++i]);
    else if (a === "--limit") args.limit = Number(argv[++i]);
    else if (a === "--force") args.force = true;
    else if (a === "--help" || a === "-h") args.help = true;
    else args._.push(a);
  }
  return args;
}

function usage() {
  console.log(`Usage:
  node tsetmc_ticks.js <InsCode> [--from YYYYMMDD] [--to YYYYMMDD] [--out DIR]
                     [--delay MS] [--limit N] [--force]

  <InsCode>    numeric instrument id, e.g. 53251602435454519 (Kian ETF)
  --from/--to  inclusive date range as YYYYMMDD (defaults: most recent
               trading day only)
  --out        output directory (default: ./ticks)
  --delay      pause between day requests in ms (default: 1500)
  --limit      process at most N days (newest first)
  --force      overwrite existing CSV files

Examples:
  node tsetmc_ticks.js 53251602435454519
  node tsetmc_ticks.js 53251602435454519 --from 20261001 --to 20261021
  node tsetmc_ticks.js 53251602435454519 --from 20221003 --limit 5`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pad(n, width) {
  return String(n).padStart(width, "0");
}

// Today's date in Tehran as YYYYMMDD (TSE days run on Tehran time).
function tehranToday() {
  const s = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tehran",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
  return s.replace(/-/g, "");
}

function sanitizeFilename(name) {
  return String(name).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 80) || "unknown";
}

async function fetchWithRetry(url, { accept = "text" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const wait = 2000 * 2 ** (attempt - 1);
      console.error(`    retry ${attempt}/${MAX_RETRIES} in ${wait} ms...`);
      await sleep(wait);
    }
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": UA,
          Accept: accept === "json" ? "application/json, text/plain, */*" : "text/plain, */*",
          Referer: BASE_OLD + "/",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`HTTP ${res.status}`);
        continue;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
      const text = await res.text();
      if (accept === "json") {
        try {
          return JSON.parse(text);
        } catch (e) {
          lastErr = new Error(`invalid JSON (got ${text.slice(0, 80).replace(/\s+/g, " ")}...)`);
          continue;
        }
      }
      return text;
    } catch (e) {
      if (e.name === "TimeoutError" || e.name === "AbortError") {
        lastErr = new Error("request timed out");
      } else {
        lastErr = e;
      }
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------- data sources

// Official daily history: <TICKER>,<DTYYYYMMDD>,<FIRST>,<HIGH>,<LOW>,<CLOSE>,
// <VALUE>,<VOL>,<OPENINT>(=trade count),<PER>,<OPEN>,<LAST> — newest first.
function parseDailyCalendar(text, insCode) {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length || !lines[0].startsWith("<TICKER>")) {
    throw new Error("unexpected Export-txt response (did not get a daily-history CSV)");
  }
  const rows = [];
  for (const line of lines.slice(1)) {
    const c = line.split(",");
    if (c.length < 12) continue;
    rows.push({
      ticker: c[0],
      date: c[1],
      vol: Number(c[7]),
      tradeCount: Number(c[8]),
    });
  }
  const ticker = rows[0] ? rows[0].ticker : sanitizeFilename(insCode);
  return { ticker, rows };
}

async function fetchCalendar(insCode) {
  const url = `${BASE_OLD}/tsev2/data/Export-txt.aspx?t=i&a=1&b=0&i=${insCode}`;
  const text = await fetchWithRetry(url);
  return parseDailyCalendar(text, insCode);
}

async function fetchTicks(insCode, date) {
  const url = `${BASE_CDN}/api/Trade/GetTradeHistory/${insCode}/${date}/false`;
  const j = await fetchWithRetry(url, { accept: "json" });
  return Array.isArray(j.tradeHistory) ? j.tradeHistory : [];
}

function ticksToCsv(ticks) {
  ticks.sort((a, b) => a.nTran - b.nTran || a.hEven - b.hEven);
  const out = ["trade_no,time_hhmmss,price_rial,volume_shares,canceled"];
  for (const t of ticks) {
    out.push(
      [t.nTran, pad(t.hEven, 6), t.pTran, t.qTitTran, t.canceled].join(",")
    );
  }
  return out.join("\r\n") + "\r\n";
}

// --------------------------------------------------------------------- main

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args._.length !== 1) {
    usage();
    process.exit(args.help ? 0 : 1);
  }
  const insCode = args._[0];
  const outDir = path.resolve(args.out || "ticks");
  const delay = Number.isFinite(args.delay) && args.delay >= 0 ? args.delay : 1500;
  const today = tehranToday();

  console.log(`Instrument ${insCode} — fetching daily calendar...`);
  const calendar = await fetchCalendar(insCode);
  console.log(`Ticker: ${calendar.ticker} (${calendar.rows.length} trading days on record, latest ${calendar.rows[0].date})`);

  // Resolve the requested range. Default = most recent trading day; also try
  // Tehran-today since Export-txt can lag the current session by a day.
  let from = args.from || null;
  let to = args.to || null;
  if (!from && !to) from = to = today;
  if (!from) from = to;
  if (!to) to = from;
  if (from > to) [from, to] = [to, from];
  if (!/^\d{8}$/.test(from) || !/^\d{8}$/.test(to)) {
    console.error("Dates must be YYYYMMDD.");
    process.exit(1);
  }

  const byDate = new Map(calendar.rows.map((r) => [r.date, r]));
  const dates = [];
  if (today >= from && today <= to && !byDate.has(today)) {
    dates.push(today); // recent session not yet in the calendar
  }
  for (const row of calendar.rows) {
    if (row.date >= from && row.date <= to) dates.push(row.date);
  }
  dates.sort((a, b) => b.localeCompare(a)); // newest first

  if (!dates.length) {
    console.error(`No trading days found between ${from} and ${to}.`);
    console.error(`Calendar coverage: ${calendar.rows[calendar.rows.length - 1].date} .. ${calendar.rows[0].date}`);
    process.exit(1);
  }

  const selected = Number.isFinite(args.limit) && args.limit > 0 ? dates.slice(0, args.limit) : dates;
  fs.mkdirSync(outDir, { recursive: true });
  console.log(`Fetching ticks for ${selected.length} day(s) -> ${outDir}\n`);

  let fetched = 0, skipped = 0, empty = 0, mismatches = 0;

  for (let i = 0; i < selected.length; i++) {
    const date = selected[i];
    const file = path.join(outDir, `${sanitizeFilename(calendar.ticker)}_${date}.csv`);

    if (fs.existsSync(file) && !args.force) {
      console.log(`[${date}] already exists, skipping (use --force to overwrite)`);
      skipped++;
    } else {
      let ticks;
      try {
        ticks = await fetchTicks(insCode, date);
      } catch (e) {
        console.error(`[${date}] FAILED: ${e.message}`);
        mismatches++;
        continue;
      }
      if (!ticks.length) {
        const note =
          date === today
            ? " — today's ticks may not be published until end-of-day processing completes"
            : "";
        console.log(`[${date}] no trades (holiday, suspended, or no tick data for this day)${note}`);
        empty++;
      } else {
        fs.writeFileSync(file, ticksToCsv(ticks), "utf8");
        const volSum = ticks.reduce((s, t) => s + (t.qTitTran || 0), 0);
        const official = byDate.get(date);
        let check;
        if (!official || !official.vol) {
          check = `${ticks.length} trades, volume ${volSum} (no official daily volume to validate against)`;
        } else if (volSum === official.vol) {
          check = `${ticks.length} trades, volume ${volSum} == official daily volume ✓`;
        } else {
          check = `${ticks.length} trades, volume ${volSum} != official ${official.vol} ✗ (incomplete day?)`;
          mismatches++;
        }
        console.log(`[${date}] saved ${path.basename(file)} — ${check}`);
        fetched++;
      }
    }

    if (i < selected.length - 1 && delay > 0) await sleep(delay);
  }

  console.log(
    `\nDone. fetched=${fetched} skipped-existing=${skipped} empty=${empty} failed/mismatch=${mismatches}`
  );
}

main().catch((e) => {
  console.error(`error: ${e.message}`);
  process.exit(1);
});
