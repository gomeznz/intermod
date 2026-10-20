// Harmonic & intermodulation engine.
// Frequencies in MHz, bandwidths in kHz. Works in the browser (ES module) and Node.
//
// A product is  sum(c_i * f_i)  with integer coefficients c_i != 0.
// Order = sum(|c_i|). Harmonics are the single-carrier case n*f.
// Occupied width of a product ~ sum(|c_i| * bw_i), so a product "hits" a receiver when
// the two occupied bands overlap (plus a user guard band).

const KHZ = 1e-3; // kHz -> MHz

/** Coefficient sets for 2-tone products, |m|+|n| = order, m>0, n != 0. */
export function twoToneCoeffs(maxOrder, { evenOrders = false } = {}) {
  const out = [];
  for (let order = 2; order <= maxOrder; order++) {
    if (!evenOrders && order % 2 === 0) continue;
    for (let m = 1; m < order; m++) {
      const n = order - m;
      out.push([m, n], [m, -n]);
    }
  }
  return out;
}

/** Coefficient sets for 3-tone products, all non-zero, sum |c| = order, first coeff > 0. */
export function threeToneCoeffs(maxOrder, { evenOrders = false } = {}) {
  const out = [];
  for (let order = 3; order <= maxOrder; order++) {
    if (!evenOrders && order % 2 === 0) continue;
    for (let a = 1; a <= order - 2; a++)
      for (let b = 1; b <= order - a - 1; b++) {
        const c = order - a - b;
        for (const sb of [1, -1]) for (const sc of [1, -1]) out.push([a, sb * b, sc * c]);
      }
  }
  return out;
}

const LETTERS = "ABCDEFGH";
export function formula(coeffs) {
  return coeffs
    .map((c, i) => {
      const mag = Math.abs(c) === 1 ? "" : Math.abs(c);
      const sign = c < 0 ? " − " : i === 0 ? "" : " + ";
      return `${sign}${mag}${LETTERS[i]}`;
    })
    .join("");
}

function productWidthKHz(coeffs, carriers) {
  let w = 0;
  for (let i = 0; i < coeffs.length; i++) w += Math.abs(coeffs[i]) * (carriers[i].bw || 0);
  return w;
}

/**
 * Score a product against a receiver.
 * Returns null if no hit, else { offsetKHz, clearanceKHz } where clearance < 0 means overlap.
 */
function hitTest(fProd, prodBwKHz, rx, guardKHz) {
  const offsetKHz = (fProd - rx.f) / KHZ;
  const clearanceKHz = Math.abs(offsetKHz) - prodBwKHz / 2 - (rx.bw || 0) / 2;
  if (clearanceKHz > guardKHz) return null;
  return { offsetKHz, clearanceKHz };
}

export function sortResults(results) {
  return results.sort((a, b) => a.order - b.order || Math.abs(a.offsetKHz) - Math.abs(b.offsetKHz) || a.carriers.length - b.carriers.length);
}

// ---------- sorted-array helpers ----------
function lowerBound(arr, f) {
  let lo = 0, hi = arr.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].f < f) lo = mid + 1; else hi = mid; }
  return lo;
}
function* inRange(arr, lo, hi) {
  for (let i = lowerBound(arr, lo); i < arr.length && arr[i].f <= hi; i++) yield [i, arr[i]];
}

/** Merge carriers that share a frequency so combinations aren't repeated. */
export function mergeByFrequency(carriers) {
  const map = new Map();
  for (const c of carriers) {
    const key = Math.round(c.f * 1e6);
    const ex = map.get(key);
    if (ex) {
      if (!ex.labels.includes(c.label)) ex.labels.push(c.label);
      if (c.src && !ex.srcs.includes(c.src)) ex.srcs.push(c.src);
      ex.bw = Math.max(ex.bw || 0, c.bw || 0);
    } else map.set(key, { f: c.f, bw: c.bw || 0, labels: [c.label], src: c.src, srcs: c.src ? [c.src] : [] });
  }
  return [...map.values()].map((c) => ({ ...c, label: c.labels.join(" / ") })).sort((a, b) => a.f - b.f);
}

const defaults = {
  maxHarmonic: 10,
  maxOrder2: 7,      // 2-tone IM
  maxOrder3: 5,      // 3-tone IM
  evenOrders: false, // include even-order mixing (A+B, A−B, 2A+2B ...)
  guardKHz: 0,       // extra margin beyond occupied-bandwidth overlap
  limit: 5000,
};

/**
 * REVERSE: which carriers in `pool` could produce energy on the victim receiver?
 * victim: { f, bw, label }
 * pool:   [{ f, bw, label }]  (transmitters)
 */
export function findSources(victim, pool, opts = {}) {
  const o = { ...defaults, ...opts };
  const P = mergeByFrequency(pool);
  const maxBw = P.reduce((m, c) => Math.max(m, c.bw || 0), 0);
  const results = [];
  const seen = new Set();
  const notes = [];
  let truncated = false;
  // requireSrc: only keep combinations using at least one carrier with this src tag (e.g. "site")
  const push = (r) => {
    if (o.requireSrc && !r.carriers.some((c) => c.srcs?.includes(o.requireSrc))) return true;
    if (results.length >= o.limit) { truncated = true; return false; }
    results.push(r); return true;
  };
  const vbw = victim.bw || 0;

  // Fundamental on channel (co-channel / adjacent) - useful context
  for (const [, c] of inRange(P, victim.f - (o.guardKHz + vbw / 2 + maxBw / 2) * KHZ, victim.f + (o.guardKHz + vbw / 2 + maxBw / 2) * KHZ)) {
    const h = hitTest(c.f, c.bw, victim, o.guardKHz);
    if (h) push({ kind: "fundamental", order: 1, formula: "A", coeffs: [1], carriers: [c], f: c.f, ...h });
  }

  // Harmonics: n*A
  for (let n = 2; n <= o.maxHarmonic; n++) {
    const span = (o.guardKHz + vbw / 2 + (n * maxBw) / 2) * KHZ;
    for (const [, c] of inRange(P, (victim.f - span) / n, (victim.f + span) / n)) {
      const fp = n * c.f;
      const h = hitTest(fp, n * c.bw, victim, o.guardKHz);
      if (h) push({ kind: "harmonic", order: n, formula: `${n}A`, coeffs: [n], carriers: [c], f: fp, ...h });
    }
  }

  // 2-tone: m*A + n*B = fv  ->  B = (fv - m*A)/n
  for (const [m, n] of twoToneCoeffs(o.maxOrder2, o)) {
    for (let i = 0; i < P.length && !truncated; i++) {
      const A = P[i];
      const span = (o.guardKHz + vbw / 2 + (m * A.bw + Math.abs(n) * maxBw) / 2) * KHZ;
      let lo = (victim.f - span - m * A.f) / n, hi = (victim.f + span - m * A.f) / n;
      if (lo > hi) [lo, hi] = [hi, lo];
      for (const [j, B] of inRange(P, lo, hi)) {
        if (j === i) continue;
        const coeffs = [m, n], cs = [A, B];
        const fp = m * A.f + n * B.f;
        if (fp <= 0) continue;
        const h = hitTest(fp, productWidthKHz(coeffs, cs), victim, o.guardKHz);
        if (!h) continue;
        const key = `2|${Math.min(i, j)}|${Math.max(i, j)}|${i < j ? m + "," + n : n + "," + m}`;
        if (seen.has(key)) continue;
        seen.add(key);
        if (!push({ kind: "im2", order: m + Math.abs(n), formula: formula(coeffs), coeffs, carriers: cs, f: fp, ...h })) break;
      }
    }
  }

  // 3-tone: a*A + b*B + c*C = fv. O(P^2) - only run when the pool is a sensible size.
  const max3 = o.maxOrder3 >= 3 ? o.maxOrder3 : 0;
  const pairBudget = 12e6; // pair-iterations x coeff sets
  const coeffs3 = max3 ? threeToneCoeffs(max3, o) : [];
  if (coeffs3.length) {
    const cost = (P.length * P.length / 2) * coeffs3.length;
    if (cost > pairBudget) {
      notes.push(`3-tone search skipped: ${P.length} carriers is too many for a full 3-tone search (narrow the pool to bands or site carriers).`);
    } else {
      for (const [a, b, c] of coeffs3) {
        for (let i = 0; i < P.length && !truncated; i++)
          for (let j = 0; j < P.length && !truncated; j++) {
            if (j === i) continue;
            const A = P[i], B = P[j];
            const base = a * A.f + b * B.f;
            const span = (o.guardKHz + vbw / 2 + (a * A.bw + Math.abs(b) * B.bw + Math.abs(c) * maxBw) / 2) * KHZ;
            let lo = (victim.f - span - base) / c, hi = (victim.f + span - base) / c;
            if (lo > hi) [lo, hi] = [hi, lo];
            for (const [k, C] of inRange(P, lo, hi)) {
              if (k === i || k === j) continue;
              const coeffs = [a, b, c], cs = [A, B, C];
              const fp = base + c * C.f;
              if (fp <= 0) continue;
              const h = hitTest(fp, productWidthKHz(coeffs, cs), victim, o.guardKHz);
              if (!h) continue;
              // canonical key: sort (index, coeff) pairs
              const key = "3|" + [[i, a], [j, b], [k, c]].sort((x, y) => x[0] - y[0]).map((x) => x.join(":")).join("|");
              if (seen.has(key)) continue;
              seen.add(key);
              if (!push({ kind: "im3", order: a + Math.abs(b) + Math.abs(c), formula: formula(coeffs), coeffs, carriers: cs, f: fp, ...h })) break;
            }
          }
      }
    }
  }
  if (truncated) notes.push(`Stopped at ${o.limit} results - narrow the pool or tighten the guard band.`);
  return { results: sortResults(results), notes, poolSize: P.length };
}

function key(pairs) {
  return pairs.slice().sort((x, y) => x[0] - y[0]).map((x) => x.join(":")).join("|");
}

/**
 * All products from a set of transmitters (forward). Returns array sorted by frequency.
 * If `mustInclude` (an index into the merged list) is given, only products using that carrier.
 */
export function allProducts(txs, opts = {}, mustInclude = null) {
  const o = { ...defaults, ...opts };
  const T = Array.isArray(txs.merged) ? txs.merged : mergeByFrequency(txs);
  const out = [];
  const inc = (...idx) => mustInclude === null || idx.includes(mustInclude);
  for (let i = 0; i < T.length; i++) {
    if (!inc(i)) continue;
    const A = T[i];
    for (let n = 2; n <= o.maxHarmonic; n++)
      out.push({ kind: "harmonic", order: n, formula: `${n}A`, coeffs: [n], carriers: [A], f: n * A.f, bw: n * A.bw });
  }
  const c2 = twoToneCoeffs(o.maxOrder2, o);
  const seen = new Set();
  for (let i = 0; i < T.length; i++)
    for (let j = 0; j < T.length; j++) {
      if (i === j || !inc(i, j)) continue;
      for (const [m, n] of c2) {
        const k = "2|" + key([[i, m], [j, n]]);
        if (seen.has(k)) continue;
        seen.add(k);
        const fp = m * T[i].f + n * T[j].f;
        if (fp <= 0) continue;
        out.push({ kind: "im2", order: m + Math.abs(n), formula: formula([m, n]), coeffs: [m, n], carriers: [T[i], T[j]], f: fp, bw: m * T[i].bw + Math.abs(n) * T[j].bw });
      }
    }
  const c3 = o.maxOrder3 >= 3 ? threeToneCoeffs(o.maxOrder3, o) : [];
  if (c3.length && T.length >= 3) {
    for (let i = 0; i < T.length; i++)
      for (let j = 0; j < T.length; j++)
        for (let l = 0; l < T.length; l++) {
          if (i === j || j === l || i === l || !inc(i, j, l)) continue;
          for (const [a, b, c] of c3) {
            const k = "3|" + key([[i, a], [j, b], [l, c]]);
            if (seen.has(k)) continue;
            seen.add(k);
            const fp = a * T[i].f + b * T[j].f + c * T[l].f;
            if (fp <= 0) continue;
            out.push({ kind: "im3", order: a + Math.abs(b) + Math.abs(c), formula: formula([a, b, c]), coeffs: [a, b, c], carriers: [T[i], T[j], T[l]], f: fp, bw: a * T[i].bw + Math.abs(b) * T[j].bw + Math.abs(c) * T[l].bw });
          }
        }
  }
  return out.sort((x, y) => x.f - y.f);
}

function hitsOn(prods, rxs, guardKHz) {
  const maxBw = prods.reduce((m, p) => Math.max(m, p.bw), 0);
  const results = [];
  for (const rx of rxs) {
    const span = (guardKHz + (rx.bw || 0) / 2 + maxBw / 2) * KHZ;
    for (const [, p] of inRange(prods, rx.f - span, rx.f + span)) {
      const h = hitTest(p.f, p.bw, rx, guardKHz);
      if (h) results.push({ ...p, victim: rx, ...h });
    }
  }
  return results;
}

function siteTxRx(stations) {
  const txs = stations.filter((s) => s.tx).map((s) => ({ f: s.tx.f, bw: s.tx.bw, label: s.label }));
  const rxs = stations.filter((s) => s.rx).map((s) => ({ f: s.rx.f, bw: s.rx.bw, label: s.label }));
  return { txs, rxs };
}

/**
 * FORWARD: check a site. stations: [{ label, tx:{f,bw}|null, rx:{f,bw}|null }]
 * Returns every harmonic / IM product that lands on a site receiver.
 */
export function checkSite(stations, opts = {}) {
  const o = { ...defaults, ...opts };
  const { txs, rxs } = siteTxRx(stations);
  const prods = allProducts(txs, o);
  const results = hitsOn(prods, rxs, o.guardKHz);
  return { results: sortResults(results), productCount: prods.length, txCount: txs.length, rxCount: rxs.length, products: prods };
}

/**
 * PLANNING: rank candidate channels for adding to a site.
 * candidates: [{ label, tx:{f,bw}, rx:{f,bw} }]  (rx may equal tx for simplex)
 * A candidate is scored on (a) products involving its Tx landing on any receiver (incl. its own Rx)
 * and (b) existing site products landing on its Rx.
 */
export function rankCandidates(stations, candidates, opts = {}) {
  const o = { ...defaults, ...opts };
  const { txs, rxs } = siteTxRx(stations);
  const existing = allProducts(txs, o);
  const out = [];
  for (const cand of candidates) {
    const merged = mergeByFrequency([...txs, { f: cand.tx.f, bw: cand.tx.bw, label: cand.label }]);
    const idx = merged.findIndex((c) => c.labels.includes(cand.label));
    const candRx = { f: cand.rx.f, bw: cand.rx.bw, label: cand.label };
    const newProds = allProducts({ merged }, o, idx);
    const res = [...hitsOn(newProds, [...rxs, candRx], o.guardKHz), ...hitsOn(existing, [candRx], o.guardKHz)];
    // co-channel: candidate's Tx on an existing Rx or vice versa
    for (const rx of rxs) { const h = hitTest(cand.tx.f, cand.tx.bw, rx, o.guardKHz); if (h) res.push({ kind: "fundamental", order: 1, formula: "A", carriers: [merged[idx]], f: cand.tx.f, victim: rx, ...h }); }
    for (const t of txs) { const h = hitTest(t.f, t.bw, candRx, o.guardKHz); if (h) res.push({ kind: "fundamental", order: 1, formula: "A", carriers: [{ ...t, labels: [t.label] }], f: t.f, victim: candRx, ...h }); }
    const worst = res.length ? Math.min(...res.map((r) => r.order)) : null;
    out.push({ ...cand, hits: res.length, worstOrder: worst, results: sortResults(res) });
  }
  const w = (c) => (c.worstOrder === null ? 999 : c.worstOrder);
  return out.sort((a, b) => w(b) - w(a) || a.hits - b.hits);
}
