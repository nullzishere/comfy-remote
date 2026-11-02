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

// Colour themes (app.css :root[data-theme]). The account's choice is saved on the PC; this device remembers the last
// one so the page doesn't flash the default colours while it loads. [id, name, background, accent, accent 2]
const THEMES = [["chrome", "Chrome", "#0b0a12", "#8b5cff", "#ff5cae"], ["dark", "Dark", "#0e0e10", "#e4e4e7", "#a1a1aa"],
  ["light", "Light", "#f5f4fa", "#7446f5", "#e2407f"], ["midnight", "Midnight blue", "#060a18", "#4d7cff", "#35d4ff"],
  ["terminal", "Terminal", "#040704", "#39ff6a", "#b4ff3a"], ["minion", "Minion", "#0b2556", "#ffd60a", "#ffe866"]];
function applyTheme(id) {
  const t = THEMES.find((x) => x[0] === id) || THEMES[0];
  document.documentElement.dataset.theme = t[0];
  document.querySelector('meta[name="theme-color"]').setAttribute("content", t[2]);
  store.set("theme", t[0]);
}
applyTheme(store.get("theme", "chrome"));

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
let firstPoll = true;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => 1 - Math.pow(1 - t, 3);
let ME = { name: "", role: "owner", prefs: { level: "dev", theme: "chrome" } };

/* How much of the app an account sees (picked on a friend's first visit, changeable in Settings):
   normal = guided prompt + simple pickers, power = everything but the expert knobs, dev = every knob. */
const LEVELS = {
  normal: { title: "Simple", hint: "Describe what you want and we help write the prompt. Just the essentials." },
  power: { title: "Power", hint: "LoRAs, reference pictures, quality and add-ons. Expert knobs stay hidden." },
  dev: { title: "Dev", hint: "Every knob: models, samplers, schedulers, steps, CFG and more." },
};
const HIDE_GROUPS = { normal: new Set(["refs", "loras", "sampling", "refine", "detail", "control"]),
  power: new Set(["sampling", "refine", "detail", "control"]), dev: new Set() };
const level = () => (ME.prefs && ME.prefs.level) || "dev";
const SIMPLE_SLOTS = [["character", "Character", "Draw a known character"], ["style", "Art style", "Draw it in a show's or artist's style"]];
const guideStep = (n, title, hint) => h("div", { class: "guide-step" }, h("span", { class: "step-num" }, String(n)), h("div", {}, h("b", {}, title), h("p", { class: "hint" }, hint)));

function simpleLoras() {                              // Simple level: the first two LoRA slots as Character / Art style pickers
  const w = S.workflows[wf], kinds = w.lora_kinds || {}, labels = w.lora_labels || {};
  const slots = w.fields.filter((f) => f.type === "lora");
  return SIMPLE_SLOTS.map(([kind, title, hint], i) => {
    const f = slots[i]; if (!f) return null;
    const names = (f.options || w.loras || []).filter((n) => kinds[n] === kind).sort((a, b) => (labels[a] || a).localeCompare(labels[b] || b));
    if (!names.length) return null;
    const x = values[wf][f.id] || {}, cur = x.on && names.includes(x.name) ? x.name : null;
    const chip = (label, on, onclick) => h("button", { class: "tg-chip", type: "button", role: "radio", "aria-checked": String(on), onclick }, label);
    return h("div", { class: "field" }, h("span", { class: "field-label" }, title), h("p", { class: "hint" }, hint),
      h("div", { class: "chips wrap", role: "radiogroup" }, chip("None", !cur, () => setLora(f.id, { on: false })),
        ...names.map((n) => chip(labels[n] || n, cur === n, () => setLora(f.id, cur === n ? { on: false } : { on: true, name: n, strength: 1, pick: {} })))),
      cur ? loraTriggers(f.id, x) : null);
  }).filter(Boolean);
}

/* After switching to a level that hides things: put hidden settings back to the workflow's defaults (so nothing you
   can't see changes your images), switch off LoRAs it can't show, then let the add-ons re-apply their settings. */
function tidyForLevel() {
  const hide = HIDE_GROUPS[level()], keep = wf;
  for (const w of Object.keys(S.workflows)) {
    wf = w;
    const d = defaults(w), v = values[w], fields = S.workflows[w].fields, kinds = S.workflows[w].lora_kinds || {};
    const slots = fields.filter((f) => f.type === "lora");
    for (const f of fields) {
      if (!hide.has(f.group)) continue;
      if (f.type === "lora") {
        const x = v[f.id] || {}, i = slots.indexOf(f);
        const simpleOk = level() === "normal" && i < SIMPLE_SLOTS.length && kinds[x.name] === SIMPLE_SLOTS[i][0];
        if (x.on && !simpleOk) { v.prompt = editTags(v.prompt, x.added || [], []); v[f.id] = { ...x, on: false, added: [] }; }
      } else if (f.type !== "image" && f.type !== "images" || level() === "normal") v[f.id] = structuredClone(d[f.id]);
    }
    for (const f of fields) if (f.id === "speed" || (f.group === "addons" && f.type === "choice")) applyAddons(f);
    saveValues();
  }
  wf = keep;
  store.set("tidied", level());
}

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
const visible = (f, v) => Object.entries(f.show || {}).every(([k, vals]) => vals.map(String).includes(String(v[k])));
const pick = (f, key, v) => (f[key + "_by"] && f[key + "_by"].mode && f[key + "_by"].mode[v.mode]) || f[key];

/* ------------------------------------------------------------ form rendering */
function renderTabs() {
  const tabs = $("#tabs"); tabs.replaceChildren();
  tabs.style.setProperty("--i", Object.keys(S.workflows).indexOf(wf));   // slides the glow under the active tab
  for (const [id, w] of Object.entries(S.workflows)) {
    tabs.append(h("button", { class: "tab", type: "button", role: "tab", "aria-selected": String(id === wf),
      onclick: () => { wf = id; store.set("wf", wf); renderTabs(); renderForm(); } },
      h("b", {}, w.label), h("small", {}, w.model)));
  }
}

function renderForm() {
  for (const f of S.workflows[wf].fields) {          // LoRAs already on (workflow defaults) get their trigger words once
    const x = values[wf][f.id];
    if (f.type === "lora" && x && x.on && !Array.isArray(x.added) && (S.workflows[wf].lora_tags || {})[x.name]) {
      x.added = loraWants(x);
      values[wf].prompt = editTags(values[wf].prompt, [], x.added);
      saveValues();
    }
  }
  const v = values[wf], form = $("#form");
  const open = new Set([...form.querySelectorAll("details[open]")].map((d) => d.dataset.group));
  form.replaceChildren();
  const groups = {};
  for (const f of S.workflows[wf].fields) {
    if (!visible(f, v)) continue;
    (groups[f.group] = groups[f.group] || []).push(f);
  }
  const hide = HIDE_GROUPS[level()];
  for (const [g, title] of Object.entries(S.groups)) {
    const fields = groups[g]; if (!fields || hide.has(g)) continue;
    const els = fields.map((f) => fieldEl(f, v));
    if (g === "main" && level() === "normal") {        // Character / Art style pickers go right under the prompt
      const at = fields.findIndex((f) => f.id === "prompt");
      els.splice(at < 0 ? els.length : at + 1, 0, ...simpleLoras());
    }
    if (!title) { form.append(...els); continue; }
    const active = activeCount(g, fields, v);
    const det = h("details", { class: "group", "data-group": g, open: open.has(g) || store.get("open." + wf + "." + g, false) },
      h("summary", {}, title, active ? h("span", { class: "count" }, `${active} on`) : null),
      h("div", { class: "group-body" }, ...els));
    det.addEventListener("toggle", () => store.set("open." + wf + "." + g, det.open));
    form.append(det);
  }
  form.append(h("button", { class: "btn ghost", type: "button", onclick: () => { values[wf] = { ...defaults(wf), ...pickUploads(values[wf]) }; saveValues(); if (level() !== "dev") tidyForLevel(); renderForm(); toast("Settings reset"); } }, level() === "dev" ? "Reset all settings to your workflow's defaults" : "Start over with the default settings"));
}
function pickUploads(v) { const o = {}; for (const f of S.workflows[wf].fields) if (f.type === "image" || f.type === "images") o[f.id] = v[f.id]; return o; }
function activeCount(g, fields, v) {
  if (g === "refs") return fields.filter((f) => v[f.id]).length;
  if (g === "loras") return fields.filter((f) => v[f.id] && v[f.id].on).length;
  if (g === "quality") return fields.filter((f) => v[f.id] === true).length;
  if (g === "addons") return fields.filter((f) => f.id !== "angle_height" && visible(f, v) && v[f.id] !== "off" && v[f.id] !== false).length;
  return 0;
}

function set(id, val, rerender = false) {
  values[wf][id] = val;
  const f = S.workflows[wf].fields.find((x) => x.id === id);
  if (f && (f.group === "addons" || id === "speed")) applyAddons(f);
  saveValues();
  if (rerender) renderForm();
}
/* Realistic add-ons: picking one switches the settings it needs (o.set) and keeps its trigger words in the prompt. */
function addonTags(v) {
  const tags = [];
  for (const f of S.workflows[wf].fields) {
    if (f.type !== "choice" || !visible(f, v)) continue;
    const o = f.options.find((o) => o.value === String(v[f.id]));
    if (o && o.prompt) tags.push(...o.prompt.map((t) => (f.id === "angle_height" && v.angle_close ? t + " close-up" : t)));
  }
  if (v.phone) tags.push("convert this into a real phone photo");
  return tags;
}
function applyAddons(f) {
  const v = values[wf];
  const o = f.type === "choice" ? f.options.find((o) => o.value === String(v[f.id])) : f.id === "phone" && v.phone ? { set: { mode: "3" } } : null;
  const dflt = defaults(wf);
  for (const [k, val] of Object.entries((o && o.set) || {})) {
    if (k === "mode" && v.mode !== val) toast("Switched to “Edit a photo”: add the photo to change");
    if (k === "speed" && v.speed !== val) toast("Turbo is off: the NSFW add-on needs normal speed");
    v[k] = val === "default" ? dflt[k] : val;
  }
  if (f.id === "speed" && v.speed === "turbo" && v.nsfw && v.nsfw !== "off") toast("Heads up: the NSFW add-on looks bad with Turbo's sampler");
  const key = "addon." + wf, before = store.get(key, []), now = addonTags(v);
  v.prompt = editTags(v.prompt, before, now);
  store.set(key, now);
}

function fieldEl(f, v) {
  const label = pick(f, "label", v), hint = pick(f, "hint", v);
  const wrap = (...kids) => h("div", { class: "field" }, h("span", { class: "field-label" }, label), hint ? h("p", { class: "hint" }, hint) : null, ...kids);
  switch (f.type) {
    case "choice": {
      if (f.compact) {
        const box = h("div", { class: "chips wrap", role: "radiogroup" });
        for (const o of f.options) box.append(h("button", { class: "tg-chip", type: "button", role: "radio", "aria-checked": String(String(v[f.id]) === o.value), title: o.hint || "", onclick: () => set(f.id, o.value, true) }, o.label));
        return wrap(box);
      }
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
      if (wf === "anime" && f.id === "prompt" && level() === "normal") {   // Simple: plain words first, then the tag box
        const [step1, more] = tagger(ta, true);
        ta.placeholder = "Your tags land here, e.g. 1girl, long hair, red eyes, night, rain";
        return h("div", { class: "field guided" },
          guideStep(1, "Describe your picture", "Write it the way you'd say it. We'll turn it into tags, the words the Anime model understands."), step1,
          guideStep(2, "Your prompt", "Tags separated by commas. Edit them, add your own, or tap more below."),
          h("div", { class: "textarea-wrap" }, ta, counter), ratingRow(ta), more);
      }
      const el = wrap(h("div", { class: "textarea-wrap" }, ta, counter));
      if (wf === "anime" && f.id === "prompt") el.append(ratingRow(ta), tagger(ta));   // Illustrious wants Danbooru tags
      return el;
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
      cb.addEventListener("change", () => setLora(f.id, { on: cb.checked }));
      const sel = h("select", { class: "input", "aria-label": label + " file" });
      const avail = f.options || S.workflows[wf].loras || [];
      const labels = S.workflows[wf].lora_labels || {}, nice = (n) => labels[n] || n.replace(/\.safetensors$/, "");
      const names = (avail.length ? [...avail] : [x.name]).sort((a, b) => nice(a).localeCompare(nice(b)));
      for (const n of names) sel.append(h("option", { value: n, selected: n === x.name }, nice(n)));
      sel.addEventListener("change", () => setLora(f.id, { name: sel.value, pick: {} }));
      const st = h("input", { class: "input", type: "number", step: "0.05", min: "-2", max: "2", value: x.strength, inputmode: "decimal", "aria-label": label + " strength" });
      st.addEventListener("change", () => set(f.id, { ...values[wf][f.id], strength: Number(st.value) }));
      return h("div", { class: "lora" + (x.on ? "" : " off") },
        h("label", { class: "toggle-row" }, h("span", { class: "txt" }, h("b", {}, label)), cb, h("span", { class: "switch" })),
        h("div", { class: "lora-body" }, sel, st), x.on ? loraTriggers(f.id, x) : null);
    }
    case "select": {
      const sel = h("select", { class: "input", "aria-label": label });
      const opts = f.options && f.options.length ? f.options : [v[f.id]];
      for (const o of opts) sel.append(h("option", { value: o, selected: o === v[f.id] }, String(o).replace(/\.(safetensors|pth|ckpt)$/, "")));
      sel.addEventListener("change", () => set(f.id, sel.value));
      return wrap(sel);
    }
    case "seed": {
      const inp = h("input", { class: "input", type: "text", inputmode: "numeric", placeholder: "Random", value: v[f.id] ?? "" });
      inp.addEventListener("input", () => { inp.value = inp.value.replace(/\D/g, ""); set(f.id, inp.value); });
      return wrap(inp);
    }
  }
  return h("div");
}
/* ------------------------------------------------------------ Illustrious prompt helper
   Write it in plain words and the PC's text model turns it into Danbooru tags, or tap/search real tags. */
const PICKS = {
  People: ["1girl", "1boy", "solo", "2girls", "2boys", "multiple girls"],
  Hair: ["long hair", "short hair", "medium hair", "ponytail", "twintails", "black hair", "white hair", "grey hair", "blonde hair", "brown hair", "red hair", "blue hair", "pink hair", "purple hair"],
  Eyes: ["red eyes", "blue eyes", "green eyes", "yellow eyes", "purple eyes", "heterochromia", "glowing eyes"],
  Outfit: ["hoodie", "school uniform", "serafuku", "jacket", "kimono", "armor", "dress", "suit", "t-shirt", "scarf"],
  Face: ["smile", "blush", "open mouth", "closed eyes", "serious", "angry", "crying", "smirk", "expressionless"],
  Pose: ["standing", "sitting", "looking at viewer", "looking back", "looking to the side", "arms crossed", "hand in pocket", "walking", "running"],
  Camera: ["portrait", "upper body", "cowboy shot", "full body", "close-up", "from below", "from above", "from side", "dutch angle", "depth of field"],
  Place: ["outdoors", "indoors", "cityscape", "rooftop", "street", "forest", "classroom", "bedroom", "beach", "simple background", "white background"],
  Light: ["day", "sunset", "night", "night sky", "rain", "snow", "backlighting", "sunlight", "neon lights", "light particles"],
};
const QUALITY_TAGS = "masterpiece, best quality, amazing quality, very aesthetic, absurdres";
const esc = (t) => t.replace(/\\?([()])/g, "\\$1");      // ComfyUI reads (x) as weight: "emilia \(re:zero\)"
const splitTags = (s) => (s || "").split(",").map((t) => t.trim()).filter(Boolean);
function tagger(ta, guided = false) {
  const has =(t) => splitTags(ta.value).some((x) => x.toLowerCase() === esc(t));
  const write = (list) => { ta.value = list.join(", "); ta.dispatchEvent(new Event("input")); refresh(); };
  const toggle = (t) => write(has(t) ? splitTags(ta.value).filter((x) => x.toLowerCase() !== esc(t)) : [...splitTags(ta.value), esc(t)]);
  const addTags = (list) => { const cur = splitTags(ta.value), low = cur.map((x) => x.toLowerCase()); write([...cur, ...list.map(esc).filter((t) => !low.includes(t))]); };

  // 1 · plain words -> tags
  const words = h("textarea", { rows: 2, maxlength: 600, placeholder: "a girl with silver hair on a snowy rooftop at night, looking sad", "aria-label": "Describe it in plain words" });
  try { words.value = sessionStorage.getItem("cr.words") || ""; } catch { /* private mode */ }
  words.addEventListener("input", () => { try { sessionStorage.setItem("cr.words", words.value); } catch { /* ignore */ } });
  const convert = h("button", { class: "btn primary", type: "button" }, "Turn into tags");
  const result = h("div", { class: "tg-result", hidden: true });
  const quality = h("input", { type: "checkbox", checked: true });
  convert.onclick = async () => {
    if (!words.value.trim()) { toast("Describe the picture first"); return; }
    convert.disabled = true; convert.textContent = "Writing tags…";
    try {
      const r = await api("/api/tagify", { json: { text: words.value } });
      const chips = h("div", { class: "tg-chips" });
      let picked = r.tags.map((x) => x.tag);
      r.tags.forEach((x) => {
        const b = h("button", { type: "button", class: "tg-chip" + (x.known ? "" : " unknown"), "aria-pressed": "true", title: x.known ? `${x.count.toLocaleString()} images on Danbooru` : "Not a standard tag, but the model may still get it" }, x.tag);
        b.onclick = () => { const on = b.getAttribute("aria-pressed") !== "true"; b.setAttribute("aria-pressed", String(on)); picked = on ? [...picked, x.tag] : picked.filter((t) => t !== x.tag); };
        chips.append(b);
      });
      result.replaceChildren(
        h("p", { class: "hint" }, "Tap a tag to leave it out. Dashed ones aren't standard tags."), chips,
        h("label", { class: "tg-q" }, quality, h("span", {}, "Start with quality tags")),
        h("div", { class: "row-btns" },
          h("button", { class: "btn primary", type: "button", onclick: () => { const keep = r.tags.map((x) => x.tag).filter((t) => picked.includes(t)).map(esc); write([...(quality.checked ? splitTags(QUALITY_TAGS) : []), ...keep]); write(splitTags(editTags(ta.value, [], activeTriggers()))); toast("Prompt replaced with tags");
            if (guided) { ta.scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" }); ta.classList.remove("flash"); void ta.offsetWidth; ta.classList.add("flash"); } } }, "Use as my prompt"),
          h("button", { class: "btn", type: "button", onclick: () => { addTags(r.tags.map((x) => x.tag).filter((t) => picked.includes(t))); toast("Tags added"); } }, "Add to my prompt")));
      result.hidden = false;
    } catch (e) { toast(e.message); }
    convert.disabled = false; convert.textContent = "Turn into tags";
  };

  // 2 · search the real tag list
  const search = h("input", { class: "input", type: "search", placeholder: "Search tags: hood, sunset, katana…", "aria-label": "Search tags", autocomplete: "off" });
  const sugg = h("div", { class: "tg-sugg" });
  let timer;
  search.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      if (!q) { sugg.replaceChildren(); return; }
      try {
        const r = await api("/api/tags?q=" + encodeURIComponent(q));
        sugg.replaceChildren(...r.tags.map((x) => h("button", { type: "button", class: "tg-s" + (has(x.tag) ? " on" : ""), onclick: (e) => { toggle(x.tag); e.currentTarget.classList.toggle("on", has(x.tag)); } },
          h("span", {}, x.tag), x.via ? h("small", {}, `for "${x.via}"`) : null, h("em", {}, x.cat !== "general" ? x.cat : fmtCount(x.count)))));
      } catch { /* offline */ }
    }, 160);
  });

  // 3 · quick picks
  const picks = h("div", { class: "tg-picks" });
  const pickBtns = [];
  for (const [cat, list] of Object.entries(PICKS)) {
    const lane = h("div", { class: "tg-lane" }, h("b", {}, cat));
    list.forEach((t) => { const b = h("button", { type: "button", class: "tg-chip", onclick: () => toggle(t) }, t); pickBtns.push([t, b]); lane.append(b); });
    picks.append(lane);
  }
  function refresh() { pickBtns.forEach(([t, b]) => b.setAttribute("aria-pressed", String(has(t)))); }
  ta.addEventListener("input", refresh); refresh();

  if (guided) {                                       // Simple level: step 1 is its own card, the rest tucks under the prompt
    return [h("div", { class: "tg-sec guide-box" }, words, convert, result),
      h("details", { class: "tagger" }, h("summary", {}, h("span", { class: "tg-spark" }, "✦"), "Add more tags", h("small", {}, "search or tap")),
        h("div", { class: "tg-body" },
          h("div", { class: "tg-sec" }, h("span", { class: "field-label" }, "Find a tag"), search, sugg),
          h("div", { class: "tg-sec" }, h("span", { class: "field-label" }, "Quick picks"), picks)))];
  }
  const det = h("details", { class: "tagger", open: store.get("tagger.open", false) },
    h("summary", {}, h("span", { class: "tg-spark" }, "✦"), "Prompt helper", h("small", {}, "write normally or tap tags")),
    h("div", { class: "tg-body" },
      h("div", { class: "tg-sec" }, h("span", { class: "field-label" }, "Say it in plain words"), words, convert, result),
      h("div", { class: "tg-sec" }, h("span", { class: "field-label" }, "Find a tag"), search, sugg),
      h("div", { class: "tg-sec" }, h("span", { class: "field-label" }, "Quick picks"), picks)));
  det.addEventListener("toggle", () => store.set("tagger.open", det.open));
  return det;
}
/* Tags the app writes into the prompt for you go right after the quality tags at the start, and come back out
   cleanly: rating tags, and each LoRA's trigger words (x.added remembers which ones that LoRA put there). */
const RATINGS = [["Any", []], ["General", ["general"]], ["Sensitive", ["sensitive"]], ["NSFW", ["nsfw"]], ["Explicit", ["nsfw", "explicit"]]];
const RATING_TAGS = ["general", "sensitive", "questionable", "nsfw", "explicit"];
const LEAD = new Set([...splitTags(QUALITY_TAGS), "newest", "highres", ...RATING_TAGS]);
function editTags(s, remove, add) {
  let parts = (s || "").split(",");
  if (parts.length === 1 && !parts[0].trim()) parts = [];
  const rm = new Set(remove.map((t) => t.toLowerCase()));
  parts = parts.filter((p) => !rm.has(p.trim().toLowerCase()));
  const have = new Set(parts.map((p) => p.trim().toLowerCase()));
  let i = 0;
  while (i < parts.length && LEAD.has(parts[i].trim().toLowerCase())) i++;
  parts.splice(i, 0, ...add.filter((t) => !have.has(t.toLowerCase())).map((t) => " " + t));
  return parts.map((p) => (/^\s/.test(p) ? p : " " + p)).join(",").replace(/^\s+/, "");
}
function ratingRow(ta) {
  const row = h("div", { class: "rating", role: "radiogroup", "aria-label": "Rating" }, h("span", { class: "field-label" }, "Rating"));
  const btns = RATINGS.map(([name, tags]) => {
    const b = h("button", { type: "button", class: "tg-chip", role: "radio" }, name);
    b.onclick = () => { ta.value = editTags(ta.value, RATING_TAGS, tags); ta.dispatchEvent(new Event("input")); };
    row.append(b);
    return b;
  });
  const refresh = () => {
    const have = new Set(splitTags(ta.value).map((t) => t.toLowerCase()));
    const cur = have.has("explicit") ? 4 : have.has("nsfw") ? 3 : have.has("sensitive") ? 2 : have.has("general") ? 1 : 0;
    btns.forEach((b, i) => b.setAttribute("aria-checked", String(i === cur)));
  };
  ta.addEventListener("input", refresh); refresh();
  return row;
}
function loraWants(x) {
  const info = x.on && (S.workflows[wf].lora_tags || {})[x.name];
  if (!info) return [];
  const chosen = info.groups.flatMap((g) => g.options.filter((o) => ((x.pick || {})[g.label] || []).includes(o.label)).flatMap((o) => o.tags));
  return [...new Set([...info.always, ...chosen])];
}
function activeTriggers() {
  return S.workflows[wf].fields.filter((f) => f.type === "lora").flatMap((f) => loraWants(values[wf][f.id] || {}));
}
function setLora(id, change) {
  const old = values[wf][id] || {}, x = { ...old, ...change };
  x.added = loraWants(x);
  values[wf].prompt = editTags(values[wf].prompt, old.added || [], x.added);     // re-added in order: trigger first
  set(id, x, true);
}
function loraTriggers(id, x) {
  const info = (S.workflows[wf].lora_tags || {})[x.name];
  if (!info) return null;
  const pick = x.pick || {};
  const choose = (g, t) => {
    const cur = pick[g.label] || [];
    const next = g.one ? (cur.includes(t) || !t ? [] : [t]) : cur.includes(t) ? cur.filter((y) => y !== t) : [...cur, t];
    setLora(id, { pick: { ...pick, [g.label]: next } });
  };
  return h("div", { class: "lora-trig" },
    info.always.length ? h("p", { class: "hint" }, "Adds to your prompt: ", h("b", {}, info.always.join(", ").replace(/\\/g, ""))) : null,
    ...info.groups.map((g) => h("div", { class: "tg-lane" }, h("b", {}, g.label),
      g.one ? h("button", { type: "button", class: "tg-chip", "aria-pressed": String(!(pick[g.label] || []).length), onclick: () => choose(g, null) }, "Default") : null,
      ...g.options.map((o) => h("button", { type: "button", class: "tg-chip", title: o.tags.join(", ").replace(/\\/g, ""), "aria-pressed": String((pick[g.label] || []).includes(o.label)), onclick: () => choose(g, o.label) }, o.label)))));
}
const fmtCount = (n) => n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
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
    if (innerWidth < 960) $("#stage").scrollIntoView({ behavior: REDUCED ? "auto" : "smooth", block: "center" });
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
  $("#start-comfy").hidden = ME.role !== "owner";
  if (!state.online && ME.role !== "owner") $("#offline-sub").textContent = "Ask the owner to start it.";
  const q = $("#quota"), me = state.me || {};
  if (q) {
    const parts = [];
    let out = false;
    if (me.role === "friend" && me.limit) {
      const left = Math.max(0, me.limit - (me.used || 0)); out ||= !left;
      parts.push(left ? `${left} of ${me.limit} left today` : `All ${me.limit} used today, more at midnight`);
    }
    if (me.role === "friend" && me.hourly) {
      const left = Math.max(0, me.hourly - (me.used_hour || 0)); out ||= !left;
      parts.push(left ? `${left} of ${me.hourly} left this hour` : `Hourly limit reached, try again soon`);
    }
    q.textContent = parts.join(" · ");
    q.className = "quota" + (out ? " out" : "");
  }
  $("#settings-status").textContent = err ? "Can't reach the app." : state.online ? (state.busy ? `ComfyUI is running · ${state.busy} job(s) in line.` : "ComfyUI is running and idle.") : state.starting ? "ComfyUI is starting…" : "ComfyUI is not running.";
}

const STATUS_TEXT = { queued: "Waiting", running: "Generating", done: "Done", error: "Failed", cancelled: "Cancelled" };
const jobCards = new Map();
function renderJobs() {
  const box = $("#jobs");
  const jobs = (state.jobs || []).filter((j) => j.status !== "cancelled" || Date.now() / 1000 - (j.finished || 0) < 20).slice().reverse().slice(0, 6);
  renderStage();
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
  card._time.replaceChildren(j.by ? h("span", { class: "by" }, j.by + " · ") : "", timeAgo(j.created));
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
    card._thumb.onclick = () => openViewer([{ id: j.id, n: j.images, summary: j.summary, workflow: j.workflow, by: j.by }], 0);
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
/* ------------------------------------------------------------ render stage
   The latest job gets the big frame: a halo ring spins round it while the PC works, the live preview is drawn
   blocky at early sampler steps and sharper as they climb, and the finished image resolves step by step. */
const STAGE = { id: null, done: false, busy: false, steps: 25, frac: 0 };
const PHASE = { detail: "FIXING DETAILS", upscale: "UPSCALING", decode: "DECODING", think: "REWRITING PROMPT", work: "WORKING" };
async function loadBitmap(path) {
  const r = await authFetch(path);
  if (!r.ok) throw new Error("image");
  const blob = await r.blob();
  if (window.createImageBitmap) return createImageBitmap(blob);
  const im = new Image(), url = URL.createObjectURL(blob);
  await new Promise((ok, no) => { im.onload = ok; im.onerror = no; im.src = url; });
  return im;
}
function drawStep(img, frac) {
  const cv = $("#stage-cv"), box = $("#stage-in"), dpr = devicePixelRatio || 1;
  const W = Math.round(box.clientWidth * dpr), H = Math.round(box.clientHeight * dpr);
  if (!W || !H) return;
  if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
  const cx = cv.getContext("2d"), tar = W / H, iw = img.width, ih = img.height;
  let sw = iw, sh = ih, sx = 0, sy = 0;
  if (iw / ih > tar) { sw = ih * tar; sx = (iw - sw) / 2; } else { sh = iw / tar; sy = (ih - sh) / 2; }
  if (frac >= 1) { cx.imageSmoothingEnabled = true; cx.drawImage(img, sx, sy, sw, sh, 0, 0, W, H); return; }
  const res = Math.max(6, Math.round(W * Math.pow(Math.max(0.02, frac), 2.2)));
  const tmp = drawStep.tmp || (drawStep.tmp = document.createElement("canvas"));
  tmp.width = res; tmp.height = Math.max(6, Math.round(res / tar));
  tmp.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, tmp.width, tmp.height);
  cx.imageSmoothingEnabled = false; cx.clearRect(0, 0, W, H); cx.drawImage(tmp, 0, 0, W, H);
}
function renderStage() {
  const jobs = state.jobs || [], j = jobs[jobs.length - 1];
  const st = $("#stage"), cap = $("#stage-cap"), center = $("#stage-center"), stepEl = $("#stage-step");
  if (!j || j.status === "cancelled") { st.hidden = cap.hidden = true; return; }
  st.hidden = cap.hidden = false;
  if (STAGE.id !== j.id) {
    STAGE.id = j.id; STAGE.done = false; STAGE.frac = 0; STAGE.steps = 0;
    const cv = $("#stage-cv"); cv.getContext("2d").clearRect(0, 0, cv.width, cv.height);
    center.hidden = false;
  }
  cap.replaceChildren(h("b", {}, (S.workflows[j.workflow] || {}).label || j.workflow), " · ", j.by ? `${j.by} · ` : "", j.summary || "");
  const active = j.status === "queued" || j.status === "running";
  st.classList.toggle("busy", active);
  st.classList.toggle("done", j.status === "done");
  $("#stage-in").onclick = j.status === "done" ? () => openViewer([{ id: j.id, n: j.images, summary: j.summary, workflow: j.workflow, by: j.by }], 0) : null;
  if (active) {
    const steps = j.step && j.step[1] ? j.step : null, sampling = j.phase === "sample";
    if (steps && sampling) STAGE.steps = Math.max(STAGE.steps, steps[1]);   // the main pass has the most steps
    // the preview only ever gets sharper: later passes (upscale, refine, detailers) don't make it blocky again
    STAGE.frac = Math.max(STAGE.frac, sampling && steps ? steps[0] / steps[1] : STAGE.frac > 0 ? 1 : 0);
    $("#stage-pct").textContent = j.status === "queued" ? (j.ahead ? `${j.ahead} ahead` : "Starting") : `${Math.round((j.progress || 0) * 100)}%`;
    $("#stage-sub").textContent = j.status === "queued" ? "Waiting for your PC" : "Rendering on your PC";
    stepEl.textContent = j.status === "queued" ? "QUEUED" : sampling && steps ? `STEP ${steps[0]}/${steps[1]}`
      : j.phase === "detail" && steps ? `${PHASE.detail} ${steps[0]}/${steps[1]}` : PHASE[j.phase] || PHASE.work;
    if (j.has_preview && !STAGE.busy) {
      STAGE.busy = true;
      loadBitmap(`/api/preview/${j.id}?t=${Date.now()}`).then((im) => {
        if (STAGE.id !== j.id || STAGE.done) return;
        center.hidden = true;
        drawStep(im, STAGE.frac || 1);
      }).catch(() => {}).finally(() => (STAGE.busy = false));
    }
  } else if (j.status === "done" && !STAGE.done) {
    STAGE.done = true;
    stepEl.textContent = "RESOLVING";
    loadBitmap(`/api/image/${j.id}/0?thumb=1`).then((im) => {
      if (STAGE.id !== j.id) return;
      center.hidden = true;
      const total = STAGE.steps || 25, t0 = performance.now(), ms = REDUCED ? 1 : 1300;
      (function tick(t) {
        const p = Math.min(1, (t - t0) / ms);
        drawStep(im, p < 1 ? 0.06 + 0.94 * ease(p) : 1);
        stepEl.textContent = p < 1 ? `STEP ${Math.max(1, Math.round(ease(p) * total))}/${total}` : "DONE · TAP TO OPEN";
        if (p < 1) requestAnimationFrame(tick);
      })(t0);
    }).catch(() => (stepEl.textContent = "DONE · TAP TO OPEN"));
  } else if (j.status === "error") {
    center.hidden = false;
    $("#stage-pct").textContent = "Failed";
    $("#stage-sub").textContent = j.error || "Something went wrong.";
    stepEl.textContent = "ERROR";
  }
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
  $("#viewer-caption").textContent = (it.by ? `by ${it.by} · ` : "") + (it.summary || "");
  $("#viewer-count").textContent = V.list.length > 1 ? `${V.i + 1} / ${V.list.length}` : "";
  $("#viewer-prev").hidden = V.i === 0; $("#viewer-next").hidden = V.i >= V.list.length - 1;
  $("#viewer-reuse").hidden = !it.values;
  V.file = null;                                      // fetched ahead so Save can open the share sheet on the tap itself
  if (SHARE_SAVE) {
    const want = `${it.id}/${it.idx}`;
    V.fileFor = want;
    authFetch(`/api/image/${want}?download=1`).then(async (r) => {
      if (!r.ok || V.fileFor !== want) return;
      const name = (/filename="([^"]+)"/.exec(r.headers.get("Content-Disposition") || "") || [])[1] || "comfy.png";
      const blob = await r.blob();
      if (V.fileFor === want) V.file = new File([blob], name, { type: blob.type || "image/png" });
    }).catch(() => {});
  }
}
// Phones and tablets: Save opens the system share sheet (iPhone: "Save Image" puts it in Photos) instead of a download.
// Where that isn't available (some in-app/Chrome builds), a press-and-hold screen with the real image does the job.
const TOUCH = matchMedia("(pointer: coarse)").matches;
const SHARE_SAVE = TOUCH && !!navigator.share;
async function pressHoldSave(it) {
  const img = $("#savesheet-img");
  img.removeAttribute("src");
  $("#savesheet").hidden = false;
  try {
    const r = await api(`/api/image/${it.id}/${it.idx}?link=1`);
    img.src = API + r.path;                           // a real link, so the long-press menu offers Save to Photos
  } catch (e) { toast(e.message); $("#savesheet").hidden = true; }
}
$("#savesheet-close").addEventListener("click", () => { $("#savesheet").hidden = true; });
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
  const it = V.list[V.i];
  if (TOUCH && (!SHARE_SAVE || !V.file || (navigator.canShare && !navigator.canShare({ files: [V.file] })))) {
    e.preventDefault();
    pressHoldSave(it);
    return;
  }
  if (SHARE_SAVE) {
    e.preventDefault();
    try {                                             // called straight from the tap, so iOS allows the share sheet
      navigator.share({ files: [V.file] }).catch((err) => { if (err.name !== "AbortError") pressHoldSave(it); });
    } catch { pressHoldSave(it); }
    return;
  }
  if (!ON_PAGES) return;
  e.preventDefault();
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
function closeSheets() { $("#gallery").hidden = true; $("#settings").hidden = true; $("#admin").hidden = true; clearTimeout(adminTimer); }
function closeAll() { closeSheets(); $("#viewer").hidden = true; }
document.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => { if (b.closest(".viewer")) $("#viewer").hidden = true; else closeSheets(); }));
function openSettings() { $("#settings").hidden = false; if (ME.role === "owner") loadFriends(); }
$("#open-settings").addEventListener("click", openSettings);
$("#status").addEventListener("click", openSettings);

/* ------------------------------------------------------------ friends (owner) */
async function loadFriends() {
  try { renderFriends((await api("/api/friends")).friends); } catch (e) { toast(e.message); }
}
// Per-friend limits: [field, label, max, what blank means]
const LIMIT_UI = [["limit", "Images / day", 1000, "No limit"], ["hourly", "Images / hour", 500, "No limit"],
  ["concurrent", "Jobs at once", 4, "1"], ["per_run", "Images / run", 4, "4"]];
function limitInputs(f, onChange) {
  const inputs = {};
  const box = h("div", { class: "limits" }, ...LIMIT_UI.map(([k, label, max, blank]) => {
    inputs[k] = h("input", { class: "input", type: "number", min: "1", max: String(max), inputmode: "numeric", placeholder: blank,
      value: f && f[k] != null && !(k === "concurrent" && f[k] === 1) && !(k === "per_run" && f[k] === 4) ? f[k] : "", "aria-label": label });
    if (onChange) inputs[k].addEventListener("change", onChange);
    return h("label", { class: "limit" }, h("small", {}, label), inputs[k]);
  }));
  box.read = () => Object.fromEntries(LIMIT_UI.map(([k]) => [k, inputs[k].value]));
  return box;
}
const addLimits = limitInputs(null);
$("#friend-add-limits").replaceWith(addLimits);
function friendUsage(f) {
  const of = (used, max) => (max ? `${used}/${max}` : `${used}`);
  return `${of(f.used_today, f.limit)} today · ${of(f.used_hour, f.hourly)} this hour · ${f.concurrent} at once · up to ${f.per_run} per run`;
}
function renderFriends(list) {
  const box = $("#friends-list");
  box.replaceChildren(...list.map((f) => {
    const lim = limitInputs(f, async () => {
      try { await api(`/api/friends/${f.id}/update`, { json: lim.read() }); toast("Limits saved"); loadFriends(); } catch (e) { toast(e.message); }
    });
    return h("div", { class: "friend-row" },
      h("div", { class: "friend-top" }, h("b", {}, f.name), f.level ? h("span", { class: "badge" }, LEVELS[f.level].title) : null,
        h("small", {}, f.seen ? "active " + timeAgo(f.seen) : "hasn't made anything yet")),
      h("small", { class: "muted" }, friendUsage(f)),
      lim,
      h("div", { class: "friend-actions" },
        h("button", { class: "btn", type: "button", onclick: async () => {
          if (!confirm(`Make a new password for ${f.name}? Their old one stops working.`)) return;
          try { const r = await api(`/api/friends/${f.id}/reset`, { json: {} }); showSecret(f.name, r.password); } catch (e) { toast(e.message); }
        } }, "New password"),
        h("button", { class: "btn danger", type: "button", onclick: async () => {
          if (!confirm(`Remove ${f.name}? They'll be signed out right away. Their images stay on your PC.`)) return;
          try { await api(`/api/friends/${f.id}/remove`, { json: {} }); toast(`${f.name} removed`); loadFriends(); } catch (e) { toast(e.message); }
        } }, "Remove")));
  }));
}
function showSecret(name, pw) {
  $("#friend-secret-title").textContent = `Password for ${name}:`;
  $("#friend-secret-pw").textContent = pw;
  $("#friend-secret").hidden = false;
  $("#friend-secret").scrollIntoView({ behavior: "smooth", block: "center" });
  loadFriends();
}
$("#friend-secret-copy").addEventListener("click", async () => {
  const text = `${location.origin}${location.pathname}\nPassword: ${$("#friend-secret-pw").textContent}`;
  try { await navigator.clipboard.writeText(text); toast("Link and password copied"); } catch { toast("Copy didn't work. Select the password and copy it."); }
});
$("#friend-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    const r = await api("/api/friends", { json: { name: $("#friend-name").value, password: $("#friend-pw").value, ...addLimits.read() } });
    e.target.reset(); showSecret(r.friend.name, r.password);
  } catch (err) { toast(err.message); }
});
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

/* ------------------------------------------------------------ admin panel (owner): performance, people, usage.
   Charts are plain SVG drawn here (the page's CSP allows no outside scripts). One measure per chart, one axis each. */
let adminTimer = null;
const SVGNS = "http://www.w3.org/2000/svg";
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k);
  return el;
}
// categorical slots, fixed order (dataviz reference palette), dark steps unless the light theme is on
const SERIES = { dark: ["#3987e5", "#d95926", "#199e70", "#c98500", "#d55181", "#008300", "#9085e9", "#e66767"],
  light: ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"] };
const seriesColor = (i) => (i < 8 ? SERIES[ME.prefs.theme === "light" ? "light" : "dark"][i] : "var(--muted)");
const ago = (t) => (!t ? "never" : Date.now() / 1000 - t < 60 ? "just now" : timeAgo(t));
const clock = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

function tipLayer(card) {                              // one tooltip per chart card, follows the pointer
  const tip = h("div", { class: "viz-tip", hidden: true });
  card.append(tip);
  return {
    show(html, x, y) { tip.replaceChildren(...html); tip.hidden = false; const r = card.getBoundingClientRect();
      tip.style.left = Math.min(r.width - tip.offsetWidth - 8, Math.max(8, x - r.left + 12)) + "px"; tip.style.top = Math.max(8, y - r.top - tip.offsetHeight - 10) + "px"; },
    hide() { tip.hidden = true; },
  };
}

function lineChart(title, pts, { max, unit = "", digits = 0, color = "var(--accent)" } = {}) {
  const W = 360, H = 120, L = 28, R = 6, T = 8, B = 18;
  const vals = pts.filter((p) => p.v != null);
  const top = max || Math.max(1, ...vals.map((p) => p.v)) * 1.15;
  const t0 = pts.length ? pts[0].t : 0, t1 = pts.length ? pts[pts.length - 1].t : 1, span = Math.max(1, t1 - t0);
  const X = (t) => L + ((t - t0) / span) * (W - L - R), Y = (v) => T + (1 - v / top) * (H - T - B);
  const last = vals.length ? vals[vals.length - 1].v : null;
  const card = h("div", { class: "viz-card" }, h("div", { class: "viz-head" }, h("span", {}, title),
    h("b", {}, last == null ? "–" : last.toFixed(digits) + unit)));
  const grid = [0, 0.5, 1].map((f) => svg("g", {}, svg("line", { x1: L, x2: W - R, y1: Y(top * f), y2: Y(top * f), class: "viz-grid" }),
    svg("text", { x: L - 6, y: Y(top * f) + 4, class: "viz-axis", "text-anchor": "end" }, (top * f).toFixed(top < 10 ? 1 : 0))));
  const d = vals.map((p, i) => `${i ? "L" : "M"}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join("");
  const area = vals.length ? `${d}L${X(vals[vals.length - 1].t)},${Y(0)}L${X(vals[0].t)},${Y(0)}Z` : "";
  const cross = svg("line", { y1: T, y2: H - B, class: "viz-cross", visibility: "hidden" });
  const dot = svg("circle", { r: 4.5, class: "viz-dot", fill: color, visibility: "hidden" });
  const hit = svg("rect", { x: L, y: T, width: W - L - R, height: H - T - B, fill: "transparent" });
  const chart = svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz", role: "img", "aria-label": `${title}, last 30 minutes` },
    ...grid, svg("path", { d: area, fill: color, opacity: 0.12 }), svg("path", { d, fill: "none", stroke: color, "stroke-width": 2, "stroke-linejoin": "round" }),
    svg("text", { x: L, y: H - 6, class: "viz-axis" }, pts.length ? clock(t0) : ""), svg("text", { x: W - R, y: H - 6, class: "viz-axis", "text-anchor": "end" }, "now"),
    cross, dot, hit);
  card.append(chart);
  const tip = tipLayer(card);
  hit.addEventListener("pointermove", (e) => {
    if (!vals.length) return;
    const r = chart.getBoundingClientRect(), t = t0 + ((e.clientX - r.left) / r.width * W - L) / (W - L - R) * span;
    const p = vals.reduce((a, b) => (Math.abs(b.t - t) < Math.abs(a.t - t) ? b : a));
    cross.setAttribute("x1", X(p.t)); cross.setAttribute("x2", X(p.t)); cross.setAttribute("visibility", "visible");
    dot.setAttribute("cx", X(p.t)); dot.setAttribute("cy", Y(p.v)); dot.setAttribute("visibility", "visible");
    tip.show([h("b", {}, p.v.toFixed(digits) + unit), h("small", {}, clock(p.t))], e.clientX, e.clientY);
  });
  hit.addEventListener("pointerleave", () => { cross.setAttribute("visibility", "hidden"); dot.setAttribute("visibility", "hidden"); tip.hide(); });
  return card;
}

function stackedDays(u, people) {                      // images per day for 14 days, one colour per person
  const W = 560, H = 190, L = 30, R = 6, T = 10, B = 24, n = u.days.length;
  const ids = people.map((p) => p.id).filter((id) => (u.per_day[id] || []).some(Boolean));
  const totals = u.days.map((_, i) => ids.reduce((s, id) => s + u.per_day[id][i], 0));
  const top = Math.max(4, ...totals) * 1.1, bw = (W - L - R) / n, Y = (v) => T + (1 - v / top) * (H - T - B);
  const color = (id) => seriesColor(people.findIndex((p) => p.id === id));
  const name = (id) => (people.find((p) => p.id === id) || {}).name;
  const card = h("div", { class: "viz-card wide" }, h("div", { class: "viz-head" }, h("span", {}, "Images per day · last 14 days"), h("b", {}, String(totals.reduce((a, b) => a + b, 0)))),
    ids.length > 1 ? h("div", { class: "viz-legend" }, ...ids.map((id) => h("span", {}, h("i", { style: `background:${color(id)}` }), name(id)))) : null);
  const tip = tipLayer(card);
  const bars = u.days.map((d, i) => {
    let y = Y(0);
    const segs = ids.map((id) => { const v = u.per_day[id][i]; if (!v) return null; const hgt = Y(0) - Y(v); y -= hgt;
      return svg("rect", { x: L + i * bw + bw * 0.18, y: y + 1, width: bw * 0.64, height: Math.max(0, hgt - 2), rx: 3, fill: color(id) }); });
    const day = new Date(d * 1000);
    const g = svg("g", { class: "viz-bar" }, svg("rect", { x: L + i * bw, y: T, width: bw, height: H - T - B, fill: "transparent" }), ...segs,
      i % 2 === n % 2 || i === n - 1 ? svg("text", { x: L + i * bw + bw / 2, y: H - 7, class: "viz-axis", "text-anchor": "middle" }, i === n - 1 ? "today" : day.toLocaleDateString([], { weekday: "short" })) : null);
    g.addEventListener("pointermove", (e) => tip.show([h("b", {}, day.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })),
      ...ids.filter((id) => u.per_day[id][i]).map((id) => h("small", {}, h("i", { style: `background:${color(id)}` }), `${name(id)}: ${u.per_day[id][i]}`)),
      h("small", {}, `Total: ${totals[i]}`)], e.clientX, e.clientY));
    g.addEventListener("pointerleave", () => tip.hide());
    return g;
  });
  card.insertBefore(svg("svg", { viewBox: `0 0 ${W} ${H}`, class: "viz", role: "img", "aria-label": "Images per day, last 14 days" },
    ...[0, 0.5, 1].map((f) => svg("g", {}, svg("line", { x1: L, x2: W - R, y1: Y(top * f), y2: Y(top * f), class: "viz-grid" }),
      svg("text", { x: L - 6, y: Y(top * f) + 4, class: "viz-axis", "text-anchor": "end" }, Math.round(top * f)))), ...bars), card.lastChild);
  return card;
}

function hBars(title, rows) {                          // [{label, value, color, note}] - direct-labelled, no legend needed
  const max = Math.max(1, ...rows.map((r) => r.value));
  return h("div", { class: "viz-card" }, h("div", { class: "viz-head" }, h("span", {}, title)),
    h("div", { class: "hbars" }, ...rows.map((r) => h("div", { class: "hbar" }, h("span", { class: "hbar-label" }, r.label),
      h("span", { class: "hbar-track" }, h("i", { style: `width:${(r.value / max) * 100}%;background:${r.color}` })),
      h("b", {}, String(r.value)), r.note ? h("small", {}, r.note) : null))));
}

function tile(label, value, sub, cls = "") {
  return h("div", { class: "tile " + cls }, h("span", {}, label), h("b", {}, value), sub ? h("small", {}, sub) : null);
}

function renderAdmin(a) {
  const s = a.samples, last = s[s.length - 1] || {}, u = a.usage, people = a.people;
  const sum = (k) => people.reduce((n, p) => n + ((u.totals[p.id] || {})[k] || 0), 0);
  const online = people.filter((p) => p.online);
  const avg = Object.entries(u.avg_seconds).map(([wf, sec]) => `${(S.workflows[wf] || {}).label || wf} ${sec}s`).join(" · ");
  const vram = last.vram_total ? `${(last.vram_used / 1024).toFixed(1)} / ${(last.vram_total / 1024).toFixed(0)} GB` : "–";
  const failRate = u.finished_week ? Math.round((u.failed_week / u.finished_week) * 100) : 0;
  const body = $("#admin-body");
  body.replaceChildren(
    h("div", { class: "tiles" },
      tile("Images today", String(sum("today")), `${sum("week")} in the last 7 days`),
      tile("Online now", String(online.length), online.map((p) => p.name).join(", ") || "Nobody right now"),
      tile("Queue", String(u.running + u.queued), u.running ? `${u.running} generating · ${u.queued} waiting` : a.online ? "ComfyUI idle" : "ComfyUI is off", a.online ? "" : "warn"),
      tile("Time per image", avg ? avg.split(" · ")[0].replace(/^\S+ /, "") : "–", avg || "No images this week"),
      tile("Failed (7 days)", `${failRate}%`, `${u.failed_week} of ${u.finished_week} jobs`, failRate > 10 ? "bad" : ""),
      tile("GPU", last.gpu != null ? `${Math.round(last.gpu)}%` : "–", [a.gpu_name, last.temp != null ? `${last.temp}°C` : null, last.power != null ? `${Math.round(last.power)} W` : null].filter(Boolean).join(" · "), last.temp >= 80 ? "warn" : "")),
    h("h3", { class: "admin-title" }, "Performance ", h("small", { class: "muted" }, "last 30 minutes, every 5 seconds")),
    h("div", { class: "viz-grid-wrap" },
      lineChart("GPU load", s.map((x) => ({ t: x.t, v: x.gpu })), { max: 100, unit: "%" }),
      lineChart("VRAM used", s.map((x) => ({ t: x.t, v: x.vram_used != null ? x.vram_used / 1024 : null })), { max: last.vram_total ? last.vram_total / 1024 : null, unit: " GB", digits: 1 }),
      lineChart("GPU temperature", s.map((x) => ({ t: x.t, v: x.temp })), { max: 100, unit: "°C" }),
      lineChart("CPU load", s.map((x) => ({ t: x.t, v: x.cpu })), { max: 100, unit: "%" })),
    h("h3", { class: "admin-title" }, "People"),
    h("div", {}, h("div", { class: "table-wrap" }, h("table", { class: "ppl" },
      h("thead", {}, h("tr", {}, ...["", "Who", "Doing", "Device", "Last seen", "Today / 7 days / all", "Limits"].map((t) => h("th", {}, t)))),
      h("tbody", {}, ...people.map((p, i) => {
        const t = u.totals[p.id] || {}, l = p.limits;
        return h("tr", {}, h("td", {}, h("i", { class: "dot " + (p.online ? "on" : ""), title: p.online ? "Online" : "Offline" }), h("i", { class: "swatch-dot", style: `background:${seriesColor(i)}` })),
          h("td", {}, h("b", {}, p.name), h("small", {}, p.role === "owner" ? "Owner" : "Friend", " · ", LEVELS[p.level] ? LEVELS[p.level].title : "Not picked yet")),
          h("td", {}, p.job ? h("span", {}, p.doing, h("small", {}, `${(S.workflows[p.job.workflow] || {}).label || ""} · ${Math.round((p.job.progress || 0) * 100)}% · ${(p.job.summary || "").slice(0, 60)}`)) : p.doing || h("span", { class: "muted" }, "–")),
          h("td", {}, p.device || "–", p.via ? h("small", {}, p.via) : null),
          h("td", {}, ago(p.last)),
          h("td", {}, `${t.today || 0} / ${t.week || 0} / ${t.all || 0}`),
          h("td", {}, l ? h("small", {}, [l.limit ? `${l.limit}/day` : "no daily cap", l.hourly ? `${l.hourly}/hour` : null, `${l.concurrent} at once`, `${l.per_run}/run`].filter(Boolean).join(" · ")) : h("span", { class: "muted" }, "–")));
      }))))),
    h("h3", { class: "admin-title" }, "Usage"),
    h("div", { class: "viz-grid-wrap" },
      stackedDays(u, people),
      hBars("Images per person · last 7 days", people.map((p, i) => ({ label: p.name, value: (u.totals[p.id] || {}).week || 0, color: seriesColor(i) })).filter((r) => r.value).sort((a, b) => b.value - a.value)),
      hBars("Images per model · last 7 days", Object.entries(S.workflows).map(([wf, w], i) => ({ label: w.label, value: u.by_workflow[wf] || 0, color: seriesColor(i),
        note: u.avg_seconds[wf] ? `${u.avg_seconds[wf]}s each` : "" })))),
    h("div", { class: "admin-cols" },
      h("div", {}, h("h3", { class: "admin-title" }, "Activity"),
        a.events.length ? h("ul", { class: "feed" }, ...a.events.slice(0, 30).map((e) => h("li", {}, h("small", {}, clock(e.t)), h("b", {}, e.name), ` ${e.action.toLowerCase()}`, e.detail ? h("span", { class: "muted" }, ` · ${e.detail}`) : null)))
          : h("p", { class: "muted" }, "Nothing yet since the app last restarted.")),
      h("div", {}, h("h3", { class: "admin-title" }, "Recent jobs"),
        h("div", { class: "table-wrap" }, h("table", { class: "ppl jobs-t" },
          h("thead", {}, h("tr", {}, ...["When", "Who", "Model", "Result", "Time", "Prompt"].map((t) => h("th", {}, t)))),
          h("tbody", {}, ...a.recent.map((r) => h("tr", {}, h("td", {}, ago(r.created)), h("td", {}, r.user), h("td", {}, (S.workflows[r.workflow] || {}).label || r.workflow),
            h("td", {}, h("span", { class: "pill " + r.status }, r.status === "done" ? `${r.images} image${r.images === 1 ? "" : "s"}` : r.status)),
            h("td", {}, r.seconds != null ? `${r.seconds}s` : "–"), h("td", { class: "clip" }, r.summary)))))))));
  $("#admin-updated").textContent = "Live · updated " + clock(a.now);
}
async function loadAdmin() {
  clearTimeout(adminTimer);
  if ($("#admin").hidden) return;
  if (!$("#admin-body").hidden) {
    try { renderAdmin(await api("/api/admin")); } catch (e) { $("#admin-updated").textContent = e.message; }
  }
  adminTimer = setTimeout(loadAdmin, 5000);
}
function adminTab(tab) {
  document.querySelectorAll(".admin-tabs button").forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === tab)));
  $("#admin-body").hidden = tab !== "stats"; $("#library-body").hidden = tab !== "library";
  $("#admin-updated").hidden = tab !== "stats";
  store.set("adminTab", tab);
  if (tab === "library") loadLibrary(true); else loadAdmin();
}
document.querySelectorAll(".admin-tabs button").forEach((b) => b.addEventListener("click", () => adminTab(b.dataset.tab)));
$("#open-admin").addEventListener("click", () => { $("#admin").hidden = false; adminTab(store.get("adminTab", "stats")); });

/* The Grand Library: every image made through the website, by anyone (images made in ComfyUI itself never show). */
const LIB = { who: "", wf: "", q: "", items: [], total: 0 };
async function loadLibrary(reset = false) {
  if (reset) LIB.items = [];
  const qs = new URLSearchParams({ offset: LIB.items.length, limit: 60, who: LIB.who, wf: LIB.wf, q: LIB.q });
  let r;
  try { r = await api("/api/library?" + qs); } catch (e) { toast(e.message); return; }
  LIB.total = r.total;
  const start = LIB.items.length;
  LIB.items.push(...r.items.map((x) => ({ id: x.job, idx: x.idx, by: x.who, summary: x.prompt, workflow: x.wf, created: x.t, seconds: x.seconds, uid: x.uid })));
  $("#lib-count").textContent = r.all ? `${r.all} image${r.all === 1 ? "" : "s"} made through the website${r.total !== r.all ? ` · ${r.total} match` : ""}` : "Nothing made through the website yet.";
  const chip = (label, on, onclick) => h("button", { class: "tg-chip", type: "button", role: "radio", "aria-checked": String(on), onclick }, label);
  $("#lib-people").replaceChildren(chip(`Everyone · ${r.all}`, !LIB.who, () => { LIB.who = ""; loadLibrary(true); }),
    ...r.people.map((p) => chip(`${p.name} · ${p.n}`, LIB.who === p.uid, () => { LIB.who = LIB.who === p.uid ? "" : p.uid; loadLibrary(true); })));
  $("#lib-models").replaceChildren(chip("All models", !LIB.wf, () => { LIB.wf = ""; loadLibrary(true); }),
    ...Object.entries(r.models).map(([wf, n]) => chip(`${(S.workflows[wf] || {}).label || wf} · ${n}`, LIB.wf === wf, () => { LIB.wf = LIB.wf === wf ? "" : wf; loadLibrary(true); })));
  const grid = $("#lib-grid");
  if (reset) grid.replaceChildren();
  LIB.items.slice(start).forEach((it, k) => grid.append(h("button", { class: "lib-item", type: "button", "aria-label": `Image by ${it.by}`, onclick: () => openViewer(LIB.items, start + k, true) },
    authImg(`/api/image/${it.id}/${it.idx}?thumb=1`, { loading: "lazy" }),
    h("span", { class: "lib-cap" }, h("b", {}, it.by), h("small", {}, `${(S.workflows[it.workflow] || {}).label || it.workflow} · ${ago(it.created)}`)))));
  $("#lib-more").hidden = LIB.items.length >= LIB.total;
}
$("#lib-more").addEventListener("click", () => loadLibrary());
let libTimer;
$("#lib-search").addEventListener("input", () => { clearTimeout(libTimer); libTimer = setTimeout(() => { LIB.q = $("#lib-search").value.trim(); loadLibrary(true); }, 250); });

/* ------------------------------------------------------------ level & colours */
async function savePrefs(p) {
  const before = level();
  try { ME.prefs = (await api("/api/prefs", { json: p })).prefs; } catch (e) { toast(e.message); return; }
  applyTheme(ME.prefs.theme);
  if (level() !== before) { tidyForLevel(); renderForm(); }
  renderPrefs();
}
function levelChoices(onPick) {
  return Object.entries(LEVELS).map(([id, l]) => h("button", { class: "choice", type: "button", role: "radio", "aria-checked": String(level() === id && !!ME.prefs.level),
    onclick: () => onPick(id) }, h("b", {}, l.title), h("small", {}, l.hint)));
}
function renderPrefs() {
  $("#level-choices").replaceChildren(...levelChoices((id) => savePrefs({ level: id }).then(() => toast(`Switched to ${LEVELS[id].title}`))));
  $("#theme-choices").replaceChildren(...THEMES.map(([id, name, bg, a, b]) => h("button", { class: "theme", type: "button", role: "radio",
    "aria-checked": String(ME.prefs.theme === id), onclick: () => savePrefs({ theme: id }) },
    h("span", { class: "swatch", style: `background:linear-gradient(135deg, ${bg} 50%, ${a} 50% 75%, ${b} 75%)` }), name)));
}
function showWelcome() {                              // a friend's first visit: pick a level before the studio opens
  $("#welcome-title").textContent = `Welcome, ${ME.name}`;
  $("#welcome-levels").replaceChildren(...levelChoices(async (id) => {
    await savePrefs({ level: id });
    $("#welcome").hidden = true; $("#app").hidden = false;
    toast("You can change this anytime in Settings");
  }));
  $("#app").hidden = true; $("#welcome").hidden = false;
}

/* ------------------------------------------------------------ boot */
function showDown() {
  $("#app").hidden = true; $("#login").hidden = true; $("#down").hidden = false; stopPolling();
}
$("#retry").addEventListener("click", () => { $("#down").hidden = true; boot().catch(showDown); });

async function boot() {
  await loadApiBase();
  const me = await api("/api/me");
  if (!me.logged_in) return showLogin();
  ME = { name: me.name, role: me.role, prefs: me.prefs || { level: "dev", theme: "chrome" } };
  applyTheme(ME.prefs.theme);
  document.body.classList.toggle("friend", ME.role !== "owner");
  $("#signed-in").textContent = ME.role === "owner" ? "Signed in as the owner" : `Signed in as ${ME.name}`;
  S = await api("/api/schema");
  if (!S.workflows[wf]) wf = Object.keys(S.workflows)[0];
  for (const w of Object.keys(S.workflows)) values[w] = loadValues(w);
  if (ME.prefs.level && store.get("tidied") !== level()) tidyForLevel();   // this device last ran at another level
  if (!store.get("lorasStartOff")) {                  // once per device: LoRAs that were only on because the workflow had them on
    const keep = wf;
    for (const w of Object.keys(S.workflows)) {
      wf = w;
      for (const f of S.workflows[w].fields) {
        const x = values[w][f.id];
        if (f.type === "lora" && x && x.on && x.name === f.default.name && !(x.pick && Object.values(x.pick).some((p) => p.length))) {
          values[w].prompt = editTags(values[w].prompt, x.added || [], []);
          values[w][f.id] = { ...x, on: false, added: [] };
        }
      }
      saveValues();
    }
    wf = keep; store.set("lorasStartOff", true);
  }
  $("#login").hidden = true; $("#app").hidden = false;
  renderTabs(); renderForm(); renderPrefs(); loadRecent(); poll();
  if (!ME.prefs.level) showWelcome();
  if (!Object.values(S.workflows).some((w) => (w.loras || []).length)) setTimeout(async () => { try { S = await api("/api/schema"); renderForm(); } catch { /* later */ } }, 5000);
}
boot().catch(showDown);
