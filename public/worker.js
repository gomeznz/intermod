// Runs the heavy calculations off the UI thread.
import { findSources, checkSite, rankCandidates } from "./engine.js";

self.onmessage = (ev) => {
  const { id, cmd, args } = ev.data;
  const t0 = performance.now();
  try {
    let out;
    if (cmd === "findSources") out = findSources(...args);
    else if (cmd === "checkSite") { out = checkSite(...args); delete out.products; }
    else if (cmd === "rankCandidates") out = { ranked: rankCandidates(...args) };
    else throw new Error("unknown command " + cmd);
    out.ms = Math.round(performance.now() - t0);
    self.postMessage({ id, ok: true, out });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
