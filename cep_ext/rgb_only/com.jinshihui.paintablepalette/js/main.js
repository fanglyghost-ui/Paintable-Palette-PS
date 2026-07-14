var EVAL_SCRIPT_TIMEOUT_MS = 3000;
var PANEL_EXTENSION_ID = "com.jinshihui.paintablepalette.panel";

function eval_script(script_text) {
  if (!window.__adobe_cep__ || typeof window.__adobe_cep__.evalScript !== "function") {
    return Promise.reject(new Error("__adobe_cep__.evalScript not available."));
  }
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error("evalScript timed out")); }
    }, EVAL_SCRIPT_TIMEOUT_MS);
    window.__adobe_cep__.evalScript(script_text, function (result) {
      if (!settled) { settled = true; clearTimeout(timer); resolve(result); }
    });
  });
}

function keep_panel_persistent() {
  if (!window.__adobe_cep__ || typeof window.__adobe_cep__.dispatchEvent !== "function") return;

  try {
    var event = typeof window.CSEvent === "function"
      ? new window.CSEvent("com.adobe.PhotoshopPersistent", "APPLICATION")
      : { type: "com.adobe.PhotoshopPersistent", scope: "APPLICATION" };
    event.extensionId = PANEL_EXTENSION_ID;
    event.data = PANEL_EXTENSION_ID;
    window.__adobe_cep__.dispatchEvent(event);
    console.log("[paintablepalette] PhotoshopPersistent dispatched:", PANEL_EXTENSION_ID);
  } catch (err) {
    console.warn("[paintablepalette] keep panel persistent failed:", err);
  }
}

console.log("[paintablepalette] main.js loaded");

window.addEventListener("error", function (ev) {
  console.error("[paintablepalette] uncaught:", ev.message, ev.filename, ev.lineno);
  set_status("ERR: " + (ev.message || "unknown"));
});
window.addEventListener("unhandledrejection", function (ev) {
  var msg = ev.reason && ev.reason.message ? ev.reason.message : String(ev.reason);
  console.error("[paintablepalette] unhandled rejection:", msg);
  set_status("ERR: " + msg);
});

function clamp_0_255(value) {
  return Math.max(0, Math.min(255, value));
}

function base64_to_bytes(base64_string) {
  const binary = atob(base64_string);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function set_status(message) {
  const el = document.getElementById("status-text");
  if (el) el.textContent = message;
}

function set_swatch(rgb) {
  const el = document.getElementById("fg-swatch");
  if (!el) return;
  el.style.backgroundColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
}

async function get_foreground_rgb() {
  const result = await eval_script("paintablepalette_getForegroundRGB()");
  if (!result) throw new Error("Empty result from ExtendScript.");
  return JSON.parse(result);
}

async function set_foreground_rgb(rgb) {
  const r = clamp_0_255(Math.round(rgb.r));
  const g = clamp_0_255(Math.round(rgb.g));
  const b = clamp_0_255(Math.round(rgb.b));
  const result = await eval_script(`paintablepalette_setForegroundRGB(${r}, ${g}, ${b})`);
  if (result && String(result).toUpperCase() !== "OK") {
    throw new Error(`ExtendScript returned: ${result}`);
  }
}

async function export_current_selection() {
  const result = await eval_script("paintablepalette_exportCurrentSelection()");
  if (!result) throw new Error("No selection export result.");
  const data = JSON.parse(result);
  if (!data.path) throw new Error(data.error || "Could not export the selected pixels.");
  return data.path;
}

const W = 400;
const H = 400;
const BG_R = 232;
const BG_G = 232;
const BG_B = 232;
const DB_NAME = "paintablepalette";
const DB_VERSION = 1;
const DB_STORE = "state";
const DB_STATE_KEY = "main";
const LEGACY_LOCAL_STORAGE_KEYS = ["paintablepalette_state_v2", "paintablepalette_state_v1"];
const PALETTE_COUNT = 4;
const SAVED_COLOR_COUNT = 24;

let canvas_el;
let ctx;
let image_data;
let pixel_buffer;
let palette_buffers = [];
let active_palette_index = 0;
let saved_colors = new Array(SAVED_COLOR_COUNT).fill(null);
let is_editing_colors = false;
let dragged_color_index = null;

let brush_radius = 20;
let brush_opacity = 0.1;
let brush_hardness = 1.0;
let brush_color = { r: 0, g: 0, b: 0 };
let color_mode = "mixbox";
let is_drawing = false;
let pick_mode = false;
let alt_key_down = false;
let last_x = null;
let last_y = null;

let needs_render = false;
let is_render_scheduled = false;
let last_render_ms = 0;
const MIN_RENDER_INTERVAL_MS = 33;

let last_pick_ms = 0;
const MIN_PICK_INTERVAL_MS = 80;

let save_timer_id = null;
let save_scheduled = false;
const SAVE_DEBOUNCE_MS = 250;
let has_unsaved_changes = false;

let db_promise = null;

function new_palette_buffer() {
  const buffer = new Uint8ClampedArray(W * H * 4);

  for (let i = 0; i < W * H; i++) {
    const idx = i * 4;
    buffer[idx] = BG_R;
    buffer[idx + 1] = BG_G;
    buffer[idx + 2] = BG_B;
    buffer[idx + 3] = 255;
  }
  return buffer;
}

function init_buffers() {
  palette_buffers = [];
  for (let i = 0; i < PALETTE_COUNT; i++) palette_buffers.push(new_palette_buffer());
  active_palette_index = 0;
  pixel_buffer = palette_buffers[active_palette_index];
}

function open_db() {
  if (db_promise) return db_promise;

  const IDB_TIMEOUT_MS = 3000;

  db_promise = new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("indexedDB not available"));
      return;
    }

    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        reject(new Error("indexedDB open timed out"));
      }
    }, IDB_TIMEOUT_MS);

    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(DB_STORE)) {
        db.createObjectStore(DB_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => {
      if (!settled) { settled = true; clearTimeout(timer); resolve(req.result); }
    };
    req.onerror = () => {
      if (!settled) { settled = true; clearTimeout(timer); reject(req.error || new Error("indexedDB open failed")); }
    };
  });

  return db_promise;
}

async function idb_get_state() {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readonly");
    const store = tx.objectStore(DB_STORE);
    const req = store.get(DB_STATE_KEY);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error || new Error("indexedDB get failed"));
  });
}

async function idb_put_state(record) {
  const db = await open_db();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(DB_STORE, "readwrite");
    const store = tx.objectStore(DB_STORE);
    const req = store.put(record);
    req.onsuccess = () => resolve(true);
    req.onerror = () => reject(req.error || new Error("indexedDB put failed"));
  });
}

function restore_state_from_record(record) {
  if (!record || record.w !== W || record.h !== H) return false;

  if ((record.v === 3 || record.v === 4) && Array.isArray(record.palettes) && record.palettes.length === PALETTE_COUNT) {
    const restored_buffers = [];
    for (const stored of record.palettes) {
      const bytes = stored instanceof Uint8Array ? stored : (stored instanceof ArrayBuffer ? new Uint8Array(stored) : null);
      if (!bytes || bytes.length !== W * H * 4) return false;
      restored_buffers.push(new Uint8ClampedArray(bytes));
    }
    palette_buffers = restored_buffers;
    active_palette_index = Math.max(0, Math.min(PALETTE_COUNT - 1, Number(record.active_palette_index) || 0));
    pixel_buffer = palette_buffers[active_palette_index];
    if (Array.isArray(record.saved_colors)) {
      saved_colors = record.saved_colors.slice(0, SAVED_COLOR_COUNT).map((c) => (
        c && Number.isFinite(c.r) && Number.isFinite(c.g) && Number.isFinite(c.b)
          ? { r: c.r, g: c.g, b: c.b } : null
      ));
      while (saved_colors.length < SAVED_COLOR_COUNT) saved_colors.push(null);
    }
    restore_settings(record.settings);
    if (record.v === 3 && color_mode === "rgb") color_mode = "mixbox";
    return true;
  }

  if (record.v !== 2) return false;

  let bytes = null;
  if (record.pixel_u8 instanceof Uint8Array) {
    bytes = record.pixel_u8;
  } else if (record.pixel_ab instanceof ArrayBuffer) {
    bytes = new Uint8Array(record.pixel_ab);
  }
  if (!bytes) return false;

  if (bytes.length !== W * H * 4) return false;
  pixel_buffer.set(bytes);
  palette_buffers[0] = pixel_buffer;

  restore_settings(record.settings);
  return true;
}

function restore_settings(s) {
  if (s) {
    if (typeof s.brush_radius === "number") brush_radius = s.brush_radius;
    if (typeof s.brush_opacity === "number") brush_opacity = s.brush_opacity;
    if (typeof s.brush_hardness === "number") brush_hardness = s.brush_hardness;
    if (s.color_mode === "rgb" || s.color_mode === "mixbox") color_mode = s.color_mode;
  }

}

function try_migrate_legacy_local_storage_state() {
  if (!window.localStorage) return null;

  let raw = null;
  for (const key of LEGACY_LOCAL_STORAGE_KEYS) {
    raw = window.localStorage.getItem(key);
    if (raw) break;
  }
  if (!raw) return null;

  let state;
  try {
    state = JSON.parse(raw);
  } catch (err) {
    console.warn("[paintablepalette] legacy restore: invalid JSON:", err);
    return null;
  }

  if (!state || state.v !== 1 || state.w !== W || state.h !== H) return null;
  if (typeof state.pixel_b64 !== "string") return null;

  try {
    const pixel_bytes = base64_to_bytes(state.pixel_b64);
    if (pixel_bytes.length !== W * H * 4) return null;
    pixel_buffer.set(pixel_bytes);

    if (state.settings) {
      restore_settings(state.settings);
    }

    return { migrated: true };
  } catch (err) {
    console.warn("[paintablepalette] legacy restore failed:", err);
    return null;
  }
}

function save_state_to_idb() {
  if (!pixel_buffer) return;

  const record = {
    id: DB_STATE_KEY,
    v: 4,
    w: W,
    h: H,
    saved_at_ms: Date.now(),
    active_palette_index,
    palettes: palette_buffers.map((buffer) => new Uint8Array(buffer)),
    saved_colors,
    settings: {
      brush_radius,
      brush_opacity,
      brush_hardness,
      color_mode,
    },
  };

  idb_put_state(record)
    .then(() => {
      has_unsaved_changes = false;
    })
    .catch((err) => console.warn("[paintablepalette] idb save failed:", err));
}

function mark_unsaved_changes() {
  has_unsaved_changes = true;
}

function schedule_save() {
  save_scheduled = true;
  if (save_timer_id !== null) return;

  save_timer_id = window.setTimeout(() => {
    save_timer_id = null;
    if (!save_scheduled) return;
    save_scheduled = false;
    save_state_to_idb();
  }, SAVE_DEBOUNCE_MS);
}

function schedule_render() {
  needs_render = true;
  if (is_render_scheduled) return;
  is_render_scheduled = true;
  requestAnimationFrame(render_if_needed);
}

function render_if_needed() {
  if (!needs_render) {
    is_render_scheduled = false;
    return;
  }
  const now = Date.now();
  if (now - last_render_ms < MIN_RENDER_INTERVAL_MS) {
    requestAnimationFrame(render_if_needed);
    return;
  }
  last_render_ms = now;

  image_data.data.set(pixel_buffer);
  ctx.putImageData(image_data, 0, 0);

  needs_render = false;
  is_render_scheduled = false;
}

function get_pos(e) {
  const rect = canvas_el.getBoundingClientRect();
  const scale_x = W / rect.width;
  const scale_y = H / rect.height;
  return {
    x: (e.clientX - rect.left) * scale_x,
    y: (e.clientY - rect.top) * scale_y,
  };
}

function get_pixel(x, y) {
  const px = Math.max(0, Math.min(W - 1, Math.round(x)));
  const py = Math.max(0, Math.min(H - 1, Math.round(y)));
  const idx = (py * W + px) * 4;
  return { r: pixel_buffer[idx], g: pixel_buffer[idx + 1], b: pixel_buffer[idx + 2] };
}

function is_pick_mode(e) {
  return pick_mode || (e && e.altKey) || alt_key_down;
}

function update_pixel_buffer_rgb(cx, cy, radius, rgb) {
  const x0 = Math.max(0, Math.floor(cx - radius));
  const y0 = Math.max(0, Math.floor(cy - radius));
  const x1 = Math.min(W, Math.ceil(cx + radius));
  const y1 = Math.min(H, Math.ceil(cy + radius));

  const hardness = Math.max(0, Math.min(1, brush_hardness));
  const inner = radius * hardness;

  for (let py = y0; py < y1; py++) {
    for (let px = x0; px < x1; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 >= radius * radius) continue;

      let a = brush_opacity;
      if (hardness < 1) {
        const d = Math.sqrt(d2);
        if (d > inner) {
          const denom = radius - inner;
          const t = denom > 0 ? (radius - d) / denom : 0;
          a = a * Math.max(0, Math.min(1, t));
        }
      }
      if (a <= 0) continue;

      const idx = (py * W + px) * 4;
      if (color_mode === "mixbox" && window.mixbox && typeof window.mixbox.lerp === "function") {
        const mixed = window.mixbox.lerp(
          [pixel_buffer[idx], pixel_buffer[idx + 1], pixel_buffer[idx + 2]],
          [rgb.r, rgb.g, rgb.b],
          a
        );
        pixel_buffer[idx] = Math.round(mixed[0]);
        pixel_buffer[idx + 1] = Math.round(mixed[1]);
        pixel_buffer[idx + 2] = Math.round(mixed[2]);
      } else {
        pixel_buffer[idx] = Math.round((1 - a) * pixel_buffer[idx] + a * rgb.r);
        pixel_buffer[idx + 1] = Math.round((1 - a) * pixel_buffer[idx + 1] + a * rgb.g);
        pixel_buffer[idx + 2] = Math.round((1 - a) * pixel_buffer[idx + 2] + a * rgb.b);
      }
      pixel_buffer[idx + 3] = 255;
    }
  }
}

function draw_stamp(cx, cy) {
  update_pixel_buffer_rgb(cx, cy, brush_radius, brush_color);
  schedule_render();
  mark_unsaved_changes();
}

function draw_stroke_to(x, y) {
  if (last_x === null) {
    draw_stamp(x, y);
    last_x = x;
    last_y = y;
    return;
  }

  const dx = x - last_x;
  const dy = y - last_y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const spacing = Math.max(2, brush_radius * 0.3);
  if (dist < spacing) return;

  const steps = Math.ceil(dist / spacing);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    draw_stamp(last_x + dx * t, last_y + dy * t);
  }
  last_x = x;
  last_y = y;
}

async function do_pick_color(x, y) {
  const now = Date.now();
  if (now - last_pick_ms < MIN_PICK_INTERVAL_MS) return;
  last_pick_ms = now;

  const rgb = get_pixel(x, y);
  set_swatch(rgb);
  set_status(`Picked: rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`);

  try {
    await set_foreground_rgb(rgb);
  } catch (err) {
    set_status(`ERROR(set fg): ${err && err.message ? err.message : String(err)}`);
  }
}

async function on_pointer_down(e) {
  is_drawing = true;
  last_x = null;
  last_y = null;

  if (e.pointerId != null && canvas_el && canvas_el.setPointerCapture) {
    try { canvas_el.setPointerCapture(e.pointerId); } catch (_) {}
  }

  var pos = get_pos(e);
  if (is_pick_mode(e)) {
    do_pick_color(pos.x, pos.y);
    return;
  }

  try {
    var fg = await get_foreground_rgb();
    brush_color = fg;
    set_swatch(fg);
  } catch (err) {
    set_status("WARN(read fg): " + (err && err.message ? err.message : String(err)));
  }

  set_status("Paint: rgb(" + brush_color.r + ", " + brush_color.g + ", " + brush_color.b + ")");
  draw_stamp(pos.x, pos.y);
}

function on_pointer_move(e) {
  if (!is_drawing) return;
  var pos = get_pos(e);
  if (is_pick_mode(e)) {
    do_pick_color(pos.x, pos.y);
  } else {
    draw_stroke_to(pos.x, pos.y);
  }
}

function on_pointer_up() {
  is_drawing = false;
  last_x = null;
  last_y = null;
  if (has_unsaved_changes) save_state_to_idb();
}

function delete_current_paper() {
  palette_buffers[active_palette_index] = new_palette_buffer();
  pixel_buffer = palette_buffers[active_palette_index];
  schedule_render();
  set_status(`Palette ${active_palette_index + 1} cleared`);
  mark_unsaved_changes();
  save_state_to_idb();
}

function render_paper_tabs() {
  document.querySelectorAll(".paper-tab").forEach((tab) => {
    tab.classList.toggle("active", Number(tab.dataset.paper) === active_palette_index);
  });
}

function select_paper(index) {
  if (index < 0 || index >= PALETTE_COUNT || index === active_palette_index) return;
  active_palette_index = index;
  pixel_buffer = palette_buffers[active_palette_index];
  schedule_render();
  render_paper_tabs();
  set_status(`Palette ${active_palette_index + 1}`);
  mark_unsaved_changes();
  schedule_save();
}

function render_saved_colors() {
  const container = document.getElementById("saved-colors");
  if (!container) return;
  container.classList.toggle("editing", is_editing_colors);
  container.innerHTML = "";
  saved_colors.forEach((rgb, index) => {
    const item = document.createElement("div");
    item.className = "saved-color-item";
    const button = document.createElement("button");
    button.className = "saved-color" + (rgb ? "" : " empty");
    button.title = rgb ? `Use rgb(${rgb.r}, ${rgb.g}, ${rgb.b})` : "Empty color slot";
    button.draggable = is_editing_colors && Boolean(rgb);
    if (rgb) button.style.backgroundColor = `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;
    button.addEventListener("click", async () => {
      if (!rgb) return;
      brush_color = rgb;
      set_swatch(rgb);
      try {
        await set_foreground_rgb(rgb);
        set_status(`Color ${index + 1} selected`);
      } catch (err) {
        set_status(`ERROR(set fg): ${err && err.message ? err.message : String(err)}`);
      }
    });
    button.addEventListener("dragstart", (event) => {
      if (!is_editing_colors || !saved_colors[index]) { event.preventDefault(); return; }
      dragged_color_index = index;
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", String(index));
      button.classList.add("dragging");
    });
    button.addEventListener("dragend", () => {
      dragged_color_index = null;
      button.classList.remove("dragging");
      document.querySelectorAll(".saved-color-item").forEach((el) => el.classList.remove("drop-target"));
    });
    item.addEventListener("dragover", (event) => {
      if (!is_editing_colors || dragged_color_index === null) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      item.classList.add("drop-target");
    });
    item.addEventListener("dragleave", () => item.classList.remove("drop-target"));
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      item.classList.remove("drop-target");
      const from = dragged_color_index;
      if (!is_editing_colors || from === null || from === index) return;
      const moved = saved_colors[from];
      saved_colors[from] = saved_colors[index];
      saved_colors[index] = moved;
      dragged_color_index = null;
      render_saved_colors();
      mark_unsaved_changes();
      schedule_save();
      set_status("Colors reordered");
    });
    const delete_button = document.createElement("button");
    delete_button.className = "color-delete";
    delete_button.title = "Delete this color";
    delete_button.textContent = "×";
    delete_button.addEventListener("click", (event) => {
      event.stopPropagation();
      if (!saved_colors[index]) return;
      saved_colors[index] = null;
      render_saved_colors();
      mark_unsaved_changes();
      schedule_save();
      set_status(`Color ${index + 1} removed`);
    });
    item.appendChild(button);
    item.appendChild(delete_button);
    container.appendChild(item);
  });
}

async function save_current_color() {
  try {
    const rgb = await get_foreground_rgb();
    let index = saved_colors.findIndex((color) => color === null);
    if (index < 0) index = SAVED_COLOR_COUNT - 1;
    saved_colors[index] = rgb;
    brush_color = rgb;
    set_swatch(rgb);
    render_saved_colors();
    mark_unsaved_changes();
    schedule_save();
    set_status(`Saved to color ${index + 1}`);
  } catch (err) {
    set_status(`ERROR(read fg): ${err && err.message ? err.message : String(err)}`);
  }
}

function file_path_to_url(path) {
  return "file:///" + path.replace(/\\\\/g, "/").replace(/^\/+/, "") + "?v=" + Date.now();
}

async function import_selection_to_paper() {
  set_status("Importing selection...");
  try {
    const path = await export_current_selection();
    const image = new Image();
    image.onload = () => {
      const temp = document.createElement("canvas");
      temp.width = W;
      temp.height = H;
      const temp_ctx = temp.getContext("2d");
      temp_ctx.fillStyle = `rgb(${BG_R}, ${BG_G}, ${BG_B})`;
      temp_ctx.fillRect(0, 0, W, H);
      const scale = Math.min(W / image.width, H / image.height);
      const draw_w = Math.max(1, Math.round(image.width * scale));
      const draw_h = Math.max(1, Math.round(image.height * scale));
      temp_ctx.drawImage(image, Math.round((W - draw_w) / 2), Math.round((H - draw_h) / 2), draw_w, draw_h);
      pixel_buffer.set(temp_ctx.getImageData(0, 0, W, H).data);
      schedule_render();
      mark_unsaved_changes();
      save_state_to_idb();
      set_status("Selection imported");
    };
    image.onerror = () => set_status("ERROR: Could not load the exported selection.");
    image.src = file_path_to_url(path);
  } catch (err) {
    set_status(`ERROR(import): ${err && err.message ? err.message : String(err)}`);
  }
}

function bind_ui() {
  const mode_el = document.getElementById("select-mode");
  const pick_el = document.getElementById("btn-pick");
  const import_el = document.getElementById("btn-import-selection");
  const delete_el = document.getElementById("btn-delete-paper");
  const save_color_el = document.getElementById("btn-save-color");
  const edit_colors_el = document.getElementById("btn-edit-colors");

  if (mode_el) {
    mode_el.addEventListener("change", (e) => {
      color_mode = e.target.value;
      set_status(`Mode: ${color_mode}`);
      mark_unsaved_changes();
      schedule_save();
    });
  }

  if (delete_el) delete_el.addEventListener("click", delete_current_paper);
  if (import_el) import_el.addEventListener("click", import_selection_to_paper);
  if (save_color_el) save_color_el.addEventListener("click", save_current_color);
  if (edit_colors_el) edit_colors_el.addEventListener("click", () => {
    is_editing_colors = !is_editing_colors;
    edit_colors_el.classList.toggle("active", is_editing_colors);
    edit_colors_el.textContent = is_editing_colors ? "Done" : "Edit";
    render_saved_colors();
    set_status(is_editing_colors ? "Drag colors to reorder; click × to delete" : "Color editing finished");
  });
  document.querySelectorAll(".paper-tab").forEach((tab) => {
    tab.addEventListener("click", () => select_paper(Number(tab.dataset.paper)));
  });

  if (pick_el) {
    pick_el.addEventListener("click", () => {
      pick_mode = !pick_mode;
      pick_el.textContent = pick_mode ? "Pick ✓" : "Pick";
      set_status(pick_mode ? "Pick mode ON (click/drag to pick)" : "Paint mode");
    });
  }

  render_paper_tabs();
  render_saved_colors();
}

async function init() {
  const t0 = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  canvas_el = document.getElementById("palette-canvas");
  keep_panel_persistent();
  if (!canvas_el) {
    set_status("ERROR: canvas not found");
    return;
  }

  ctx = canvas_el.getContext("2d", { willReadFrequently: false }) || canvas_el.getContext("2d");
  if (!ctx) {
    set_status("ERROR: 2d context not available");
    return;
  }
  image_data = ctx.createImageData(W, H);
  init_buffers();

  image_data.data.set(pixel_buffer);
  ctx.putImageData(image_data, 0, 0);

  bind_ui();

  const mode_el = document.getElementById("select-mode");
  if (mode_el) {
    mode_el.value = color_mode;
    if (mode_el.value !== color_mode) {
      color_mode = "mixbox";
      mode_el.value = color_mode;
    }
  }

  // 同时绑 pointer + mouse 事件，防止某些 Mac CEF 中 PointerEvent 存在但不触发
  var pointer_active = false;
  function wrap_down(ev) {
    if (ev.type === "pointerdown") pointer_active = true;
    if (ev.type === "mousedown" && pointer_active) return;
    on_pointer_down(ev);
  }
  function wrap_move(ev) {
    if (ev.type === "mousemove" && pointer_active) return;
    on_pointer_move(ev);
  }
  function wrap_up(ev) {
    if ((ev.type === "mouseup" || ev.type === "mouseleave") && pointer_active) return;
    on_pointer_up(ev);
  }

  if (typeof PointerEvent !== "undefined") {
    canvas_el.addEventListener("pointerdown", wrap_down);
    canvas_el.addEventListener("pointermove", wrap_move);
    canvas_el.addEventListener("pointerup", wrap_up);
    canvas_el.addEventListener("pointerleave", wrap_up);
  }
  canvas_el.addEventListener("mousedown", wrap_down);
  canvas_el.addEventListener("mousemove", wrap_move);
  canvas_el.addEventListener("mouseup", wrap_up);
  canvas_el.addEventListener("mouseleave", wrap_up);

  document.addEventListener("keydown", function (e) {
    if (e.keyCode === 18 || e.key === "Alt") alt_key_down = true;
  });
  document.addEventListener("keyup", function (e) {
    if (e.keyCode === 18 || e.key === "Alt") alt_key_down = false;
  });
  window.addEventListener("blur", function () { alt_key_down = false; });

  console.log("[paintablepalette] bindEvents ok.");

  let restored = false;
  let migrated = false;
  try {
    const record = await idb_get_state();
    restored = restore_state_from_record(record);
  } catch (err) {
    console.warn("[paintablepalette] idb restore failed:", err);
  }

  if (!restored) {
    const legacy = try_migrate_legacy_local_storage_state();
    if (legacy) {
      migrated = true;
      restored = true;
      mark_unsaved_changes();
      save_state_to_idb();
      if (window.localStorage) {
        for (const key of LEGACY_LOCAL_STORAGE_KEYS) window.localStorage.removeItem(key);
      }
    }
  }

  if (restored) {
    image_data.data.set(pixel_buffer);
    ctx.putImageData(image_data, 0, 0);
  }
  render_paper_tabs();
  render_saved_colors();

  console.log("[paintablepalette] init ok.");
  if (restored) console.log("[paintablepalette] state restored from indexedDB");
  if (migrated) console.log("[paintablepalette] legacy localStorage migrated to indexedDB");

  try {
    const fg = await get_foreground_rgb();
    brush_color = fg;
    set_swatch(fg);
    set_status(`Ready (${color_mode}) FG: rgb(${fg.r}, ${fg.g}, ${fg.b})`);
  } catch (err) {
    set_status(`Ready (${color_mode}). WARN(read fg): ${err && err.message ? err.message : String(err)}`);
  }

  const t1 = typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
  console.log("[paintablepalette] init time ms:", Math.round(t1 - t0));
}

document.addEventListener("DOMContentLoaded", function () {
  init().catch(function (err) {
    console.error("[paintablepalette] init fatal:", err);
    set_status("FATAL: " + (err && err.message ? err.message : String(err)));
  });
});
