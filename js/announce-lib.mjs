// ランク発表画像（announce.html）の計算部分。DOM・fetch・canvas を持ち込まない純粋関数だけを置く
// （tests/js/announce-lib.test.mjs で node --test する）。
// 座標はすべて 1920px 幅の発表画像の座標。部品と配置の定義は site/announce/layout.json（scripts/announce_parts.py が PSD から作る）。

export const RANKS = ['GOLD', 'SILVER', 'BRONZE'];
export const RANK_COLS = { GOLD: 1, SILVER: 2, BRONZE: 3 };
export const FIT_LIMITS = { min: -0.5, max: 1.5, zoomMin: 0.5, zoomMax: 12 };

// 「2026-10」→「2026年10月」
export function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym || '');
  if (!m) throw new Error('ランク月の形式が不正です: ' + ym);
  return `${m[1]}年${Number(m[2])}月`;
}

// 見出しの文字（2つの大きさ）。pt は layout.header.pt
export function headerRuns(ym, pt) {
  return [{ text: `${monthLabel(ym)} - `, pt: pt[0] }, { text: 'キャストランク発表-', pt: pt[1] }];
}

// 発表用の名前の初期値: 括弧書き（読み・肩書き）を除いて前後の空白を落とす。「7_ko（ナナコ）」→「7_ko」
export function defaultName(name) {
  return String(name || '').replace(/[（(][^）)]*[）)]/g, '').trim();
}

// 画像に描く・画面に出す名前。空欄にしても名前が消えないよう、元の名前 → ID の順に補う
// （QA P1: 表示名を空にするとプレビューは空欄・保存後は元の名前に戻る食い違いがあった）
export function displayName(edited, castName, id) {
  return String(edited || '').trim() || defaultName(castName) || `ID ${id}`;
}

// 保存の競合（他の人が先に保存）時の取り込み: 最新の announce.json に、自分が触ったキャストの分だけを上書きする
// （QA P4: 同じ sha で保存し直すと永久に競合し、再読込で自分の調整が全部消えていた。全員分を上書きすると相手の調整を消す）
export function mergeAnnounce(latest, mine, touchedIds) {
  const casts = { ...latest.casts };
  for (const id of touchedIds) if (mine.casts[id]) casts[id] = mine.casts[id];
  return { version: 1, updated_month: mine.updated_month || latest.updated_month || '', casts };
}

// casts.json → ランク入りキャストの一覧（公開前の人も含む）。並びはショーケースと同じ（ランク → display_order → ID）
export function rankedCasts(castsJson) {
  const list = [];
  for (const c of (castsJson && castsJson.casts) || []) {
    const rank = c.auto && c.auto.rank;
    if (!RANKS.includes(rank)) continue;
    const m = c.manual || {};
    list.push({
      id: String(c.cast_id), rank, name: m.name || '', order: Number.isFinite(m.display_order) ? m.display_order : 9999,
      portraits: (m.portraits || []).filter(p => /^assets\/\d+_KV\d+\.png$/.test(p)),
      icon: /^assets\/\d+_icon\.png$/.test(m.icon || '') ? m.icon : '', published: !!m.published,
    });
  }
  list.sort((a, b) => RANKS.indexOf(a.rank) - RANKS.indexOf(b.rank) || a.order - b.order || Number(a.id) - Number(b.id));
  return list;
}

// ビルド後の公開パス（build.sh が PNG を WebP に変換する）
export function webpPath(pngPath) {
  return pngPath.replace(/\.png$/, '.webp');
}

// キャストが選べる画像の一覧。key は announce.json に保存する値
export function sourceOptions(cast, pastIds) {
  const out = [];
  if (pastIds.includes(cast.id)) out.push({ key: 'past', label: '前回の発表画像', url: `announce/past/${cast.id}.webp` });
  for (const p of cast.portraits) {
    const kv = /_(KV\d+)\.png$/.exec(p)[1];
    out.push({ key: kv, label: `立ち絵 ${kv}`, url: webpPath(p) });
  }
  if (cast.icon) out.push({ key: 'icon', label: 'アイコン（名前ラベル付き）', url: webpPath(cast.icon) });
  return out;
}

// 画像ごとの初期の切り出し。null は「読み込み後に立ち絵から推定する」
export function defaultFit(sourceKey) {
  if (sourceKey === 'past') return { x: 0.5, y: 0.5, zoom: 1 };          // PSD の配置そのまま
  if (sourceKey === 'icon') return { x: 0.5, y: 0.37, zoom: 1.35 };      // 下部の名前ラベルを避ける
  return null;
}

// 保存済み設定とキャストから、今回使う画像・切り出し・名前を決める
export function resolveEntry(saved, cast, pastIds) {
  const opts = sourceOptions(cast, pastIds);
  const name = saved && typeof saved.name === 'string' && saved.name.trim() ? saved.name : defaultName(cast.name);
  if (!opts.length) return { source: null, url: null, fit: null, name, options: opts };
  const keep = saved && opts.find(o => o.key === saved.source);
  const opt = keep || opts[0];
  const fit = keep && isFit(saved) ? { x: saved.x, y: saved.y, zoom: saved.zoom } : defaultFit(opt.key);
  return { source: opt.key, url: opt.url, fit, name, options: opts };
}

function isFit(v) {
  return v && [v.x, v.y, v.zoom].every(n => typeof n === 'number' && Number.isFinite(n));
}

export function clampFit(f) {
  const c = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  return { x: c(f.x, FIT_LIMITS.min, FIT_LIMITS.max), y: c(f.y, FIT_LIMITS.min, FIT_LIMITS.max), zoom: c(f.zoom, FIT_LIMITS.zoomMin, FIT_LIMITS.zoomMax) };
}

// 画像（幅 w・高さ h）から切り出す正方形。画像の外にはみ出してよい（はみ出しは透明＝丸の地色が見える）
export function cropRect(w, h, fit) {
  const size = Math.min(w, h) / fit.zoom;
  return { x: fit.x * w - size / 2, y: fit.y * h - size / 2, size };
}

// 丸の中でのドラッグ量（表示上のピクセル）→ 切り出し中心の移動量（画像に対する割合）
export function dragFit(fit, w, h, dxPx, dyPx, circlePx) {
  const size = Math.min(w, h) / fit.zoom;
  return clampFit({ x: fit.x - (dxPx / circlePx) * size / w, y: fit.y - (dyPx / circlePx) * size / h, zoom: fit.zoom });
}

// 透過立ち絵の顔位置の推定。alpha は縮小した不透明度の配列（行優先・gw×gh・0〜255）。
// いちばん上の不透明な行から下 8% を「頭」とみなし、その横幅の 1.8 倍の正方形で、頭頂が上から 6% に来るように切る
export function guessFit(alpha, gw, gh, w, h) {
  let top = -1;
  for (let y = 0; y < gh && top < 0; y++) for (let x = 0; x < gw; x++) if (alpha[y * gw + x] > 32) { top = y; break; }
  if (top < 0) return { x: 0.5, y: 0.25, zoom: 2 };
  const band = Math.max(1, Math.round(gh * 0.08));
  const xs = [];
  for (let y = top; y < Math.min(gh, top + band); y++) for (let x = 0; x < gw; x++) if (alpha[y * gw + x] > 32) xs.push(x);
  xs.sort((a, b) => a - b);
  const p = q => xs[Math.min(xs.length - 1, Math.floor(q * xs.length))];
  const sx = w / gw, sy = h / gh;
  const headW = Math.max(1, (p(0.9) - p(0.1) + 1) * sx);
  const cx = ((p(0.1) + p(0.9)) / 2 + 0.5) * sx;
  const side = Math.min(Math.min(w, h), Math.max(Math.min(w, h) * 0.12, headW * 1.8));
  const cy = top * sy - side * 0.06 + side / 2;
  return clampFit({ x: cx / w, y: cy / h, zoom: Math.min(w, h) / side });
}

// 人数から全体の配置を決める。layout は layout.json、counts は {GOLD: n, ...}
// 返り値: { height, panels: [{rank, y, h, rows}], slots: {RANK: [{x, y}]} }（slot は枠の左上）
export function computeLayout(layout, counts) {
  let y = layout.bg.top_fixed;
  const panels = [], slots = {};
  for (const rank of RANKS) {
    const n = counts[rank] || 0;
    slots[rank] = [];
    if (!n) continue;
    const spec = layout.ranks[rank], cols = spec.cols, k = cols.length;
    const rows = Math.ceil(n / k);
    const span = (rows - 1) * spec.row_pitch + spec.item.item_h;
    const h = Math.max(span + 2 * spec.panel.pad, spec.panel.min_h);
    const top = y + (h - span) / 2;
    const step = k > 1 ? cols[1] - cols[0] : 0;
    for (let i = 0; i < n; i++) {
      const r = Math.floor(i / k), j = i % k;
      const inRow = Math.min(k, n - r * k);   // 端数の行は中央寄せ
      slots[rank].push({ x: Math.round(cols[0] + (j + (k - inRow) / 2) * step), y: Math.round(top + r * spec.row_pitch) });
    }
    panels.push({ rank, y, h, rows });
    y += h + layout.panel_gap;
  }
  const lastBottom = panels.length ? y - layout.panel_gap : layout.bg.top_fixed;
  const height = Math.round(lastBottom + (layout.source_height - layout.bg.bottom_fixed));
  return { height, panels, slots, lastBottom };
}

// 背景の縦方向の貼り方: [元のy, 元の高さ, 先のy, 先の高さ] の列。上部と下部は固定、間を伸縮
export function bgSlices(layout, lastBottom) {
  const t = layout.bg.top_fixed, b = layout.bg.bottom_fixed, H = layout.source_height;
  return [[0, t, 0, t], [t, b - t, t, lastBottom - t], [b, H - b, lastBottom, H - b]];
}

// パネルの縦方向の貼り方（5分割: 上端・上の伸縮帯・月桂樹・下の伸縮帯・下端）。dstH は余白込みの高さ
export function panelSlices(panel, dstH) {
  const { cap_top: ct, laurel: [la, lb], cap_bottom: cb } = panel.bands;
  const H = panel.h, lh = lb - la;
  const dla = Math.round((dstH - lh) / 2);
  const dcb = dstH - (H - cb);
  if (dla < ct || dla + lh > dcb) throw new Error('パネルの高さが足りません（最小高さの設定を確認してください）');
  return [
    [0, ct, 0, ct],
    [ct, la - ct, ct, dla - ct],
    [la, lh, dla, lh],
    [lb, cb - lb, dla + lh, dcb - dla - lh],
    [cb, H - cb, dcb, H - cb],
  ];
}

// 名前が下線の幅に収まる文字サイズ
export function fitFontPx(px, measuredWidth, maxWidth) {
  if (!(measuredWidth > maxWidth)) return px;
  return px * maxWidth / measuredWidth;
}

// announce.json の検証。壊れた値は捨てずにエラーにする（黙って初期値に戻すと調整が消えたことに気づけない）
export function parseAnnounce(text) {
  const d = JSON.parse(text);
  if (!d || d.version !== 1 || !d.casts || typeof d.casts !== 'object' || Array.isArray(d.casts)) throw new Error('announce.json の形式が不正です');
  const casts = {};
  for (const [id, v] of Object.entries(d.casts)) {
    if (!/^[1-9]\d*$/.test(id) || !v || typeof v !== 'object') throw new Error(`announce.json のキャスト ${id} が不正です`);
    const e = {};
    if (v.source !== undefined) {
      if (typeof v.source !== 'string' || !/^(past|icon|KV\d+)$/.test(v.source)) throw new Error(`キャスト ${id} の画像の指定が不正です`);
      e.source = v.source;
    }
    if (v.name !== undefined) {
      if (typeof v.name !== 'string' || v.name.length > 40) throw new Error(`キャスト ${id} の名前が不正です`);
      e.name = v.name;
    }
    if (v.x !== undefined || v.y !== undefined || v.zoom !== undefined) {
      if (!isFit(v)) throw new Error(`キャスト ${id} の位置・拡大率が不正です`);
      const c = clampFit(v);
      if (c.x !== v.x || c.y !== v.y || c.zoom !== v.zoom) throw new Error(`キャスト ${id} の位置・拡大率が範囲外です`);
      Object.assign(e, c);
    }
    casts[id] = e;
  }
  return { version: 1, updated_month: typeof d.updated_month === 'string' ? d.updated_month : '', casts };
}

export function serializeAnnounce(data) {
  const casts = {};
  for (const id of Object.keys(data.casts).sort((a, b) => Number(a) - Number(b))) {
    const v = data.casts[id], e = {};
    if (v.source) e.source = v.source;
    if (v.name) e.name = v.name;
    if (isFit(v)) { e.x = round4(v.x); e.y = round4(v.y); e.zoom = round4(v.zoom); }
    casts[id] = e;
  }
  return JSON.stringify({ version: 1, updated_month: data.updated_month || '', casts }, null, 2) + '\n';
}

function round4(n) { return Math.round(n * 10000) / 10000; }

// 書き出しファイル名「202610ランク発表画像.png」
export function exportFileName(ym) {
  return `${ym.replace('-', '')}ランク発表画像.png`;
}
