// Vol-filtered dip + trailing exit untuk cbBTC (CBBTC/USDC), bar 1 menit,
// btc-race-24h-20261118-1444.
//
// Gagasan: satu sampai dua round trip saja, beli di lembah lalu biarkan
// pantulannya jalan sejauh mungkin. Tiga hal membedakan bot ini dari
// bot tangga dip biasa:
//
//  1. PINTU VOLATILITAS. Beli hanya bila pasar 60 bar terakhir masih
//     dalam band normal: rentang high-low 60 bar (HL60) paling besar
//     250 bps, dan return 60 bar paling buruk -200 bps. Band ini
//     dibaca dari data, bukan ditebak: di tiga window dev, tidak satu
//     pun entry pemenang yang punya HL60 di atas 240 atau return 60
//     bar di bawah -162, sementara chop ekstrem di window 0828
//     menembus HL60 288 (p95). Pintu ini sengaja longgar — di window
//     dev ia tidak pernah menghalangi satu pun trade — tugasnya hanya
//     menahan bot masuk saat rezim di race window lebih liar daripada
//     apa pun yang pernah dimenangkan di dev.
//
//  2. TANGGA DIP. Pembelian pertama butuh 140 bps di bawah puncak
//     120 bar; pembelian kedua baru boleh di 290 bps (140 + 150),
//     plus harga sudah memantul 50 bps dari lembah pasca-exit. Jadi
//     pembelian kedua tidak terjadi di tengah longsoran yang sama,
//     melainkan di lembah kapitulasi yang jauh lebih dalam — di
//     window 0828, lembah kedua inilah yang memantul +446 bps.
//
//  3. TRAILING STOP sebagai exit utama. Begitu puncak pasca-entry
//     mencapai +120 bps, stop mengikuti 60 bps di bawah puncak.
//     Tidak ada target untung tetap: di window 0828 trailing ini
//     mengunci +365 bps dari pantulan yang target tetap 200 bps
//     hanya akan memotong di tengah jalan. Pelindungnya: stop keras
//     -80 bps dan batas tahan 408 bar.
//
// Sekali masuk, bot memakai seluruh kas (long only, satu posisi).
// Semua hitungan memakai bilangan bulat pada satuan harga (bigint),
// tanpa jam, tanpa acak, tanpa lingkungan: dua run pada data yang
// sama menghasilkan order yang sama persis.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const ASSET = 'CBBTC';
// Jendela pengamatan (bar).
const LOOKBACK = 120;
const VOL_WINDOW = 60;
// Ambang dip (bps di bawah puncak rolling) pembelian pertama, dan
// tambahan untuk pembelian kedua.
const FIRST_DIP = 140n;
const DIP_STEP = 150n;
// Kenaikan minimum (bps) dari lembah pasca-exit sebelum pembelian
// kedua diizinkan.
const REARM = 50n;
// Pintu volatilitas: HL60 maksimum dan return 60 bar minimum.
const VOL_HI = 250n;
const TREND_MIN = -200n;
// Trailing: aktif begitu puncak pasca-entry >= ARM, keluar begitu
// gain turun GIVEBACK bps dari puncak. Stop keras dan batas tahan.
const TRAIL_ARM = 120n;
const GIVEBACK = 60n;
const STOP = 80n;
const HOLD_LIMIT = 408;
// Jeda (bar) setelah tiap exit sebelum boleh masuk lagi.
const REST_BARS = 30;
const SLIP = 150;

/** Seluruh memori bot: riwayat close dan keadaan posisi terbuka. */
const s = {
  /** Close yang sudah terlihat, sebagai bigint pada satuan harga. */
  closes: [] as bigint[],
  /** Close bar saat order beli dikirim; dipakai sebagai awal puncak. */
  stagedPeak: 0n,
  /** Harga fill pembelian yang membuka posisi saat ini, 0n bila flat. */
  entryPrice: 0n,
  /** Close tertinggi sejak entry (termasuk close bar beli). */
  peak: 0n,
  /** Bar yang sudah dilewati sejak fill pembelian. */
  age: 0,
  /** Sisa jeda setelah exit; 0 berarti boleh masuk. */
  rest: 0,
  /** Berapa pembelian yang sudah terisi sepanjang window (maks 2). */
  buys: 0,
  /** Close terendah sejak exit terakhir; hanya bermakna bila hasLow. */
  low: 0n,
  /** True sejak exit pertama terisi. */
  hasLow: false,
};

/** Puncak tertinggi dari `n` close terakhir (termasuk close saat ini). */
function highest(n: number): bigint {
  let top = 0n;
  const from = s.closes.length - n > 0 ? s.closes.length - n : 0;
  for (let i = from; i < s.closes.length; i++) {
    const c = s.closes[i]!;
    if (c > top) top = c;
  }
  return top;
}

/** Terendah dari `n` close terakhir (termasuk close saat ini). */
function lowest(n: number): bigint {
  let bot = 0n;
  const from = s.closes.length - n > 0 ? s.closes.length - n : 0;
  for (let i = from; i < s.closes.length; i++) {
    const c = s.closes[i]!;
    if (bot === 0n || c < bot) bot = c;
  }
  return bot;
}

/** Perpindahan dari `from` ke `to`, dalam bps (bertanda, dibulatkan ke nol). */
function moveBps(from: bigint, to: bigint): bigint {
  return ((to - from) * 10000n) / from;
}

/** Rentang high-low 60 bar terakhir, dalam bps terhadap close saat ini. */
function range60(close: bigint): bigint {
  const hi = highest(VOL_WINDOW + 1);
  const lo = lowest(VOL_WINDOW + 1);
  return ((hi - lo) * 10000n) / close;
}

/** Return 60 bar terakhir, dalam bps (bertanda). */
function trend60(close: bigint): bigint {
  const old = s.closes[s.closes.length - 1 - VOL_WINDOW]!;
  return moveBps(old, close);
}

/** True bila rezim 60 bar terakhir masih dalam band normal. */
function volOk(close: bigint): boolean {
  if (range60(close) > VOL_HI) return false;
  if (trend60(close) < TREND_MIN) return false;
  return true;
}

/** Order beli seluruh kas, atau [] bila tak layak. */
function buyAll(state: BarsState): BuyInput[] {
  const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
  let spend = state.cash;
  const room = state.weightRoom(ASSET);
  if (spend > room) spend = room;
  if (spend < minNotional) return [];
  return [{ side: 'buy', symbol: ASSET, notional_quote_units: spend, max_slippage_bps: SLIP } satisfies BuyInput];
}

/** Order jual seluruh posisi yang dipegang. */
function sellAll(heldQty: bigint): SellInput[] {
  return [{ side: 'sell', symbol: ASSET, qty: heldQty, max_slippage_bps: SLIP } satisfies SellInput];
}

/** True bila posisi terbuka harus ditutup pada gain dan puncak saat ini. */
function mustExit(gain: bigint, peakGain: bigint): boolean {
  if (gain <= -STOP) return true;
  if (peakGain >= TRAIL_ARM && peakGain - gain >= GIVEBACK) return true;
  if (s.age >= HOLD_LIMIT) return true;
  return false;
}

/** True bila semua syarat masuk terpenuhi pada close saat ini. */
function entryOk(close: bigint, prev: bigint): boolean {
  if (s.rest > 0) return false;
  if (s.buys >= 2) return false;
  if (close <= prev) return false; // butuh bar hijau: close naik
  const peak = highest(LOOKBACK);
  if (peak === 0n) return false;
  const dip = ((peak - close) * 10000n) / peak;
  const need = FIRST_DIP + BigInt(s.buys) * DIP_STEP;
  if (dip < need) return false;
  if (s.buys >= 1) {
    if (!s.hasLow || s.low === 0n) return false;
    if (moveBps(s.low, close) < REARM) return false;
  }
  if (!volOk(close)) return false;
  return true;
}

await runBars({
  onBatch(state: BarsState, batch) {
    // Catat bar baru dulu: close bar ini dipakai untuk reset lembah
    // pasca-exit bila ada fill jual di batch ini.
    for (const bar of batch.bars) {
      if (bar.symbol === ASSET) s.closes.push(BigInt(bar.c));
    }
    const close = s.closes[s.closes.length - 1];
    const prev = s.closes.length > 1 ? s.closes[s.closes.length - 2] : undefined;
    if (close === undefined || prev === undefined) return [];

    // Lipat fill: beli mengisi harga masuk dan umur posisi, jual menutup
    // posisi, memulai jeda, dan me-reset lembah ke close bar exit.
    for (const f of batch.fills) {
      if (f.symbol !== ASSET || f.status !== 'filled' || f.client_id.startsWith('_')) continue;
      if (f.side === 'buy') {
        s.entryPrice = BigInt(f.price);
        s.peak = s.stagedPeak > close ? s.stagedPeak : close;
        s.age = 0;
        s.buys += 1;
      } else {
        s.entryPrice = 0n;
        s.peak = 0n;
        s.age = 0;
        s.rest = REST_BARS;
        s.low = close;
        s.hasLow = true;
      }
    }
    // Lembah pasca-exit: titik terendah close sejak exit terakhir.
    if (s.hasLow && close < s.low) s.low = close;

    if (state.warmingUp) return [];
    if (s.closes.length <= LOOKBACK) return [];
    if (s.rest > 0) s.rest--;

    const held = state.positions.get(ASSET);

    // Memegang posisi: periksa pemicu keluar, berurutan.
    if (held !== undefined && held.qty > 0n) {
      if (s.entryPrice === 0n) s.entryPrice = close;
      if (close > s.peak) s.peak = close;
      s.age += 1;
      const gain = moveBps(s.entryPrice, close);
      const peakGain = moveBps(s.entryPrice, s.peak);
      if (mustExit(gain, peakGain)) return sellAll(held.qty);
      return [];
    }

    // Flat: masuk hanya bila semua syarat dip + volatilitas terpenuhi.
    if (entryOk(close, prev)) {
      s.stagedPeak = close;
      return buyAll(state);
    }
    return [];
  },
});
