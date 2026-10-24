# TSETMC Tick Data Extractor

Extracts trade-by-trade (tick) data for any Tehran Stock Exchange / FaraBourse
instrument from TSETMC, validated against the official daily volumes.

## Browser UI (no install)

Open [`tsetmc_tick_extractor.html`](tsetmc_tick_extractor.html) in any modern
browser. Add one or more InsCodes (instrument names are looked up
automatically and shown next to them), pick a start/end date, and extract:

- per-day and per-instrument combined CSV downloads (same format as the CLI)
- per-instrument summaries and an inline preview of the first 50 ticks
- cancel anytime; failed requests retry automatically with backoff

Works from a plain `file://` open — the TSETMC CDN API allows cross-origin
browser requests. The IRANSans webfont ships in `fonts/`.

## CLI

Zero dependencies — requires Node.js 18+ only.

```
node tsetmc_ticks.js <InsCode> [--from YYYYMMDD] [--to YYYYMMDD] [--out DIR]
                    [--delay MS] [--limit N] [--force]
```

`<InsCode>` is the numeric instrument id from the page URL. For example:

```
https://old.tsetmc.com/Loader.aspx?ParTree=151311&i=53251602435454519
                                                    ^^^^^^^^^^^^^^^
```

Kian ETF has InsCode `53251602435454519`.

```
node tsetmc_ticks.js 53251602435454519                        # most recent session
node tsetmc_ticks.js 53251602435454519 --from 20261001 --to 20261021
node tsetmc_ticks.js 53251602435454519 --from 20221003 --limit 5   # test a backfill
node tsetmc_ticks.js 53251602435454519 --from 20221003             # full backfill
```

Weekends and TSE holidays drop out automatically — the script first downloads
the instrument's official daily calendar and only requests days that actually
traded (plus today's session, which may not be in the calendar yet).

## Output

One CSV per trading day in `./ticks/` (change with `--out`), named
`{TICKER}_{YYYYMMDD}.csv`:

```csv
trade_no,time_hhmmss,price_rial,volume_shares,canceled
1,083000,115040,50000,0
2,083000,115040,30000,0
...
6990,175957,115041,40000,0
```

- rows are sorted oldest → newest by exchange trade sequence (`nTran`)
- `time_hhmmss` is exchange time as HHMMSS
- prices are in rials, volumes in shares
- `canceled` = 1 marks cancelled/corrected trades (rare)

Re-runs skip days whose CSV already exists (pass `--force` to overwrite), so
incremental backfills are safe to interrupt and resume.

## Validation

For every day with official statistics, the script compares the sum of tick
volumes against the official daily `VOL` and prints `✓` / `✗` per day. On a
verified sample (Kian ETF, 2026-10-19 .. 2026-10-21) all three days matched
exactly (e.g. 20261021: 6,990 trades, volume sum 151,075,813 = official).

## Endpoints used (verified October 2026)

| Purpose | URL |
|---|---|
| Trade-by-trade ticks | `GET https://cdn.tsetmc.com/api/Trade/GetTradeHistory/{InsCode}/{YYYYMMDD}/false` → `{"tradeHistory":[{nTran,hEven,pTran,qTitTran,canceled,...}]}` |
| Daily OHLC calendar (official) | `GET https://old.tsetmc.com/tsev2/data/Export-txt.aspx?t=i&a=1&b=0&i={InsCode}` |
| Best bid/ask history (not used yet) | `GET https://cdn.tsetmc.com/api/BestLimits/{InsCode}/{YYYYMMDD}` |
| Individual/legal breakdown (not used yet) | `GET https://cdn.tsetmc.com/api/ClientType/GetClientTypeHistory/{InsCode}/{YYYYMMDD}` |

Notes learned from probing:

- `/false` on the tick endpoint returns the **complete** trade log; `/true`
  returns a filtered subset (≈65% of rows on the sample day).
- Tick rows arrive newest-first and must be reversed.
- The tick API generally publishes a session's data after end-of-day
  processing; today's ticks may be empty until then even though the session
  traded (the script prints a hint when this happens).
- Tick history is deep: verified working ≥ 3 years back (the whole life of a
  2022-listed ETF), one request per trading day.

## Rate limits / politeness

TSETMC throttles aggressive clients. The script defaults to a 1500 ms pause
between day requests and retries transient failures (429/5xx/timeouts) with
exponential backoff. Keep the delay at or above the default, cache the CSVs,
and avoid hammering the site with parallel runs.
