"use strict";
// Comfy Remote web app: renders the workflow fields from /api/schema, sends jobs, follows them live.

const $ = (s, el = document) => el.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;          // CSSOM, so the strict CSP allows it
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "html") el.innerHTML = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(kid));
  return el;
};
const ICON = {
  x: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6L6 18"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};
const store = {
  get(k, d) { try { const v = localStorage.getItem("cr." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("cr." + k, JSON.stringify(v)); } catch { /* private mode */ } },
};

// Opened from GitHub Pages, the page talks to the PC's tunnel address (from config.json, kept current by the PC)
// and signs requests with a token; opened from the tunnel link itself, it's same-origin with a cookie.
const ON_PAGES = location.hostname.endsWith("github.io");
let API = "";
const token = {
  get() { try { return localStorage.getItem("cr.token") || sessionStorage.getItem("cr.token"); } catch { return null; } },
  set(t, remember) { try { (remember ? localStorage : sessionStorage).setItem("cr.token", t); } catch { /* private mode */ } },
  clear() { try { localStorage.removeItem("cr.token"); sessionStorage.removeItem("cr.token"); } catch { /* ignore */ } },
};
function authHeaders() { const t = ON_PAGES && token.get(); return t ? { Authorization: "Bearer " + t } : {}; }
async function loadApiBase() {
  if (!ON_PAGES) return;
  const r = await fetch("config.json?t=" + Date.now(), { cache: "no-store" });
  API = (await r.json()).api.replace(/\/$/, "");
}
async function authFetch(path) {
  return fetch(API + path, { headers: authHeaders(), credentials: ON_PAGES ? "omit" : "same-origin" });
}
const blobs = new Map();
async function authSrc(img, path, cache = true) {
  if (!ON_PAGES) { img.src = path; return; }
  if (cache && blobs.has(path)) { img.src = blobs.get(path); return; }
  try {
    const r = await authFetch(path);
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    if (cache) blobs.set(path, url);
    else { if (img.dataset.blob) URL.revokeObjectURL(img.dataset.blob); img.dataset.blob = url; }
    img.src = url;
  } catch { /* offline */ }
}
const authImg = (path, attrs = {}) => { const img = h("img", { alt: "", ...attrs }); authSrc(img, path); return img; };

async function api(path, opts = {}) {
  const init = { method: opts.method || "GET", headers: { "X-CR": "1", ...authHeaders() }, credentials: ON_PAGES ? "omit" : "same-origin" };
  if (opts.json !== undefined) { init.method = opts.method || "POST"; init.headers["Content-Type"] = "application/json"; init.body = JSON.stringify(opts.json); }
  if (opts.form) { init.method = "POST"; init.body = opts.form; }
  let r;
  try { r = await fetch(API + path, init); } catch { throw new Error("Can't reach your PC right now"); }
  let data = {};
  try { data = await r.json(); } catch { /* empty */ }
  if (r.status === 401 && path !== "/api/login") { token.clear(); showLogin(); throw new Error("Please sign in again"); }
  if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status})`);
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ------------------------------------------------------------ login */
function showLogin() { $("#app").hidden = true; $("#login").hidden = false; stopPolling(); setTimeout(() => $("#pw").focus(), 50); }
$("#login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector("button"); btn.disabled = true; $("#login-error").textContent = "";
  try {
    const res = await api("/api/login", { json: { password: $("#pw").value, remember: $("#remember").checked } });
    if (ON_PAGES && res.token) token.set(res.token, $("#remember").checked);
    $("#pw").value = ""; await boot();
  } catch (err) { $("#login-error").textContent = err.message; }
  btn.disabled = false;
});

/* ------------------------------------------------------------ state */
let S = null;                // schema
let wf = store.get("wf", "anime");
const values = {};           // per workflow
let state = { online: false, jobs: [] };
const seenDone = new Set();
let firstPoll = true;            // jobs that were already done when the page opened don't buzz

function defaults(w) { const o = {}; for (const f of S.workflows[w].fields) o[f.id] = structuredClone(f.default); return o; }
function loadValues(w) {
  const saved = store.get("values." + w, {});
  const v = defaults(w);
  for (const f of S.workflows[w].fields) if (f.id in saved && f.type !== "image" && f.type !== "images") v[f.id] = saved[f.id];
  return v;
}
function saveValues() {
  const v = { ...values[wf] };
  store.set("values." + wf, v);
}
const visible = (f, v) => Object.entries(f.show || {}).every(([k, vals]) => vals.includes(String(v[k])));
const pick = (f, key, v) => (f[key + "_by"] && f[key + "_by"].mode && f[key + "_by"].mode[v.mode]) || f[key];

/* ------------------------------------------------------------ form rendering */
function renderTabs() {
  const tabs = $("#tabs"); tabs.replaceChildren();
  for (const [id, w] of Object.entries(S.workflows)) {
    tabs.append(h("button", { class: "tab", type: "button", role: "tab", "aria-selected": String(id === wf),
      onclick: () => { wf = id; store.set("wf", wf); renderTabs(); renderForm(); } },
      h("b", {}, w.label), h("small", {}, w.model)));
  }
}

function renderForm() {
  const v = values[wf], form = $("#form");
  const open = new Set([...form.querySelectorAll("details[open]")].map((d) => d.dataset.group));
  form.replaceChildren();
  const groups = {};
  for (const f of S.workflows[wf].fields) {
    if (!visible(f, v)) continue;
    (groups[f.group] = groups[f.group] || []).push(f);
  }
  for (const [g, title] of Object.entries(S.groups)) {
    const fields = groups[g]; if (!fields) continue;
    const els = fields.map((f) => fieldEl(f, v));
    if (!title) { form.append(...els); continue; }
    const active = activeCount(g, fields, v);
    const det = h("details", { class: "group", "data-group": g, open: open.has(g) || store.get("open." + wf + "." + g, false) },
      h("summary", {}, title, active ? h("span", { class: "count" }, `${active} on`) : null),
      h("div", { class: "group-body" }, ...els));
    det.addEventListener("toggle", () => store.set("open." + wf + "." + g, det.open));
    form.append(det);
  }
  if (groups.advanced) {
    $(".group[data-group=advanced] .group-body", form)?.append(
      h("button", { class: "btn ghost", type: "button", onclick: () => { values[wf] = { ...defaults(wf), ...pickUploads(values[wf]) }; saveValues(); renderForm(); toast("Settings reset"); } }, "Reset all settings to your workflow's defaults"));
  }
}
function pickUploads(v) { const o = {}; for (const f of S.workflows[wf].fields) if (f.type === "image" || f.type === "images") o[f.id] = v[f.id]; return o; }
function activeCount(g, fields, v) {
  if (g === "refs") return fields.filter((f) => v[f.id]).length;
  if (g === "loras") return fields.filter((f) => v[f.id] && v[f.id].on).length;
  if (g === "quality") return fields.filter((f) => v[f.id] === true).length;
  return 0;
}

function set(id, val, rerender = false) {
  values[wf][id] = val; saveValues();
  if (rerender) renderForm();
}

function fieldEl(f, v) {
  const label = pick(f, "label", v), hint = pick(f, "hint", v);
  const wrap = (...kids) => h("div", { class: "field" }, h("span", { class: "field-label" }, label), hint ? h("p", { class: "hint" }, hint) : null, ...kids);
  switch (f.type) {
    case "choice": {
      const box = h("div", { class: "choices", role: "radiogroup" });
      for (const o of f.options) {
        box.append(h("button", { class: "choice", type: "button", role: "radio", "aria-checked": String(String(v[f.id]) === o.value),
          onclick: () => set(f.id, o.value, true) }, h("b", {}, o.label), o.hint ? h("small", {}, o.hint) : null));
      }
      return wrap(box);
    }
    case "size": {
      const box = h("div", { class: "chips", role: "radiogroup" });
      for (const o of f.options) {
        const s = 16 / Math.max(o.w, o.h);
        box.append(h("button", { class: "chip", type: "button", role: "radio", "aria-checked": String(v[f.id] === o.value), onclick: () => set(f.id, o.value, true) },
          h("span", { class: "shape", style: `width:${Math.round(o.w * s)}px;height:${Math.round(o.h * s)}px` }), o.label));
      }
      return wrap(box);
    }
    case "text": {
      const ta = h("textarea", { rows: f.rows || 3, maxlength: f.max, placeholder: f.placeholder || "", spellcheck: "true" });
      ta.value = v[f.id] || "";
      const counter = h("span", { class: "counter" }, "");
      const upd = () => { counter.textContent = ta.value.length > f.max * 0.8 ? `${ta.value.length}/${f.max}` : ""; };
      ta.addEventListener("input", () => { set(f.id, ta.value); upd(); }); upd();
      return wrap(h("div", { class: "textarea-wrap" }, ta, counter));
    }
    case "image": {
      if (f.group === "refs") {
        return h("div", { class: "refrow" }, slotEl(v[f.id], (name) => set(f.id, name, true)),
          h("span", { class: "field-label" }, label), hint ? h("p", { class: "hint" }, hint) : null);
      }
      return wrap(h("div", { class: "slots" }, slotEl(v[f.id], (name) => set(f.id, name, true))));
    }
    case "images": {
      const list = v[f.id] || [], box = h("div", { class: "slots" });
      list.forEach((name, i) => box.append(slotEl(name, (n) => { const l = [...list]; if (n) l[i] = n; else l.splice(i, 1); set(f.id, l, true); }, i + 1)));
      if (list.length < f.max_count) box.append(slotEl(null, (n) => n && set(f.id, [...(values[wf][f.id] || []), n], true), null, true, f.max_count - list.length));
      return wrap(box);
    }
    case "slider": {
      const out = h("span", { class: "value-pill" }, fmt(v[f.id]));
      const r = h("input", { type: "range", min: f.min, max: f.max, step: f.step, value: v[f.id], "aria-label": label });
      r.addEventListener("input", () => { out.textContent = fmt(r.value); set(f.id, Number(r.value)); });
      return h("div", { class: "field" }, h("span", { class: "field-label" }, label, out),
        h("div", { class: "slider-row" }, r, f.ends ? h("div", { class: "slider-ends" }, h("span", {}, f.ends[0]), h("span", {}, f.ends[1])) : null));
    }
    case "number": {
      const inp = h("input", { type: "number", min: f.min, max: f.max, step: f.step, value: v[f.id], inputmode: "decimal", "aria-label": label });
      const clamp = (x) => Math.min(f.max, Math.max(f.min, Math.round(x / f.step) * f.step));
      const bump = (d) => { inp.value = fmt(clamp(Number(inp.value) + d * f.step)); set(f.id, Number(inp.value)); };
      inp.addEventListener("change", () => { inp.value = fmt(clamp(Number(inp.value) || f.min)); set(f.id, Number(inp.value)); });
      return wrap(h("div", { class: "stepper" }, h("button", { type: "button", "aria-label": "Less", onclick: () => bump(-1) }, "−"), inp, h("button", { type: "button", "aria-label": "More", onclick: () => bump(1) }, "+")));
    }
    case "toggle": {
      const cb = h("input", { type: "checkbox", checked: !!v[f.id] });
      cb.addEventListener("change", () => set(f.id, cb.checked, true));
      return h("label", { class: "toggle-row" }, h("span", { class: "txt" }, h("b", {}, label), hint ? h("small", {}, hint) : null), cb, h("span", { class: "switch" }));
    }
    case "lora": {
      const x = v[f.id] || { on: false, name: "", strength: 1 };
      const cb = h("input", { type: "checkbox", checked: !!x.on });
      cb.addEventListener("change", () => set(f.id, { ...values[wf][f.id], on: cb.checked }, true));
      const sel = h("select", { class: "input", "aria-label": label + " file" });
      const names = S.loras.length ? S.loras : [x.name];
      for (const n of names) sel.append(h("option", { value: n, selected: n === x.name }, n.replace(/\.safetensors$/, "")));
      sel.addEventListener("change", () => set(f.id, { ...values[wf][f.id], name: sel.value }));
      const st = h("input", { class: "input", type: "number", step: "0.05", min: "-2", max: "2", value: x.strength, inputmode: "decimal", "aria-label": label + " strength" });
      st.addEventListener("change", () => set(f.id, { ...values[wf][f.id], strength: Number(st.value) }));
      return h("div", { class: "lora" + (x.on ? "" : " off") },
        h("label", { class: "toggle-row" }, h("span", { class: "txt" }, h("b", {}, label)), cb, h("span", { class: "switch" })),
        h("div", { class: "lora-body" }, sel, st));
    }
    case "seed": {
      const inp = h("input", { class: "input", type: "text", inputmode: "numeric", placeholder: "Random", value: v[f.id] ?? "" });
      inp.addEventListener("input", () => { inp.value = inp.value.replace(/\D/g, ""); set(f.id, inp.value); });
      return wrap(inp);
    }
  }
  return h("div");
}
const fmt = (x) => { const n = Number(x); return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0$/, ""); };

function slotEl(name, onChange, num = null, isAdd = false, room = 1) {
  const slot = h("div", { class: "slot" + (name ? " filled" : "") + (isAdd ? " slot-add" : ""), role: "button", tabindex: "0", "aria-label": name ? "Change picture" : "Add picture" });
  const pickFile = () => {
    const inp = h("input", { type: "file", accept: "image/*", multiple: isAdd && room > 1 });
    inp.addEventListener("change", async () => {
      const files = [...inp.files].slice(0, room); if (!files.length) return;
      slot.replaceChildren(h("span", { class: "spin" }));
      for (const file of files) {
        try {
          const fd = new FormData(); fd.append("image", file);
          const r = await api("/api/upload", { form: fd });
          onChange(r.name);
        } catch (e) { toast(e.message); renderForm(); return; }
      }
    });
    inp.click();
  };
  slot.addEventListener("click", (e) => { if (!e.target.closest(".x")) pickFile(); });
  slot.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pickFile(); } });
  if (name) {
    slot.append(authImg("/api/upload/" + encodeURIComponent(name)),
      h("button", { class: "x", type: "button", "aria-label": "Remove", html: ICON.x, onclick: (e) => { e.stopPropagation(); onChange(null); } }));
    if (num) slot.append(h("span", { class: "num" }, String(num)));
  } else {
    slot.innerHTML = ICON.plus;
    slot.append(h("span", { style: "position:absolute;bottom:10px;left:0;right:0" }, isAdd && room > 1 ? "Add photos" : "Add"));
  }
  return slot;
}

/* ------------------------------------------------------------ generate */
$("#generate").addEventListener("click", async () => {
  const btn = $("#generate"); btn.disabled = true; $("#gen-error").textContent = "";
  try {
    const v = { ...values[wf] };
    for (const f of S.workflows[wf].fields) if (f.type === "seed" && v[f.id] === "") v[f.id] = "";
    await api("/api/generate", { json: { workflow: wf, values: v } });
    if (navigator.vibrate) navigator.vibrate(15);
    await poll(true);
    if (innerWidth < 960) $(".results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (e) { $("#gen-error").textContent = e.message; }
  btn.disabled = false;
});

/* ------------------------------------------------------------ live jobs */
let pollTimer = null;
function stopPolling() { clearTimeout(pollTimer); pollTimer = null; }
async function poll(once = false) {
  clearTimeout(pollTimer);
  try { state = await api("/api/state"); renderStatus(); renderJobs(); } catch (e) { if (!$("#app").hidden) renderStatus(true); }
  if ($("#app").hidden) return;
  const active = state.jobs && state.jobs.some((j) => j.status === "queued" || j.status === "running");
  pollTimer = setTimeout(poll, active ? 1000 : document.hidden ? 15000 : 4000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && !$("#app").hidden) { document.title = "Comfy Remote"; poll(); } });

function renderStatus(err = false) {
  const st = $("#status"), txt = $("span", st);
  st.className = "status " + (err || !state.online ? "off" : state.busy ? "busy" : "ok");
  txt.textContent = err ? "No connection" : !state.online ? (state.starting ? "Starting…" : "PC offline") : state.busy ? `Working · ${state.busy}` : "Ready";
  $("#offline").hidden = err || state.online;
  $("#offline-sub").textContent = state.starting ? "Starting up — this takes about a minute." : "Start it to generate images.";
  $("#start-comfy").disabled = !!state.starting;
  $("#settings-status").textContent = err ? "Can't reach the app." : state.online ? (state.busy ? `ComfyUI is running · ${state.busy} job(s) in line.` : "ComfyUI is running and idle.") : state.starting ? "ComfyUI is starting…" : "ComfyUI is not running.";
}

const STATUS_TEXT = { queued: "Waiting", running: "Generating", done: "Done", error: "Failed", cancelled: "Cancelled" };
const jobCards = new Map();
function renderJobs() {
  const box = $("#jobs");
  const jobs = (state.jobs || []).filter((j) => j.status !== "cancelled" || Date.now() / 1000 - (j.finished || 0) < 20).slice().reverse().slice(0, 6);
  if (!jobs.length) { box.replaceChildren(h("p", { class: "empty muted" }, "Your images will show up here.")); jobCards.clear(); return; }
  const keep = new Set();
  for (const j of jobs) {
    keep.add(j.id);
    let card = jobCards.get(j.id);
    if (!card) { card = buildJobCard(j); jobCards.set(j.id, card); }
    updateJobCard(card, j);
    if (j.status === "done" && !seenDone.has(j.id)) {
      seenDone.add(j.id);
      if (firstPoll) continue;
      toast("Image ready");
      if (document.hidden) document.title = "✓ Image ready · Comfy Remote";
      if (navigator.vibrate) navigator.vibrate([30, 60, 30]);
      loadRecent();
    }
  }
  firstPoll = false;
  for (const id of [...jobCards.keys()]) if (!keep.has(id)) jobCards.delete(id);
  box.replaceChildren(...jobs.map((j) => jobCards.get(j.id)));
}
function buildJobCard(j) {
  const card = h("div", { class: "job" });
  card._thumb = h("button", { class: "job-thumb", type: "button", "aria-label": "Open" });
  card._title = h("b"); card._time = h("span", { class: "muted" });
  card._sum = h("p", { class: "job-sum" }, j.summary || "(no prompt)");
  card._bar = h("div", { class: "bar" }, h("i"));
  card._actions = h("div", { class: "job-actions" });
  card.append(card._thumb, h("div", { class: "job-main" }, h("div", { class: "job-top" }, card._title, card._time), card._sum, card._bar, card._actions));
  return card;
}
function updateJobCard(card, j) {
  const wfName = (S.workflows[j.workflow] || {}).label || j.workflow;
  card.className = "job" + (j.status === "error" ? " error" : "");
  let t = `${STATUS_TEXT[j.status] || j.status} · ${wfName}`;
  if (j.status === "queued") t = j.ahead ? `Waiting · ${j.ahead} ahead` : "Starting…";
  if (j.status === "running") t = `Generating · ${Math.round((j.progress || 0) * 100)}%`;
  card._title.textContent = t;
  card._time.textContent = timeAgo(j.created);
  if (j.status === "error") card._sum.textContent = j.error || "Something went wrong.";
  const active = j.status === "queued" || j.status === "running";
  card._bar.hidden = !active;
  card._bar.className = "bar" + (j.status === "queued" || !j.progress ? " wait" : "");
  if (j.progress) $("i", card._bar).style.width = Math.max(4, j.progress * 100) + "%";
  // thumbnail: live preview while running, result when done
  if (active && j.has_preview) {
    let img = $("img", card._thumb);
    if (!img) { img = h("img", { alt: "" }); card._thumb.replaceChildren(img); }
    if (ON_PAGES) authSrc(img, `/api/preview/${j.id}?t=${Date.now()}`, false);
    else { const pre = new Image(); pre.onload = () => (img.src = pre.src); pre.src = `/api/preview/${j.id}?t=${Date.now()}`; }
  } else if (j.status === "done" && j.images && card._doneFor !== j.id) {
    card._doneFor = j.id;
    card._thumb.replaceChildren(authImg(`/api/image/${j.id}/0?thumb=1`));
    card._thumb.onclick = () => openViewer([{ id: j.id, n: j.images, summary: j.summary, workflow: j.workflow }], 0);
  } else if (active && !$("img", card._thumb)) {
    card._thumb.replaceChildren(h("span", { class: "slot" }, h("span", { class: "spin" })));
    $(".slot", card._thumb).style.cssText = "border:0;width:100%;height:100%";
  }
  const acts = [];
  if (active) acts.push(h("button", { class: "btn", type: "button", onclick: async () => { try { await api(`/api/cancel/${j.id}`, { json: {} }); poll(); } catch (e) { toast(e.message); } } }, "Cancel"));
  if (j.status === "done" && j.images > 1) {
    const strip = h("div", { class: "job-images" });
    for (let i = 1; i < j.images; i++) strip.append(h("button", { type: "button", onclick: () => openViewer([{ id: j.id, n: j.images, summary: j.summary, workflow: j.workflow }], i) }, authImg(`/api/image/${j.id}/${i}?thumb=1`)));
    acts.push(strip);
  }
  if (card._actKey !== j.status + j.images) { card._actKey = j.status + j.images; card._actions.replaceChildren(...acts); }
}
function timeAgo(ts) {
  const s = Math.max(0, Date.now() / 1000 - ts);
  if (s < 60) return "just now"; if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago"; return new Date(ts * 1000).toLocaleDateString();
}

/* ------------------------------------------------------------ gallery & viewer */
async function loadRecent() {
  try {
    const r = await api("/api/history");
    const grid = $("#recent"); grid.replaceChildren();
    const flat = flatten(r.items).slice(0, 12);
    flat.forEach((it, i) => grid.append(thumbBtn(it, () => openViewer(flat, i, true))));
  } catch { /* offline */ }
}
function flatten(items) { const out = []; for (const x of items) for (let i = 0; i < x.images; i++) out.push({ ...x, idx: i }); return out; }
function thumbBtn(it, onclick) { return h("button", { type: "button", onclick, "aria-label": "Open image" }, authImg(`/api/image/${it.id}/${it.idx}?thumb=1`, { loading: "lazy" })); }

let galleryItems = [], galleryBefore = null;
async function openGallery() {
  $("#gallery").hidden = false; galleryItems = []; galleryBefore = null; $("#gallery-grid").replaceChildren();
  await moreGallery();
}
async function moreGallery() {
  const r = await api("/api/history" + (galleryBefore ? `?before=${galleryBefore}` : ""));
  if (r.items.length) galleryBefore = r.items[r.items.length - 1].created;
  const add = flatten(r.items), start = galleryItems.length;
  galleryItems.push(...add);
  add.forEach((it, i) => $("#gallery-grid").append(thumbBtn(it, () => openViewer(galleryItems, start + i, true))));
  $("#gallery-more").hidden = r.items.length < 40;
  if (!galleryItems.length) $("#gallery-grid").replaceChildren(h("p", { class: "empty muted", style: "grid-column:1/-1" }, "Nothing here yet."));
}
$("#open-gallery").addEventListener("click", openGallery);
$("#see-all").addEventListener("click", openGallery);
$("#gallery-more").addEventListener("click", moreGallery);

let V = { list: [], i: 0 };
function openViewer(list, i, flat = false) {
  V.list = flat ? list : list.flatMap((x) => Array.from({ length: x.n }, (_, k) => ({ ...x, idx: k })));
  V.i = flat ? i : i; show();
  $("#viewer").hidden = false;
}
function show() {
  const it = V.list[V.i]; if (!it) return;
  $("#viewer-img").removeAttribute("src");
  authSrc($("#viewer-img"), `/api/image/${it.id}/${it.idx}`);
  $("#viewer-download").href = ON_PAGES ? "#" : `/api/image/${it.id}/${it.idx}?download=1`;
  $("#viewer-caption").textContent = it.summary || "";
  $("#viewer-count").textContent = V.list.length > 1 ? `${V.i + 1} / ${V.list.length}` : "";
  $("#viewer-prev").hidden = V.i === 0; $("#viewer-next").hidden = V.i >= V.list.length - 1;
  $("#viewer-reuse").hidden = !it.values;
}
const step = (d) => { V.i = Math.min(V.list.length - 1, Math.max(0, V.i + d)); show(); };
$("#viewer-prev").addEventListener("click", () => step(-1));
$("#viewer-next").addEventListener("click", () => step(1));
let touchX = null;
$(".viewer-stage").addEventListener("touchstart", (e) => (touchX = e.touches[0].clientX), { passive: true });
$(".viewer-stage").addEventListener("touchend", (e) => { if (touchX == null) return; const dx = e.changedTouches[0].clientX - touchX; if (Math.abs(dx) > 50) step(dx < 0 ? 1 : -1); touchX = null; });
document.addEventListener("keydown", (e) => {
  if ($("#viewer").hidden) { if (e.key === "Escape") closeSheets(); return; }
  if (e.key === "ArrowLeft") step(-1); else if (e.key === "ArrowRight") step(1); else if (e.key === "Escape") $("#viewer").hidden = true;
});
$("#viewer-download").addEventListener("click", async (e) => {
  if (!ON_PAGES) return;
  e.preventDefault();
  const it = V.list[V.i];
  try {
    const r = await authFetch(`/api/image/${it.id}/${it.idx}?download=1`);
    const name = (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || "comfy.png";
    const a = h("a", { href: URL.createObjectURL(await r.blob()), download: name });
    document.body.append(a); a.click(); a.remove();
  } catch (err) { toast(err.message); }
});
$("#viewer-reuse").addEventListener("click", () => {
  const it = V.list[V.i]; if (!it.values) return;
  wf = it.workflow; store.set("wf", wf);
  values[wf] = { ...loadValues(wf), ...it.values }; saveValues();
  closeAll(); renderTabs(); renderForm(); toast("Settings loaded"); scrollTo({ top: 0, behavior: "smooth" });
});
$("#viewer-use").addEventListener("click", async () => {
  // send the image back in as an upload, then drop it into the first photo slot of the current workflow
  const it = V.list[V.i];
  try {
    const blob = await (await authFetch(`/api/image/${it.id}/${it.idx}`)).blob();
    const fd = new FormData(); fd.append("image", blob, "result.png");
    const r = await api("/api/upload", { form: fd });
    const v = values[wf];
    if (wf === "anime") { v.mode = "restyle"; v.source = r.name; }
    else { if (!["3", "4", "5", "2"].includes(String(v.mode))) v.mode = "3"; v.refs = [r.name, ...(v.refs || [])].slice(0, 10); }
    saveValues(); closeAll(); renderForm(); toast("Added as your photo"); scrollTo({ top: 0, behavior: "smooth" });
  } catch (e) { toast(e.message); }
});

/* ------------------------------------------------------------ sheets & settings */
function closeSheets() { $("#gallery").hidden = true; $("#settings").hidden = true; }
function closeAll() { closeSheets(); $("#viewer").hidden = true; }
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { if (b.closest(".viewer")) $("#viewer").hidden = true; else closeSheets(); }));
$("#open-settings").addEventListener("click", () => { $("#settings").hidden = false; });
$("#status").addEventListener("click", () => { $("#settings").hidden = false; });
async function startComfy() {
  try { await api("/api/comfy/start", { json: {} }); toast("Starting ComfyUI — about a minute"); poll(); } catch (e) { toast(e.message); }
}
$("#start-comfy").addEventListener("click", startComfy);
$("#settings-start").addEventListener("click", startComfy);
$("#settings-free").addEventListener("click", async () => { try { await api("/api/comfy/free", { json: {} }); toast("GPU memory freed"); } catch (e) { toast(e.message); } });
$("#logout").addEventListener("click", async () => { try { await api("/api/logout", { json: {} }); } catch { /* ignore */ } token.clear(); closeAll(); showLogin(); });
$("#logout-all").addEventListener("click", async () => {
  if (!confirm("Sign out on every device, including this one?")) return;
  try { await api("/api/logout-all", { json: {} }); } catch { /* ignore */ } token.clear(); closeAll(); showLogin();
});
$("#pw-form").addEventListener("submit", async (e) => {
  e.preventDefault(); const msg = $("#pw-msg");
  try {
    const res = await api("/api/password", { json: { old: $("#pw-old").value, new: $("#pw-new").value } });
    if (ON_PAGES && res.token) token.set(res.token, true);
    msg.textContent = "Password changed. Other devices were signed out."; e.target.reset();
  } catch (err) { msg.textContent = err.message; }
});

/* ------------------------------------------------------------ boot */
function showDown() {
  $("#app").hidden = true; $("#login").hidden = true; $("#down").hidden = false; stopPolling();
}
$("#retry").addEventListener("click", () => { $("#down").hidden = true; boot().catch(showDown); });

async function boot() {
  await loadApiBase();
  const me = await api("/api/me");
  if (!me.logged_in) return showLogin();
  S = await api("/api/schema");
  if (!S.workflows[wf]) wf = Object.keys(S.workflows)[0];
  for (const w of Object.keys(S.workflows)) values[w] = loadValues(w);
  $("#login").hidden = true; $("#app").hidden = false;
  renderTabs(); renderForm(); loadRecent(); poll();
  if (!S.loras.length) setTimeout(async () => { try { const s2 = await api("/api/schema"); if (s2.loras.length) { S.loras = s2.loras; renderForm(); } } catch { /* later */ } }, 5000);
}
boot().catch(showDown);
