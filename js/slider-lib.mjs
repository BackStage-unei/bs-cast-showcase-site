// スライダーの切り抜き調整画面（slider.html）の計算部分。DOM・fetch・canvas を持ち込まない純粋関数だけを置く
// （tests/js/slider-lib.test.mjs で node --test する）。
//
// 座標の定義は scripts/portraits_lib.py（slider_crop_box / slider_manual_box）と同じ式・同じ丸め。
// どちらも tests/fixtures/slider-crop-vectors.json（Python が作る答え合わせ表）と一致することをテストしている。
//   どれもトリム後の画像（透明余白を落とした立ち絵1枚目。幅 w・高さ h）に対する値
//   zoom: 1 = 自動と同じ大きさ。窓の高さ = min(h, round(1.6 × w ÷ zoom))。大きいほど寄る（0.5〜4）
//   x   : 切り出しの中心の横位置（w に対する割合 0〜1）
//   y   : 切り出しの上端（h に対する割合 0〜1）
//   画像からはみ出す分は端に寄せる。丸めは Python の round と同じ偶数丸め（pyRound）

export const ASPECT = 0.46, HEAD_FACTOR = 1.6;
export const ZOOM_MIN = 0.5, ZOOM_MAX = 4;
export const SLIDE_MAX_H = 1400;   // build_slider.py の SLIDE_MAX_H と同じ（書き出す画像の高さの上限）
const ID_RE = /^[1-9][0-9]*$/;
// iPhone の画面の縦横比（rank-slider.js の .screen: 左右 5.33%・上 3.9%・下 5.2%、枠 900×1950）
export const SCREEN_W = 900 * (1 - 0.0533 * 2), SCREEN_H = 1950 * (1 - 0.039 - 0.052);
// 書き出す画像の切り出し幅がこれより小さいと、スマホの画面（約300〜400px 幅・高解像度）で粗く見える
export const LOW_RES_PX = 300;
// slider.json の入れ子の深さの上限（Python の json は深い入れ子で RecursionError になる。JS と同じ所で「壊れている」にする）
export const MAX_DEPTH = 32;
const SOURCE_RE = /^[A-Za-z0-9_-]{1,40}$/;

// Python の round(v) と同じ（.5 ちょうどは偶数へ）。v - floor(v) は浮動小数でも誤差なく求まる
export function pyRound(v) {
  const f = Math.floor(v), d = v - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

// 保存する値の丸め（小数6桁）。4桁だと幅1万px超の絵で round(x*w) が1px ずれ、自動の枠を値で表せなかった（3周目 review）
export function roundFit(n) { return Math.round(n * 1e6) / 1e6; }

// 自動の切り抜き（portraits_lib.slider_crop_box と同じ）。返り値 [left, top, right, bottom]
export function autoBox(w, h, cx) {
  const winH = Math.min(h, pyRound(HEAD_FACTOR * w));
  const cropW = Math.min(w, pyRound(ASPECT * winH));
  const left = Math.min(Math.max(0, cx - Math.floor(cropW / 2)), w - cropW);
  return [left, 0, left + cropW, winH];
}

// 手動調整の切り抜き（portraits_lib.slider_manual_box と同じ）
export function manualBox(w, h, fit) {
  const winH = Math.max(1, Math.min(h, pyRound(HEAD_FACTOR * w / fit.zoom)));
  const cropW = Math.max(1, Math.min(w, pyRound(ASPECT * winH)));
  const center = pyRound(fit.x * w);
  const left = Math.min(Math.max(0, center - Math.floor(cropW / 2)), w - cropW);
  const top = Math.min(Math.max(0, pyRound(fit.y * h)), h - winH);
  return [left, top, left + cropW, top + winH];
}

// 書き出される画像の大きさ（build_slider.py の encode_slide と同じ: 高さ1400を超えたら縮小）
export function outputSize(box) {
  const w = box[2] - box[0], h = box[3] - box[1];
  if (h > SLIDE_MAX_H) return { w: pyRound(w * SLIDE_MAX_H / h), h: SLIDE_MAX_H };
  return { w, h };
}

// 立ち絵の参照（assets/154_KV01.png / .webp）→ source 値（KV01）。portraits_lib.slider_source_key と同じ
export function sourceKey(ref, id) {
  if (typeof ref !== 'string') return null;
  const name = ref.split('/').pop().replace(/\.[^.]*$/, '');
  const prefix = `${id}_`;
  if (!name.startsWith(prefix)) return null;
  const key = name.slice(prefix.length);
  return SOURCE_RE.test(key) ? key : null;
}

// JSON の 1e400 や 400桁の整数は Infinity になる → 数値として扱わない（Python も同じ）
const isNum = v => typeof v === 'number' && Number.isFinite(v);
const isSize = v => Number.isInteger(v) && v >= 1;
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

// 保存できる値にそろえる（範囲内・小数6桁）。保存した値とプレビューの値を同じにするため、編集のたびに通す
export function clampFit(f) {
  return { x: roundFit(clamp(f.x, 0, 1)), y: roundFit(clamp(f.y, 0, 1)), zoom: roundFit(clamp(f.zoom, ZOOM_MIN, ZOOM_MAX)) };
}

// その立ち絵で拡大が実際に効き始める値。これより小さくすると窓の高さが画像の高さで頭打ちになり、絵が変わらない
// （win_h = min(h, round(1.6w/zoom)) が h になる zoom = 1.6w/h 以下）。小数4桁に切り下げ（それ以下なら必ず頭打ち）
export function minZoom(meta) {
  const z = Math.floor(HEAD_FACTOR * meta.w / meta.h * 10000) / 10000;
  return clamp(z, ZOOM_MIN, ZOOM_MAX);
}

// 自動の切り抜きと同じ枠になる値（調整を始めるときの初期値）。横長の絵は zoom 1 でも頭打ちなので、効き始める値にそろえる
export function autoFit(meta) {
  return clampFit({ x: meta.cx / meta.w, y: 0, zoom: Math.max(1, minZoom(meta)) });
}

// その値の切り出しが自動の切り抜きと同じ枠か（同じなら「自動」扱いに戻す。触っただけで手動にしない）
// 画面に描く枠: 自動（stale を含む）の人はビルドと同じ autoBox（slider_crop_box）そのもの。値の丸めに依存しない
export function entryBox(meta, entry) {
  return entry.mode === 'manual' ? manualBox(meta.w, meta.h, entry.fit) : autoBox(meta.w, meta.h, meta.cx);
}

export function isAutoBox(meta, fit) {
  return sameBox(manualBox(meta.w, meta.h, fit), autoBox(meta.w, meta.h, meta.cx));
}

// 切り出し枠のうち、iPhone の画面（cover・上揃え）で実際に見える範囲 [left, top, right, bottom]（画像の座標）
export function visibleBox(box) {
  const w = box[2] - box[0], h = box[3] - box[1];
  const k = coverLayout(SCREEN_W, SCREEN_H, w, h);
  const vw = Math.min(w, SCREEN_W / k.scale), vh = Math.min(h, SCREEN_H / k.scale);
  const left = box[0] + (w - vw) / 2;
  return [left, box[1], left + vw, box[1] + vh];
}

// 書き出す画像が粗くなるか（切り出し幅が LOW_RES_PX 未満）
export function isLowRes(box) { return box[2] - box[0] < LOW_RES_PX; }

// 端に寄せられた分を値に反映する（画像の外へドラッグし続けても値だけが先へ進まないように）
export function normalizeFit(meta, fit) {
  const f = clampFit(fit);
  const [l, t, r] = manualBox(meta.w, meta.h, f);
  const n = clampFit({ x: (l + Math.floor((r - l) / 2)) / meta.w, y: t / meta.h, zoom: f.zoom });
  // 丸めても同じ枠になることを確かめる（ならなければ丸める前の値を使う）
  return sameBox(manualBox(meta.w, meta.h, n), manualBox(meta.w, meta.h, f)) ? n : f;
}

export function sameBox(a, b) { return a.length === b.length && a.every((v, i) => v === b[i]); }

// object-fit: cover; object-position: center top で、枠（screenW×screenH）に画像（imgW×imgH）を置いたときの倍率と位置
export function coverLayout(screenW, screenH, imgW, imgH) {
  const scale = Math.max(screenW / imgW, screenH / imgH);
  return { scale, left: (screenW - imgW * scale) / 2, top: 0 };
}

// ドラッグ: 押した時点の値 start から、画面上の移動量（dx, dy・CSS px）だけ絵を動かす。
// pxPerSrc = 画面上の 1px がトリム後の画像の何 px か（の逆数）。絵を右へ動かす = 切り出しを左へ
export function dragFit(meta, start, dx, dy, cssPerSrc) {
  const [l, t, r] = manualBox(meta.w, meta.h, start);
  const center = l + Math.floor((r - l) / 2);
  return normalizeFit(meta, { x: (center - dx / cssPerSrc) / meta.w, y: (t - dy / cssPerSrc) / meta.h, zoom: start.zoom });
}

// 拡大率を変える（横の中心と上端はそのまま）。下限はその立ち絵で拡大が効き始める値（minZoom）
export function zoomFit(meta, fit, zoom) {
  return normalizeFit(meta, { x: fit.x, y: fit.y, zoom: clamp(zoom, minZoom(meta), ZOOM_MAX) });
}

// slider.json の1人分の検査（portraits_lib.slider_entry_problem と同じ規則）。正しければ null、壊れていれば理由
export function entryProblem(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return '値がオブジェクトではありません';
  if (typeof v.source !== 'string' || !SOURCE_RE.test(v.source)) return 'source（調整した立ち絵）が不正です';
  for (const k of ['x', 'y', 'zoom']) if (!isNum(v[k])) return `${k} が数値ではありません`;
  if (!(v.x >= 0 && v.x <= 1 && v.y >= 0 && v.y <= 1)) return 'x・y が 0〜1 の範囲外です';
  if (!(v.zoom >= ZOOM_MIN && v.zoom <= ZOOM_MAX)) return `zoom が ${ZOOM_MIN}〜${ZOOM_MAX} の範囲外です`;
  // w・h（調整したときのトリム後の立ち絵の大きさ）は必須（同じファイル名に別の絵を上書きしたことを見分けるため）
  if (!(isSize(v.w) && isSize(v.h))) return 'w・h（調整した立ち絵の大きさ）が無いか不正です';
  return null;
}

// slider.json を読む。ファイル全体が壊れていたら例外（保存で上書きしないため）。壊れた行だけなら捨てて warnings に入れる
// （ビルドも壊れた行は自動の切り抜きにする。画面で保存するとその行は消える）
export function parseSlider(text) {
  let d;
  // ファイルごと壊れているときは、画面から上書きして全員の調整を消さないよう読み込みを止める（直し方を添える）
  const fix = '。GitHub で data/slider.json を直すか、作業ブランチで修正してください（このままでもスライダーは全員自動の切り抜きで表示されます）';
  // 先頭の BOM は外す（ビルドの build_slider.py も utf-8-sig で外す）
  if (typeof text === 'string' && text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (jsonDepth(text) > MAX_DEPTH) throw new Error(`slider.json の入れ子が深すぎます（${MAX_DEPTH}段まで）` + fix);
  try { d = JSON.parse(text); } catch (e) { throw new Error('slider.json が JSON として読めません（' + e.message + '）' + fix); }
  if (!d || d.version !== 1 || !d.casts || typeof d.casts !== 'object' || Array.isArray(d.casts)) throw new Error('slider.json の形式が不正です（version: 1 と casts が必要）' + fix);
  const casts = {}, warnings = [];
  for (const [id, v] of Object.entries(d.casts)) {
    if (!ID_RE.test(id)) { warnings.push(`キー「${id}」はキャストIDではありません`); continue; }
    const p = entryProblem(v);
    if (p) { warnings.push(`ID ${id}: ${p}`); continue; }
    casts[id] = pickRecord(v);
  }
  return { data: { version: 1, casts }, warnings };
}

// JSON の文字列の最大の入れ子の深さ（文字列の中の括弧は数えない）。portraits_lib.json_depth と同じ
export function jsonDepth(text) {
  let depth = 0, max = 0, inStr = false, esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '[' || ch === '{') { depth++; if (depth > max) max = depth; }
    else if (ch === ']' || ch === '}') depth--;
  }
  return max;
}

// 保存する1行（決めたキーだけ。w・h は有るときだけ）
function pickRecord(v) {
  return { source: v.source, x: v.x, y: v.y, zoom: v.zoom, w: v.w, h: v.h };
}

export function serializeSlider(data) {
  const casts = {};
  for (const id of Object.keys(data.casts).sort((a, b) => Number(a) - Number(b))) {
    const v = pickRecord(data.casts[id]);
    casts[id] = { ...v, x: roundFit(v.x), y: roundFit(v.y), zoom: roundFit(v.zoom) };
  }
  return JSON.stringify({ version: 1, casts }, null, 2) + '\n';
}

// 保存の競合時の取り込み: 最新の slider.json に、自分が変えた人の分だけを反映する。
// mine[id] が null = 「自動に戻す」（その人の行を消す）
export function mergeSlider(latest, mine, ids) {
  const casts = { ...latest.casts };
  for (const id of ids) {
    if (mine[id]) casts[id] = mine[id]; else delete casts[id];
  }
  return { version: 1, casts };
}

// 保存済みの値と今の立ち絵から、画面の初期状態を決める
//   auto   … 調整なし（自動の切り抜き）
//   manual … 調整あり（その値で切り抜く）
//   stale  … 調整した立ち絵と今の立ち絵1枚目が違う → ビルドは自動に戻している
// 「違う」= source（KV01 など）が違う、または保存した w・h が今のトリム後の大きさと違う（同じファイル名に別の絵を上書き）。
// ファイル名が読めない（meta.source が null）ときも stale（portraits_lib.slider_adjust_is_stale と同じ）
export function isStale(saved, meta) {
  return !meta.source || saved.source !== meta.source || saved.w !== meta.w || saved.h !== meta.h;
}
export function resolveState(saved, meta) {
  if (!saved) return { mode: 'auto', fit: autoFit(meta) };
  if (isStale(saved, meta)) return { mode: 'stale', fit: autoFit(meta) };
  return { mode: 'manual', fit: clampFit(saved) };
}

// 画面の状態 → slider.json に書く1人分（自動なら null）。stale のまま触っていなければ保存済みの行を返す（未保存に数えない。
// 保存するときは、画面が stale の行をまとめて消す＝ slider-app.mjs の onSave）
export function desiredRecord(entry, meta, saved) {
  if (entry.mode === 'manual') {
    return { source: meta.source, ...clampFit(entry.fit), w: meta.w, h: meta.h };
  }
  if (entry.mode === 'stale') return saved || null;
  return null;
}

// 未保存かどうかの判定用: 値の丸めの差ではなく、実際に切り出す枠が同じか（手書きの 0.1 と 0.0999 は同じ枠なら同じ）
export function sameRecordBox(a, b) {
  if (!a || !b) return !a && !b;
  return a.source === b.source && a.w === b.w && a.h === b.h && sameBox(manualBox(a.w, a.h, a), manualBox(b.w, b.h, b));
}

export function sameRecord(a, b) {
  if (!a || !b) return !a && !b;
  return a.source === b.source && roundFit(a.x) === roundFit(b.x) && roundFit(a.y) === roundFit(b.y) && roundFit(a.zoom) === roundFit(b.zoom)
    && a.w === b.w && a.h === b.h;
}

// スライダーに出る人（casts-data.js の立ち絵ありの人・rank-slider.js と同じ条件）に、ビルドが作った寸法を付ける
export function sliderCasts(showcaseCasts, srcJson) {
  const metas = (srcJson && srcJson.casts) || {};
  const out = [];
  for (const c of Array.isArray(showcaseCasts) ? showcaseCasts : []) {
    if (!c || !Array.isArray(c.portraits) || !c.portraits.length) continue;
    const id = String(c.cast_id);
    if (!ID_RE.test(id)) continue;
    const m = metas[id];
    const meta = m && [m.w, m.h, m.cx].every(n => Number.isInteger(n) && n >= 0) && m.w > 0 && m.h > 0
      && typeof m.src === 'string' && /^assets\/\d+_slidesrc\.webp$/.test(m.src)
      ? { w: m.w, h: m.h, cx: m.cx, src: m.src, source: typeof m.source === 'string' && SOURCE_RE.test(m.source) ? m.source : null }
      : null;
    out.push({
      id, name: String(c.name || ''), rank: String(c.rank || ''),
      accent: /^#[0-9a-f]{6}$/.test(c.accent_color || '') ? c.accent_color : '',
      source: sourceKey(c.portraits[0], id), meta,
    });
  }
  return out;
}

// 保存のときに消してよい行（立ち絵が変わって使われなくなった行）。消すのは次の両方を満たす行だけ:
//   (a) 行の source が、main の data/casts.json の今の立ち絵1枚目（mainSources: id → source）と違う
//   (b) 行が、このタブで読み込んだ（最後に保存した）時点の行 loaded と同じ＝ほかの誰も触っていない
// 409 で読み直して出てきた新しい行・変わった行（ほかの人がデプロイ後に正しく保存した行）は消さない。skipIds（自分が書く人）も除く
export function rowsToDelete(base, loaded, mainSources, candidateIds, skipIds) {
  return candidateIds.filter(id => !skipIds.includes(id) && base[id] && mainSources.has(id)
    && base[id].source !== mainSources.get(id) && sameRecord(base[id], loaded[id] || null));
}

// 保存のコミットメッセージ
export function commitMessage(ids) {
  const list = [...ids].sort((a, b) => Number(a) - Number(b));
  const head = list.slice(0, 5).join(', ');
  return `content: スライダーの切り抜きを保存（ID ${head}${list.length > 5 ? ` ほか${list.length - 5}人` : ''}）`;
}
