// スライダーの切り抜き・DM 通知の顔の位置の調整画面（slider.html）。計算は slider-lib.mjs、ここは DOM・通信・canvas 描画だけ。
// 名簿 = 公開中の casts-data.js（スライダーに出る人＝立ち絵ありの人。DM 通知に出る人も同じ）、寸法 = slider-src.json（build_slider.py が作る）、
// 調整値 = data/slider.json（スライダー）と data/dm-faces.json（DM の顔）。どちらもこの画面だけが書く。
// 2つのファイルは同じ形・同じ仕組み（保存・競合・公開待ち・立ち絵の差し替え・壊れた行）で扱い、違う所は kind（下の KIND_UI と lib の KINDS）に寄せる。
// 接続方式は manage.html・announce.html と同じ（閲覧者の GitHub トークンで contents API。トークンは localStorage の同じキー）。
import {
  autoBox, entryBox, outputSize, autoFit, dragFit, zoomFit, coverLayout, parseAdjust, serializeAdjust, mergeSlider,
  resolveState, desiredRecord, sameRecord, sameRecordBox, rowsToDelete, sourceKey, sliderCasts, commitMessage, minZoom, isAutoBox,
  visibleBox, isLowRes, LOW_RES_PX, KINDS, dmResolveState, dmDesiredRecord, dmYMax, sameDmLook,
} from './slider-lib.mjs';

const OWNER = 'BackStage-unei', REPO = 'bs-cast-showcase', BRANCH = 'main';
const TOKEN_KEY = 'bs_cast_admin_token';
const RANKS = ['GOLD', 'SILVER', 'BRONZE'];
const PARAMS = new URLSearchParams(location.search);
// ローカル確認用（make slider-dev）: リポジトリ直下を配信し dist/slider.html?local=1 で開く。保存はファイルのダウンロード
const LOCAL = /^(127\.0\.0\.1|localhost)$/.test(location.hostname) && PARAMS.has('local');
// ローカル確認モードだけ: ?slider=・?dm=<dist からの相対パス> で data/ の代わりに読む（一致の確認用）
// 同じサーバの中の相対パスだけ（// で始まる別サイトや .. は受け付けない）
const localPath = (param, kind) => {
  const v = PARAMS.get(param) || '';
  return LOCAL && /^\w[\w./-]*\.json$/.test(v) && !v.includes('..') ? v : '../' + kind.path;
};
// embed/dm-notice.js（本物と同じ計算・CSS・マークアップ）。読めなかったときは DM の顔だけ使えなくし、スライダーは使えるようにする
const DmLib = window.BsDmNotice || null;

// 種類ごとの違い（計算は lib、ここは画面の言葉と操作）
const KIND_UI = {
  slider: {
    kind: KINDS.slider, localFile: localPath('slider', KINDS.slider),
    resolve: resolveState, desired: desiredRecord, sameForDirty: sameRecordBox,
    isAuto: (meta, fit) => isAutoBox(meta, fit), autoFit: meta => autoFit(meta),
    autoLabel: '自動に戻す', autoWord: '自動の切り抜き（未調整）', staleWord: '自動の切り抜き', autoBadge: '',
  },
  dm: {
    kind: KINDS.dm, localFile: localPath('dm', KINDS.dm),
    // 未保存の判定は見た目（丸の中の切り抜き）で比べる（拡大スライダーの 0.01 刻みで触って戻しただけを変更と数えない）
    resolve: dmResolveState, desired: dmDesiredRecord, sameForDirty: sameDmLook,
    isAuto: (meta, fit) => DmLib.isDefault(fit), autoFit: () => ({ ...DmLib.DEFAULT_CROP }),
    // 既定 {x .5, y .5, size 1} は画像の上の部分（幅いっぱいの丸）。中央ではない
    autoLabel: '既定に戻す', autoWord: '未登録（画像の上の部分）', staleWord: '既定の切り抜き（画像の上の部分）', autoBadge: '未登録（上の部分）',
  },
};
const MODES = ['slider', 'dm'];

const $ = id => document.getElementById(id);
// blocked: その種類だけ編集・保存できないときの理由（もう片方は使える）。{ kind, msg }
//   broken … ファイルが丸ごと壊れている（JSON でない・形が違う）／ network … 通信で読めなかった（一時的かもしれない）／
//   nolib … DM 通知の本体（dm-notice.js）を読めなかった
const newStore = () => ({ saved: { version: 1, casts: {} }, sha: null, entries: new Map(), warnings: [], blocked: null });
function blockedText(m) {
  const b = store(m).blocked, k = ui(m).kind;
  if (!b) return '';
  if (b.kind === 'broken') return `${k.file} が壊れているので「${k.label}」は編集できません（${b.msg}）`;
  if (b.kind === 'loading') return `${k.file} を読み込み中です。少し待ってください（「${k.label}」は読み込めたら編集できます）`;
  if (b.kind === 'nolib') return `DM 通知の本体（embed/dm-notice.js）を読み込めませんでした。「${k.label}」は編集できません。再読込してください`;
  return `${k.file} を読み込めませんでした（通信）。「${k.label}」は編集できません。再読込してください（${b.msg}）`;
}
const state = {
  casts: [],                 // sliderCasts の結果（両方共通）
  mode: PARAMS.get('mode') === 'dm' ? 'dm' : 'slider',
  stores: { slider: newStore(), dm: newStore() },   // 種類ごとの保存済みの内容・画面の状態
  selected: null, saving: false, images: new Map(),
};
const ui = (m = state.mode) => KIND_UI[m];
const store = (m = state.mode) => state.stores[m];

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

// 調整ファイル（slider.json / dm-faces.json）を読む。無ければ空。ファイルごと壊れていたら例外（上書きしないよう保存させない）
async function loadAdjust(m) {
  const k = ui(m).kind, empty = '{"version":1,"casts":{}}';
  if (LOCAL) {
    const r = await fetch(ui(m).localFile, { cache: 'no-store' });
    if (r.status === 404) return { ...parseAdjust(empty, k), sha: null };
    if (!r.ok) throw new Error(`${k.file} を読めません (` + r.status + ')');
    return { ...parseOrBroken(await r.text(), k), sha: null };
  }
  const r = await api(`/repos/${OWNER}/${REPO}/contents/${k.path}?ref=${BRANCH}`, { cache: 'no-store' });
  if (r.status === 401 || r.status === 403) throw authError('トークンでリポジトリを読めませんでした (' + r.status + ')');
  if (r.status === 404) {
    // ファイルがまだ無いのか、トークンの権限が無いのかを見分ける（GitHub は権限の無い private リポにも 404 を返す）
    const repo = await api(`/repos/${OWNER}/${REPO}`);
    if (!repo.ok) throw authError('トークンでリポジトリを読めませんでした (' + repo.status + ')');
    return { ...parseAdjust(empty, k), sha: null };
  }
  if (!r.ok) throw new Error(`${k.file} の取得に失敗しました (` + r.status + ')');
  const body = await r.json();
  return { ...parseOrBroken(b64decodeUtf8(body.content), k), sha: body.sha };
}
// 中身が壊れている（JSON でない・形が違う）ときだけ broken の印を付ける（通信の失敗と見分ける）
function parseOrBroken(text, k) {
  try { return parseAdjust(text, k); } catch (err) { throw Object.assign(err, { broken: true }); }
}

function putAdjust(m, text, sha, ids) {
  const k = ui(m).kind;
  const body = { message: commitMessage(ids, k.what), content: b64encodeUtf8(text), branch: BRANCH };
  if (sha) body.sha = sha;
  return api(`/repos/${OWNER}/${REPO}/contents/${k.path}`, { method: 'PUT', body: JSON.stringify(body) });
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
// 立ち絵を差し替えても URL は同じなので、寸法を付けてブラウザの古いキャッシュ（最大10分）を避ける
const ver = meta => `?v=${encodeURIComponent(`${meta.source}-${meta.w}x${meta.h}`)}`;
// DM 通知の画像は公開済みの {id}_dm.webp そのもの（本番と同じ画像で調整する）
const dmUrl = (c) => `assets/${c.id}_dm.webp${ver(c.meta)}`;

// ---------- 状態 ----------
const castById = id => state.casts.find(c => c.id === id);
const savedOf = (id, m = state.mode) => store(m).saved.casts[id] || null;
function recordOf(id, m = state.mode) {
  const c = castById(id), e = store(m).entries.get(id);
  return c && c.meta && e ? ui(m).desired(e, c.meta, savedOf(id, m)) : savedOf(id, m);
}
// 未保存かどうか。スライダーは値ではなく切り出す枠で比べる（丸めの差だけ・自動と同じ枠に戻しただけでは未保存にしない）
// DM は y を画像の中に詰めた保存値と比べる（meta を渡す）。この同じ基準で、409 の取り込みの「触っていない」も判定する
const isDirtyId = (id, m = state.mode) => { const c = castById(id); return !ui(m).sameForDirty(recordOf(id, m), savedOf(id, m), c && c.meta); };
const dirtyIds = (m = state.mode) => state.casts.filter(c => isDirtyId(c.id, m)).map(c => c.id);
const anyDirty = () => MODES.some(m => dirtyIds(m).length);

function setStatus(t, dirty = false) { const s = $('status'); s.textContent = t; s.classList.toggle('dirty', dirty); }
function refreshDirty() {
  const parts = MODES.map(m => [ui(m).kind.label, dirtyIds(m).length]).filter(([, n]) => n);
  $('saveBtn').disabled = state.saving || !parts.length;
  if (!state.saving) setStatus(parts.length ? '未保存の変更: ' + parts.map(([l, n]) => `${l} ${n}人`).join('・') : '保存済み', parts.length > 0);
}

// ---------- 一覧 ----------
function buildList() {
  const list = $('castList'); list.replaceChildren(); itemSigs.clear();
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
  const e = store().entries.get(c.id);
  return [state.mode, !!c.meta, e ? e.mode : '', isDirtyId(c.id)].join('|');
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
  const e = store().entries.get(c.id);
  const badge = (text, cls) => { const s = document.createElement('span'); s.className = 'badge ' + cls; s.textContent = text; b.append(s); };
  if (!c.meta) badge('画像なし', 'warn');
  else if (store().blocked) { /* 読めていない種類では調整の印を出さない（分からない） */ }
  else if (!c.meta.source) badge('ファイル名が読めない', 'warn');
  else if (e && e.mode === 'manual') badge('調整済み', 'ok');
  else if (e && e.mode === 'stale') badge(`立ち絵が変わった→${state.mode === 'dm' ? '既定' : '自動'}`, 'warn');
  else if (e && e.mode === 'auto' && ui().autoBadge) badge(ui().autoBadge, 'dirty');
  if (isDirtyId(c.id)) badge('未保存', 'dirty');
  b.addEventListener('click', () => {
    select(c.id);
    // スマホ（1列表示）では一覧がプレビューの下にあるので、選んだらプレビューまで戻す
    if (matchMedia('(max-width: 760px)').matches) (state.mode === 'dm' ? $('dmStage') : $('phone')).scrollIntoView({ behavior: 'smooth', block: 'start' });
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

// スライダー／DM の顔の切り替え
function setMode(m) {
  if (!KIND_UI[m] || state.mode === m) return;
  endGesture();
  state.mode = m;
  $('tabSlider').setAttribute('aria-pressed', String(m === 'slider'));
  $('tabDm').setAttribute('aria-pressed', String(m === 'dm'));
  $('phone').hidden = m !== 'slider'; $('dmStage').hidden = m !== 'dm';
  $('helpSlider').hidden = m !== 'slider'; $('helpDm').hidden = m !== 'dm';
  $('autoBtnLabel').textContent = ui().autoLabel;
  $('overviewLegend').textContent = m === 'dm'
    ? 'DM 通知用の画像全体と、丸に入る範囲（ピンク）／点線 = 未登録（画像の上の部分）のときの範囲'
    : 'ピンクの枠 = iPhone の画面に見える範囲／点線 = 自動のときに見える範囲';
  buildList(); renderControls(); scheduleRender();
}

// ---------- 右側（プレビューと操作） ----------
function renderControls() {
  const m = state.mode, c = castById(state.selected), e = c && store().entries.get(c.id);
  const can = !!(c && c.meta && e && !e.loadError && !store().blocked);
  $('castName').textContent = c ? `${c.name || '（名前未設定）'}（ID ${c.id}）` : '左の一覧からキャストを選んでください';
  const st = $('castState'); st.classList.remove('warn');
  if (!c) st.textContent = '';
  else if (store().blocked) { st.textContent = blockedText(state.mode); st.classList.add('warn'); }
  else if (!c.meta) { st.textContent = 'この人のプレビュー画像がまだありません（公開の反映を待って再読込してください）'; st.classList.add('warn'); }
  else if (e.loadError) { st.textContent = 'プレビュー画像を読み込めません（再読込してください）'; st.classList.add('warn'); }
  else if (!c.meta.source) { st.textContent = `立ち絵1枚目のファイル名（${c.id}_KVnn）が読めないため調整できません（${ui().staleWord}のまま）`; st.classList.add('warn'); }
  else if (e.mode === 'stale') {
    const s = savedOf(c.id);
    st.textContent = `立ち絵1枚目が変わったため（調整したのは ${s ? `${s.source} ${s.w}×${s.h}` : '?'}、いまは ${c.meta.source} ${c.meta.w}×${c.meta.h}）、${ui().staleWord}で表示しています。動かすと新しい立ち絵で調整し直せます（次に保存するとき古い調整は消えます）`;
    st.classList.add('warn');
  }
  else st.textContent = (e.mode === 'manual' ? '調整済み' : ui().autoWord) + `・立ち絵 ${c.meta.source}` + (isDirtyId(c.id) ? '・未保存' : '');
  const editable = can && !!c.meta.source;
  $('zoom').disabled = !editable; $('autoBtn').disabled = !editable || e.mode === 'auto';
  $('revertBtn').disabled = !c || !isDirtyId(c.id);
  $('phone').tabIndex = editable && m === 'slider' ? 0 : -1;
  const big = document.querySelector('#dmStage .dm-big');
  if (big) big.tabIndex = editable && m === 'dm' ? 0 : -1;
  if (m === 'dm') {
    // 拡大 = 1 / size（size は丸に入れる幅の割合）。1 = 画像の幅がちょうど丸に入る（未登録と同じ大きさ）
    $('zoom').min = '1'; $('zoom').max = String(DmLib ? 1 / DmLib.LIMITS.sizeMin : 20);
    $('zoomMin').textContent = '';
    if (e) { const z = 1 / e.fit.size; $('zoom').value = z; $('zoomVal').textContent = z.toFixed(2) + '倍'; } else $('zoomVal').textContent = '';
    $('qualityWarn').hidden = true;
    return;
  }
  // 拡大の下限は「その立ち絵で拡大が効き始める値」（横長の絵は 1 より大きい。それより小さくしても絵が変わらないため）
  const zmin = c && c.meta ? minZoom(c.meta) : 0.5;
  // スライダーの目盛りは min から 0.01 刻みなので、min を 0.01 単位に切り下げる（1.00 などちょうどの値に戻せるように。
  // それより下は絵が変わらない範囲なので、実際の値は zoomFit が zmin にそろえる）
  $('zoom').max = '4';
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

function clearCanvas(cv) { cv.getContext('2d').clearRect(0, 0, cv.width, cv.height); }

async function render() {
  const m = state.mode, c = castById(state.selected), e = c && store().entries.get(c.id);
  if (!c || !c.meta || !e || (m === 'dm' && !DmLib)) { clearCanvas($('crop')); clearCanvas($('overview')); if (m === 'dm' && DmLib) renderDm(null); return; }
  let img;
  try { img = await loadImage(m === 'dm' ? dmUrl(c) : c.meta.src + ver(c.meta)); e.loadError = false; }
  catch { if (!e.loadError) { e.loadError = true; renderControls(); refreshItem(c.id); } return; }
  if (state.selected !== c.id || state.mode !== m) return;   // 待っている間に別の人・別の種類が選ばれた
  if (m === 'dm') { renderDm(c, e, img); return; }
  const crop = $('crop');
  const meta = c.meta, box = entryBox(meta, e), out = outputSize(box);
  // 書き出される画像と同じ大きさのキャンバスに、同じ範囲を描く（表示は rank-slider.js と同じ object-fit: cover・上揃え）
  if (crop.width !== out.w || crop.height !== out.h) { crop.width = out.w; crop.height = out.h; }
  const kx = img.naturalWidth / meta.w, ky = img.naturalHeight / meta.h;
  const ctx = crop.getContext('2d');
  ctx.clearRect(0, 0, out.w, out.h);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, box[0] * kx, box[1] * ky, (box[2] - box[0]) * kx, (box[3] - box[1]) * ky, 0, 0, out.w, out.h);
  drawOverview(img, meta, box);
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

// ---------- DM の顔のプレビュー（本物の dm-notice.js と同じマークアップ・CSS・計算） ----------
function setupDmPreview() {
  if (!DmLib) return;   // 本体が読めない → DM の顔は使えない（スライダーは使える）
  // dm-notice.js の CSS（#bs-dm-notice の中だけに効く）を、この画面では html/body の指定を除いて入れる
  const style = document.createElement('style');
  style.textContent = DmLib.CSS.split('\n').filter(l => !/^html,body/.test(l)).join('\n');
  document.head.append(style);
  const root = document.createElement('div'); root.id = 'bs-dm-notice';
  // 上: 調整用の大きな丸（本物の丸を 2.2 倍に拡大したもの）。下: 本物と同じ大きさ・同じ見た目の吹き出し。
  // マークアップは本体と同じ関数（DmLib.markup / AVATAR_HTML）から作る
  root.innerHTML = '<div class="dm-big" role="application" aria-label="DM の顔の位置（ドラッグで位置、ホイールで大きさ）"><div class="zoomwrap">' + DmLib.AVATAR_HTML + '</div></div>' + DmLib.markup();
  // プレビューの丸は押せないように（操作は大きな丸の枠で受ける）
  for (const b of root.querySelectorAll('button.avatar')) { b.tabIndex = -1; b.setAttribute('aria-hidden', 'true'); }
  $('bs-dm-notice-preview').replaceWith(root);
}

function renderDm(c, e, img) {
  const imgs = document.querySelectorAll('#bs-dm-notice .avatar img');
  for (const el of imgs) {
    if (!c) { el.removeAttribute('src'); continue; }
    const s = DmLib.cropStyle(e.fit);   // 本物と同じ計算（未登録の人は既定＝画像の上の部分）
    el.style.width = s.width; el.style.left = s.left; el.style.top = s.top;
    if (el.getAttribute('src') !== img.src) el.src = img.src;
  }
  if (!c) { clearCanvas($('overview')); return; }
  // 全体図: DM 通知用の画像と、丸に入る範囲
  const ov = $('overview'), W = 220, Hm = 440, ar = img.naturalHeight / img.naturalWidth;
  const w = Math.min(W, Math.round(Hm / ar)), h = Math.round(w * ar);
  if (ov.width !== w || ov.height !== h) { ov.width = w; ov.height = h; }
  const ctx = ov.getContext('2d');
  ctx.clearRect(0, 0, w, h);
  ctx.drawImage(img, 0, 0, w, h);
  const ring = (f, dash, color, lw) => {
    ctx.save(); if (dash) ctx.setLineDash([5, 4]); ctx.strokeStyle = color; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(f.x * w, f.y * w, f.size * w / 2, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  };
  ring(DmLib.DEFAULT_CROP, true, '#555', 1.5);
  ring(e.fit, false, '#ff2d78', 2.5);
}

// いまの選択の「画面上の 1px = トリム後の画像の何分の1 px か」（cover で拡大されている倍率）
function cssPerSrc(c, e) {
  const box = entryBox(c.meta, e), r = $('screen').getBoundingClientRect();
  return coverLayout(r.width, r.height, box[2] - box[0], box[3] - box[1]).scale;
}
// DM: 大きな丸の中の画像の表示幅（px）。値（x・y）は画像の幅に対する割合なので、ドラッグ量をこれで割る
function dmImgPx() {
  const im = document.querySelector('#dmStage .dm-big img');
  return (im && im.getBoundingClientRect().width) || 1;
}

function editable() {
  const c = castById(state.selected), e = c && store().entries.get(c.id);
  return c && c.meta && c.meta.source && e && !e.loadError && !store().blocked ? { c, e } : null;
}

function changed(id) {
  pendingItems.add(id); scheduleRender();
}

// 編集の結果。自動（DM は既定＝画像の上の部分）と同じになったら「自動」に戻す（触っただけ・戻しただけで手動の行を作らない）。
// 立ち絵が変わって自動に戻っている人（stale）は、その状態のまま（保存済みの古い行を勝手に消さない）
function setFit(c, e, fit) {
  e.fit = fit;
  if (ui().isAuto(c.meta, fit)) e.mode = ui().resolve(savedOf(c.id), c.meta).mode === 'stale' ? 'stale' : 'auto';
  else e.mode = 'manual';
  changed(c.id);
}

// 種類ごとの操作（ドラッグ・拡大）。scale はドラッグを始めた時点の「画面 px の換算」、zoom は拡大率の数値
const OPS = {
  slider: {
    scale: t => cssPerSrc(t.c, t.e),
    drag: (t, start, dx, dy, k) => dragFit(t.c.meta, start, dx, dy, k),
    zoomOf: fit => fit.zoom,
    zoomTo: (t, fit, z) => zoomFit(t.c.meta, fit, z),   // 範囲は zoomFit が minZoom〜4 にそろえる
  },
  dm: {
    scale: () => dmImgPx(),
    drag: (t, start, dx, dy, k) => DmLib.dragCrop(start, dx, dy, k, dmYMax(t.c.meta)),   // y は丸の中心が画像の中に残る所まで
    zoomOf: fit => 1 / fit.size,
    zoomTo: (t, fit, z) => DmLib.zoomCrop(fit, z, dmYMax(t.c.meta)),
  },
};
const ops = () => OPS[state.mode];

// ドラッグ（1本指・マウス）で位置、2本指で拡大。gesture はいま進行中の操作の起点
const gesture = { pointers: new Map(), drag: null, pinch: null, el: null };
function endGesture() {
  gesture.pointers.clear(); gesture.drag = null; gesture.pinch = null;
  for (const el of document.querySelectorAll('.dragging')) el.classList.remove('dragging');
}

// ドラッグ・2本指の途中でホイール・キー・スライダーで値が変わったら、起点を「今の位置と今の値」で取り直す
// （取り直さないと、次の指の動きで押した時点の値に戻ってしまう）
function rebaseGesture() {
  const t = editable(); if (!t) return;
  const g = gesture;
  if (g.drag && g.pointers.has(g.drag.pointerId)) {
    const p = g.pointers.get(g.drag.pointerId);
    g.drag = { ...g.drag, x: p.x, y: p.y, fit: t.e.fit, k: ops().scale(t) };
  }
  if (g.pinch && g.pointers.size >= 2) {
    const [a, b] = [...g.pointers.values()];
    g.pinch = { ...g.pinch, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: ops().zoomOf(t.e.fit) };
  }
}

// el = 操作を受ける要素（スライダーは iPhone、DM は大きな丸）、mode = その要素が受け持つ種類
function bindGestures(el, mode) {
  const g = gesture, pointers = g.pointers;
  const active = () => state.mode === mode;
  const startDrag = (t, pid, p) => { g.drag = { id: t.c.id, pointerId: pid, x: p.x, y: p.y, fit: t.e.fit, k: ops().scale(t) }; };
  el.addEventListener('pointerdown', ev => {
    const t = active() && editable(); if (!t) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    try { el.setPointerCapture(ev.pointerId); } catch { /* 指を離した後 */ }
    if (pointers.size === 1) { startDrag(t, ev.pointerId, { x: ev.clientX, y: ev.clientY }); g.pinch = null; el.classList.add('dragging'); }
    else if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      g.pinch = { id: t.c.id, dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, zoom: ops().zoomOf(t.e.fit) }; g.drag = null;
    }
  });
  el.addEventListener('pointermove', ev => {
    if (!pointers.has(ev.pointerId)) return;
    pointers.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    const t = active() && editable(); if (!t) return;
    if (g.drag && g.drag.id === t.c.id && g.drag.pointerId === ev.pointerId) {
      setFit(t.c, t.e, ops().drag(t, g.drag.fit, ev.clientX - g.drag.x, ev.clientY - g.drag.y, g.drag.k));
    } else if (g.pinch && g.pinch.id === t.c.id && pointers.size >= 2) {
      const [a, b] = [...pointers.values()];
      setFit(t.c, t.e, ops().zoomTo(t, t.e.fit, g.pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y) / g.pinch.dist));
    }
  });
  const end = ev => {
    pointers.delete(ev.pointerId);
    if (pointers.size === 0) { g.drag = null; g.pinch = null; el.classList.remove('dragging'); }
    else if (pointers.size === 1) {
      // 2本指から1本に戻ったら、残った指で続けてドラッグできるように始点を取り直す
      const t = active() && editable(), [[pid, p]] = [...pointers.entries()];
      g.pinch = null;
      if (t) startDrag(t, pid, p); else g.drag = null;
    }
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', ev => {
    const t = active() && editable(); if (!t) return;
    ev.preventDefault();
    setFit(t.c, t.e, ops().zoomTo(t, t.e.fit, ops().zoomOf(t.e.fit) * Math.exp(-ev.deltaY * 0.0015)));
    rebaseGesture();
  }, { passive: false });

  // キーボード: 矢印で絵を動かす（Shift で大きく）、+ / - で拡大・縮小。日本語入力の変換中は何もしない
  el.addEventListener('keydown', ev => {
    if (ev.isComposing || ev.keyCode === 229 || ev.altKey || ev.ctrlKey || ev.metaKey) return;
    const t = active() && editable(); if (!t) return;
    const step = ev.shiftKey ? 20 : 3, k = ops().scale(t);
    const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
    if (moves[ev.key]) setFit(t.c, t.e, ops().drag(t, t.e.fit, moves[ev.key][0], moves[ev.key][1], k));
    else if (ev.key === '+' || ev.key === '=' || ev.key === ';') setFit(t.c, t.e, ops().zoomTo(t, t.e.fit, ops().zoomOf(t.e.fit) * 1.05));
    else if (ev.key === '-' || ev.key === '_') setFit(t.c, t.e, ops().zoomTo(t, t.e.fit, ops().zoomOf(t.e.fit) / 1.05));
    else return;
    ev.preventDefault();
    rebaseGesture();
  });
}

function bindControls() {
  bindGestures($('phone'), 'slider');
  const big = document.querySelector('#dmStage .dm-big');
  if (big) bindGestures(big, 'dm');
  $('zoom').addEventListener('input', () => {
    const t = editable(); if (!t) return;
    setFit(t.c, t.e, ops().zoomTo(t, t.e.fit, Number($('zoom').value)));
    rebaseGesture();
  });
  $('autoBtn').addEventListener('click', () => {
    const t = editable(); if (!t) return;
    t.e.mode = 'auto'; t.e.fit = ui().autoFit(t.c.meta);
    changed(t.c.id);
  });
  $('revertBtn').addEventListener('click', () => {
    const c = castById(state.selected); if (!c || !c.meta) return;
    const e = store().entries.get(c.id), s = ui().resolve(savedOf(c.id), c.meta);
    e.mode = s.mode; e.fit = s.fit;
    changed(c.id);
  });
  $('tabSlider').addEventListener('click', () => setMode('slider'));
  $('tabDm').addEventListener('click', () => setMode('dm'));
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

// 1種類（slider.json か dm-faces.json）を保存する。戻り値はステータスに出す文の部品
async function saveKind(m, main) {
  const k = ui(m).kind, st = store(m);
  let ids = dirtyIds(m);
  const mine = {};
  for (const id of ids) mine[id] = recordOf(id, m);   // 押した時点の値（保存中に動かした分は次の保存へ）
  let pending = [];
  if (main) {
    // 公開待ちの立ち絵の人は保存から外す（ほかの人の分は保存する）
    pending = ids.filter(id => mine[id] && main.get(id) !== mine[id].source);
    ids = ids.filter(id => !pending.includes(id));
    for (const id of pending) delete mine[id];
    if (!ids.length) return { pending, names: [], staleNames: [], merged: false, saved: false };
  }
  // 自分が変えた人＋使われなくなった行（消す）。base はいま保存しようとしている元のファイル。
  // 消すのは main と立ち絵が違い、かつ誰も触っていない行だけ（rowsToDelete）。main を読まないローカル確認モードでは消さない
  const loaded = st.saved.casts;
  const build = base => {
    // 公開待ちで外した人の行もここでは消さない（「消した」と「公開待ち」が同じ人に重ならないように。次の保存で判断する）
    const stale = main ? rowsToDelete(base.casts, loaded, main, state.casts.map(c => c.id), [...ids, ...pending]) : [];
    const all = [...ids, ...stale], rec = { ...mine };
    for (const id of stale) rec[id] = null;
    return { data: mergeSlider(base, rec, all), stale, all };
  };
  let plan = build(st.saved), text = serializeAdjust(plan.data, k);
  parseAdjust(text, k);   // 書く前に自分で検証
  let merged = false;
  const overwritten = new Set();   // 再試行のたびに見つけた「上書きした人」を積み上げる
  if (LOCAL) {
    download(new Blob([text], { type: 'application/json' }), k.file);
  } else {
    let r = await putAdjust(m, text, st.sha, plan.all);
    for (let i = 0; await isConflict(r); i++) {
      if (i >= RETRY_WAITS_MS.length) throw new Error(`${k.label}の保存が続けて競合しました。少し待ってからもう一度「保存」を押してください（調整は消えていません）`);
      // 他の人が先に保存した → 少し待って最新を読み直し、自分が変えた人の分だけ上書きして再試行
      await sleep(RETRY_WAITS_MS[i]);
      const latest = await loadAdjust(m);   // ファイルごと壊れていたら例外 → 保存しない（変更は残る）
      // 読み直したファイルに、まだ見せていない壊れた行がある → 黙って消さずに止める。
      // 表示して見せたので、もう一度「保存」すれば（初回読み込みで壊れた行があったときと同じく）その行を消して保存する
      const unseen = latest.warnings.filter(w => !st.warnings.includes(w));
      if (unseen.length) {
        st.warnings = [...st.warnings, ...unseen];
        showFileWarn();
        throw new Error(`他の人が保存した ${k.file} に壊れた値がありました（上の赤い欄）。保存を止めました（調整は消えていません）。`
          + `GitHub で data/${k.file} を直してから再読込するか、このままもう一度「保存」を押すと壊れた行を消して保存します`);
      }
      // 同じ人をほかの人も直していた（しかも自分と違う値）→ 後勝ち（自分の値）で上書きする。誰を上書きしたかは知らせる
      // （公開待ちで外した人は ids に入っていないので対象外）
      for (const id of ids) {
        if (!sameRecord(latest.data.casts[id] || null, loaded[id] || null) && !sameRecord(latest.data.casts[id] || null, mine[id] || null)) overwritten.add(id);
      }
      plan = build(latest.data); text = serializeAdjust(plan.data, k);
      r = await putAdjust(m, text, latest.sha, plan.all);
      merged = true;
    }
    if (!r.ok) {
      const body = await r.json().catch(() => ({}));
      const msg = `${k.label}の保存に失敗しました (` + r.status + (body.message ? ': ' + body.message : '') + ')';
      throw (r.status === 401 || r.status === 403) ? authError(msg + '。トークンに書き込みの権限があるか確認してください') : new Error(msg);
    }
    st.sha = (await r.json()).content.sha;
  }
  const before = st.saved;
  st.saved = parseAdjust(text, k).data;
  st.warnings = []; showFileWarn();   // 書いたファイルには壊れた行は無い（serializeAdjust は正しい行だけ書く）
  // 消した stale の人は、画面でも「自動」にする
  // （自分の画面が古くて「調整済み」に見えていた人も。保存中にその人を動かしていたら、その編集は残す）
  for (const id of plan.stale) {
    const c = castById(id), en = st.entries.get(id);
    if (c && c.meta && en && ui(m).sameForDirty(ui(m).desired(en, c.meta, before.casts[id] || null), before.casts[id] || null, c.meta)) {
      st.entries.set(id, { ...ui(m).resolve(null, c.meta), loadError: en.loadError });
    }
  }
  if (merged) applyOthers(m, plan.all, before);
  return { pending, names: [...overwritten].map(nameOf), staleNames: plan.stale.map(nameOf), merged, saved: true };
}

// 保存。スライダーと DM の顔は種類ごとに独立して保存する（片方が失敗しても、もう片方は保存する）。それぞれの成否をステータスに出す
async function onSave() {
  if (state.saving) return;
  // ローカル確認モードはダウンロードなので、今のタブの種類だけ保存する（2つ続けてダウンロードするとブラウザに止められることがある）
  const kinds = MODES.filter(m => !store(m).blocked && dirtyIds(m).length && (!LOCAL || m === state.mode));
  const otherLeft = LOCAL ? MODES.filter(m => m !== state.mode && dirtyIds(m).length).length : 0;
  if (!kinds.length) {
    if (otherLeft) setStatus(`ローカル確認モードでは今のタブの種類だけ保存します。「${MODES.filter(m => m !== state.mode).map(m => ui(m).kind.label).join('')}」に未保存があります。タブを切り替えて保存してください`, true);
    return;
  }
  state.saving = true; $('saveBtn').disabled = true; $('reloadBtn').disabled = true; setStatus('保存中…');
  const msgs = [], errors = [], pendingAll = new Set();
  let overwrote = false;
  try {
    let main = null;
    if (!LOCAL) {
      // 公開待ちの確認に使う main の casts.json が読めなければ、どちらも保存しない（安全側）
      try { main = await loadMainSources(); }
      catch (err) { errors.push(err.message); return; }
    }
    for (const m of kinds) {
      const l = ui(m).kind.label;
      try {
        const r = await saveKind(m, main);
        r.pending.forEach(id => pendingAll.add(id));
        if (!r.saved) continue;
        if (r.names.length) overwrote = true;
        msgs.push(`${l}の調整を${LOCAL ? ` ${ui(m).kind.file} としてダウンロードしました（ローカル確認モード）` : '保存しました'}`
          + (r.merged ? '（他の人の保存も取り込みました）' : '')
          + (r.names.length ? `。${r.names.join('、')}の「${l}」の調整は、ほかの人の保存を上書きしました（${r.names.length}人）` : '')
          + (r.staleNames.length ? `。立ち絵が変わって使われなくなった ${r.staleNames.join('、')}の古い「${l}」の調整を消しました（${r.staleNames.length}人）` : ''));
      } catch (err) {
        errors.push(`「${l}」は保存できませんでした: ${err.message}`);
      }
    }
  } finally {
    // 成否に関わらず、一覧・右側・保存ボタンを今の状態に合わせる（片方だけ保存できた場合も古い表示を残さない）
    state.saving = false; $('reloadBtn').disabled = false;
    for (const c of state.casts) refreshItem(c.id);
    renderControls(); refreshDirty();
    const pend = [...pendingAll];
    const left = MODES.reduce((n, m) => n + dirtyIds(m).filter(id => !pendingAll.has(id)).length, 0);
    const parts = [...msgs];
    if (msgs.length && !LOCAL) parts.push('公式サイトへの反映は数分〜10分ほどかかります（画像のキャッシュのため）');
    if (pend.length) parts.push(`${pend.map(nameOf).join('、')}は立ち絵の更新が公開待ちのため保存していません。数分〜10分後に再読込して調整し直してください`);
    if (otherLeft) parts.push(`「${MODES.filter(m => m !== state.mode).map(m => ui(m).kind.label).join('')}」に未保存があります（ローカル確認モードは今のタブの種類だけ保存します。タブを切り替えて保存してください）`);
    else if (left > 0 && !errors.length) parts.push(`保存中に変えた ${left}人は未保存です`);
    const text = (errors.length ? '⚠ ' + errors.join('／') + (parts.length ? '。' : '') : '') + parts.join('。');
    setStatus(text, errors.length > 0 || left > 0 || pend.length > 0 || overwrote || otherLeft > 0);
    $('saveBtn').disabled = !anyDirty();
  }
}

// 競合を取り込んだあと: 自分が変えていない人は、他の人が保存した値で表示し直す（次の保存で古い値に戻さないため）。
// 「変えていない」= 画面の値が、取り込む前に読み込んでいた値のまま（保存中に動かした人はそのまま残す）
function applyOthers(m, mineIds, before) {
  const st = store(m);
  for (const c of state.casts) {
    if (!c.meta || mineIds.includes(c.id)) continue;
    const e = st.entries.get(c.id), old = before.casts[c.id] || null;
    // 「触っていない」は未保存の判定と同じ基準（スライダーは切り出し枠、DM は見た目）。許容内の微小な操作なら他の人の値に入れ替える
    if (e && !ui(m).sameForDirty(ui(m).desired(e, c.meta, old), old, c.meta)) continue;
    st.entries.set(c.id, { ...ui(m).resolve(savedOf(c.id, m), c.meta), loadError: !!(e && e.loadError) });
  }
  scheduleRender();
}

// ---------- 起動 ----------
let loadSerial = 0;
async function load() {
  if (state.saving) { setStatus('保存が終わってから再読込してください'); return; }
  const serial = ++loadSerial;   // 連打されたら最後の読み込みだけを使う
  setStatus('読み込み中…'); $('appView').hidden = false; $('loginView').hidden = true; $('saveBtn').disabled = true;
  // 調整ファイルは種類ごとに読み、読めた種類から使えるようにする（片方の読み込みが止まっても、もう片方は待たない）。
  // 読めない方（壊れている・通信・本体なし）は編集・保存させない＝上書きして全員分を消さない。トークンの問題はログインへ。
  // DM 通知の本体（dm-notice.js）が読めないときは dm-faces.json を読まない（検査に本体の関数を使うため）
  const settle = p => p.then(v => ({ v }), err => { if (err.auth) throw err; return { err }; });
  const loads = { slider: settle(loadAdjust('slider')), dm: DmLib ? settle(loadAdjust('dm')) : Promise.resolve({ nolib: true }) };
  const loginOnAuth = err => {
    if (serial !== loadSerial) return;
    if (err.auth) { loadSerial++; showLogin('⚠ ' + (err.base || err.message) + '。下の欄にトークンを入れ直してください'); return; }
    setStatus('⚠ ' + err.message, true);
  };
  let showcase, srcMeta;
  try {
    [showcase, srcMeta] = await Promise.all([loadShowcase(), loadSrcMeta()]);
  } catch (err) { loginOnAuth(err); return; }
  if (serial !== loadSerial) return;
  state.casts = sliderCasts(showcase, srcMeta);
  for (const m of MODES) { const st = store(m); st.blocked = { kind: 'loading', msg: '' }; st.entries = new Map(); st.saved = { version: 1, casts: {} }; st.sha = null; st.warnings = []; }
  if (state.selected && !castById(state.selected)) state.selected = null;
  if (!state.selected && state.casts.length) state.selected = state.casts[0].id;
  showFileWarn(); buildList(); renderControls(); scheduleRender(); loadStatus();

  // 1種類が読めたら（または読めなかったら）その種類だけを反映する
  const apply = (m, r) => {
    if (serial !== loadSerial) return;
    const st = store(m), f = r.v || { data: { version: 1, casts: {} }, sha: null, warnings: [] };
    st.blocked = r.nolib ? { kind: 'nolib', msg: '' } : r.err ? { kind: r.err.broken ? 'broken' : 'network', msg: r.err.message } : null;
    st.saved = f.data; st.sha = st.blocked ? null : f.sha; st.warnings = st.blocked ? [] : f.warnings; st.entries = new Map();
    if (!st.blocked) for (const c of state.casts) if (c.meta) st.entries.set(c.id, ui(m).resolve(savedOf(c.id, m), c.meta));
    showFileWarn();
    if (m === state.mode) buildList();
    // 先に読めた種類をもう編集していたら、その未保存の知らせを消さない
    renderControls(); scheduleRender(); if (anyDirty()) refreshDirty(); else loadStatus();
  };
  for (const m of MODES) loads[m].then(r => apply(m, r)).catch(loginOnAuth);
}

// 読み込みの状況（種類ごと。読み込み中の種類は「読み込み中…」）
function loadStatus() {
  if (state.saving) return;
  const count = (m, mode) => state.casts.filter(c => { const e = store(m).entries.get(c.id); return e && e.mode === mode; }).length;
  const why = { broken: 'ファイルが壊れていて編集できません', network: '読み込めませんでした（通信）。再読込してください', nolib: '本体を読み込めませんでした。再読込してください', loading: '読み込み中…' };
  const part = m => store(m).blocked ? `${ui(m).kind.label}: ${store(m).blocked.kind === 'loading' ? '' : '⚠ '}${why[store(m).blocked.kind]}`
    : `${ui(m).kind.label}: 調整済み ${count(m, 'manual')}人${count(m, 'stale') ? `・立ち絵が変わって戻った ${count(m, 'stale')}人` : ''}`;
  setStatus(`${state.casts.length}名を読み込みました（${part('slider')}／${part('dm')}）`);
}

// 調整ファイルの壊れた行の知らせ（初回読み込みと、保存の競合で読み直したときで同じ文言）
function showFileWarn() {
  const fw = $('fileWarn'), parts = [];
  for (const m of MODES) {
    if (store(m).blocked) { if (store(m).blocked.kind !== 'loading') parts.push(blockedText(m)); continue; }
    const w = store(m).warnings;
    if (w.length) parts.push(`${ui(m).kind.file} の壊れた値を無視しています（その人は${ui(m).staleWord}。保存するとこの行は消えます）: ${w.join(' ／ ')}`);
  }
  fw.hidden = !parts.length;
  fw.textContent = parts.join('　／　');
}

function showLogin(msg) {
  $('appView').hidden = true; $('loginView').hidden = false; $('loginErr').textContent = msg || ''; setStatus('');
  // 読み込めている状態から「接続し直す」で来たときは、入れ直さずに戻れるようにする
  $('cancelLoginBtn').hidden = !(token() && state.casts.length && !LOCAL);
}

function init() {
  $('modeNote').hidden = !LOCAL;
  $('reconnectBtn').hidden = LOCAL;
  setupDmPreview();
  $('cancelLoginBtn').addEventListener('click', () => { $('loginView').hidden = true; $('appView').hidden = false; refreshDirty(); });
  $('reconnectBtn').addEventListener('click', () => {
    if (state.saving) return;
    if (anyDirty() && !confirm('未保存の変更があります。トークンを入れ直すと読み直すので、変更は消えます。続けますか？')) return;
    $('tokenInput').value = '';
    showLogin('GitHub のトークンを入れ直してください（manage.html・announce.html と共通です）');
  });
  $('saveBtn').addEventListener('click', onSave);
  $('reloadBtn').addEventListener('click', () => { if (!anyDirty() || confirm('未保存の変更を捨てて読み直しますか？')) { state.images.clear(); load(); } });
  $('loginBtn').addEventListener('click', () => {
    const t = $('tokenInput').value.trim();
    if (!t) { $('loginErr').textContent = 'トークンを入力してください'; return; }
    if (!TOKEN_RE.test(t)) { $('loginErr').textContent = 'トークンに使えない文字（全角・空白など）が入っています。コピーし直してください'; return; }
    try { localStorage.setItem(TOKEN_KEY, t); } catch { $('loginErr').textContent = 'このブラウザではトークンを保存できません'; return; }
    $('loginErr').textContent = '';
    load();
  });
  window.addEventListener('beforeunload', ev => { if (anyDirty()) { ev.preventDefault(); ev.returnValue = ''; } });
  window.addEventListener('resize', scheduleRender);
  bindControls();
  bindListKeys();
  // ?mode=dm で DM の顔から開く
  const m0 = state.mode; state.mode = '';
  setMode(m0);
  if (LOCAL || token()) load(); else showLogin();
}

init();
