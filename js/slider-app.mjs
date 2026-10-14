// スライダーの切り抜き調整画面（slider.html）。計算は slider-lib.mjs、ここは DOM・通信・canvas 描画だけ。
// 名簿 = 公開中の casts-data.js（スライダーに出る人＝立ち絵ありの人）、寸法 = slider-src.json（build_slider.py が作る）、
// 調整値 = data/slider.json（この画面だけが書く）。接続方式は manage.html・announce.html と同じ
// （閲覧者の GitHub トークンで contents API。トークンは localStorage の同じキー）。
import {
  autoBox, manualBox, entryBox, outputSize, autoFit, dragFit, zoomFit, coverLayout, parseSlider, serializeSlider, mergeSlider,
  resolveState, desiredRecord, sameRecord, sameRecordBox, rowsToDelete, sourceKey, sliderCasts, commitMessage, ZOOM_MAX, minZoom, isAutoBox, visibleBox, isLowRes, LOW_RES_PX,
} from './slider-lib.mjs';

const OWNER = 'BackStage-unei', REPO = 'bs-cast-showcase', BRANCH = 'main';
const SLIDER_PATH = 'data/slider.json';
const TOKEN_KEY = 'bs_cast_admin_token';
const RANKS = ['GOLD', 'SILVER', 'BRONZE'];
const PARAMS = new URLSearchParams(location.search);
// ローカル確認用（make slider-dev）: リポジトリ直下を配信し dist/slider.html?local=1 で開く。保存はファイルのダウンロード
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && PARAMS.has('local');
// ローカル確認モードだけ: ?slider=<dist からの相対パス> で data/slider.json の代わりに読む（一致の確認用）
// 同じサーバの中の相対パスだけ（// で始まる別サイトや .. は受け付けない）
const LOCAL_SLIDER = LOCAL && /^\w[\w./-]*\.json$/.test(PARAMS.get('slider') || '') && !(PARAMS.get('slider') || '').includes('..')
  ? PARAMS.get('slider') : '../' + SLIDER_PATH;

const $ = id => document.getElementById(id);
const state = {
  casts: [],                 // sliderCasts の結果
  saved: { version: 1, casts: {} }, sha: null,   // 読み込んだ（保存した）slider.json
  entries: new Map(),        // id → { mode, fit }
  selected: null, saving: false, images: new Map(), warnings: [],
};

// ---------- 通信 ----------
function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
const API_TIMEOUT_MS = 20000;
// GitHub API。通信が止まっても「保存中…」で固まらないよう 20 秒で打ち切る
// トークンに使えない文字（全角・空白・改行など）が入っていると、ブラウザが通信の前に止める → 入れ直してもらう
const TOKEN_RE = /^[\x21-\x7e]+$/;
// base はログイン画面に出す文（その画面ではトークン欄がすぐ下にあるので「接続し直す」の案内は付けない）
const authError = msg => Object.assign(new Error(msg + '。右上の「接続し直す」からトークンを入れ直してください'), { auth: true, base: msg });
async function api(path, opts = {}) {
  const tk = token();
  if (!TOKEN_RE.test(tk)) throw authError('保存されているトークンの形式が正しくありません');
  try {
    opts.headers = new Headers(Object.assign({ Authorization: 'Bearer ' + tk, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opts.headers || {}));
  } catch { throw authError('トークンを通信に使えません'); }
  const ac = new AbortController(), timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);
  try { return await fetch('https://api.github.com' + path, { ...opts, signal: ac.signal }); }
  catch (err) { throw new Error(err.name === 'AbortError' ? 'GitHub との通信が時間切れになりました。もう一度お試しください' : 'GitHub に接続できません: ' + err.message); }
  finally { clearTimeout(timer); }
}

// 保存の競合か: 409、または sha の不一致・欠落を言う 422（他の人が先にファイルを作った）。それ以外の 422 は入力の誤り
async function isConflict(r) {
  if (r.status === 409) return true;
  if (r.status !== 422) return false;
  const body = await r.clone().json().catch(() => ({}));
  return /sha/i.test(String(body.message || ''));
}
function b64decodeUtf8(b64) { const bin = atob(b64.replace(/\n/g, '')); return new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))); }
function b64encodeUtf8(str) { let bin = ''; for (const b of new TextEncoder().encode(str)) bin += String.fromCharCode(b); return btoa(bin); }

// slider.json を読む。無ければ空。ファイルごと壊れていたら例外（上書きしないよう保存させない）
async function loadSlider() {
  if (LOCAL) {
    const r = await fetch(LOCAL_SLIDER, { cache: 'no-store' });
    if (r.status === 404) return { ...parseSlider('{"version":1,"casts":{}}'), sha: null };
    if (!r.ok) throw new Error('slider.json を読めません (' + r.status + ')');
    return { ...parseSlider(await r.text()), sha: null };
  }
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${SLIDER_PATH}?ref=${BRANCH}`, { cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw authError('トークンでリポジトリを読めませんでした (' + r.status + ')');
  if (r.status === 404) {
    // ファイルがまだ無いのか、トークンの権限が無いのかを見分ける（GitHub は権限の無い private リポにも 404 を返す）
    const repo = await api(`/repos/${OWNER}/${REPO}`);
    if (!repo.ok) throw authError('トークンでリポジトリを読めませんでした (' + repo.status + ')');
    return { ...parseSlider('{"version":1,"casts":{}}'), sha: null };
  }
  if (!r.ok) throw new Error('slider.json の取得に失敗しました (' + r.status + ')');
  const body = await r.json();
  return { ...parseSlider(b64decodeUtf8(body.content)), sha: body.sha };
}

function putSlider(text, sha, ids) {
  const body = { message: commitMessage(ids), content: b64encodeUtf8(text), branch: BRANCH };
  if (sha) body.sha = sha;
  return api(`/repos/${OWNER}/${REPO}/contents/${SLIDER_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
}

// 公開中の casts-data.js を読み直す（キャッシュを避けるため毎回 URL を変える）
function loadShowcase() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'casts-data.js?t=' + Date.now();
    s.onload = () => { s.remove(); resolve(window.SHOWCASE && window.SHOWCASE.casts); };
    s.onerror = () => { s.remove(); reject(new Error('casts-data.js を読めません')); };
    document.head.append(s);
  });
}

async function loadSrcMeta() {
  const r = await fetch('slider-src.json?t=' + Date.now(), { cache: 'no-store' });
  if (!r.ok) throw new Error('slider-src.json を読めません (' + r.status + ')。ビルドが古い可能性があります');
  return r.json();
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 画像 ----------
// 読み込み失敗はキャッシュに残さない（再読込で取り直せるように）
function loadImage(url) {
  if (!state.images.has(url)) {
    const p = new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('画像を読み込めません: ' + url));
      im.src = url;
    });
    p.catch(() => { if (state.images.get(url) === p) state.images.delete(url); });
    state.images.set(url, p);
  }
  return state.images.get(url);
}

// ---------- 状態 ----------
const castById = id => state.casts.find(c => c.id === id);
const savedOf = id => state.saved.casts[id] || null;
function recordOf(id) {
  const c = castById(id), e = state.entries.get(id);
  return c && c.meta && e ? desiredRecord(e, c.meta, savedOf(id)) : savedOf(id);
}
// 未保存かどうかは値ではなく切り出す枠で比べる（丸めの差だけ・自動と同じ枠に戻しただけでは未保存にしない）
const isDirtyId = id => !sameRecordBox(recordOf(id), savedOf(id));
const dirtyIds = () => state.casts.filter(c => isDirtyId(c.id)).map(c => c.id);

function setStatus(t, dirty = false) { const s = $('status'); s.textContent = t; s.classList.toggle('dirty', dirty); }
function refreshDirty() {
  const n = dirtyIds().length;
  $('saveBtn').disabled = state.saving || !n;
  if (!state.saving) setStatus(n ? `未保存の変更 ${n}人` : '保存済み', n > 0);
}

// ---------- 一覧 ----------
function buildList() {
  const list = $('castList'); list.replaceChildren();
  if (!state.casts.length) { const p = document.createElement('p'); p.className = 'empty'; p.textContent = 'スライダーに出るキャストがいません'; list.append(p); return; }
  const groups = new Map();
  for (const c of state.casts) { const k = RANKS.includes(c.rank) ? c.rank : 'その他'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(c); }
  for (const [rank, casts] of groups) {
    const h = document.createElement('h3'); h.className = 'rank-head rank-' + rank; h.textContent = `${rank}（${casts.length}名）`;
    list.append(h);
    for (const c of casts) list.append(listItem(c));
  }
}

// 一覧の項目の見た目を決める値（これが変わったときだけ項目を作り直す。ドラッグ中に毎回作り直さない）
function itemSig(c) {
  const e = state.entries.get(c.id);
  return [!!c.meta, e ? e.mode : '', isDirtyId(c.id)].join('|');
}
const itemSigs = new Map();

function listItem(c) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'item'; b.dataset.id = c.id;
  // 一覧は Tab 1回で入って出る（選んでいる人だけ Tab で止まる。中は ↑↓ で移動・Enter で選ぶ）
  b.tabIndex = c.id === rovingId() ? 0 : -1;
  itemSigs.set(c.id, itemSig(c));
  if (c.id === state.selected) b.classList.add('selected');
  const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = c.name || '（名前未設定）';
  const id = document.createElement('span'); id.className = 'id'; id.textContent = `ID ${c.id}`;
  b.append(nm, id);
  const e = state.entries.get(c.id);
  const badge = (text, cls) => { const s = document.createElement('span'); s.className = 'badge ' + cls; s.textContent = text; b.append(s); };
  if (!c.meta) badge('画像なし', 'warn');
  else if (!c.meta.source) badge('ファイル名が読めない', 'warn');
  else if (e && e.mode === 'manual') badge('調整済み', 'ok');
  else if (e && e.mode === 'stale') badge('立ち絵が変わった→自動', 'warn');
  if (isDirtyId(c.id)) badge('未保存', 'dirty');
  b.addEventListener('click', () => {
    select(c.id);
    // スマホ（1列表示）では一覧がプレビューの下にあるので、選んだらプレビューまで戻す
    if (matchMedia('(max-width: 760px)').matches) $('phone').scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  return b;
}

function refreshItem(id) {
  const c = castById(id);
  if (!c || itemSigs.get(id) === itemSig(c)) return;
  const old = document.querySelector(`.item[data-id="${CSS.escape(id)}"]`);
  if (!old) return;
  const fresh = listItem(c), hadFocus = document.activeElement === old;
  old.replaceWith(fresh);
  if (hadFocus) fresh.focus();   // 作り直しでキーボードの位置を失わない
}

// 一覧で Tab が止まる項目（選んでいる人、いなければ先頭）
function rovingId() { return state.selected || (state.casts[0] && state.casts[0].id); }

function bindListKeys() {
  $('castList').addEventListener('keydown', ev => {
    const items = [...document.querySelectorAll('#castList .item')];
    const i = items.indexOf(document.activeElement);
    if (i < 0) return;
    const to = { ArrowDown: i + 1, ArrowUp: i - 1, Home: 0, End: items.length - 1 }[ev.key];
    if (to === undefined) return;   // Enter・Space はボタンなのでそのまま「選ぶ」になる
    ev.preventDefault();
    const next = items[Math.max(0, Math.min(items.length - 1, to))];
    for (const el of items) el.tabIndex = el === next ? 0 : -1;
    next.focus();
  });
}

function select(id) {
  state.selected = id;
  for (const el of document.querySelectorAll('.item')) { el.classList.toggle('selected', el.dataset.id === id); el.tabIndex = el.dataset.id === id ? 0 : -1; }
  renderControls();
  scheduleRender();
}

// ---------- 右側（プレビューと操作） ----------
function renderControls() {
  const c = castById(state.selected), e = c && state.entries.get(c.id);
  const can = !!(c && c.meta && e && !e.loadError);
  $('castName').textContent = c ? `${c.name || '（名前未設定）'}（ID ${c.id}）` : '左の一覧からキャストを選んでください';
  const st = $('castState'); st.classList.remove('warn');
  if (!c) st.textContent = '';
  else if (!c.meta) { st.textContent = 'この人のプレビュー画像がまだありません（公開の反映を待って再読込してください）'; st.classList.add('warn'); }
  else if (e.loadError) { st.textContent = 'プレビュー画像を読み込めません（再読込してください）'; st.classList.add('warn'); }
  else if (!c.meta.source) { st.textContent = `立ち絵1枚目のファイル名（${c.id}_KVnn）が読めないため調整できません（自動の切り抜きのまま）`; st.classList.add('warn'); }
  else if (e.mode === 'stale') {
    const s = savedOf(c.id);
    st.textContent = `立ち絵1枚目が変わったため（調整したのは ${s ? `${s.source} ${s.w}×${s.h}` : '?'}、いまは ${c.meta.source} ${c.meta.w}×${c.meta.h}）、自動の切り抜きで表示しています。動かすと新しい立ち絵で調整し直せます（次に保存するとき古い調整は消えます）`;
    st.classList.add('warn');
  }
  else st.textContent = (e.mode === 'manual' ? '調整済み' : '自動の切り抜き（未調整）') + `・立ち絵 ${c.meta.source}` + (isDirtyId(c.id) ? '・未保存' : '');
  const editable = can && !!c.meta.source;
  $('zoom').disabled = !editable; $('autoBtn').disabled = !editable || e.mode === 'auto';
  $('revertBtn').disabled = !c || !isDirtyId(c.id);
  $('phone').tabIndex = editable ? 0 : -1;
  // 拡大の下限は「その立ち絵で拡大が効き始める値」（横長の絵は 1 より大きい。それより小さくしても絵が変わらないため）
  const zmin = c && c.meta ? minZoom(c.meta) : 0.5;
  // スライダーの目盛りは min から 0.01 刻みなので、min を 0.01 単位に切り下げる（1.00 などちょうどの値に戻せるように。
  // それより下は絵が変わらない範囲なので、実際の値は zoomFit が zmin にそろえる）
  $('zoom').min = String(Math.floor(zmin * 100) / 100);
  $('zoomMin').textContent = c && c.meta ? `いちばん引いた状態: ${zmin.toFixed(2)}倍` : '';
  // 表示は実際に効いている値（保存値が下限より小さくても、絵は下限と同じなので下限を出す）
  if (e) { const shown = Math.max(e.fit.zoom, zmin); $('zoom').value = shown; $('zoomVal').textContent = shown.toFixed(2) + '倍'; } else $('zoomVal').textContent = '';
  const box = editable ? entryBox(c.meta, e) : null;
  const low = !!(box && isLowRes(box));
  $('qualityWarn').hidden = !low;
  $('qualityWarn').textContent = low ? `拡大しすぎて画像が粗くなります（切り出す幅 ${box[2] - box[0]}px・目安 ${LOW_RES_PX}px 以上）。保存はできます` : '';
  $('slide').style.setProperty('--bg', (c && c.accent) || '#ffd93b');
}

// ドラッグ・ホイールのたびに画面を作り直すと重いので、1フレームに1回へまとめる
// （値が変わった人の一覧の項目・右側の操作欄・保存ボタン・プレビューの描画）
let renderQueued = false;
const pendingItems = new Set();
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    if (pendingItems.size) {
      for (const id of pendingItems) refreshItem(id);
      pendingItems.clear();
      renderControls(); refreshDirty();
    }
    render();
  });
}

async function render() {
  const c = castById(state.selected), e = c && state.entries.get(c.id);
  const crop = $('crop'), ov = $('overview');
  if (!c || !c.meta || !e) { crop.getContext('2d').clearRect(0, 0, crop.width, crop.height); ov.getContext('2d').clearRect(0, 0, ov.width, ov.height); return; }
  let img;
  // 立ち絵を差し替えても URL は同じなので、寸法を付けてブラウザの古いキャッシュ（最大10分）を避ける
  try { img = await loadImage(`${c.meta.src}?v=${encodeURIComponent(`${c.meta.source}-${c.meta.w}x${c.meta.h}`)}`); e.loadError = false; }
  catch { if (!e.loadError) { e.loadError = true; renderControls(); refreshItem(c.id); } return; }
  if (state.selected !== c.id) return;   // 待っている間に別の人が選ばれた
  const m = c.meta, box = entryBox(m, e), out = outputSize(box);
  // 書き出される画像と同じ大きさのキャンバスに、同じ範囲を描く（表示は rank-slider.js と同じ object-fit: cover・上揃え）
  if (crop.width !== out.w || crop.height !== out.h) { crop.width = out.w; crop.height = out.h; }
  const kx = img.naturalWidth / m.w, ky = img.naturalHeight / m.h;
  const ctx = crop.getContext('2d');
  ctx.clearRect(0, 0, out.w, out.h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box[0] * kx, box[1] * ky, (box[2] - box[0]) * kx, (box[3] - box[1]) * ky, 0, 0, out.w, out.h);
  drawOverview(img, m, box);
}

// 立ち絵全体と、切り出す範囲（ピンク）・自動の範囲（点線）
function drawOverview(img, m, box) {
  const ov = $('overview'), W = 220, H = Math.max(80, Math.round(W * m.h / m.w));
  const h = Math.min(H, 440), w = Math.round(h * m.w / m.h);
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const ctx = ov.getContext('2d'), k = w / m.w;
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  // どちらも iPhone の画面で実際に見える範囲（切り出した画像のうち、画面の縦横比で切れる分を除く）
  const auto = visibleBox(autoBox(m.w, m.h, m.cx)), vis = visibleBox(box);   // autoBox はビルドの slider_crop_box と同じ
  ctx.save(); ctx.setLineDash([5, 4]); ctx.strokeStyle = '#555'; ctx.lineWidth = 1.5;
  ctx.strokeRect(auto[0] * k, auto[1] * k, (auto[2] - auto[0]) * k, (auto[3] - auto[1]) * k); ctx.restore();
  ctx.strokeStyle = '#ff2d78'; ctx.lineWidth = 2.5;
  ctx.strokeRect(vis[0] * k, vis[1] * k, (vis[2] - vis[0]) * k, (vis[3] - vis[1]) * k);
}

// いまの選択の「画面上の 1px = トリム後の画像の何分の1 px か」（cover で拡大されている倍率）
function cssPerSrc(c, e) {
  const box = entryBox(c.meta, e), r = $('screen').getBoundingClientRect();
  return coverLayout(r.width, r.height, box[2] - box[0], box[3] - box[1]).scale;
}

function editable() {
  const c = castById(state.selected), e = c && state.entries.get(c.id);
  return c && c.meta && c.meta.source && e && !e.loadError ? { c, e } : null;
}

function changed(id) {
  pendingItems.add(id); scheduleRender();
}

// 編集の結果。切り出し枠が自動と同じになったら「自動」に戻す（触っただけ・戻しただけで手動の行を作らない）。
// 立ち絵が変わって自動に戻っている人（stale）は、その状態のまま（保存済みの古い行を勝手に消さない）
function setFit(c, e, fit) {
  e.fit = fit;
  if (isAutoBox(c.meta, fit)) e.mode = resolveState(savedOf(c.id), c.meta).mode === 'stale' ? 'stale' : 'auto';
  else e.mode = 'manual';
  changed(c.id);
}

// ドラッグ（1本指・マウス）で位置、2本指で拡大。gesture はいま進行中の操作の起点
const gesture = { pointers: new Map(), drag: null, pinch: null };

// ドラッグ・2本指の途中でホイール・キー・スライダーで値が変わったら、起点を「今の位置と今の値」で取り直す
// （取り直さないと、次の指の動きで押した時点の値に戻ってしまう）
function rebaseGesture() {
  const t = editable(); if (!t) return;
  const g = gesture;
  if (g.drag && g.pointers.has(g.drag.pointerId)) {
    const p = g.pointers.get(g.drag.pointerId);
    g.drag = { ...g.drag, x: p.x, y: p.y, fit: t.e.fit, k: cssPerSrc(t.c, t.e) };
  }
  if (g.pinch && g.pointers.size >= 2) {
    const [a, b] = [...g.pointers.values()];
    g.pinch = { ...g.pinch, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: t.e.fit.zoom };
  }
}

function bindPhone() {
  const phone = $('phone'), g = gesture, pointers = g.pointers;
  const startDrag = (t, pid, p) => { g.drag = { id: t.c.id, pointerId: pid, x: p.x, y: p.y, fit: t.e.fit, k: cssPerSrc(t.c, t.e) }; };
  phone.addEventListener('pointerdown', ev => {
    const t = editable(); if (!t) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { phone.setPointerCapture(ev.pointerId); } catch { /* 指を離した後 */ }
    if (pointers.size === 1) { startDrag(t, ev.pointerId, { x: ev.clientX, y: ev.clientY }); g.pinch = null; phone.classList.add('dragging'); }
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      g.pinch = { id: t.c.id, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: t.e.fit.zoom }; g.drag = null;
    }
  });
  phone.addEventListener('pointermove', ev => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const t = editable(); if (!t) return;
    if (g.drag && g.drag.id === t.c.id && g.drag.pointerId === ev.pointerId) {
      setFit(t.c, t.e, dragFit(t.c.meta, g.drag.fit, ev.clientX - g.drag.x, ev.clientY - g.drag.y, g.drag.k));
    } else if (g.pinch && g.pinch.id === t.c.id && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      setFit(t.c, t.e, zoomFit(t.c.meta, t.e.fit, g.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.dist));
    }
  });
  const end = ev => {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) { g.drag = null; g.pinch = null; phone.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      // 2本指から1本に戻ったら、残った指で続けてドラッグできるように始点を取り直す
      const t = editable(), [[pid, p]] = [...pointers.entries()];
      g.pinch = null;
      if (t) startDrag(t, pid, p); else g.drag = null;
    }
  };
  phone.addEventListener('pointerup', end); phone.addEventListener('pointercancel', end);
  phone.addEventListener('wheel', ev => {
    const t = editable(); if (!t) return;
    ev.preventDefault();
    setFit(t.c, t.e, zoomFit(t.c.meta, t.e.fit, t.e.fit.zoom * Math.exp(-ev.deltaY * 0.0015)));
    rebaseGesture();
  }, { passive: false });

  $('zoom').addEventListener('input', () => {
    const t = editable(); if (!t) return;
    setFit(t.c, t.e, zoomFit(t.c.meta, t.e.fit, Number($('zoom').value)));   // 範囲は zoomFit が minZoom〜4 にそろえる
    rebaseGesture();
  });

  // キーボード: 矢印で絵を動かす（Shift で大きく）、+ / - で拡大・縮小。日本語入力の変換中は何もしない
  phone.addEventListener('keydown', ev => {
    if (ev.isComposing || ev.keyCode === 229 || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const t = editable(); if (!t) return;
    const step = ev.shiftKey ? 20 : 3, k = cssPerSrc(t.c, t.e);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[ev.key]) setFit(t.c, t.e, dragFit(t.c.meta, t.e.fit, moves[ev.key][0], moves[ev.key][1], k));
    else if (ev.key === '+' || ev.key === '=' || ev.key === ';') setFit(t.c, t.e, zoomFit(t.c.meta, t.e.fit, t.e.fit.zoom * 1.05));
    else if (ev.key === '-' || ev.key === '_') setFit(t.c, t.e, zoomFit(t.c.meta, t.e.fit, t.e.fit.zoom / 1.05));
    else return;
    ev.preventDefault();
    rebaseGesture();
  });
  $('autoBtn').addEventListener('click', () => {
    const t = editable(); if (!t) return;
    t.e.mode = 'auto'; t.e.fit = autoFit(t.c.meta);
    changed(t.c.id);
  });
  $('revertBtn').addEventListener('click', () => {
    const c = castById(state.selected); if (!c || !c.meta) return;
    const e = state.entries.get(c.id), s = resolveState(savedOf(c.id), c.meta);
    e.mode = s.mode; e.fit = s.fit;
    changed(c.id);
  });
}

// ---------- 保存 ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));
const nameOf = id => (castById(id) || {}).name || `ID ${id}`;
// 409 のあと読み直しても、GitHub が少しの間古い sha を返すことがある。少し待って最大3回まで読み直して再試行する
const RETRY_WAITS_MS = [800, 1600, 2400];

// main の data/casts.json の立ち絵1枚目（source）。画面は公開サイト（デプロイ後）の slider-src.json を見ているので、
// 立ち絵を替えた直後（デプロイ前）は食い違う → その人は保存しない（古い寸法で保存して、次のビルドで黙って自動に戻るのを防ぐ）
async function loadMainSources() {
  const r = await api(`/repos/${OWNER}/${REPO}/contents/data/casts.json?ref=${BRANCH}`, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw authError('トークンで data/casts.json を読めませんでした (' + r.status + ')');
  if (!r.ok) throw new Error('立ち絵の確認のための data/casts.json を読めませんでした (' + r.status + ')。保存していません');
  // JSON でない・形が想定と違う → 保存しない（安全側）。英語の内部エラーではなく理由を日本語で出す
  const bad = new Error('main の data/casts.json が読めない／形式が想定と違うため保存を止めました（管理画面かリポジトリを確認してください）');
  let json;
  try { json = await r.json(); } catch { throw bad; }
  if (!json || typeof json !== 'object' || !Array.isArray(json.casts)) throw bad;
  const out = new Map();
  for (const c of json.casts) {
    if (!c || typeof c !== 'object' || c.cast_id === undefined || !c.manual || typeof c.manual !== 'object') throw bad;
    if (c.manual.portraits !== undefined && !Array.isArray(c.manual.portraits)) throw bad;
    const ports = c.manual.portraits || [];
    // 公開データ（showcase_lib.build_public_casts）と同じく、空の欄を除いた1枚目
    out.set(String(c.cast_id), sourceKey(ports.filter(Boolean)[0], c.cast_id));
  }
  return out;
}

async function onSave() {
  if (state.saving) return;
  let ids = dirtyIds();
  if (!ids.length) return;
  const mine = {};
  for (const id of ids) mine[id] = recordOf(id);   // 押した時点の値（保存中に動かした分は次の保存へ）
  state.saving = true; $('saveBtn').disabled = true; $('reloadBtn').disabled = true; setStatus('保存中…');
  let pending = [], main = null;
  try {
    if (!LOCAL) {
      // 公開待ちの立ち絵の人は保存から外す（ほかの人の分は保存する）
      main = await loadMainSources();
      pending = ids.filter(id => mine[id] && main.get(id) !== mine[id].source);
      ids = ids.filter(id => !pending.includes(id));
      for (const id of pending) delete mine[id];
      if (!ids.length) throw new Error(`${pending.map(nameOf).join('、')}: 立ち絵の更新が公開待ちです。数分〜10分後に再読込して調整し直してください（保存していません）`);
    }
    // 自分が変えた人＋使われなくなった行（消す）。base はいま保存しようとしている元のファイル。
    // 消すのは main と立ち絵が違い、かつ誰も触っていない行だけ（rowsToDelete）。main を読まないローカル確認モードでは消さない
    const loaded = state.saved.casts;
    const build = base => {
      const stale = main ? rowsToDelete(base.casts, loaded, main, state.casts.map(c => c.id), ids) : [];
      const all = [...ids, ...stale], rec = { ...mine };
      for (const id of stale) rec[id] = null;
      return { data: mergeSlider(base, rec, all), stale, all };
    };
    let plan = build(state.saved), text = serializeSlider(plan.data);
    parseSlider(text);   // 書く前に自分で検証
    let merged = false;
    const overwritten = new Set();   // 再試行のたびに見つけた「上書きした人」を積み上げる
    if (LOCAL) {
      download(new Blob([text], { type: 'application/json' }), 'slider.json');
    } else {
      let r = await putSlider(text, state.sha, plan.all);
      for (let i = 0; await isConflict(r); i++) {
        if (i >= RETRY_WAITS_MS.length) throw new Error('保存が続けて競合しました。少し待ってからもう一度「保存」を押してください（調整は消えていません）');
        // 他の人が先に保存した → 少し待って最新を読み直し、自分が変えた人の分だけ上書きして再試行
        await sleep(RETRY_WAITS_MS[i]);
        const latest = await loadSlider();   // ファイルごと壊れていたら例外 → 保存しない（変更は残る）
        // 読み直したファイルに、まだ見せていない壊れた行がある → 黙って消さずに止める。
        // 表示して見せたので、もう一度「保存」すれば（初回読み込みで壊れた行があったときと同じく）その行を消して保存する
        const unseen = latest.warnings.filter(w => !state.warnings.includes(w));
        if (unseen.length) {
          state.warnings = [...state.warnings, ...unseen];
          showFileWarn();
          throw new Error('他の人が保存した slider.json に壊れた値がありました（上の赤い欄）。保存を止めました（調整は消えていません）。'
            + 'GitHub で data/slider.json を直してから再読込するか、このままもう一度「保存」を押すと壊れた行を消して保存します');
        }
        // 同じ人をほかの人も直していた（しかも自分と違う値）→ 後勝ち（自分の値）で上書きする。誰を上書きしたかは知らせる
        // （公開待ちで外した人は ids に入っていないので対象外）
        for (const id of ids) {
          if (!sameRecord(latest.data.casts[id] || null, loaded[id] || null) && !sameRecord(latest.data.casts[id] || null, mine[id] || null)) overwritten.add(id);
        }
        plan = build(latest.data); text = serializeSlider(plan.data);
        r = await putSlider(text, latest.sha, plan.all);
        merged = true;
      }
      if (!r.ok) {
        const body = await r.json().catch(() => ({}));
        const msg = '保存に失敗しました (' + r.status + (body.message ? ': ' + body.message : '') + ')';
        throw (r.status === 401 || r.status === 403) ? authError(msg + '。トークンに書き込みの権限があるか確認してください') : new Error(msg);
      }
      state.sha = (await r.json()).content.sha;
    }
    const before = state.saved;
    state.saved = parseSlider(text).data;
    state.warnings = []; showFileWarn();   // 書いたファイルには壊れた行は無い（serializeSlider は正しい行だけ書く）
    // 消した stale の人は、画面でも「自動」にする
    // （自分の画面が古くて「調整済み」に見えていた人も。保存中にその人を動かしていたら、その編集は残す）
    for (const id of plan.stale) {
      const c = castById(id), en = state.entries.get(id);
      if (c && c.meta && en && sameRecordBox(desiredRecord(en, c.meta, before.casts[id] || null), before.casts[id] || null)) state.entries.set(id, { ...resolveState(null, c.meta), loadError: en.loadError });
    }
    if (merged) applyOthers(plan.all, before);
    state.saving = false;
    for (const c of state.casts) refreshItem(c.id);
    renderControls(); refreshDirty();
    const left = dirtyIds().length, names = [...overwritten].map(nameOf), staleNames = plan.stale.map(nameOf);
    setStatus((LOCAL ? 'slider.json をダウンロードしました（ローカル確認モード）' : '保存しました。公式サイトへの反映は数分〜10分ほどかかります（画像のキャッシュのため）')
      + (merged ? '。他の人の保存も取り込みました' : '')
      + (names.length ? `。${names.join('、')}の調整は、ほかの人の保存を上書きしました（${names.length}人）` : '')
      + (staleNames.length ? `。立ち絵が変わって使われなくなった ${staleNames.join('、')}の古い調整を消しました（${staleNames.length}人）` : '')
      + (pending.length ? `。${pending.map(nameOf).join('、')}は立ち絵の更新が公開待ちのため保存していません。数分〜10分後に再読込して調整し直してください` : '')
      + (left - pending.length > 0 ? `。保存中に変えた ${left - pending.length}人は未保存です` : ''), left > 0 || names.length > 0 || pending.length > 0);
  } catch (err) {
    setStatus('⚠ ' + err.message, true);
  } finally {
    state.saving = false; $('reloadBtn').disabled = false; $('saveBtn').disabled = !dirtyIds().length;
  }
}

// 競合を取り込んだあと: 自分が変えていない人は、他の人が保存した値で表示し直す（次の保存で古い値に戻さないため）。
// 「変えていない」= 画面の値が、取り込む前に読み込んでいた値のまま（保存中に動かした人はそのまま残す）
function applyOthers(mineIds, before) {
  for (const c of state.casts) {
    if (!c.meta || mineIds.includes(c.id)) continue;
    const e = state.entries.get(c.id), old = before.casts[c.id] || null;
    if (e && !sameRecord(desiredRecord(e, c.meta, old), old)) continue;
    state.entries.set(c.id, { ...resolveState(savedOf(c.id), c.meta), loadError: !!(e && e.loadError) });
  }
  scheduleRender();
}

// ---------- 起動 ----------
let loadSerial = 0;
async function load() {
  if (state.saving) { setStatus('保存が終わってから再読込してください'); return; }
  const serial = ++loadSerial;   // 連打されたら最後の読み込みだけを使う
  setStatus('読み込み中…'); $('appView').hidden = false; $('loginView').hidden = true; $('saveBtn').disabled = true;
  try {
    const [showcase, srcMeta, slider] = await Promise.all([loadShowcase(), loadSrcMeta(), loadSlider()]);
    if (serial !== loadSerial) return;
    state.casts = sliderCasts(showcase, srcMeta);
    state.saved = slider.data; state.sha = slider.sha; state.warnings = slider.warnings;
    state.entries = new Map();
    for (const c of state.casts) if (c.meta) state.entries.set(c.id, resolveState(savedOf(c.id), c.meta));
    if (state.selected && !castById(state.selected)) state.selected = null;
    if (!state.selected && state.casts.length) state.selected = state.casts[0].id;
    showFileWarn();
    buildList(); renderControls(); scheduleRender();
    const n = state.casts.filter(c => state.entries.get(c.id) && state.entries.get(c.id).mode === 'manual').length;
    const stale = state.casts.filter(c => state.entries.get(c.id) && state.entries.get(c.id).mode === 'stale').length;
    setStatus(`${state.casts.length}名を読み込みました（調整済み ${n}人${stale ? `・立ち絵が変わって自動に戻った ${stale}人` : ''}）`);
  } catch (err) {
    if (serial !== loadSerial) return;
    if (err.auth) { showLogin('⚠ ' + (err.base || err.message) + '。下の欄にトークンを入れ直してください'); return; }
    setStatus('⚠ ' + err.message, true);
  }
}


// slider.json の壊れた行の知らせ（初回読み込みと、保存の競合で読み直したときで同じ文言）
function showFileWarn() {
  const fw = $('fileWarn');
  fw.hidden = !state.warnings.length;
  fw.textContent = state.warnings.length ? `slider.json の壊れた値を無視しています（その人は自動の切り抜き。保存するとこの行は消えます）: ${state.warnings.join(' ／ ')}` : '';
}

function showLogin(msg) {
  $('appView').hidden = true; $('loginView').hidden = false; $('loginErr').textContent = msg || ''; setStatus('');
  // 読み込めている状態から「接続し直す」で来たときは、入れ直さずに戻れるようにする
  $('cancelLoginBtn').hidden = !(token() && state.casts.length && !LOCAL);
}

function init() {
  $('modeNote').hidden = !LOCAL;
  $('reconnectBtn').hidden = LOCAL;
  $('cancelLoginBtn').addEventListener('click', () => { $('loginView').hidden = true; $('appView').hidden = false; refreshDirty(); });
  $('reconnectBtn').addEventListener('click', () => {
    if (state.saving) return;
    if (dirtyIds().length && !confirm('未保存の変更があります。トークンを入れ直すと読み直すので、変更は消えます。続けますか？')) return;
    $('tokenInput').value = '';
    showLogin('GitHub のトークンを入れ直してください（manage.html・announce.html と共通です）');
  });
  $('saveBtn').addEventListener('click', onSave);
  $('reloadBtn').addEventListener('click', () => { if (!dirtyIds().length || confirm('未保存の変更を捨てて読み直しますか？')) { state.images.clear(); load(); } });
  $('loginBtn').addEventListener('click', () => {
    const t = $('tokenInput').value.trim();
    if (!t) { $('loginErr').textContent = 'トークンを入力してください'; return; }
    if (!TOKEN_RE.test(t)) { $('loginErr').textContent = 'トークンに使えない文字（全角・空白など）が入っています。コピーし直してください'; return; }
    try { localStorage.setItem(TOKEN_KEY, t); } catch { $('loginErr').textContent = 'このブラウザではトークンを保存できません'; return; }
    $('loginErr').textContent = '';
    load();
  });
  window.addEventListener('beforeunload', ev => { if (dirtyIds().length) { ev.preventDefault(); ev.returnValue = ''; } });
  window.addEventListener('resize', scheduleRender);
  bindPhone();
  bindListKeys();
  if (LOCAL || token()) load(); else showLogin();
}

init();
