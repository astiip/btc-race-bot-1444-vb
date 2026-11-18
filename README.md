# btc-race-bot-1444-vb

[![make.fun · btc-race-24h-20261118-1444](https://make.fun/badge/btc-race-24h-20261118-1444.svg)](https://make.fun/bounty/btc-race-24h-20261118-1444?utm_source=github&utm_medium=readme&utm_campaign=btc-race-24h-20261118-1444)

Volatility-filtered dip bot with a trailing exit for the make.fun
`btc-race-24h-20261118-1444` competition (CBBTC/USDC, 1-minute bars,
$1,000 USDC paper, long only).

## Strategy

At most two round trips per window, full cash each time:

- **Entry — escalating dip + volatility gate.** Buy 1 needs a dip of
  ≥140 bps below the 120-bar rolling high on a green bar; buy 2 needs
  ≥290 bps (140 + 150) plus a 50 bps bounce off the post-exit low.
  Either buy is skipped when the last 60 bars are outside the normal
  band: 60-bar high–low range above 250 bps, or 60-bar return below
  −200 bps. The band is read off the dev data: no winning dev entry
  ever had HL60 above 240 or a 60-bar return below −162, while the
  wildest dev window's chop reaches HL60 288 (p95).
- **Exit — trailing stop first.** Once the post-entry peak reaches
  +120 bps, the stop trails 60 bps below the peak. No fixed take
  profit: on the 0828 dev window the trailing stop banked +365 bps
  off a capitulation bounce that peaked at +446 bps. Backstops are a
  hard stop at −80 bps and a 408-bar maximum hold.

## Backtest (local simulator, harness fill model)

| window | net PnL | fills | round trips | wins | max DD |
|--------|--------:|------:|------------:|-----:|-------:|
| 1444 (dev) | +$13.50 | 2 | 1 | 1 | 0.8% |
| 0603 | +$14.46 | 2 | 1 | 1 | 0.6% |
| 0828 | +$24.55 | 4 | 2 | 1 | 1.9% |

Worst window +$13.50, sum +$52.50 across the three frozen dev
windows. For comparison, the escalating-dip ladder with a fixed
+200 bps take profit scores +$17.55 / +$11.34 / +$8.23 (worst
+$8.23, sum +$37.12): this bot gives up a little on 1444 and gains
a lot of robustness, above all on 0828, where the trailing exit
rides the deep second dip instead of cutting it at +200 bps.

## Honest limits

- The 0828 result hinges on one discrete event: the second buy at a
  302 bps dip catching a capitulation bottom. Shifting the first-dip
  threshold, the escalation step, the lookback, or the stop by ±10–20%
  can lose that trade and turn 0828 negative. The edge is real across
  three windows, but it is concentrated, not diversified.
- The volatility gate never binds on the dev windows; it is a guard
  rail for regimes wilder than anything in dev, not a proven filter.
- On 1444 and 0603 the exit was the 408-bar time cap, not the trail:
  the trail only fired on the big 0828 bounce.
- The race window is unseen; a flat or steadily rising window gives
  this bot few or no entries (it never trades without a dip).

## Layout

- `main.ts` — the bot (TypeScript, Node type stripping, stdlib only
  via the vendored SDK shim).
- `vendor/makefun-bars.ts` — byte-identical copy of the kit SDK shim.
- `.makefun/owner.json` — claim file for the entry wallet.
