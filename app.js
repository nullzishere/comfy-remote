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
let firstPoll = true;
const REDUCED = matchMedia("(prefers-reduced-motion: reduce)").matches;
const ease = (t) => 1 - Math.pow(1 - t, 3);
let ME = { name: "", role: "owner" };            // jobs that were already done when the page opened don't buzz

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
  form.append(h("button", { class: "btn ghost", type: "button", onclick: () => { values[wf] = { ...defaults(wf), ...pickUploads(values[wf]) }; saveValues(); renderForm(); toast("Settings reset"); } }, "Reset all settings to your workflow's defaults"));
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
    v[k] = val === "default" ? dflt[k] : val;
  }
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
function tagger(ta) {
  const has = (t) => splitTags(ta.value).some((x) => x.toLowerCase() === esc(t));
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
          h("button", { class: "btn primary", type: "button", onclick: () => { const keep = r.tags.map((x) => x.tag).filter((t) => picked.includes(t)).map(esc); write([...(quality.checked ? splitTags(QUALITY_TAGS) : []), ...keep]); write(splitTags(editTags(ta.value, [], activeTriggers()))); toast("Prompt replaced with tags"); } }, "Use as my prompt"),
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
    if (me.role === "friend" && me.limit) {
      const left = Math.max(0, me.limit - (me.used || 0));
      q.textContent = left ? `${left} of ${me.limit} images left today` : `You've used all ${me.limit} images for today. More at midnight.`;
      q.className = "quota" + (left ? "" : " out");
    } else q.textContent = "";
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
function openSettings() { $("#settings").hidden = false; if (ME.role === "owner") loadFriends(); }
$("#open-settings").addEventListener("click", openSettings);
$("#status").addEventListener("click", openSettings);

/* ------------------------------------------------------------ friends (owner) */
async function loadFriends() {
  try { renderFriends((await api("/api/friends")).friends); } catch (e) { toast(e.message); }
}
function renderFriends(list) {
  const box = $("#friends-list");
  box.replaceChildren(...list.map((f) => {
    const lim = h("input", { class: "input", type: "number", min: "1", max: "1000", inputmode: "numeric", placeholder: "No limit", value: f.limit ?? "", "aria-label": `Daily limit for ${f.name}` });
    const save = async () => {
      try { await api(`/api/friends/${f.id}/update`, { json: { limit: lim.value } }); toast("Limit saved"); loadFriends(); } catch (e) { toast(e.message); }
    };
    lim.addEventListener("change", save);
    return h("div", { class: "friend-row" },
      h("div", { class: "friend-top" }, h("b", {}, f.name),
        h("small", {}, f.limit ? `${f.used_today}/${f.limit} today` : `${f.used_today} today · no limit`),
        h("small", {}, f.seen ? "· active " + timeAgo(f.seen) : "· hasn't made anything yet")),
      h("div", { class: "friend-actions" }, h("span", { class: "muted", style: "font-size:13px" }, "Images/day"), lim,
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
    const r = await api("/api/friends", { json: { name: $("#friend-name").value, limit: $("#friend-limit").value, password: $("#friend-pw").value } });
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

/* ------------------------------------------------------------ boot */
function showDown() {
  $("#app").hidden = true; $("#login").hidden = true; $("#down").hidden = false; stopPolling();
}
$("#retry").addEventListener("click", () => { $("#down").hidden = true; boot().catch(showDown); });

async function boot() {
  await loadApiBase();
  const me = await api("/api/me");
  if (!me.logged_in) return showLogin();
  ME = { name: me.name, role: me.role };
  document.body.classList.toggle("friend", ME.role !== "owner");
  $("#signed-in").textContent = ME.role === "owner" ? "Signed in as the owner" : `Signed in as ${ME.name}`;
  S = await api("/api/schema");
  if (!S.workflows[wf]) wf = Object.keys(S.workflows)[0];
  for (const w of Object.keys(S.workflows)) values[w] = loadValues(w);
  $("#login").hidden = true; $("#app").hidden = false;
  renderTabs(); renderForm(); loadRecent(); poll();
  if (!Object.values(S.workflows).some((w) => (w.loras || []).length)) setTimeout(async () => { try { S = await api("/api/schema"); renderForm(); } catch { /* later */ } }, 5000);
}
boot().catch(showDown);
