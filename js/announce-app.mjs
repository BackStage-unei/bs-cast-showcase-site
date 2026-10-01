// ランク発表画像の編集画面（announce.html）。計算は announce-lib.mjs、ここは DOM・通信・canvas 描画だけ。
// 名簿 = data/casts.json（sync.yml が bs-data の承認ランクから作る）、調整値 = data/announce.json（この画面だけが書く）。
// 接続方式は manage.html と同じ（閲覧者の GitHub トークンで contents API。トークンは localStorage の同じキー）。
import {
  RANKS, rankedCasts, resolveEntry, defaultFit, cropRect, dragFit, guessFit, clampFit,
  computeLayout, bgSlices, panelSlices, headerRuns, fitFontPx, parseAnnounce, serializeAnnounce,
  exportFileName, monthLabel, defaultName, displayName, mergeAnnounce,
} from './announce-lib.mjs';

const OWNER = 'BackStage-unei', REPO = 'bs-cast-showcase', BRANCH = 'main';
const CASTS_PATH = 'data/casts.json', ANNOUNCE_PATH = 'data/announce.json';
const TOKEN_KEY = 'bs_cast_admin_token';
// ローカル確認用（make announce-dev）: リポジトリ直下を配信し dist/announce.html?local=1 で開く。保存はファイルのダウンロード
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && new URLSearchParams(location.search).has('local');
// 秀英初号明朝（Adobe Fonts）。Creative Cloud で有効化されていればブラウザからも使える
const FONT_CANDIDATES = ['DNPShueiShogoMinStd', 'DNP ShueiShogoMinStd', 'DNP 秀英初号明朝 Std', 'DNPShueiShogoMinStd-Hv'];
const FALLBACK_FONT = '"Hiragino Mincho ProN", "Yu Mincho", serif';
// 文字は4倍で描いてから縮める。Mac の Chrome は文字をそのまま描くと線を少し太らせるため、
// Photoshop で書き出した過去の画像より濃く見えた（文字の面積が約1割多い。2026-10-01 実測）
const TEXT_SCALE = 4;
// 小さい名前ほど Photoshop の書き出しは線が細い（文字は 29pt を変形で拡大しており、ブロンズは 1.13倍・ゴールドは 3.17倍）。
// 輪郭をランクごとにこの幅（発表画像の px）だけ削って合わせる。値は 7月版との文字の面積の実測で決めた
// 2026-10-01 実測: 削らないと 7月版より シルバー +6〜16%・ブロンズ +14〜26% 濃い。この値でランク平均がほぼ一致（名前ごとに ±1割の差は残る）
const TEXT_THIN = { GOLD: 0, SILVER: 0.14, BRONZE: 0.21 };
if (LOCAL) {   // 調整用（ローカル確認モードのみ）: ?thin=金,銀,銅
  const t = new URLSearchParams(location.search).get('thin');
  if (t) t.split(',').map(Number).forEach((v, i) => { if (Number.isFinite(v)) TEXT_THIN[RANKS[i]] = v; });
}

const $ = id => document.getElementById(id);
const state = {
  layout: null, month: '', casts: [], entries: new Map(), announce: { version: 1, casts: {} }, announceSha: null,
  images: new Map(), iconCache: new Map(), selected: null, font: null, base: null, baseKey: '', geo: null, rendered: null,
  // 触ったキャスト → 最後に触った通し番号。保存中に触った分を「保存済み」にしないために番号で見分ける
  touched: new Map(), editSeq: 0, saving: false, renderQueued: false,
};
const isDirty = () => state.touched.size > 0;

// ---------- 通信 ----------
function token() { try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; } }
const API_TIMEOUT_MS = 20000;
// GitHub API。通信が止まっても「保存中…」で固まらないよう 20 秒で打ち切る
async function api(path, opts = {}) {
  opts.headers = Object.assign({ Authorization: 'Bearer ' + token(), Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }, opts.headers || {});
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

async function loadCastsJson() {
  if (LOCAL) { const r = await fetch('../' + CASTS_PATH, { cache: 'no-store' }); if (!r.ok) throw new Error('casts.json を読めません (' + r.status + ')'); return r.json(); }
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${CASTS_PATH}?ref=${BRANCH}`, { headers: { Accept: 'application/vnd.github.raw+json' }, cache: 'no-store' });
  if (r.status === 401 || r.status === 403 || r.status === 404) throw Object.assign(new Error('トークンでリポジトリを読めませんでした (' + r.status + ')'), { auth: true });
  if (!r.ok) throw new Error('casts.json の取得に失敗しました (' + r.status + ')');
  return r.json();
}

async function loadAnnounce() {
  if (LOCAL) {
    const r = await fetch('../' + ANNOUNCE_PATH, { cache: 'no-store' });
    if (r.status === 404) return { data: { version: 1, casts: {} }, sha: null };
    if (!r.ok) throw new Error('announce.json を読めません (' + r.status + ')');
    return { data: parseAnnounce(await r.text()), sha: null };
  }
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${ANNOUNCE_PATH}?ref=${BRANCH}`, { cache: 'no-store' });
  if (r.status === 404) return { data: { version: 1, casts: {} }, sha: null };
  if (!r.ok) throw new Error('announce.json の取得に失敗しました (' + r.status + ')');
  const body = await r.json();
  return { data: parseAnnounce(b64decodeUtf8(body.content)), sha: body.sha };
}

function putAnnounce(text, sha) {
  const body = { message: `content: ランク発表画像の調整を保存（${state.month}）`, content: b64encodeUtf8(text), branch: BRANCH };
  if (sha) body.sha = sha;
  return api(`/repos/${OWNER}/${REPO}/contents/${ANNOUNCE_PATH}`, { method: 'PUT', body: JSON.stringify(body) });
}

// 保存。ids = 今回書くキャスト（触った人だけ。触っていない人は読み込んだ値のまま残す）。
// 競合（他の人が先に保存）したら最新を読み直し、ids の分だけ上書きして1回だけ再試行する。返り値は実際に書いた内容
async function saveAnnounce(ids) {
  const mine = buildAnnounceData(ids);
  let data = mergeAnnounce(state.announce, mine, ids);
  let text = serializeAnnounce(data);
  parseAnnounce(text);   // 書く前に自分で検証
  if (LOCAL) { download(new Blob([text], { type: 'application/json' }), 'announce.json'); return { data: parseAnnounce(text), merged: false }; }
  let r = await putAnnounce(text, state.announceSha), merged = false;
  if (await isConflict(r)) {
    const latest = await loadAnnounce();
    data = mergeAnnounce(latest.data, mine, ids);
    text = serializeAnnounce(data);
    r = await putAnnounce(text, latest.sha);
    merged = true;
    if (await isConflict(r)) throw new Error('保存が続けて競合しました。少し待ってからもう一度「調整を保存」を押してください（調整は消えていません）');
  }
  if (!r.ok) {
    const body = await r.json().catch(() => ({}));
    throw new Error('保存に失敗しました (' + r.status + (body.message ? ': ' + body.message : '') + ')');
  }
  state.announceSha = (await r.json()).content.sha;
  return { data: parseAnnounce(text), merged };
}

function download(blob, name) {
  const url = URL.createObjectURL(blob), a = document.createElement('a');
  a.href = url; a.download = name; document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

// ---------- 画像 ----------
// 読み込み失敗はキャッシュに残さない（新規の立ち絵は公開反映まで数分 404 になる。再読込で取り直せるように）
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

// 大きい画像を一度に小さく描くと粗くなるため、半分ずつ縮めてから描く（ルキチャレ結果画像ツールと同じ方式）
function drawSmooth(ctx, img, sx, sy, sw, sh, dx, dy, dw, dh) {
  let src = img, x = sx, y = sy, w = sw, h = sh;
  while (w / 2 > dw && h / 2 > dh) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w / 2)); c.height = Math.max(1, Math.round(h / 2));
    const cc = c.getContext('2d'); cc.imageSmoothingQuality = 'high';
    cc.drawImage(src, x, y, w, h, 0, 0, c.width, c.height);
    src = c; x = 0; y = 0; w = c.width; h = c.height;
  }
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, x, y, w, h, dx, dy, dw, dh);
}

// はみ出し（負の座標）を含む切り出しを描く。drawImage は画像外の範囲を含むと描かないため、重なる部分だけに絞る
function drawCrop(ctx, img, rect, dx, dy, size) {
  const W = img.naturalWidth || img.width, H = img.naturalHeight || img.height;
  const k = size / rect.size;
  const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y);
  const x1 = Math.min(W, rect.x + rect.size), y1 = Math.min(H, rect.y + rect.size);
  if (x1 <= x0 || y1 <= y0) return;
  drawSmooth(ctx, img, x0, y0, x1 - x0, y1 - y0, dx + (x0 - rect.x) * k, dy + (y0 - rect.y) * k, (x1 - x0) * k, (y1 - y0) * k);
}

// 丸く切り抜いたアイコン（地色＋画像）。ドラッグ中も変わった人以外は縮小をやり直さないようにキャッシュする
async function iconCanvas(id, entry, rank, size) {
  const disk = state.layout.disk[rank];
  // キャッシュは「キャスト×大きさ」ごとに最新の1枚だけ（ドラッグのフレームごとに溜めない）
  const key = `${id}|${size}`, sig = [entry.url, entry.fit && entry.fit.x, entry.fit && entry.fit.y, entry.fit && entry.fit.zoom, disk.join(',')].join('|');
  const hit = state.iconCache.get(key);
  if (hit && hit.sig === sig) return hit.canvas;
  const c = document.createElement('canvas'); c.width = size; c.height = size;
  const ctx = c.getContext('2d');
  ctx.beginPath(); ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2); ctx.clip();
  ctx.fillStyle = `rgb(${disk.join(',')})`; ctx.fillRect(0, 0, size, size);
  if (entry.url && entry.fit) {
    try { const img = await loadImage(entry.url); drawCrop(ctx, img, cropRect(img.naturalWidth, img.naturalHeight, entry.fit), 0, 0, size); }
    catch { return c; }   // 読めない画像はキャッシュしない（地色の丸だけ返す）
  }
  state.iconCache.set(key, { sig, canvas: c });
  return c;
}

function alphaGrid(img, gw = 64) {
  const W = img.naturalWidth, H = img.naturalHeight, gh = Math.max(1, Math.round(gw * H / W));
  const c = document.createElement('canvas'); c.width = gw; c.height = gh;
  const ctx = c.getContext('2d', { willReadFrequently: true }); ctx.drawImage(img, 0, 0, gw, gh);
  const d = ctx.getImageData(0, 0, gw, gh).data, a = new Uint8Array(gw * gh);
  for (let i = 0; i < a.length; i++) a[i] = d[i * 4 + 3];
  return { a, gw, gh };
}

// ---------- フォント ----------
function detectFont() {
  const c = document.createElement('canvas').getContext('2d'), sample = 'キャストランク発表2026年鹿鳴りあ';
  const width = f => { c.font = `40px ${f}`; return c.measureText(sample).width; };
  const base = width('serif');
  for (const f of FONT_CANDIDATES) {
    const w = [width(`"${f}", serif`), width(`"${f}", sans-serif`), width(`"${f}", monospace`)];
    if (w[0] === w[1] && w[1] === w[2] && w[0] !== base) return `"${f}"`;
  }
  return null;
}
const fontStack = () => (state.font ? state.font + ', ' : '') + FALLBACK_FONT;

// ---------- 描画 ----------
// box（発表画像の座標）の範囲を TEXT_SCALE 倍の別キャンバスに描き、縮めて貼る。draw(c, k) は元の座標のまま描けばよい（k = 倍率）
function drawHiRes(ctx, box, draw) {
  const k = TEXT_SCALE;
  if (k <= 1) { draw(ctx, 1); return; }
  const x = Math.floor(box.x), y = Math.floor(box.y), w = Math.ceil(box.x + box.w) - x, h = Math.ceil(box.y + box.h) - y;
  const c = document.createElement('canvas'); c.width = w * k; c.height = h * k;
  const cc = c.getContext('2d');
  cc.setTransform(k, 0, 0, k, -x * k, -y * k);
  draw(cc, k);
  drawSmooth(ctx, c, 0, 0, c.width, c.height, x, y, w, h);
}

async function drawBase(geo) {
  const L = state.layout, key = JSON.stringify([geo.height, geo.panels, state.month, state.font]);
  if (state.baseKey === key && state.base) return state.base;
  const c = document.createElement('canvas'); c.width = L.width; c.height = geo.height;
  const ctx = c.getContext('2d');
  const bg = await loadImage('announce/bg.webp');
  for (const [sy, sh, dy, dh] of bgSlices(L, geo.lastBottom)) if (sh > 0 && dh > 0) ctx.drawImage(bg, 0, sy, L.width, sh, 0, dy, L.width, dh);
  for (const p of geo.panels) {
    const spec = L.ranks[p.rank].panel, img = await loadImage(`announce/panel_${p.rank}.webp`);
    const dstH = p.h + 2 * spec.margin;
    for (const [sy, sh, dy, dh] of panelSlices(spec, dstH)) if (sh > 0 && dh > 0) ctx.drawImage(img, 0, sy, spec.w, sh, spec.x, p.y - spec.margin + dy, spec.w, dh);
  }
  drawHeader(ctx);
  state.base = c; state.baseKey = key;
  return c;
}

function drawHeader(ctx) {
  const h = state.layout.header, chars = [];
  for (const run of headerRuns(state.month, h.pt)) {
    const px = run.pt * h.scale;
    ctx.font = `${px}px ${fontStack()}`;
    for (const ch of run.text) chars.push({ ch, px, w: ctx.measureText(ch).width, sp: px * h.tracking / 1000 });
  }
  const total = chars.reduce((s, c) => s + c.w + c.sp, 0) - chars[chars.length - 1].sp;
  const put = (target, fill) => {
    let x = h.cx - total / 2;
    target.fillStyle = fill;
    for (const c of chars) { target.font = `${c.px}px ${fontStack()}`; target.fillText(c.ch, x, h.baseline); x += c.w + c.sp; }
  };
  // 影（ぼかした文字）→ グラデーションの文字。ぼかしの半径は描くキャンバスの画素単位なので倍率を掛ける
  const sh = h.shadow, pad = sh.blur * 4;
  const box = { x: h.cx - total / 2 - pad, y: h.box[1] - pad - 20, w: total + pad * 2, h: h.box[3] - h.box[1] + pad * 2 + 40 };
  drawHiRes(ctx, box, (c, k) => {
    c.save(); c.filter = `blur(${sh.blur * k}px)`; put(c, `rgba(${sh.rgb.join(',')},${sh.alpha})`); c.restore();
    const g = c.createLinearGradient(0, h.box[1], 0, h.box[3]);
    for (const s of h.gradient) g.addColorStop(s.t, `rgb(${s.rgb.join(',')})`);
    c.save(); put(c, g); c.restore();
  });
}

function slotGeometry(rank, slot) {
  const it = state.layout.ranks[rank].item;
  return { cx: slot.x + it.icon_pos[0] + it.icon_size / 2, cy: slot.y + it.icon_pos[1] + it.icon_size / 2, r: it.icon_size / 2 };
}

async function drawItem(ctx, rank, slot, entry, cast) {
  const L = state.layout, it = L.ranks[rank].item;
  ctx.drawImage(await iconCanvas(cast.id, entry, rank, it.icon_size), slot.x + it.icon_pos[0], slot.y + it.icon_pos[1]);
  const [frame, line] = await Promise.all([loadImage(`announce/frame_${rank}.png`), loadImage(`announce/line_${rank}.png`)]);
  ctx.drawImage(frame, slot.x, slot.y);
  ctx.drawImage(line, slot.x + it.line_pos[0], slot.y + it.line_pos[1]);
  ctx.font = `${it.name_px}px ${fontStack()}`;
  const label = displayName(entry.name, cast.name, cast.id);
  const px = fitFontPx(it.name_px, ctx.measureText(label).width, it.name_maxw);
  ctx.font = `${px}px ${fontStack()}`;
  // 縦位置: 漢字「国」の墨の中心を、PSD の文字の中心に合わせる
  const m = ctx.measureText('国'), w = ctx.measureText(label).width;
  const cx = slot.x + it.name_cx, base = slot.y + it.name_cy + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2;
  drawHiRes(ctx, { x: cx - w / 2 - px * 0.2, y: base - px * 1.2, w: w + px * 0.4, h: px * 1.6 }, c => {
    c.fillStyle = `rgb(${L.name_color.join(',')})`; c.textAlign = 'center'; c.textBaseline = 'alphabetic';
    c.font = `${px}px ${fontStack()}`;
    c.fillText(label, cx, base);
    const thin = TEXT_THIN[rank];
    if (thin > 0) {   // 輪郭を削る（このキャンバスには文字しか無いので、背景は消えない）
      c.save(); c.globalCompositeOperation = 'destination-out'; c.lineWidth = thin * 2; c.lineJoin = 'round';
      c.strokeText(label, cx, base); c.restore();
    }
  });
}

// いまの状態から完成画像を1枚作る（プレビューと書き出しで共通。途中で状態が変わっても、この呼び出しの時点の内容で作り切る）
async function composeCanvas() {
  const casts = state.casts.slice(), entries = new Map([...state.entries].map(([k, v]) => [k, { ...v }]));
  const counts = {};
  for (const c of casts) counts[c.rank] = (counts[c.rank] || 0) + 1;
  const geo = computeLayout(state.layout, counts);
  const base = await drawBase(geo);
  const c = document.createElement('canvas'); c.width = base.width; c.height = base.height;
  const ctx = c.getContext('2d'); ctx.drawImage(base, 0, 0);
  const idx = {};
  for (const cast of casts) {
    const i = idx[cast.rank] = (idx[cast.rank] ?? -1) + 1;
    await drawItem(ctx, cast.rank, geo.slots[cast.rank][i], entries.get(cast.id), cast);
  }
  return { canvas: c, geo, casts };
}

let renderSerial = 0, rendering = false, renderAgain = false;
async function render() {
  if (rendering) { renderAgain = true; return; }   // 描いている間の変更は、終わってから1回だけ描き直す
  rendering = true;
  try {
    do { renderAgain = false; await renderOnce(); } while (renderAgain);
  } finally { rendering = false; }
}
async function renderOnce() {
  const serial = ++renderSerial;
  const out = await composeCanvas();
  if (serial !== renderSerial) return;   // 再読込などで別の描画が始まっていたら古い結果は捨てる
  const view = $('preview');
  if (view.width !== out.canvas.width || view.height !== out.canvas.height) { view.width = out.canvas.width; view.height = out.canvas.height; }
  state.geo = out.geo; state.geoCasts = out.casts; state.rendered = out.canvas;
  drawSelection();
  drawEditor();
}

// ドラッグ・ホイール・入力のたびに描くと重いので、1フレームに1回へまとめる
function scheduleRender() {
  if (state.renderQueued) return;
  state.renderQueued = true;
  requestAnimationFrame(() => { state.renderQueued = false; render(); });
}

function drawSelection() {
  const out = $('preview'), ctx = out.getContext('2d');
  if (!state.rendered) return;
  ctx.drawImage(state.rendered, 0, 0);
  const g = state.selected && hitGeometry().find(h => h.id === state.selected);
  if (!g) return;
  ctx.save(); ctx.strokeStyle = '#ff2d78'; ctx.lineWidth = 6; ctx.setLineDash([14, 10]);
  ctx.beginPath(); ctx.arc(g.cx, g.cy, g.r + 10, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
}

// プレビューに描かれている並び（state.geo と同じ時点の名簿）で当たり判定を作る。再読込中に名簿だけ変わっても食い違わない
function hitGeometry() {
  if (!state.geo || !state.geoCasts) return [];
  const out = [], idx = {};
  for (const cast of state.geoCasts) {
    const i = idx[cast.rank] = (idx[cast.rank] ?? -1) + 1;
    const slot = state.geo.slots[cast.rank] && state.geo.slots[cast.rank][i];
    if (slot) out.push({ id: cast.id, ...slotGeometry(cast.rank, slot) });
  }
  return out;
}

// 選んだキャストのアイコンを大きく描く（プレビュー上のブロンズは小さく、ドラッグが粗くなるため）
async function drawEditor() {
  const c = $('editor'), id = state.selected;
  const cast = state.casts.find(x => x.id === id), e = id && state.entries.get(id);
  if (!cast || !e) {
    c.getContext('2d').clearRect(0, 0, c.width, c.height);
    $('editorName').textContent = '左の一覧かプレビューでキャストを選んでください';
    return;
  }
  const icon = await iconCanvas(id, e, cast.rank, c.width);
  if (state.selected !== id) return;   // 待っている間に別の人が選ばれた
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(icon, 0, 0);
  $('editorName').textContent = `${displayName(e.name, cast.name, cast.id)}（${cast.rank}）` + (e.loadError ? ' ⚠ 画像を読み込めません' : '');
}

// ---------- 一覧（左） ----------
function buildList() {
  const list = $('castList'); list.replaceChildren();
  for (const rank of RANKS) {
    const casts = state.casts.filter(c => c.rank === rank);
    if (!casts.length) continue;
    const h = document.createElement('h3'); h.className = 'rank-head rank-' + rank; h.textContent = `${rank}（${casts.length}名）`;
    list.append(h);
    for (const cast of casts) list.append(castCard(cast));
  }
}

function castCard(cast) {
  const e = state.entries.get(cast.id);
  const card = document.createElement('div'); card.className = 'card'; card.dataset.id = cast.id;
  if (cast.id === state.selected) card.classList.add('selected');
  card.addEventListener('click', ev => { if (ev.target === card || ev.target.classList.contains('card-title')) select(cast.id); });

  const title = document.createElement('div'); title.className = 'card-title';
  title.textContent = `${cast.name || '（名前未設定）'}（ID ${cast.id}）`;
  if (!cast.published) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = '新規・非公開'; title.append(b); }
  if (!e.source) { const b = document.createElement('span'); b.className = 'badge warn'; b.textContent = '画像なし'; title.append(b); }
  else if (e.loadError) { const b = document.createElement('span'); b.className = 'badge warn'; b.textContent = '画像を読み込めません'; title.append(b); }
  card.append(title);

  const nameLabel = document.createElement('label'); nameLabel.textContent = '表示名';
  const name = document.createElement('input'); name.type = 'text'; name.maxLength = 40; name.value = e.name;
  name.addEventListener('input', () => { e.name = name.value; markDirty(cast.id); scheduleRender(); });
  nameLabel.append(name); card.append(nameLabel);

  const srcLabel = document.createElement('label'); srcLabel.textContent = '画像';
  const sel = document.createElement('select');
  for (const o of e.options) { const op = document.createElement('option'); op.value = o.key; op.textContent = o.label; sel.append(op); }
  sel.value = e.source || ''; sel.disabled = !e.options.length;
  sel.addEventListener('change', async () => {
    const opt = e.options.find(o => o.key === sel.value);
    e.source = opt.key; e.url = opt.url; e.fit = defaultFit(opt.key); e.loadError = false;
    await ensureFit(e); markDirty(cast.id); syncZoom(cast.id); scheduleRender();
  });
  srcLabel.append(sel); card.append(srcLabel);

  const zoomLabel = document.createElement('label'); zoomLabel.textContent = '拡大';
  const zoom = document.createElement('input'); zoom.type = 'range'; zoom.min = '0.5'; zoom.max = '12'; zoom.step = '0.01';
  zoom.value = e.fit ? e.fit.zoom : 1; zoom.disabled = !e.fit; zoom.className = 'zoom';
  zoom.addEventListener('input', () => { if (!e.fit) return; e.fit = clampFit({ ...e.fit, zoom: Number(zoom.value) }); markDirty(cast.id); scheduleRender(); });
  zoomLabel.append(zoom); card.append(zoomLabel);

  const reset = document.createElement('button'); reset.type = 'button'; reset.textContent = '初期位置に戻す';
  reset.addEventListener('click', async () => { e.fit = defaultFit(e.source); e.loadError = false; await ensureFit(e); markDirty(cast.id); syncZoom(cast.id); scheduleRender(); });
  card.append(reset);
  return card;
}

function refreshCard(id) {
  const old = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`), cast = state.casts.find(c => c.id === id);
  if (old && cast) old.replaceWith(castCard(cast));
}

function syncZoom(id) {
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  const e = state.entries.get(id);
  if (!card || !e) return;
  const z = card.querySelector('input.zoom'); z.disabled = !e.fit; if (e.fit) z.value = e.fit.zoom;
}

function select(id) {
  state.selected = id;
  for (const el of document.querySelectorAll('.card')) el.classList.toggle('selected', el.dataset.id === id);
  const card = document.querySelector(`.card[data-id="${CSS.escape(id)}"]`);
  if (card) card.scrollIntoView({ block: 'nearest' });
  drawSelection();
  drawEditor();
}

function markDirty(id) {
  state.touched.set(id, ++state.editSeq);
  $('saveBtn').disabled = state.saving;
  setStatus('未保存の変更があります');
}
function setStatus(t) { $('status').textContent = t; }

// 立ち絵で切り出しが未定（初回）のときは、画像の不透明部分から顔位置を推定する。
// 画像を読めないときは推定値をでっち上げない（保存すると、公開反映後も誤った位置が残るため）。印を付けて一覧に出す
async function ensureFit(e) {
  if (!e.url) return;
  try {
    const img = await loadImage(e.url);
    e.loadError = false;
    if (!e.fit) { const g = alphaGrid(img); e.fit = guessFit(g.a, g.gw, g.gh, img.naturalWidth, img.naturalHeight); }
  } catch { e.loadError = true; }
}

// ---------- プレビュー上の操作（ドラッグで移動・ホイールで拡大） ----------
function canvasPoint(ev) {
  const c = $('preview'), r = c.getBoundingClientRect();
  return { x: (ev.clientX - r.left) * c.width / r.width, y: (ev.clientY - r.top) * c.height / r.height };
}
function hitAt(p) {
  return hitGeometry().find(g => (p.x - g.cx) ** 2 + (p.y - g.cy) ** 2 <= (g.r + 6) ** 2) || null;
}

// ドラッグの共通処理。toCircle は「ポインタの移動量を丸の大きさで割る」ための丸の直径（表示上の単位）
function startDrag(target, getPoint, getHit) {
  let drag = null, pressed = false;
  target.addEventListener('pointerdown', async ev => {
    pressed = true;
    const hit = getHit(ev);
    if (!hit) return;
    if (hit.id !== state.selected) select(hit.id);
    const e = state.entries.get(hit.id);
    if (!e || !e.fit || !e.url) return;
    const p = getPoint(ev), pointerId = ev.pointerId;
    const img = await loadImage(e.url).catch(() => null);
    if (!img || !pressed) return;   // 画像を待つ間にボタンを離していたら始めない
    drag = { id: hit.id, x: p.x, y: p.y, fit: e.fit, img, size: hit.size };
    try { target.setPointerCapture(pointerId); } catch { /* 指を離した後 */ }
  });
  target.addEventListener('pointermove', ev => {
    if (!drag) return;
    if (ev.buttons === 0) { end(); return; }
    const p = getPoint(ev), e = state.entries.get(drag.id);
    if (!e || !e.fit) { drag = null; return; }
    // 位置は押した時点からの移動量、拡大率はいまの値（ドラッグ中のホイールを打ち消さない）
    e.fit = dragFit({ ...drag.fit, zoom: e.fit.zoom }, drag.img.naturalWidth, drag.img.naturalHeight, p.x - drag.x, p.y - drag.y, drag.size);
    markDirty(drag.id); scheduleRender();
  });
  function end() { pressed = false; if (drag) syncZoom(drag.id); drag = null; }
  target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
}

function wheelZoom(target, getId) {
  target.addEventListener('wheel', ev => {
    const id = getId(ev), e = id && state.entries.get(id);
    if (!e || !e.fit) return;
    ev.preventDefault();
    if (id !== state.selected) select(id);
    e.fit = clampFit({ ...e.fit, zoom: e.fit.zoom * Math.exp(-ev.deltaY * 0.0015) });
    syncZoom(id); markDirty(id); scheduleRender();
  }, { passive: false });
}

function bindPreview() {
  const c = $('preview');
  startDrag(c, canvasPoint, ev => { const h = hitAt(canvasPoint(ev)); return h && { id: h.id, size: h.r * 2 }; });
  wheelZoom(c, ev => { const h = hitAt(canvasPoint(ev)); return h && h.id; });
}

function bindEditor() {
  const c = $('editor');
  const point = ev => ({ x: ev.clientX, y: ev.clientY });
  startDrag(c, point, () => state.selected && { id: state.selected, size: c.getBoundingClientRect().width });
  wheelZoom(c, () => state.selected);
}

// ---------- 保存・書き出し ----------
function buildAnnounceData(ids) {
  const casts = {};
  for (const id of ids) {
    const cast = state.casts.find(c => c.id === id), e = state.entries.get(id);
    if (!cast || !e) continue;
    const v = {};
    if (e.source) v.source = e.source;
    if (e.name.trim() && e.name.trim() !== defaultName(cast.name)) v.name = e.name.trim();
    if (e.fit) Object.assign(v, e.fit);
    casts[id] = v;
  }
  return { version: 1, updated_month: state.month, casts };
}

async function onSave() {
  if (state.saving || !isDirty()) return;
  const snapshot = new Map(state.touched);   // 保存中に触った分は保存済みにしない
  state.saving = true; $('saveBtn').disabled = true; $('reloadBtn').disabled = true; setStatus('保存中…');
  try {
    const { data, merged } = await saveAnnounce(new Set(snapshot.keys()));
    state.announce = data;
    for (const [id, seq] of snapshot) if (state.touched.get(id) === seq) state.touched.delete(id);
    if (merged) await applyOthersChanges();
    setStatus((LOCAL ? 'announce.json をダウンロードしました（ローカル確認モード）' : '保存しました（data/announce.json）')
      + (merged ? '。他の人の保存も取り込みました' : '') + (isDirty() ? '。保存中の変更は未保存です' : ''));
  } catch (err) { setStatus('⚠ ' + err.message); }
  finally { state.saving = false; $('saveBtn').disabled = !isDirty(); $('reloadBtn').disabled = false; }
}

// 競合を取り込んだあと: 自分が触っていない人は、他の人が保存した値で表示し直す（次の保存で古い値に戻さないため）
async function applyOthersChanges() {
  for (const cast of state.casts) {
    if (state.touched.has(cast.id)) continue;
    const e = resolveEntry(state.announce.casts[cast.id], cast, state.layout.past_icons || []);
    await ensureFit(e);
    if (state.touched.has(cast.id)) continue;   // 画像を待っている間にユーザーが触った → その編集を優先
    state.entries.set(cast.id, e);
    refreshCard(cast.id);
  }
  scheduleRender();
}

async function onExport() {
  const btn = $('exportBtn'); btn.disabled = true; setStatus('書き出し中…');
  try {
    const { canvas } = await composeCanvas();   // 押した時点の内容で作り切る（途中の変更で古い絵にならない）
    const blob = await new Promise(res => canvas.toBlob(res, 'image/png'));
    if (!blob) throw new Error('画像を作れませんでした');
    download(blob, exportFileName(state.month));
    setStatus(state.font ? '書き出しました' : '書き出しました（⚠ 秀英初号明朝が無いため代わりの字体です）');
  } catch (err) { setStatus('⚠ ' + err.message); }
  finally { btn.disabled = false; }
}

// ---------- 起動 ----------
let loadSerial = 0;
async function load() {
  if (state.saving) { setStatus('保存が終わってから再読込してください'); return; }
  const serial = ++loadSerial;   // 連打されたら最後の読み込みだけを使う
  setStatus('読み込み中…'); $('appView').hidden = false; $('loginView').hidden = true;
  try {
    const [layout, castsJson, ann] = await Promise.all([
      fetch('announce/layout.json', { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error('layout.json を読めません'); return r.json(); }),
      loadCastsJson(), loadAnnounce(),
    ]);
    if (serial !== loadSerial) return;
    state.layout = layout; state.announce = ann.data; state.announceSha = ann.sha;
    state.month = castsJson.meta && castsJson.meta.rank_month;
    $('month').textContent = monthLabel(state.month) + 'のランク';
    const casts = rankedCasts(castsJson), entries = new Map();
    for (const cast of casts) entries.set(cast.id, resolveEntry(state.announce.casts[cast.id], cast, layout.past_icons || []));
    await Promise.all([...entries.values()].map(ensureFit));
    if (serial !== loadSerial) return;
    state.geo = null; state.geoCasts = null;
    state.casts = casts; state.entries = entries;
    state.touched = new Map(); state.base = null; state.iconCache.clear();
    if (state.selected && !entries.has(state.selected)) state.selected = null;
    $('saveBtn').disabled = true;
    buildList();
    await render();
    const missing = casts.filter(c => !entries.get(c.id).source).map(c => displayName('', c.name, c.id));
    const broken = casts.filter(c => entries.get(c.id).loadError).map(c => displayName('', c.name, c.id));
    setStatus(`${casts.length}名を読み込みました` + (missing.length ? `（画像なし: ${missing.join('、')}）` : '')
      + (broken.length ? `（画像を読み込めない: ${broken.join('、')}。公開反映を待って再読込）` : ''));
  } catch (err) {
    if (serial !== loadSerial) return;
    if (err.auth) { showLogin('⚠ ' + err.message); return; }
    setStatus('⚠ ' + err.message);
  }
}

function showLogin(msg) {
  $('appView').hidden = true; $('loginView').hidden = false; $('loginErr').textContent = msg || '';
}

function init() {
  state.font = detectFont();
  $('fontWarn').hidden = !!state.font;
  $('modeNote').hidden = !LOCAL;
  $('saveBtn').addEventListener('click', onSave);
  $('exportBtn').addEventListener('click', onExport);
  $('reloadBtn').addEventListener('click', () => { if (!isDirty() || confirm('未保存の変更を捨てて読み直しますか？')) { state.images.clear(); load(); } });
  $('loginBtn').addEventListener('click', () => {
    const t = $('tokenInput').value.trim();
    if (!t) { $('loginErr').textContent = 'トークンを入力してください'; return; }
    try { localStorage.setItem(TOKEN_KEY, t); } catch { $('loginErr').textContent = 'このブラウザではトークンを保存できません'; return; }
    load();
  });
  window.addEventListener('beforeunload', ev => { if (isDirty()) { ev.preventDefault(); ev.returnValue = ''; } });
  bindPreview();
  bindEditor();
  if (LOCAL || token()) load(); else showLogin();
}

init();
