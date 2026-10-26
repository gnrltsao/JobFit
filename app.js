/* JobFit: static, client-side job matcher.
 * 1. Loads data/jobs.json (written daily by the GitHub Action).
 * 2. Reads the visitor's resume (PDF / DOCX / text) or typed bullets in the browser.
 * 3. Applies hard filters (time window, work arrangement, location), then ranks by keyword overlap.
 * 4. Sends the top N to Claude in small batches for a 1-5 fit score with a one-line reason.
 * 5. Shows only roles scored 4 or 5.
 */
(() => {
  "use strict";

  const KEEP_AT_OR_ABOVE = 4;
  const BATCH_SIZE = 8;
  const CONCURRENCY = 3;
  const PROFILE_CHARS = 12000;
  const KEY_STORE = "jobfit.apikey";

  const $ = (id) => document.getElementById(id);
  const state = { jobs: [], meta: null, mode: "upload", resumeText: "", running: false, kept: [] };

  // ------------------------------------------------------------------ safe storage
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
    del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } },
  };

  // ------------------------------------------------------------------ helpers
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = (u) => (/^https?:\/\//i.test(u || "") ? u : "#");

  function ago(iso) {
    if (!iso) return "date unknown";
    const h = (Date.now() - new Date(iso).getTime()) / 36e5;
    if (h < 1) return "under 1h ago";
    if (h < 24) return `${Math.round(h)}h ago`;
    const d = Math.round(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  const STOP = new Set(("a an and are as at be been by for from has have i in is it its of on or our that the their " +
    "this to was we were will with you your who what when where which while within across also into over per via " +
    "team teams work working role roles job jobs company years year experience including include etc using use used " +
    "ability strong excellent new other all any can may more most such than them they these those well able based " +
    "responsible responsibilities requirements required preferred plus help helping make makes").split(" "));

  function tokens(text) {
    return (text || "").toLowerCase().replace(/[^a-z0-9+#.\s-]/g, " ").split(/[\s/-]+/)
      .map((t) => t.replace(/^[.]+|[.]+$/g, "").replace(/(?<=..)s$/, ""))
      .filter((t) => t.length > 2 && !STOP.has(t) && !/^\d+$/.test(t));
  }

  // ------------------------------------------------------------------ data load
  async function loadJobs() {
    try {
      const r = await fetch("data/jobs.json", { cache: "no-cache" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      state.jobs = data.jobs || [];
      state.meta = data.meta || {};
      const when = state.meta.generated_at ? new Date(state.meta.generated_at) : null;
      $("freshness").textContent = when
        ? `${state.jobs.length.toLocaleString()} recent postings · ${state.meta.companies_ok}/${state.meta.companies_total} boards · updated ${ago(state.meta.generated_at)}`
        : "No job data yet. Run the “Fetch jobs” workflow.";
    } catch (e) {
      $("freshness").textContent = "Couldn't load job data";
      console.error(e);
    }
  }

  async function showSources(ev) {
    ev?.preventDefault();
    const dlg = $("sources-dialog");
    dlg.showModal();
    try {
      const r = await fetch("data/sources.json", { cache: "no-cache" });
      const d = await r.json();
      const rows = (d.sources || []).map((s) => `<tr><td>${esc(s.company)}</td><td>${esc(s.ats)}</td>
        <td class="${s.ok ? "" : "bad"}">${s.ok ? `${s.jobs} new` : esc(s.error || "failed")}</td></tr>`).join("");
      $("sources-body").innerHTML = `<p class="hint">Run at ${esc(new Date(d.meta.generated_at).toLocaleString())}. Failed boards usually mean the company changed systems or the board name is wrong.</p>
        <table class="src-table"><thead><tr><th>Company</th><th>System</th><th>Result</th></tr></thead><tbody>${rows}</tbody></table>`;
    } catch {
      $("sources-body").textContent = "No source report yet.";
    }
  }

  // ------------------------------------------------------------------ resume input
  async function readFile(file) {
    const name = file.name.toLowerCase();
    if (name.endsWith(".pdf")) {
      if (!window.pdfjsLib) throw new Error("PDF reader failed to load. Paste your bullets instead.");
      pdfjsLib.GlobalWorkerOptions.workerSrc =
        "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
      const pdf = await pdfjsLib.getDocument({ data: await file.arrayBuffer() }).promise;
      let out = "";
      for (let p = 1; p <= pdf.numPages; p++) {
        const page = await pdf.getPage(p);
        const tc = await page.getTextContent();
        out += tc.items.map((i) => i.str + (i.hasEOL ? "\n" : " ")).join("") + "\n";
      }
      return out;
    }
    if (name.endsWith(".docx")) {
      if (!window.mammoth) throw new Error("Word reader failed to load. Paste your bullets instead.");
      const res = await mammoth.extractRawText({ arrayBuffer: await file.arrayBuffer() });
      return res.value;
    }
    if (name.endsWith(".doc")) throw new Error("Old .doc files aren't supported. Save as .docx or PDF.");
    return await file.text();
  }

  async function onFile(file) {
    if (!file) return;
    $("file-status").textContent = `Reading ${file.name}…`;
    try {
      const text = (await readFile(file)).replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
      if (text.length < 200) throw new Error("Very little text came out of that file. If it's a scanned PDF, paste your bullets instead.");
      state.resumeText = text;
      $("file-status").textContent = `✓ ${file.name}: ${text.split(/\s+/).length.toLocaleString()} words read`;
    } catch (e) {
      state.resumeText = "";
      $("file-status").textContent = e.message;
    }
  }

  function profileText() {
    return (state.mode === "upload" ? state.resumeText : $("bullets").value).trim();
  }

  // ------------------------------------------------------------------ filter + rank
  function prefs() {
    const list = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
    return {
      titles: list($("titles").value),
      locations: list($("locations").value).map((s) => s.toLowerCase()),
      remote: $("wp-remote").checked, hybrid: $("wp-hybrid").checked, onsite: $("wp-onsite").checked,
      notes: $("notes").value.trim(),
      hours: Number($("window").value),
      topN: Number($("topn").value),
      workday: $("incl-workday").checked,
    };
  }

  function hardFilter(jobs, p) {
    const cutoff = Date.now() - p.hours * 36e5;
    return jobs.filter((j) => {
      if (!p.workday && j.source === "workday") return false;
      if (j.posted_at && new Date(j.posted_at).getTime() < cutoff) return false;
      const loc = (j.location || "").toLowerCase();
      const wp = j.workplace === "remote" ? "remote" : j.workplace === "hybrid" ? "hybrid" : "onsite";
      if (!p[wp]) return false;
      if (wp !== "remote" && p.locations.length && !p.locations.some((l) => loc.includes(l))) return false;
      return true;
    });
  }

  function rank(jobs, profile, p) {
    const prof = new Map();
    for (const t of tokens(profile)) prof.set(t, Math.min((prof.get(t) || 0) + 1, 3));
    const titleTerms = new Set(tokens(p.titles.join(" ")));
    const phrases = p.titles.map((t) => t.toLowerCase());
    return jobs.map((j) => {
      const tt = tokens(j.title);
      let s = 0;
      for (const t of tt) s += titleTerms.has(t) ? 6 : prof.has(t) ? 2 * prof.get(t) : 0;
      if (phrases.some((ph) => j.title.toLowerCase().includes(ph))) s += 12;
      const dt = new Set(tokens(j.description));
      let hit = 0;
      for (const t of dt) if (prof.has(t)) hit += prof.get(t);
      s += (hit / Math.sqrt(dt.size + 4)) * 4;
      return { job: j, kw: s };
    }).sort((a, b) => b.kw - a.kw).slice(0, p.topN).map((x) => x.job);
  }

  // ------------------------------------------------------------------ Claude scoring
  const RUBRIC = `You are an experienced recruiter scoring how well ONE candidate fits each job posting.

Score every job from 1 to 5:
5 = Strong match. The candidate meets nearly all core requirements; function, seniority and domain align. They could credibly interview tomorrow.
4 = Good match. Meets most core requirements with at most one manageable gap (adjacent industry, one tool, a modest level stretch).
3 = Partial match. Same function family but notable gaps: level mismatch, missing a key requirement, or a different specialty.
2 = Weak match. Some transferable skills, but a different function or a large level gap.
1 = No match.

Rules:
- Judge from the candidate profile and the posting text only. Do not invent experience the candidate does not show.
- Seniority matters in both directions: a role far more junior than the candidate is at most a 3.
- If the posting clearly conflicts with a stated preference (location, work arrangement, or pay when the posting lists pay), score it at most 2 and say why.
- Reason: one sentence, at most 25 words, naming the deciding factor.
- Respond with ONLY a JSON array, no prose: [{"id": "<job id>", "score": <1-5>, "reason": "<sentence>"}], one entry per job.`;

  function buildSystem(profile, p) {
    const pref = [
      p.titles.length ? `Target titles: ${p.titles.join(", ")}` : "",
      `Acceptable arrangements: ${["remote", "hybrid", "onsite"].filter((k) => p[k]).join(", ")}`,
      p.locations.length ? `Acceptable locations for hybrid/onsite: ${p.locations.join(", ")}` : "",
      p.notes ? `Other preferences: ${p.notes}` : "",
    ].filter(Boolean).join("\n");
    return [
      { type: "text", text: RUBRIC },
      { type: "text", text: `CANDIDATE PROFILE\n${profile.slice(0, PROFILE_CHARS)}\n\nCANDIDATE PREFERENCES\n${pref}`,
        cache_control: { type: "ephemeral" } },
    ];
  }

  function jobBlock(j) {
    return [`ID: ${j.id}`, `Title: ${j.title}`, `Company: ${j.company}`,
      `Location: ${j.location} (${j.workplace})`, j.pay ? `Pay: ${j.pay}` : "Pay: not listed",
      `Description: ${j.description || "(none provided)"}`].join("\n");
  }

  async function callClaude(key, model, system, jobs, attempt = 0) {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": key,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model, max_tokens: 1500, temperature: 0, system,
        messages: [{ role: "user", content: `Score these ${jobs.length} jobs.\n\n` + jobs.map(jobBlock).join("\n\n---\n\n") }],
      }),
    });
    if ((r.status === 429 || r.status === 529 || r.status >= 500) && attempt < 3) {
      await new Promise((res) => setTimeout(res, 1500 * 2 ** attempt + Math.random() * 500));
      return callClaude(key, model, system, jobs, attempt + 1);
    }
    if (!r.ok) {
      let msg = `Claude API error ${r.status}`;
      try { msg += `: ${(await r.json()).error?.message || ""}`; } catch { /* ignore */ }
      if (r.status === 401) msg = "Your API key was rejected. Check it and try again.";
      const err = new Error(msg); err.fatal = r.status === 401 || r.status === 403 || r.status === 400; throw err;
    }
    const data = await r.json();
    const text = (data.content || []).filter((c) => c.type === "text").map((c) => c.text).join("");
    const m = text.match(/\[[\s\S]*\]/);
    if (!m) throw new Error("Claude returned an unreadable answer for one batch.");
    return JSON.parse(m[0]);
  }

  async function scoreAll(key, model, system, jobs, onProgress) {
    const batches = [];
    for (let i = 0; i < jobs.length; i += BATCH_SIZE) batches.push(jobs.slice(i, i + BATCH_SIZE));
    const scores = new Map();
    let done = 0, failed = 0, fatal = null, next = 0;
    async function worker() {
      while (next < batches.length && !fatal) {
        const b = batches[next++];
        try {
          for (const s of await callClaude(key, model, system, b)) {
            const n = Math.round(Number(s.score));
            if (s.id && n >= 1 && n <= 5) scores.set(String(s.id), { score: n, reason: String(s.reason || "") });
          }
        } catch (e) {
          if (e.fatal) fatal = e; else { failed += b.length; console.warn(e); }
        }
        done += b.length;
        onProgress(Math.min(done, jobs.length), jobs.length);
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, worker));
    if (fatal) throw fatal;
    return { scores, failed };
  }

  // ------------------------------------------------------------------ render
  function setProgress(pct, text) {
    $("progress").hidden = false;
    $("bar-fill").style.width = `${pct}%`;
    $("progress-text").textContent = text;
  }

  function card(j) {
    const label = j.score === 5 ? "Strong" : "Good";
    const badges = [
      j.pay ? `<span class="badge pay">${esc(j.pay)}</span>` : "",
      `<span class="badge">${esc(j.source)}</span>`,
      j.experimental ? `<span class="badge exp">experimental source</span>` : "",
      j.date_basis === "updated" ? `<span class="badge exp">date = last updated</span>` : "",
    ].join("");
    return `<article class="card">
      <div class="score s${j.score}" aria-label="Score ${j.score} of 5">${j.score}<small>${label}</small></div>
      <div>
        <h3><a href="${esc(safeUrl(j.url))}" target="_blank" rel="noopener">${esc(j.title)}</a></h3>
        <div class="meta"><span>${esc(j.company)}</span><span>${esc(j.location)}</span><span>${esc(j.workplace)}</span><span>${esc(ago(j.posted_at))}</span></div>
        <p class="reason">${esc(j.reason)}</p>
        <div class="badges">${badges}</div>
      </div>
    </article>`;
  }

  function render(kept, stats) {
    $("progress").hidden = true;
    const s = $("summary");
    s.hidden = false;
    s.innerHTML = `<div>
        <p><strong>${kept.length} ${kept.length === 1 ? "role" : "roles"} scored 4 or 5</strong></p>
        <p class="sub">${stats.pool.toLocaleString()} postings in your window → ${stats.scored} shortlisted and scored by Claude → ${stats.removed} removed below 4${stats.failed ? ` · ${stats.failed} could not be scored` : ""}</p>
      </div>
      ${kept.length ? `<button type="button" class="go ghost" id="csv">Download CSV</button>` : ""}`;
    $("list").innerHTML = kept.length ? kept.map(card).join("")
      : `<div class="empty"><h2>No 4s or 5s this time</h2><p class="hint">Try a wider time window, more roles to score, broader target titles, or more locations. New postings arrive every morning.</p></div>`;
    $("csv")?.addEventListener("click", downloadCsv);
  }

  function downloadCsv() {
    const cols = ["score", "title", "company", "location", "workplace", "pay", "posted_at", "source", "reason", "url"];
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const csv = [cols.join(","), ...state.kept.map((j) => cols.map((c) => q(j[c])).join(","))].join("\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `jobfit-matches-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  // ------------------------------------------------------------------ main flow
  async function run(ev) {
    ev.preventDefault();
    if (state.running) return;
    const err = $("form-error");
    err.textContent = "";
    const profile = profileText();
    const key = $("apikey").value.trim();
    const p = prefs();

    if (profile.length < 80) return (err.textContent = state.mode === "upload"
      ? "Upload a resume first (or switch to Type bullets)." : "Add a few bullets about your experience.");
    if (!key) return (err.textContent = "Add your Claude API key to score roles.");
    if (!p.remote && !p.hybrid && !p.onsite) return (err.textContent = "Pick at least one work arrangement.");
    if (!state.jobs.length) return (err.textContent = "No job data is loaded yet.");

    if ($("remember").checked) store.set(KEY_STORE, key); else store.del(KEY_STORE);

    state.running = true;
    $("go").disabled = true;
    $("empty").hidden = true;
    $("summary").hidden = true;
    $("list").innerHTML = "";

    try {
      const pool = hardFilter(state.jobs, p);
      if (!pool.length) {
        render([], { pool: 0, scored: 0, removed: 0, failed: 0 });
        return;
      }
      const shortlist = rank(pool, profile, p);
      setProgress(2, `Scoring ${shortlist.length} of ${pool.length.toLocaleString()} postings with Claude…`);
      if (matchMedia("(max-width: 860px)").matches) $("progress").scrollIntoView({ behavior: "smooth" });
      const { scores, failed } = await scoreAll(key, $("model").value, buildSystem(profile, p), shortlist,
        (d, t) => setProgress(Math.max(2, (d / t) * 100), `Scored ${d} of ${t} roles…`));

      const scored = shortlist.filter((j) => scores.has(String(j.id)))
        .map((j) => ({ ...j, ...scores.get(String(j.id)) }));
      state.kept = scored.filter((j) => j.score >= KEEP_AT_OR_ABOVE)
        .sort((a, b) => b.score - a.score || new Date(b.posted_at) - new Date(a.posted_at));
      render(state.kept, { pool: pool.length, scored: scored.length,
        removed: scored.length - state.kept.length, failed: shortlist.length - scored.length });
    } catch (e) {
      $("progress").hidden = true;
      err.textContent = e.message || String(e);
      $("empty").hidden = false;
    } finally {
      state.running = false;
      $("go").disabled = false;
    }
  }

  // ------------------------------------------------------------------ wire up
  document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
    state.mode = b.dataset.mode;
    document.querySelectorAll(".seg-btn").forEach((x) => {
      x.classList.toggle("active", x === b);
      x.setAttribute("aria-selected", String(x === b));
    });
    $("mode-upload").hidden = state.mode !== "upload";
    $("mode-type").hidden = state.mode !== "type";
  }));
  $("file").addEventListener("change", (e) => onFile(e.target.files[0]));
  const drop = $("drop");
  ["dragenter", "dragover"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); }));
  ["dragleave", "drop"].forEach((t) => drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
  drop.addEventListener("drop", (e) => onFile(e.dataTransfer.files[0]));
  $("form").addEventListener("submit", run);
  $("show-sources").addEventListener("click", showSources);
  $("freshness").addEventListener("click", showSources);
  const saved = store.get(KEY_STORE);
  if (saved) { $("apikey").value = saved; $("remember").checked = true; }

  loadJobs();
})();
