import test from "node:test";
import assert from "node:assert/strict";
import { findSources, checkSite, rankCandidates, allProducts, formula } from "../public/engine.js";

const c = (f, label, bw = 12.5) => ({ f, bw, label });
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test("formula strings", () => {
  assert.equal(formula([2, -1]), "2A − B");
  assert.equal(formula([1, 1, -1]), "A + B − C");
  assert.equal(formula([3, -2]), "3A − 2B");
});

test("3rd order 2-tone: 2A-B", () => {
  const { results } = findSources(c(149.9, "victim"), [c(150.0, "A"), c(150.1, "B")], { maxOrder3: 0 });
  const r = results.find((r) => r.kind === "im2" && r.order === 3);
  assert.ok(r, "expected a 3rd order hit");
  assert.ok(near(r.f, 149.9));
  assert.equal(r.carriers[0].label, "A"); // 2*150.0 - 150.1
  assert.equal(r.formula, "2A − B");
});

test("harmonic: 3 x 150 = 450", () => {
  const { results } = findSources(c(450.0, "v"), [c(150.0, "VHF"), c(151.0, "x")]);
  const h = results.filter((r) => r.kind === "harmonic");
  assert.equal(h.length, 1);
  assert.equal(h[0].order, 3);
});

test("3-tone: A+B-C", () => {
  const { results } = findSources(c(158.5, "v"), [c(160, "A"), c(161, "B"), c(162.5, "C")], { maxOrder2: 0 });
  const r = results.find((r) => r.kind === "im3" && r.order === 3);
  assert.ok(r);
  assert.ok(near(r.f, 158.5));
});

test("bandwidth overlap decides a hit", () => {
  // 2A-B lands 10 kHz off victim. Product width = 3*12.5 = 37.5 kHz -> half 18.75, victim half 6.25 -> overlaps
  let { results } = findSources(c(149.91, "v"), [c(150.0, "A"), c(150.1, "B")], { maxOrder3: 0 });
  assert.ok(results.some((r) => r.order === 3));
  // 30 kHz off -> clearance 30-18.75-6.25 = 5 kHz > 0 guard -> no hit
  ({ results } = findSources(c(149.93, "v"), [c(150.0, "A"), c(150.1, "B")], { maxOrder3: 0, maxOrder2: 3 }));
  assert.ok(!results.some((r) => r.order === 3));
  // ...unless guard band covers it
  ({ results } = findSources(c(149.93, "v"), [c(150.0, "A"), c(150.1, "B")], { maxOrder3: 0, maxOrder2: 3, guardKHz: 6 }));
  assert.ok(results.some((r) => r.order === 3));
});

// Brute force reference
function brute(victim, pool, o) {
  const hits = new Set();
  const T = pool;
  const hit = (fp, bw) => Math.abs(fp - victim.f) * 1000 - bw / 2 - victim.bw / 2 <= (o.guardKHz || 0);
  for (let i = 0; i < T.length; i++) {
    for (let n = 2; n <= o.maxHarmonic; n++) if (hit(n * T[i].f, n * T[i].bw)) hits.add(`h${n}|${i}`);
    for (let j = 0; j < T.length; j++) {
      if (j === i) continue;
      for (let m = 1; m <= o.maxOrder2; m++) for (let n = -o.maxOrder2; n <= o.maxOrder2; n++) {
        if (!n || m + Math.abs(n) > o.maxOrder2 || (m + Math.abs(n)) % 2 === 0) continue;
        const fp = m * T[i].f + n * T[j].f;
        if (fp > 0 && hit(fp, m * T[i].bw + Math.abs(n) * T[j].bw)) hits.add(`2|${[[i, m], [j, n]].sort((a, b) => a[0] - b[0]).map((x) => x.join(":")).join("|")}`);
      }
      for (let k = 0; k < T.length; k++) {
        if (k === i || k === j) continue;
        for (let a = 1; a <= o.maxOrder3; a++) for (let b = -o.maxOrder3; b <= o.maxOrder3; b++) for (let cc = -o.maxOrder3; cc <= o.maxOrder3; cc++) {
          const ord = a + Math.abs(b) + Math.abs(cc);
          if (!b || !cc || ord > o.maxOrder3 || ord % 2 === 0) continue;
          const fp = a * T[i].f + b * T[j].f + cc * T[k].f;
          if (fp > 0 && hit(fp, a * T[i].bw + Math.abs(b) * T[j].bw + Math.abs(cc) * T[k].bw)) hits.add(`3|${[[i, a], [j, b], [k, cc]].sort((x, y) => x[0] - y[0]).map((x) => x.join(":")).join("|")}`);
        }
      }
    }
  }
  return hits.size;
}

test("reverse search matches brute force on random sets", () => {
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
  const o = { maxHarmonic: 5, maxOrder2: 7, maxOrder3: 5, guardKHz: 2 };
  for (let t = 0; t < 40; t++) {
    const pool = Array.from({ length: 7 }, (_, i) => c(+(150 + rnd() * 4).toFixed(4), "T" + i, [6.25, 12.5, 25][i % 3]));
    // pick a victim that is guaranteed to be hit by some product
    const [A, B, C] = pool;
    const fv = [2 * A.f - B.f, A.f + B.f - C.f, 3 * A.f - 2 * C.f][t % 3];
    const victim = c(fv + (rnd() - 0.5) * 0.02, "v", 12.5);
    const fast = findSources(victim, pool, o).results.filter((r) => r.kind !== "fundamental").length;
    assert.equal(fast, brute(victim, pool, o), `trial ${t}`);
  }
});

test("forward site check agrees with reverse search", () => {
  const stations = [
    { label: "R1", tx: { f: 151.0125, bw: 12.5 }, rx: { f: 155.19375, bw: 12.5 } },
    { label: "R2", tx: { f: 151.6, bw: 12.5 }, rx: { f: 155.78125, bw: 12.5 } },
    { label: "R3", tx: { f: 152.1875, bw: 12.5 }, rx: { f: 156.36875, bw: 12.5 } },
    { label: "R4", tx: { f: 150.42, bw: 12.5 }, rx: { f: 150.42, bw: 12.5 } },
  ];
  const o = { maxHarmonic: 5, maxOrder2: 7, maxOrder3: 5 };
  const fwd = checkSite(stations, o).results;
  const txs = stations.map((s) => ({ ...s.tx, label: s.label }));
  let rev = 0;
  for (const s of stations) rev += findSources({ ...s.rx, label: s.label }, txs, o).results.filter((r) => r.kind !== "fundamental").length;
  assert.equal(fwd.length, rev);
  // R1/R2/R3 Tx equally spaced by 0.5875 MHz -> 2*R2 - R1 = R3 Tx exactly; R4 simplex at 2*R1-R2 = 150.425 (5 kHz off)
  assert.ok(fwd.some((r) => r.victim.label === "R4" && r.order === 3));
});

test("rankCandidates puts a clean channel ahead of a hit one", () => {
  const stations = [
    { label: "A", tx: { f: 150.0, bw: 12.5 }, rx: { f: 154.0, bw: 12.5 } },
    { label: "B", tx: { f: 150.1, bw: 12.5 }, rx: { f: 154.1, bw: 12.5 } },
  ];
  const cands = [
    { label: "bad", tx: { f: 151.0, bw: 12.5 }, rx: { f: 149.9, bw: 12.5 } }, // Rx sits on 2A-B
    { label: "good", tx: { f: 151.337, bw: 12.5 }, rx: { f: 155.71, bw: 12.5 } },
  ];
  const r = rankCandidates(stations, cands, { maxOrder2: 7, maxOrder3: 5 });
  assert.equal(r[0].label, "good");
  assert.ok(r.find((x) => x.label === "bad").results.some((h) => h.order === 3));
});

test("full PIB 23 pool reverse search is fast enough", async () => {
  const fs = await import("node:fs");
  const db = JSON.parse(fs.readFileSync(new URL("../data/channels.json", import.meta.url)));
  const pool = db.channels.filter((e) => e.role !== "M").map((e) => ({ f: e.f, bw: e.bw, label: e.n }));
  const t0 = Date.now();
  const { results, notes } = findSources({ f: 155.19375, bw: 12.5, label: "EN22#" }, pool, { maxOrder2: 5, maxOrder3: 3 });
  const ms = Date.now() - t0;
  assert.ok(ms < 8000, `took ${ms} ms`);
  assert.ok(results.length > 0);
  console.log(`  full-pool search: ${pool.length} carriers, ${results.length} results, ${ms} ms`, notes);
});

test("requireSrc keeps only combinations using a site carrier", () => {
  const pool = [
    { f: 150.0, bw: 12.5, label: "site", src: "site" },
    { f: 150.1, bw: 12.5, label: "db1", src: "db" },
    { f: 150.05, bw: 12.5, label: "db2", src: "db" },
    { f: 150.15, bw: 12.5, label: "db3", src: "db" },
  ];
  // 149.9 = 2*150.0 - 150.1 (uses site) and also 2*150.05 - 150.2? (no) ; 150.05*2-150.15 = 149.95 (db only, not hit)
  const all = findSources({ f: 150.0, bw: 12.5, label: "v" }, pool, { maxOrder3: 3 }).results.filter((r) => r.kind !== "fundamental");
  const site = findSources({ f: 150.0, bw: 12.5, label: "v" }, pool, { maxOrder3: 3, requireSrc: "site" }).results;
  assert.ok(site.length > 0 && site.length < all.length);
  assert.ok(site.every((r) => r.carriers.some((c) => c.srcs.includes("site"))));
});
