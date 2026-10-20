// Intermod UI
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtF = (f) => (+f).toFixed(f * 1e6 % 1000 === 0 ? 4 : 6).replace(/(\.\d{4}\d*?)0+$/, "$1");
const fmtK = (k) => (k >= 0 ? "+" : "−") + Math.abs(k).toFixed(Math.abs(k) < 10 ? 2 : 1);
const ordClass = (o) => (o <= 1 ? "o1" : o <= 7 ? "o" + o : "ohi");
const store = {
  get(k, d) { try { const v = localStorage.getItem("intermod." + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem("intermod." + k, JSON.stringify(v)); } catch {} },
};
const uid = () => Math.random().toString(36).slice(2, 9);

// ---------------- emission modes ----------------
// Occupied bandwidth (kHz) from the emission designator. Channel spacing is not the signal width:
// a 6.25 kHz NXDN carrier occupies ~4 kHz, a 12.5 kHz analogue FM carrier ~11 kHz.
const MODES = {
  fm25:   { label: "Analogue FM 25 kHz", em: "16K0F3E", occ: 16 },
  fm12:   { label: "Analogue FM 12.5 kHz", em: "11K0F3E", occ: 11 },
  nxdn6:  { label: "NXDN 6.25 kHz", em: "4K00F1E", occ: 4 },
  nxdn12: { label: "NXDN 12.5 kHz", em: "8K30F1E", occ: 8.3 },
  dmr:    { label: "DMR", em: "7K60FXE", occ: 7.6 },
  p25:    { label: "P25 Phase 1", em: "8K10F1E", occ: 8.1 },
  custom: { label: "Custom width", em: "", occ: null },
};
const defaultMode = (spacing) => (spacing <= 6.25 ? "nxdn6" : spacing <= 12.5 ? "fm12" : "fm25");
const occOf = (mode, spacing) => (MODES[mode]?.occ ?? spacing);
const stOcc = (s) => (s.mode === "custom" ? +s.customBw || s.tx?.bw || s.rx?.bw : occOf(s.mode || defaultMode(s.tx?.bw ?? s.rx?.bw), s.tx?.bw ?? s.rx?.bw));
const modeOptions = (sel) => Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${k === sel ? "selected" : ""}>${m.label}${m.em ? " · " + m.em : ""}</option>`).join("");

// ---------------- data ----------------
let DB = null, BY_NAME = new Map(), SORTED = [];
async function loadDb() {
  const r = await fetch("data/channels.json");
  DB = await r.json();
  for (const c of DB.channels) BY_NAME.set(c.n.toUpperCase(), c);
  SORTED = [...DB.channels].sort((a, b) => a.f - b.f);
}
function channelAt(f) {
  return DB.channels.filter((c) => Math.abs(c.f - f) < 1e-7);
}
function describe(c) {
  const role = { B: "base Tx", M: "mobile Tx", S: "simplex" }[c.role];
  return `${c.n} · ${fmtF(c.f)} MHz · ${c.bw} kHz${c.bw <= 6.25 ? " (digital)" : ""} ${role} · ${c.band}${c.u ? " · " + c.u : ""}`;
}

// ---------------- worker ----------------
const worker = new Worker("worker.js", { type: "module" });
const pending = new Map();
worker.onmessage = (ev) => { const p = pending.get(ev.data.id); pending.delete(ev.data.id); ev.data.ok ? p.res(ev.data.out) : p.rej(new Error(ev.data.error)); };
function run(cmd, ...args) { const id = uid(); return new Promise((res, rej) => { pending.set(id, { res, rej }); worker.postMessage({ id, cmd, args }); }); }

// ---------------- sites ----------------
let sites = store.get("sites", null);
let currentId = store.get("current", null);
if (!sites || !Object.keys(sites).length) { const id = uid(); sites = { [id]: { name: "My site", stations: [] } }; currentId = id; }
if (!sites[currentId]) currentId = Object.keys(sites)[0];
const site = () => sites[currentId];
const save = () => { store.set("sites", sites); store.set("current", currentId); };

function stationFromChannel(c) {
  if (c.role === "B") {
    const p = BY_NAME.get((c.p || "").toUpperCase());
    return { id: uid(), label: c.n, ch: c.n, tx: { f: c.f, bw: c.bw }, rx: p ? { f: p.f, bw: p.bw } : null, txOn: true, rxOn: !!p, mode: defaultMode(c.bw) };
  }
  if (c.role === "M") {
    const p = BY_NAME.get((c.p || "").toUpperCase());
    return { id: uid(), label: c.n, ch: c.n, tx: { f: c.f, bw: c.bw }, rx: p ? { f: p.f, bw: p.bw } : null, txOn: true, rxOn: !!p, mode: defaultMode(c.bw) };
  }
  return { id: uid(), label: c.n, ch: c.n, tx: { f: c.f, bw: c.bw }, rx: { f: c.f, bw: c.bw }, txOn: true, rxOn: true, mode: defaultMode(c.bw) };
}

/** Parse "FN123", "152.4875", "152.4875/156.66", "152.4875 156.66 12.5" */
function parseEntry(text) {
  const t = text.trim();
  if (!t) return null;
  const c = BY_NAME.get(t.toUpperCase().replace(/\s+/g, ""));
  if (c) return { kind: "channel", c };
  const nums = t.split(/[\s,/;]+/).map(Number).filter((n) => !isNaN(n) && n > 0);
  if (nums.length && nums[0] > 1) {
    const [tx, rx = tx, bw = 12.5] = nums;
    return { kind: "manual", tx, rx, bw };
  }
  return null;
}

function renderSites() {
  const sel = $("#siteSelect");
  sel.innerHTML = Object.entries(sites).map(([id, s]) => `<option value="${id}" ${id === currentId ? "selected" : ""}>${esc(s.name)}</option>`).join("");
  renderStations();
}
function renderStations() {
  const st = site().stations;
  $("#stationsEmpty").hidden = st.length > 0;
  $("#stations").innerHTML = st.map((s) => `
    <div class="st" data-id="${s.id}">
      <div class="name"><input value="${esc(s.label)}" data-field="label" aria-label="Label"></div>
      <button class="x" data-act="remove" aria-label="Remove ${esc(s.label)}">✕</button>
      <div class="freqs">
        ${s.tx ? `<button class="tog ${s.txOn ? "" : "off"}" data-act="tx" title="Click to include/exclude this transmitter">Tx <b>${fmtF(s.tx.f)}</b></button>` : ""}
        ${s.rx ? `<button class="tog ${s.rxOn ? "" : "off"}" data-act="rx" title="Click to include/exclude this receiver">Rx <b>${fmtF(s.rx.f)}</b></button>` : ""}
      </div>
      <div class="mode">
        <select data-field="mode" aria-label="Emission mode">${modeOptions(s.mode || defaultMode(s.tx?.bw ?? s.rx?.bw))}</select>
        ${s.mode === "custom" ? `<input type="number" step="0.1" min="0.1" data-field="customBw" value="${s.customBw ?? (s.tx?.bw ?? s.rx?.bw)}" aria-label="Occupied bandwidth kHz"><span>kHz</span>` : `<span>${stOcc(s)} kHz wide</span>`}
      </div>
    </div>`).join("");
  renderVictimPicks();
  updateCleanCount();
}
function siteForEngine() {
  return site().stations.map((s) => {
    const bw = stOcc(s);
    return { label: s.label, tx: s.txOn && s.tx ? { f: s.tx.f, bw } : null, rx: s.rxOn && s.rx ? { f: s.rx.f, bw } : null };
  });
}

$("#stations").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]"); if (!b) return;
  const id = b.closest(".st").dataset.id;
  const st = site().stations; const s = st.find((x) => x.id === id);
  if (b.dataset.act === "remove") st.splice(st.indexOf(s), 1);
  if (b.dataset.act === "tx") s.txOn = !s.txOn;
  if (b.dataset.act === "rx") s.rxOn = !s.rxOn;
  save(); renderStations();
});
$("#stations").addEventListener("change", (e) => {
  const inp = e.target.closest("[data-field]"); if (!inp) return;
  const s = site().stations.find((x) => x.id === inp.closest(".st").dataset.id);
  const fld = inp.dataset.field;
  if (fld === "label") { s.label = inp.value.trim() || s.label; save(); renderVictimPicks(); return; }
  if (fld === "mode") s.mode = inp.value;
  if (fld === "customBw") s.customBw = +inp.value;
  save(); renderStations();
});

$("#addForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const inp = $("#addInput");
  const p = parseEntry(inp.value);
  if (!p) { $("#addHint").textContent = `"${inp.value}" isn't a PIB 23 channel or a frequency.`; return; }
  let s;
  if (p.kind === "channel") s = stationFromChannel(p.c);
  else s = { id: uid(), label: `${fmtF(p.tx)}${p.rx !== p.tx ? " / " + fmtF(p.rx) : ""}`, tx: { f: p.tx, bw: p.bw }, rx: { f: p.rx, bw: p.bw }, txOn: true, rxOn: true, mode: defaultMode(p.bw) };
  site().stations.push(s); save(); renderStations();
  inp.value = ""; $("#addHint").textContent = p.kind === "channel" ? describe(p.c) : "Added manual entry. Rename it by clicking the label.";
  inp.focus();
});

// suggestions (datalist kept small so phones stay quick)
function suggest(q) {
  q = q.trim().toUpperCase().replace(/\s+/g, "");
  const dl = $("#chanList");
  if (!q || !DB) { dl.innerHTML = ""; return; }
  const out = [];
  if (/^[A-Z]/.test(q)) { for (const c of DB.channels) { if (c.n.toUpperCase().startsWith(q)) out.push(c); if (out.length >= 40) break; } }
  else if (/^\d/.test(q)) { for (const c of SORTED) { if (String(c.f).startsWith(q)) out.push(c); if (out.length >= 40) break; } }
  dl.innerHTML = out.map((c) => `<option value="${esc(c.n)}">${esc(describe(c))}</option>`).join("");
}
for (const id of ["#addInput", "#victimInput"]) $(id).addEventListener("input", (e) => suggest(e.target.value));

// site menu
$("#siteSelect").addEventListener("change", (e) => { currentId = e.target.value; save(); renderSites(); });
$("#siteMenuBtn").addEventListener("click", (e) => { e.stopPropagation(); $("#siteMenu").hidden = !$("#siteMenu").hidden; });
document.addEventListener("click", () => ($("#siteMenu").hidden = true));
$("#siteMenu").addEventListener("click", async (e) => {
  const act = e.target.dataset.act; if (!act) return;
  if (act === "new") { const name = await prompt1("New site", "Site name", ""); if (!name) return; const id = uid(); sites[id] = { name, stations: [] }; currentId = id; }
  if (act === "rename") { const name = await prompt1("Rename site", "Site name", site().name); if (name) site().name = name; }
  if (act === "dup") { const id = uid(); sites[id] = structuredClone(site()); sites[id].name += " (copy)"; currentId = id; }
  if (act === "delete") { if (!confirm(`Delete "${site().name}"?`)) return; delete sites[currentId]; if (!Object.keys(sites).length) sites[uid()] = { name: "My site", stations: [] }; currentId = Object.keys(sites)[0]; }
  if (act === "export") {
    const blob = new Blob([JSON.stringify({ app: "intermod", version: 1, site: site() }, null, 2)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: site().name.replace(/[^\w-]+/g, "_") + ".json" });
    a.click(); URL.revokeObjectURL(a.href);
  }
  if (act === "import") {
    const f = Object.assign(document.createElement("input"), { type: "file", accept: ".json,application/json" });
    f.onchange = async () => { try { const j = JSON.parse(await f.files[0].text()); const s = j.site || j; if (!Array.isArray(s.stations)) throw 0; const id = uid(); sites[id] = { name: s.name || "Imported", stations: s.stations.map((x) => ({ ...x, id: uid() })) }; currentId = id; save(); renderSites(); } catch { alert("That file isn't an Intermod site export."); } };
    f.click(); return;
  }
  if (act === "csv") {
    const text = await promptArea("Paste a list", "One per line: a PIB 23 channel (FN123) or  label, Tx MHz, Rx MHz, bandwidth kHz");
    if (!text) return;
    const bad = [];
    for (const line of text.split(/\r?\n/)) {
      const l = line.trim(); if (!l) continue;
      const parts = l.split(/[,\t;]+/).map((x) => x.trim());
      const c = BY_NAME.get(parts[0].toUpperCase().replace(/\s+/g, ""));
      if (c && parts.length === 1) { site().stations.push(stationFromChannel(c)); continue; }
      const [label, tx, rx, bw] = [parts[0], +parts[1], +(parts[2] || parts[1]), +(parts[3] || 12.5)];
      if (!isNaN(+label) && parts.length <= 3) { const t = +label, r = +(parts[1] || label), w = +(parts[2] || 12.5); site().stations.push({ id: uid(), label: fmtF(t), tx: { f: t, bw: w }, rx: { f: r, bw: w }, txOn: true, rxOn: true, mode: defaultMode(w) }); continue; }
      if (isNaN(tx) || tx <= 0) { bad.push(l); continue; }
      site().stations.push({ id: uid(), label, tx: { f: tx, bw }, rx: { f: rx, bw }, txOn: true, rxOn: true, mode: defaultMode(bw) });
    }
    if (bad.length) alert("Couldn't read:\n" + bad.join("\n"));
  }
  save(); renderSites();
});

function dialog(title, bodyHtml) {
  const d = $("#dlg"); $("#dlgTitle").textContent = title; $("#dlgBody").innerHTML = bodyHtml; d.showModal();
  return new Promise((res) => d.addEventListener("close", () => res(d.returnValue === "ok"), { once: true }));
}
async function prompt1(title, label, value) { const ok = await dialog(title, `<label>${esc(label)}<input id="dlgIn" value="${esc(value)}"></label>`); return ok ? $("#dlgIn").value.trim() : null; }
async function promptArea(title, label) { const ok = await dialog(title, `<label>${esc(label)}<textarea id="dlgIn"></textarea></label>`); return ok ? $("#dlgIn").value : null; }

// ---------------- tabs & settings ----------------
$$(".tabs button").forEach((b) => b.addEventListener("click", () => {
  $$(".tabs button").forEach((x) => x.setAttribute("aria-selected", x === b));
  $$(".tabpane").forEach((p) => (p.hidden = p.dataset.pane !== b.dataset.tab));
  store.set("tab", b.dataset.tab);
}));
const SETTINGS = { setHarm: 10, setO2: 7, setO3: 5, setGuard: 0, setEven: false };
const savedSettings = store.get("settings", {});
for (const [id, d] of Object.entries(SETTINGS)) {
  const el = $("#" + id), v = savedSettings[id] ?? d;
  if (el.type === "checkbox") el.checked = v; else el.value = v;
  el.addEventListener("change", () => { const s = {}; for (const k of Object.keys(SETTINGS)) { const e = $("#" + k); s[k] = e.type === "checkbox" ? e.checked : +e.value; } store.set("settings", s); });
}
const opts = () => ({ maxHarmonic: +$("#setHarm").value, maxOrder2: +$("#setO2").value, maxOrder3: +$("#setO3").value, guardKHz: +$("#setGuard").value, evenOrders: $("#setEven").checked });

// ---------------- results rendering ----------------
function carriersHtml(r) {
  return `<div class="carriers">${r.carriers.map((c, i) => `<span><em>${"ABC"[i]}</em>${fmtF(c.f)}<small>${esc(c.label)}</small></span>`).join("")}</div>`;
}
function kindLabel(r) { return { fundamental: "On-channel", harmonic: "Harmonic", im2: "2-tone IM", im3: "3-tone IM" }[r.kind]; }
function resultTable(rows, { victimCol = false } = {}) {
  return `<div class="tablewrap"><table>
    <thead><tr><th>Order</th><th>Type</th><th>Product</th><th>Carriers</th><th class="num">Lands MHz</th><th class="num">Offset kHz</th><th class="num">Clearance kHz</th>${victimCol ? "<th>Victim Rx</th>" : ""}</tr></thead>
    <tbody>${rows.map((r) => `<tr>
      <td><span class="ord ${ordClass(r.order)}">${r.order}</span></td>
      <td>${kindLabel(r)}</td>
      <td class="mono">${esc(r.formula)}</td>
      <td>${carriersHtml(r)}</td>
      <td class="num">${fmtF(r.f)}</td>
      <td class="num">${fmtK(r.offsetKHz)}</td>
      <td class="num ${r.clearanceKHz < 0 ? "overlap" : ""}" title="${r.clearanceKHz < 0 ? "Product overlaps the receiver passband" : "Gap between product and receiver passband"}">${r.clearanceKHz < 0 ? "overlap " + Math.abs(r.clearanceKHz).toFixed(1) : r.clearanceKHz.toFixed(1)}</td>
      ${victimCol ? `<td>${esc(r.victim.label)} <span class="mono">${fmtF(r.victim.f)}</span></td>` : ""}
    </tr>`).join("")}</tbody></table></div>`;
}
function orderSummary(results, onFilter) {
  const counts = {};
  for (const r of results) counts[r.order] = (counts[r.order] || 0) + 1;
  const wrap = document.createElement("div"); wrap.className = "summary";
  wrap.innerHTML = `<button class="pill" aria-pressed="true" data-o="all">All ${results.length}</button>` +
    Object.keys(counts).sort((a, b) => a - b).map((o) => `<button class="pill" data-o="${o}"><span class="ord ${ordClass(+o)}">${o}</span> ${counts[o]}</button>`).join("");
  wrap.addEventListener("click", (e) => { const b = e.target.closest(".pill"); if (!b) return; $$(".pill", wrap).forEach((x) => x.setAttribute("aria-pressed", x === b)); onFilter(b.dataset.o === "all" ? null : +b.dataset.o); });
  return wrap;
}
function pagedTable(container, results, tableOpts) {
  let filter = null, shown = 200;
  const body = document.createElement("div");
  const draw = () => {
    const rows = filter === null ? results : results.filter((r) => r.order === filter);
    body.innerHTML = resultTable(rows.slice(0, shown), tableOpts) + (rows.length > shown ? `<button class="more">Show more (${rows.length - shown} left)</button>` : "");
    const m = $(".more", body); if (m) m.onclick = () => { shown += 500; draw(); };
  };
  container.append(orderSummary(results, (o) => { filter = o; shown = 200; draw(); }), body);
  draw();
}
async function busy(btn, fn) {
  const label = btn.textContent; btn.disabled = true; btn.innerHTML = `<span class="spinner"></span>Calculating…`;
  try { await fn(); } catch (err) { alert("Calculation failed: " + err.message); console.error(err); }
  finally { btn.disabled = false; btn.textContent = label; }
}

// ---------------- FIND SOURCE ----------------
function renderVictimPicks() {
  const rxs = site().stations.filter((s) => s.rx);
  let el = $("#victimPicks");
  if (!el) { el = document.createElement("div"); el.id = "victimPicks"; el.className = "chips"; el.style.marginTop = "8px"; $("#victimHint").before(el); }
  el.innerHTML = rxs.length ? rxs.map((s) => `<button class="chip" data-f="${s.rx.f}" data-bw="${stOcc(s)}" data-label="${esc(s.label)}">${esc(s.label)} Rx ${fmtF(s.rx.f)}</button>`).join("") : "";
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("#victimPicks .chip"); if (!b) return;
  $("#victimInput").value = fmtF(+b.dataset.f); $("#victimBw").value = b.dataset.bw; $("#victimInput").dataset.label = b.dataset.label; updateVictimHint();
});
function getVictim() {
  const inp = $("#victimInput"), p = parseEntry(inp.value);
  if (!p) return null;
  if (p.kind === "channel") return { f: p.c.f, bw: +$("#victimBw").value || occOf(defaultMode(p.c.bw), p.c.bw), label: p.c.n, c: p.c };
  return { f: p.tx, bw: +$("#victimBw").value, label: inp.dataset.label || fmtF(p.tx) + " MHz" };
}
function updateVictimHint() {
  const v = getVictim(), h = $("#victimHint");
  if (!$("#victimInput").value.trim()) { h.textContent = ""; return; }
  if (!v) { h.textContent = "Not a PIB 23 channel or frequency."; return; }
  if (v.c) {
    h.textContent = describe(v.c) + (v.c.role === "B" ? ` — note: a base station receives on ${v.c.p}` : "");
  } else {
    const on = channelAt(v.f); h.textContent = on.length ? `${fmtF(v.f)} MHz is ${on.map((c) => c.n).join(", ")}` : `${fmtF(v.f)} MHz (not on a PIB 23 channel)`;
  }
}
$("#victimInput").addEventListener("input", () => { delete $("#victimInput").dataset.label; updateVictimHint(); });
$("#victimInput").addEventListener("change", () => { const v = getVictim(); if (v?.c) $("#victimBw").value = occOf(defaultMode(v.c.bw), v.c.bw); updateVictimHint(); });

const selectedBands = new Set(store.get("poolBands", []));
function renderBandChips() {
  $("#bandChips").innerHTML = DB.bands.map((b) => `<button class="chip" data-band="${esc(b.band)}" aria-pressed="${selectedBands.has(b.band)}" title="${fmtF(b.lo)}–${fmtF(b.hi)} MHz">${esc(b.band.replace(/ Band$/, ""))}</button>`).join("");
  updatePoolCount();
}
$("#bandChips").addEventListener("click", (e) => {
  const b = e.target.closest(".chip"); if (!b) return;
  const band = b.dataset.band; selectedBands.has(band) ? selectedBands.delete(band) : selectedBands.add(band);
  b.setAttribute("aria-pressed", selectedBands.has(band)); store.set("poolBands", [...selectedBands]); updatePoolCount();
});
function dbPool() {
  const roles = new Set(["B", "S", "M"].filter((r) => $("#role" + r).checked));
  return DB.channels.filter((c) => selectedBands.has(c.band) && roles.has(c.role)).map((c) => ({ f: c.f, bw: occOf(defaultMode(c.bw), c.bw), label: c.n, src: "db" }));
}
function updatePoolCount() {
  if (!DB) return;
  const n = new Set(dbPool().map((c) => c.f)).size;
  $("#poolCount").textContent = selectedBands.size ? `${n.toLocaleString()} distinct frequencies` : "Pick one or more bands";
}
$("#poolDb").addEventListener("change", (e) => ($("#dbPoolOpts").hidden = !e.target.checked));
["#roleB", "#roleS", "#roleM"].forEach((id) => $(id).addEventListener("change", updatePoolCount));

$("#runSource").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const out = $("#sourceOut"); out.innerHTML = "";
  const v = getVictim();
  if (!v) { out.innerHTML = `<div class="note">Enter the receive frequency that's being interfered with.</div>`; return; }
  let pool = [];
  if ($("#poolSite").checked) pool.push(...site().stations.filter((s) => s.tx && s.txOn).map((s) => ({ f: s.tx.f, bw: stOcc(s), label: s.label, src: "site" })));
  if ($("#poolDb").checked) pool.push(...dbPool());
  if (!pool.length) { out.innerHTML = `<div class="note">No candidate transmitters. Add transmitters to the site, or tick "PIB 23 channels" and pick bands.</div>`; return; }
  const requireSrc = $("#poolSite").checked && $("#poolDb").checked && $("#requireSite").checked && pool.some((c) => c.src === "site") ? "site" : null;
  const { results, notes, poolSize, ms } = await run("findSources", { f: v.f, bw: v.bw, label: v.label }, pool, { ...opts(), requireSrc });
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = `<h2>${results.length ? results.length.toLocaleString() + " possible source" + (results.length === 1 ? "" : "s") : "No sources found"} for ${esc(v.label)} <span class="mono">${fmtF(v.f)}</span></h2>
    <p class="hint">${poolSize.toLocaleString()} transmit frequencies searched in ${ms} ms${requireSrc ? ", keeping only combinations with a site transmitter" : ""}. Lower order = stronger product.</p>
    ${notes.map((n) => `<div class="note">${esc(n)}</div>`).join("")}`;
  out.append(card);
  if (results.length) pagedTable(card, results);
}));

// ---------------- CHECK SITE ----------------
$("#runSite").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const out = $("#siteOut"); out.innerHTML = "";
  const st = siteForEngine();
  if (!st.some((s) => s.tx) || !st.some((s) => s.rx)) { out.innerHTML = `<div class="note">The site needs at least one transmitter and one receiver.</div>`; return; }
  const { results, productCount, txCount, rxCount, ms } = await run("checkSite", st, opts());
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = `<h2>${results.length ? results.length + " hit" + (results.length === 1 ? "" : "s") + " on site receivers" : "<span class='clean-ok'>No products land on any site receiver</span>"}</h2>
    <p class="hint">${txCount} Tx · ${rxCount} Rx · ${productCount.toLocaleString()} products checked in ${ms} ms.</p>`;
  out.append(card);
  if (results.length) pagedTable(card, results, { victimCol: true });
}));

// ---------------- CLEAN CHANNEL ----------------
function plansFor(band) {
  const m = new Map();
  for (const c of DB.channels) {
    if (c.band !== band || c.role === "M") continue;
    const k = `${c.sec}|${c.bw}|${c.role === "B" ? "pair" : "simplex"}`;
    if (!m.has(k)) m.set(k, { key: k, sec: c.sec, bw: c.bw, kind: c.role === "B" ? "pair" : "simplex", n: 0 });
    m.get(k).n++;
  }
  return [...m.values()];
}
function renderCleanSelects() {
  const bands = DB.bands.filter((b) => plansFor(b.band).length);
  const saved = store.get("clean", {});
  $("#cleanBand").innerHTML = bands.map((b) => `<option ${b.band === saved.band ? "selected" : ""}>${esc(b.band)}</option>`).join("");
  renderPlans(saved.plan);
}
function renderPlans(sel) {
  const plans = plansFor($("#cleanBand").value);
  $("#cleanPlan").innerHTML = plans.map((p) => `<option value="${p.key}" ${p.key === sel ? "selected" : ""}>${p.bw} kHz${p.bw <= 6.25 ? " digital" : ""} ${p.kind === "pair" ? "two-frequency" : "simplex"} (§${p.sec}, ${p.n})</option>`).join("");
  updateCleanCount();
}
$("#cleanBand").addEventListener("change", () => { renderPlans(); store.set("clean", { band: $("#cleanBand").value, plan: $("#cleanPlan").value }); });
$("#cleanPlan").addEventListener("change", () => { updateCleanCount(); store.set("clean", { band: $("#cleanBand").value, plan: $("#cleanPlan").value }); });
$("#cleanSkipUsed").addEventListener("change", updateCleanCount);
function candidates() {
  if (!DB || !$("#cleanPlan").value) return [];
  const [sec, bw, kind] = $("#cleanPlan").value.split("|");
  const used = new Set(site().stations.map((s) => s.ch).filter(Boolean));
  const band = $("#cleanBand").value;
  return DB.channels.filter((c) => c.band === band && c.sec === sec && c.bw === +bw && (kind === "pair" ? c.role === "B" : c.role === "S"))
    .filter((c) => !$("#cleanSkipUsed").checked || !used.has(c.n))
    .map((c) => { const s = stationFromChannel(c); const bw = stOcc(s); return { label: c.n, tx: { f: s.tx.f, bw }, rx: { f: (s.rx || s.tx).f, bw }, use: c.u }; });
}
function updateCleanCount() { if (DB) $("#cleanCount").textContent = `${candidates().length.toLocaleString()} candidate channels, checked against ${site().stations.length} site entries.`; }

$("#runClean").addEventListener("click", (e) => busy(e.currentTarget, async () => {
  const out = $("#cleanOut"); out.innerHTML = "";
  const cands = candidates();
  if (!cands.length) { out.innerHTML = `<div class="note">No candidate channels.</div>`; return; }
  const { ranked, ms } = await run("rankCandidates", siteForEngine(), cands, opts());
  const clean = ranked.filter((c) => c.worstOrder === null).length;
  const card = document.createElement("div"); card.className = "card";
  card.innerHTML = `<h2>${clean ? `<span class="clean-ok">${clean} clean</span> of ${ranked.length} channels` : `No fully clean channels — best of ${ranked.length} shown first`}</h2>
    <p class="hint">Ranked in ${ms} ms. Clean = no harmonic or IM product (within the settings) lands on its Rx or any site Rx, and no site product lands on it. Then by highest worst-case order, then fewest hits.</p>`;
  let shown = 100;
  const list = document.createElement("div");
  const draw = () => {
    list.innerHTML = `<div class="tablewrap"><table><thead><tr><th>#</th><th>Channel</th><th class="num">Tx MHz</th><th class="num">Rx MHz</th><th>Worst</th><th class="num">Hits</th><th>Use</th></tr></thead><tbody>` +
      ranked.slice(0, shown).map((c, i) => `<tr data-i="${i}" style="cursor:${c.hits ? "pointer" : "default"}">
        <td class="num">${i + 1}</td><td><b>${esc(c.label)}</b></td><td class="num">${fmtF(c.tx.f)}</td><td class="num">${fmtF(c.rx.f)}</td>
        <td>${c.worstOrder === null ? `<span class="clean-ok">Clean</span>` : `<span class="ord ${ordClass(c.worstOrder)}">${c.worstOrder}</span>`}</td>
        <td class="num">${c.hits || ""}</td><td>${esc(c.use || "")}</td></tr>`).join("") + `</tbody></table></div>` +
      (ranked.length > shown ? `<button class="more">Show more (${ranked.length - shown} left)</button>` : "") + `<div id="candDetail"></div>`;
    const m = $(".more", list); if (m) m.onclick = () => { shown += 200; draw(); };
  };
  list.addEventListener("click", (ev) => {
    const tr = ev.target.closest("tr[data-i]"); if (!tr) return;
    const c = ranked[+tr.dataset.i]; if (!c.hits) return;
    const d = $("#candDetail", list); d.innerHTML = `<div class="group-head"><h3>${esc(c.label)} — ${c.hits} hit${c.hits === 1 ? "" : "s"}</h3></div>` + resultTable(c.results, { victimCol: true });
    d.scrollIntoView({ behavior: "smooth", block: "nearest" });
  });
  draw(); card.append(list); out.append(card);
}));

// ---------------- boot ----------------
(async function boot() {
  const tab = store.get("tab", "source");
  $(`.tabs button[data-tab="${tab}"]`)?.click();
  renderSites();
  try { await loadDb(); } catch { $("#addHint").textContent = "Couldn't load the channel database."; return; }
  renderBandChips(); renderCleanSelects(); renderStations();
})();
