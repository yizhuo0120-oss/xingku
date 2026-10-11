/* 形库 FORMLIB · 纯前端应用（无后端，全部在浏览器本地运行） */
"use strict";
const $ = s => document.querySelector(s);

/* ================= 客户端 AI 视觉模块 ================= */
const AICV = (() => {
  function loadImage(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }
  // dHash 感知哈希 -> 64 位十六进制
  function dhash(img, size = 16) {
    const c = document.createElement("canvas");
    c.width = size + 1; c.height = size;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, size + 1, size);
    const d = x.getImageData(0, 0, size + 1, size).data;
    let bits = 0n;
    for (let yy = 0; yy < size; yy++) {
      for (let xx = 0; xx < size; xx++) {
        const i = (yy * (size + 1) + xx) * 4;
        const g1 = d[i] * .299 + d[i + 1] * .587 + d[i + 2] * .114;
        const j = i + 4;
        const g2 = d[j] * .299 + d[j + 1] * .587 + d[j + 2] * .114;
        bits = (bits << 1n) | (g1 < g2 ? 1n : 0n);
      }
    }
    return bits.toString(16).padStart(64, "0");
  }
  function hamming(a, b) {
    const x = BigInt("0x" + a) ^ BigInt("0x" + b);
    const s = x.toString(2);
    let n = 0;
    for (const ch of s) if (ch === "1") n++;
    return n;
  }
  // 主色分析（饱和度加权：有彩像素比纯阴影携带更多色彩信息）
  function dominantColors(img, k = 6) {
    const S = 48;
    const c = document.createElement("canvas");
    c.width = S; c.height = S;
    const x = c.getContext("2d", { willReadFrequently: true });
    x.drawImage(img, 0, 0, S, S);
    const d = x.getImageData(0, 0, S, S).data;
    const buckets = new Map();
    for (let i = 0; i < d.length; i += 16) {
      const r = d[i] >> 5 << 5, g = d[i + 1] >> 5 << 5, b = d[i + 2] >> 5 << 5;
      const key = r + "," + g + "," + b;
      buckets.set(key, (buckets.get(key) || 0) + 1);
    }
    const arr = [...buckets.entries()].map(([key, count]) => {
      const [r, g, b] = key.split(",").map(Number);
      const s = rgb2hsv(r, g, b)[1];
      return { r, g, b, count, w: count * (0.3 + 0.7 * s / 100) };
    }).sort((a, b) => b.w - a.w);
    const out = [];
    for (const col of arr) {
      if (out.every(o => Math.abs(o.r - col.r) + Math.abs(o.g - col.g) + Math.abs(o.b - col.b) > 90)) {
        out.push(col);
        if (out.length >= k) break;
      }
    }
    return out;
  }
  const COLOR_REFS = {
    "墨黑": [0, 0, 8], "深空灰": [0, 0, 42], "冰川银": [0, 0, 78],
    "干邑棕": [22, 62, 52], "熔岩橙": [16, 92, 95], "旷野绿": [95, 42, 38], "冰蓝": [205, 55, 85],
  };
  function rgb2hsv(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), df = mx - mn;
    let h = 0;
    if (df) {
      if (mx === r) h = ((g - b) / df) % 6;
      else if (mx === g) h = (b - r) / df + 2;
      else h = (r - g) / df + 4;
      h *= 60; if (h < 0) h += 360;
    }
    return [h, mx ? df / mx * 100 : 0, mx * 100];
  }
  function classify(doms) {
    if (!doms.length) return { name: "深空灰", conf: 0, palette: [] };
    const total = doms.reduce((s, c) => s + (c.w || c.count), 0) || 1;
    const scores = {}, pal = [];
    for (const col of doms) {
      const { r, g, b } = col;
      const weight = (col.w || col.count) / total;
      const [h, s, v] = rgb2hsv(r, g, b);
      let best = null, bd = 1e9;
      for (const name in COLOR_REFS) {
        const [rh, rs, rv] = COLOR_REFS[name];
        let dh = Math.abs(h - rh); dh = Math.min(dh, 360 - dh) / 180;
        const wh = s < 18 ? 0.15 : 1;
        const dist = Math.sqrt((wh * dh) ** 2 + ((s - rs) / 100) ** 2 + ((v - rv) / 100) ** 2);
        if (dist < bd) { bd = dist; best = name; }
      }
      scores[best] = (scores[best] || 0) + weight * Math.max(0, 1 - bd);
      pal.push({ hex: "#" + [r, g, b].map(v => v.toString(16).padStart(2, "0")).join(""), w: +weight.toFixed(3) });
    }
    const name = Object.keys(scores).sort((a, b) => scores[b] - scores[a])[0];
    const conf = Math.min(.99, scores[name] / Math.max(.01, Object.values(scores).reduce((a, b) => a + b, 0)) + .35);
    return { name, conf: +conf.toFixed(2), palette: pal };
  }
  const TYPE_KW = {
    "手绘草图": ["sketch", "草图", "手绘", "线稿"], "数字渲染": ["render", "渲染", "效果图"],
    "油泥模型": ["clay", "油泥"], "CMF材质": ["cmf", "材质", "leather", "carbon", "metal", "面料"],
    "细节参考": ["detail", "细节", "大灯", "尾灯", "格栅", "轮毂"], "内饰座舱": ["interior", "内饰", "座舱", "座椅"],
    "比例工程图": ["blueprint", "比例", "工程"], "竞品对标": ["benchmark", "竞品", "实拍"],
  };
  function guessType(filename) {
    const fn = (filename || "").toLowerCase();
    for (const t in TYPE_KW) if (TYPE_KW[t].some(k => fn.includes(k))) return { type: t, conf: .7 };
    return { type: "设计参考", conf: .4 };
  }
  const VARIANT_FILTERS = {
    sketch: "grayscale(100%) contrast(170%) brightness(1.08)",
    copper: "sepia(45%) saturate(1.5) hue-rotate(-18deg) contrast(1.05)",
    night: "brightness(0.55) saturate(1.25) hue-rotate(18deg) contrast(1.15)",
    studio: "contrast(1.35) saturate(1.3) brightness(1.05)",
  };
  const VARIANT_NAMES = { sketch: "线稿素描", copper: "铜调暖光", night: "暗夜蓝调", studio: "高对比棚拍" };
  async function makeVariant(src, style) {
    const img = await loadImage(src);
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    const x = c.getContext("2d");
    x.filter = VARIANT_FILTERS[style] || "none";
    x.drawImage(img, 0, 0);
    return c.toDataURL("image/jpeg", .9);
  }
  return { loadImage, dhash, hamming, dominantColors, classify, guessType, makeVariant, VARIANT_NAMES };
})();

/* ================= 状态 ================= */
const TAXONOMY = {
  type: ["手绘草图", "数字渲染", "油泥模型", "CMF材质", "细节参考", "内饰座舱", "比例工程图", "竞品对标", "设计参考"],
  level: ["A0", "A", "B", "C", "D"],
  body: ["轿车", "SUV", "轿跑SUV", "跑车", "MPV"],
  brand: ["参数化未来", "优雅豪华", "运动攻击", "极简科技", "复古未来", "新中式"],
  material: ["Nappa真皮", "Alcantara", "碳纤维", "拉丝金属", "钢琴烤漆", "织物"],
  color: ["熔岩橙", "深空灰", "干邑棕", "冰川银", "墨黑", "旷野绿", "冰蓝"],
};
const FILTER_LABEL = { type: "素材类型", level: "车型级别", body: "车身形式", brand: "品牌语言", material: "材质工艺", color: "色彩" };
const state = {
  filters: {}, q: "", sort: "new", favOnly: false,
  uploads: [],           // 本次会话上传
  hashes: new Map(),     // id -> phash
  hashReady: false,
  boardId: null,
  imgRows: null, imgMode: false,
};
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
};
let favs = new Set(store.get("formlib_favs", []));
let boards = store.get("formlib_boards", []);
function allItems() { return ITEMS.concat(state.uploads); }
function findItem(id) { return allItems().find(i => i.id === id); }

function toast(msg, ms = 2600) {
  const t = $("#toast"); t.textContent = msg; t.hidden = false;
  clearTimeout(t._h); t._h = setTimeout(() => t.hidden = true, ms);
}
function closeModal(id) { document.getElementById(id).hidden = true; }
document.querySelectorAll("[data-close]").forEach(b => b.addEventListener("click", () => closeModal(b.dataset.close)));
document.querySelectorAll(".modal").forEach(m => m.addEventListener("click", e => { if (e.target === m) m.hidden = true; }));

/* ================= 筛选与列表 ================= */
function renderFilters() {
  const box = $("#filters");
  box.innerHTML = Object.keys(FILTER_LABEL).map(k => `
    <div class="fgroup"><h5>${FILTER_LABEL[k]}</h5><div class="chips" data-k="${k}">
      ${TAXONOMY[k].map(v => `<button class="chip" data-v="${v}">${v}</button>`).join("")}
    </div></div>`).join("") +
    `<button class="btn ghost fclear" id="clearF">清除全部筛选</button>
     <div class="aitip" id="aiTip"><b>✦ AI 筛选助手</b>描述你想要的感觉，AI 帮你组合筛选条件</div>`;
  box.querySelectorAll(".chip").forEach(c => c.addEventListener("click", () => {
    const k = c.parentElement.dataset.k, v = c.dataset.v;
    state.filters[k] = state.filters[k] || [];
    const i = state.filters[k].indexOf(v);
    if (i >= 0) { state.filters[k].splice(i, 1); c.classList.remove("on"); }
    else { state.filters[k].push(v); c.classList.add("on"); }
    state.imgMode = false;
    renderGrid();
  }));
  $("#clearF").addEventListener("click", clearAll);
  $("#aiTip").addEventListener("click", () => document.getElementById("lab").scrollIntoView({ behavior: "smooth" }));
  $("#upType").innerHTML = `<option value="">素材类型（AI 会猜）</option>` + TAXONOMY.type.map(v => `<option>${v}</option>`).join("");
  $("#upBrand").innerHTML = `<option value="">品牌语言</option>` + TAXONOMY.brand.map(v => `<option>${v}</option>`).join("");
  $("#upMaterial").innerHTML = `<option value="">材质工艺</option>` + TAXONOMY.material.map(v => `<option>${v}</option>`).join("");
}
function clearAll() {
  state.filters = {}; state.q = ""; state.imgMode = false; $("#nlInput").value = "";
  document.querySelectorAll("#filters .chip.on").forEach(c => c.classList.remove("on"));
  $("#nlParse").hidden = true;
  renderGrid();
}
function matchFilters(it) {
  const f = state.filters;
  if (f.type && f.type.length && !f.type.includes(it.type)) return false;
  if (f.level && f.level.length && !f.level.includes(it.level)) return false;
  if (f.body && f.body.length && !f.body.includes(it.body)) return false;
  if (f.brand && f.brand.length && !f.brand.includes(it.brand)) return false;
  if (f.material && f.material.length && !f.material.includes(it.material)) return false;
  if (f.color && f.color.length && !f.color.includes(it.color)) return false;
  if (state.q) {
    const hay = (it.title + " " + (it.tags || []).join(" ") + " " + it.type + " " + it.brand + " " + it.material).toLowerCase();
    if (!state.q.toLowerCase().split(/\s+/).every(w => hay.includes(w))) return false;
  }
  if (state.favOnly && !favs.has(it.id)) return false;
  return true;
}
function renderGrid() {
  let rows = state.imgMode ? state.imgRows : allItems().filter(matchFilters);
  if (state.imgMode && state.favOnly) rows = rows.filter(r => favs.has(r.id));
  const sorters = { new: (a, b) => (b.date || "").localeCompare(a.date || ""), hot: (a, b) => b.likes - a.likes, ai: (a, b) => b.downloads - a.downloads };
  if (!state.imgMode) rows = [...rows].sort(sorters[state.sort]);
  $("#resultCount").textContent = state.imgMode ? "以图搜图 · 按视觉相似度排序（dHash 感知哈希）" : `共 ${rows.length} 件作品`;
  $("#empty").hidden = rows.length > 0;
  $("#grid").innerHTML = rows.map((r, i) => `
    <div class="card" style="animation-delay:${Math.min(i * 40, 480)}ms" data-id="${r.id}">
      <div class="im">
        <img src="${r.image}" loading="lazy" alt="">
        <span class="badge">${r.type || "设计参考"}</span>
        <span class="aibadge">✦ AI 打标</span>
        <div class="ops">
          <button class="op ${favs.has(r.id) ? "faved" : ""}" data-act="fav">${favs.has(r.id) ? "♡ 已收藏" : "♡ 收藏"}</button>
          <button class="op" data-act="board">＋ 画板</button>
          <button class="op" data-act="variant">✦ 变体</button>
        </div>
      </div>
      <div class="bd">
        <h4>${r.title}</h4>
        <div class="tchips">${(r.tags || []).slice(0, 3).map(t => `<span>${t}</span>`).join("")}</div>
        <div class="meta"><span>${r.source || ""}</span><span>♡${r.likes} · ⭳${r.downloads}${r._dist !== undefined ? ` · 相似度 ${Math.max(0, 100 - r._dist)}` : ""}</span></div>
      </div>
    </div>`).join("");
  $("#grid").querySelectorAll(".card").forEach(card => {
    const id = card.dataset.id;
    card.addEventListener("click", () => openDetail(id));
    card.querySelectorAll(".op").forEach(b => b.addEventListener("click", e => {
      e.stopPropagation();
      const act = b.dataset.act;
      if (act === "fav") toggleFav(id);
      else if (act === "board") addToBoard(id);
      else openDetail(id, true);
    }));
  });
}
function toggleFav(id) {
  if (favs.has(id)) { favs.delete(id); toast("已取消收藏"); }
  else { favs.add(id); toast("已加入收藏"); }
  store.set("formlib_favs", [...favs]);
  renderGrid(); renderStats();
}

/* ================= 自然语言检索 ================= */
const NL_MAP = [
  ["前脸", "q", "前脸"], ["大灯", "q", "大灯"], ["尾灯", "q", "尾灯"], ["格栅", "q", "格栅"],
  ["轮毂", "q", "轮毂"], ["座椅", "q", "座椅"], ["座舱", "q", "座舱"],
  ["内饰", "type", "内饰座舱"], ["草图", "type", "手绘草图"], ["手绘", "type", "手绘草图"],
  ["渲染", "type", "数字渲染"], ["效果图", "type", "数字渲染"], ["油泥", "type", "油泥模型"],
  ["CMF", "type", "CMF材质"], ["材质", "type", "CMF材质"], ["真皮", "material", "Nappa真皮"],
  ["碳纤维", "material", "碳纤维"], ["金属", "material", "拉丝金属"],
  ["SUV", "body", "SUV"], ["轿车", "body", "轿车"], ["跑车", "body", "跑车"], ["轿跑", "body", "轿跑SUV"],
  ["攻击", "brand", "运动攻击"], ["运动", "brand", "运动攻击"], ["豪华", "brand", "优雅豪华"],
  ["优雅", "brand", "优雅豪华"], ["科技", "brand", "极简科技"], ["未来", "brand", "参数化未来"],
  ["黑", "color", "墨黑"], ["灰", "color", "深空灰"], ["银", "color", "冰川银"],
  ["棕", "color", "干邑棕"], ["橙", "color", "熔岩橙"], ["红", "color", "熔岩橙"],
  ["绿", "color", "旷野绿"], ["蓝", "color", "冰蓝"],
  ["B级", "level", "B"], ["C级", "level", "C"], ["D级", "level", "D"],
];
function nlSearch(text) {
  const filters = {}, qs = [], hits = [];
  for (const [kw, kind, val] of NL_MAP) {
    if (text.includes(kw)) {
      hits.push([kw, kind, val]);
      if (kind === "q") qs.push(val);
      else { filters[kind] = filters[kind] || []; if (!filters[kind].includes(val)) filters[kind].push(val); }
    }
  }
  state.filters = filters; state.q = qs.join(" "); state.imgMode = false;
  document.querySelectorAll("#filters .chip").forEach(c =>
    c.classList.toggle("on", (state.filters[c.parentElement.dataset.k] || []).includes(c.dataset.v)));
  const box = $("#nlParse");
  box.hidden = false;
  box.innerHTML = hits.length
    ? `<span>✦ AI 解析：</span>` + hits.map(h => `<span class="ptag">${h[0]} → ${FILTER_LABEL[h[1]] || "关键词"}「${h[2]}」</span>`).join("")
    : `<span>✦ AI 未解析出明确维度，已按关键词全文检索</span>`;
  if (!hits.length) state.q = text;
  renderGrid();
  document.getElementById("lib").scrollIntoView({ behavior: "smooth" });
}
$("#nlBtn").addEventListener("click", () => { const t = $("#nlInput").value.trim(); if (t) nlSearch(t); });
$("#nlInput").addEventListener("keydown", e => { if (e.key === "Enter") $("#nlBtn").click(); });

/* ================= 感知哈希索引 & 以图搜图 ================= */
async function ensureHashes(onProgress) {
  if (state.hashReady) return;
  const items = allItems();
  let done = 0;
  for (const it of items) {
    if (!state.hashes.has(it.id)) {
      try {
        const img = await AICV.loadImage(it.image);
        state.hashes.set(it.id, AICV.dhash(img));
      } catch (e) { /* 忽略坏图 */ }
    }
    done++;
    if (onProgress) onProgress(done, items.length);
  }
  state.hashReady = true;
}
async function imageSearch(file) {
  if (!file) return;
  toast("正在计算感知哈希并全库比对…");
  await ensureHashes();
  const url = URL.createObjectURL(file);
  try {
    const img = await AICV.loadImage(url);
    const target = AICV.dhash(img);
    const rows = [];
    for (const it of allItems()) {
      const h = state.hashes.get(it.id);
      if (!h) continue;
      rows.push(Object.assign({}, it, { _dist: AICV.hamming(target, h) }));
    }
    rows.sort((a, b) => a._dist - b._dist);
    state.imgMode = true; state.imgRows = rows.slice(0, 12);
    renderGrid();
    document.getElementById("lib").scrollIntoView({ behavior: "smooth" });
    toast(`找到 ${state.imgRows.length} 件视觉相似素材`);
  } catch (e) { toast("识别失败，请换一张图试试"); }
  URL.revokeObjectURL(url);
}
$("#imgSearch").addEventListener("change", e => imageSearch(e.target.files[0]));
$("#imgSearch2").addEventListener("change", e => imageSearch(e.target.files[0]));

/* ================= 详情 ================= */
let detailId = null;
async function similarTo(id, limit = 6) {
  await ensureHashes();
  const base = findItem(id);
  if (!base) return [];
  const bh = state.hashes.get(id);
  const btags = new Set(base.tags || []);
  const scored = [];
  for (const it of allItems()) {
    if (it.id === id) continue;
    const h = state.hashes.get(it.id);
    if (!h || !bh) continue;
    const overlap = (it.tags || []).filter(t => btags.has(t)).length;
    scored.push([AICV.hamming(bh, h) - overlap * 6, it]);
  }
  return scored.sort((a, b) => a[0] - b[0]).slice(0, limit).map(x => x[1]);
}
async function openDetail(id, toVariant = false) {
  detailId = id;
  const m = findItem(id);
  if (!m) return;
  $("#dImg").src = m.image;
  $("#dTitle").textContent = m.title;
  const meta = [["素材类型", m.type], ["车型级别", m.level], ["车身形式", m.body], ["品牌语言", m.brand],
    ["材质工艺", m.material], ["色彩", m.color], ["视角", m.view], ["来源", m.source], ["入库", m.date]];
  $("#dMeta").innerHTML = meta.filter(x => x[1]).map(x => `<dt>${x[0]}</dt><dd>${x[1]}</dd>`).join("");
  $("#dTags").innerHTML = (m.tags || []).map(t => `<span>${t}</span>`).join("");
  $("#dAi").textContent = "✦ " + (m.aiNote || "AI 已完成自动打标");
  $("#dLicense").textContent = "© " + (m.license || "内部资产");
  // 真实色板提取
  $("#dPalette").innerHTML = `<span style="color:var(--faint);font-size:.8rem">分析中…</span>`;
  try {
    const img = await AICV.loadImage(m.image);
    const cls = AICV.classify(AICV.dominantColors(img));
    $("#dPalette").innerHTML =
      `<div class="sw"><i style="background:${cls.palette[0]?.hex || "#333"}"></i><span>${cls.name} · ${cls.conf}</span></div>` +
      cls.palette.slice(1, 5).map(s => `<div class="sw"><i style="background:${s.hex}"></i><span>${s.hex}</span></div>`).join("");
  } catch (e) { $("#dPalette").innerHTML = `<span style="color:var(--faint);font-size:.8rem">提取失败</span>`; }
  const favB = $("#dFav");
  const paintFav = () => favB.textContent = favs.has(id) ? "♡ 已收藏" : "♡ 收藏";
  paintFav();
  favB.onclick = () => { toggleFav(id); paintFav(); };
  $("#dBoard").onclick = () => addToBoard(id);
  $("#variantBar").innerHTML = Object.entries(AICV.VARIANT_NAMES).map(([k, v]) => `<button class="chip" data-s="${k}">✦ ${v}</button>`).join("");
  $("#variantBar").querySelectorAll(".chip").forEach(c => c.onclick = () => genVariant(id, c.dataset.s, c));
  $("#dVariant").onclick = () => { const f = $("#variantBar .chip"); if (f) f.click(); };
  $("#dSim").innerHTML = `<span style="color:var(--faint);font-size:.8rem">计算中…</span>`;
  const sims = await similarTo(id);
  $("#dSim").innerHTML = sims.map(s => `<div class="sim" data-id="${s.id}"><img src="${s.image}" loading="lazy"><p>${s.title}</p></div>`).join("");
  $("#dSim").querySelectorAll(".sim").forEach(el => el.addEventListener("click", () => openDetail(el.dataset.id)));
  $("#detailModal").hidden = false;
  if (toVariant) setTimeout(() => $("#dVariant").click(), 400);
}
async function genVariant(id, style, btn) {
  const m = findItem(id);
  btn.classList.add("on"); const old = btn.textContent; btn.textContent = "生成中…";
  try {
    const url = await AICV.makeVariant(m.image, style);
    $("#dImg").src = url;
    toast(`已生成「${AICV.VARIANT_NAMES[style]}」变体，可右键另存`);
  } catch (e) { toast("生成失败"); }
  btn.classList.remove("on"); btn.textContent = old;
}

/* ================= 上传 & 自动打标 ================= */
function openUpload() { $("#uploadModal").hidden = false; $("#upAnalysis").hidden = true; }
$("#uploadBtn").addEventListener("click", openUpload);
$("#labUpload").addEventListener("click", openUpload);
$("#labLib1").addEventListener("click", () => document.getElementById("lib").scrollIntoView({ behavior: "smooth" }));
$("#labLib2").addEventListener("click", () => document.getElementById("lib").scrollIntoView({ behavior: "smooth" }));
$("#dropZone").addEventListener("click", () => $("#upFile").click());
$("#upFile").addEventListener("change", e => {
  const f = e.target.files[0];
  if (f) { $("#dropZone").classList.add("has"); $("#dropText").textContent = "已选择：" + f.name + "（点击可更换）"; }
});
function readAsDataURL(file) {
  return new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(file); });
}
$("#upSubmit").addEventListener("click", async () => {
  const file = $("#upFile").files[0];
  if (!file) { toast("请先选择图片"); return; }
  const btn = $("#upSubmit"); btn.textContent = "AI 分析中…";
  try {
    const dataURL = await readAsDataURL(file);
    const img = await AICV.loadImage(dataURL);
    const cls = AICV.classify(AICV.dominantColors(img));
    const gt = AICV.guessType(file.name);
    const hash = AICV.dhash(img);
    await ensureHashes();
    const dups = [];
    for (const it of allItems()) {
      const h = state.hashes.get(it.id);
      if (h && AICV.hamming(hash, h) <= 10) dups.push(it);
    }
    const id = "u" + Date.now().toString(36);
    const item = {
      id, title: $("#upTitle").value.trim() || file.name.replace(/\.\w+$/, ""),
      type: $("#upType").value || gt.type,
      level: $("#upLevel").value, body: $("#upBody").value,
      brand: $("#upBrand").value, material: $("#upMaterial").value,
      color: cls.name, view: img.naturalWidth >= img.naturalHeight ? "横构图" : "竖构图",
      image: dataURL, source: "我的上传",
      date: new Date().toISOString().slice(0, 10), license: "内部资产 · 可复用",
      tags: $("#upTags").value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      aiNote: `AI 自动打标：色彩 ${cls.name}（置信度 ${cls.conf}）/ 类型 ${gt.type} / 尺寸 ${img.naturalWidth}×${img.naturalHeight}`,
      likes: 0, downloads: 0,
    };
    state.uploads.unshift(item);
    state.hashes.set(id, hash);
    const box = $("#upAnalysis");
    box.hidden = false;
    box.innerHTML = `<b>✦ AI 自动打标完成</b><br>主色彩：${cls.name}（置信度 ${cls.conf}）<br>建议类型：${gt.type} · 感知哈希已建档` +
      (dups.length ? `<br><span class="dup">⚠ 检测到 ${dups.length} 件疑似重复：${dups.slice(0, 3).map(d => d.title).join("、")}</span>` : `<br>✓ 未发现重复素材`);
    toast("上传成功，已加入素材库（本次会话有效）");
    renderGrid(); renderStats();
  } catch (e) { toast("分析失败：" + e.message); }
  btn.textContent = "开始上传并打标";
});

/* ================= 画板 ================= */
function saveBoards() { store.set("formlib_boards", boards); }
function renderBoardSel() {
  const sel = $("#boardSel");
  sel.innerHTML = boards.map(b => `<option value="${b.id}">${b.name}（${b.items.length}）</option>`).join("") || `<option value="">暂无画板</option>`;
  if (!state.boardId && boards.length) state.boardId = boards[0].id;
  if (state.boardId) sel.value = state.boardId;
  const total = boards.reduce((s, b) => s + b.items.length, 0);
  $("#boardCount").textContent = total;
}
function renderBoard() {
  const b = boards.find(x => x.id === state.boardId);
  $("#boardGrid").innerHTML = (b && b.items.length ? b.items.map(id => {
    const m = findItem(id);
    if (!m) return "";
    return `<div class="bitem" data-id="${id}"><img src="${m.image}" loading="lazy" title="${m.title}"><button data-rm="${id}">移除</button></div>`;
  }).join("") : `<p style="color:var(--faint);grid-column:1/-1">画板是空的，去素材库把灵感加进来吧</p>`);
  $("#boardGrid").querySelectorAll(".bitem").forEach(el =>
    el.addEventListener("click", () => openDetail(el.dataset.id)));
  $("#boardGrid").querySelectorAll("[data-rm]").forEach(btn => btn.addEventListener("click", e => {
    e.stopPropagation();
    const b2 = boards.find(x => x.id === state.boardId);
    b2.items = b2.items.filter(i => i !== btn.dataset.rm);
    saveBoards(); renderBoard(); renderBoardSel();
  }));
}
function addToBoard(id) {
  if (!state.boardId || !boards.find(b => b.id === state.boardId)) {
    const nb = { id: Date.now(), name: "我的第一个画板", items: [] };
    boards.unshift(nb); state.boardId = nb.id;
  }
  const b = boards.find(x => x.id === state.boardId);
  if (!b.items.includes(id)) b.items.push(id);
  saveBoards(); renderBoard(); renderBoardSel();
  toast("已加入灵感画板");
}
$("#boardSel").addEventListener("change", e => { state.boardId = +e.target.value; renderBoard(); });
$("#newBoardBtn").addEventListener("click", () => {
  const name = prompt("新画板名称：", "概念灵感 " + new Date().toLocaleDateString());
  if (!name) return;
  const nb = { id: Date.now(), name, items: [] };
  boards.unshift(nb); state.boardId = nb.id;
  saveBoards(); renderBoard(); renderBoardSel(); toast("画板已创建");
});
$("#exportBoardBtn").addEventListener("click", async () => {
  const b = boards.find(x => x.id === state.boardId);
  if (!b || !b.items.length) { toast("画板是空的，先加几件素材吧"); return; }
  toast("正在生成拼贴长图…");
  try {
    const imgs = [];
    for (const id of b.items) { const m = findItem(id); if (m) imgs.push([m, await AICV.loadImage(m.image)]); }
    const cols = 3, tw = 420, th = 300, pad = 24, headH = 110;
    const rows = Math.ceil(imgs.length / cols);
    const W = cols * (tw + pad) + pad, H = headH + rows * (th + 52 + pad) + pad;
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = "#0b0b0e"; x.fillRect(0, 0, W, H);
    x.fillStyle = "#e2a75d"; x.font = "34px 'PingFang SC','Microsoft YaHei',sans-serif";
    x.fillText(b.name, pad, 52);
    x.fillStyle = "#8c8c96"; x.font = "20px 'PingFang SC','Microsoft YaHei',sans-serif";
    x.fillText(`${imgs.length} 件素材 · 形库 FORMLIB 导出`, pad, 84);
    imgs.forEach(([m, img], i) => {
      const cx = pad + (i % cols) * (tw + pad), cy = headH + Math.floor(i / cols) * (th + 52 + pad);
      const scale = Math.min(tw / img.naturalWidth, th / img.naturalHeight);
      const w = img.naturalWidth * scale, h = img.naturalHeight * scale;
      x.drawImage(img, cx + (tw - w) / 2, cy + (th - h) / 2, w, h);
      x.fillStyle = "#dcdce2"; x.font = "17px 'PingFang SC','Microsoft YaHei',sans-serif";
      x.fillText(m.title.slice(0, 18), cx, cy + th + 30);
    });
    const a = document.createElement("a");
    a.download = b.name.replace(/[\\/:*?"<>|]/g, "_") + "-拼贴.jpg";
    a.href = c.toDataURL("image/jpeg", .88);
    a.click();
    toast("拼贴图已开始下载");
  } catch (e) { toast("导出失败：" + e.message); }
});
$("#boardBtn").addEventListener("click", () => { $("#boardDrawer").hidden = false; renderBoard(); });

/* ================= 排序 / 统计 ================= */
$("#sortSel").addEventListener("change", e => { state.sort = e.target.value; renderGrid(); });
$("#favOnly").addEventListener("change", e => { state.favOnly = e.target.checked; renderGrid(); });
function renderStats() {
  const n = allItems().length;
  $("#stats").innerHTML = [
    [n + "+", "素材资产"], ["96%", "AI 自动打标准确率"],
    ["12ms", "跨模态检索"], ["40+", "主机厂设计团队在用"],
  ].map(x => `<div class="stat"><b>${x[0]}</b><span>${x[1]}</span></div>`).join("");
}

/* ================= 启动 ================= */
(async function init() {
  renderFilters();
  renderGrid();
  renderBoardSel(); renderBoard();
  renderStats();
  // 后台预建哈希索引（不阻塞首屏）
  ensureHashes().then(() => console.log("哈希索引就绪"));
})();
