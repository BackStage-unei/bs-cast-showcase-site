// DM 通知（「キャストから直接メッセージが届くことも・・・？👀」の丸い顔が 8 秒ごとに替わる吹き出し）の本体。
// STUDIO には studio_dm_snippet.html の3行（読み込み前の高さの style・div・このファイルを読む script）を貼る。iframe で包まない
// （STUDIO の埋め込みボックスは中身から高さを測るため。iframe だと 150px に縮んだ＝スライダーと同じ教訓）。
// 見た目（CSS・文言・svg）は 2026-10-15 まで STUDIO に直貼りしていた HTML と同じ。中身を直すときはこのファイルを直す。
//
// 読むもの（このファイルと同じサイト）: casts-data.js（出る人）、embed/dm-faces.json（顔の位置。ビルドが data/dm-faces.json から作る）
// 顔の位置の値: x・y = {id}_dm.webp の中の顔の中心（どちらも画像の幅に対する割合）、size = 丸に入れる幅（画像の幅に対する割合）
// 登場の順番は読み込むたびにランダム。div に data-start="cast_id" を付けると、その人から始まる（確認・撮影用）
//
// 下の「計算部分」は DOM を使わない純粋関数で、tests/js/dm-notice.test.mjs が node で読む。調整画面（slider.html）も同じ計算を使う。
(function (root) {
  'use strict';

  // ---------- 計算部分（DOM なし） ----------
  var RANKS = ['GOLD', 'SILVER', 'BRONZE'];
  // 登録の無い人は、画像の上の部分（幅いっぱいの丸）を使う。x・y・size はどれも画像の幅に対する割合なので、
  // {0.5, 0.5, 1} は「上端から幅と同じ高さまでの正方形」に内接する丸
  var DEFAULT_CROP = { x: 0.5, y: 0.5, size: 1 };
  // 値の範囲（scripts/portraits_lib.py の DM_* と同じ。JS ではここが唯一の定義で、slider-lib.mjs・調整画面もこれを使う）。
  // y の上限 3 は検査の目安。実際の上限は画像の縦横比（丸の中心が画像の中に残る範囲。slider-lib の dmYMax / portraits_lib.dm_y_max）
  var LIMITS = { xMax: 1, yMax: 3, sizeMin: 0.05, sizeMax: 1 };
  var SOURCE_RE = /^[A-Za-z0-9_-]{1,40}$/;

  function inRange(v, min, max) {
    return typeof v === 'number' && isFinite(v) && v >= min && v <= max;
  }

  // embed/dm-faces.json の中身から、正しい値の行だけを残す（壊れた行は既定に落ちる）
  function normalizeCrops(json) {
    var out = {};
    var crops = json && typeof json === 'object' ? json.crops : null;
    if (!crops || typeof crops !== 'object' || Array.isArray(crops)) return out;
    Object.keys(crops).forEach(function (id) {
      var c = crops[id];
      if (!/^[1-9][0-9]*$/.test(id) || !c || typeof c !== 'object') return;
      if (inRange(c.x, 0, LIMITS.xMax) && inRange(c.y, 0, LIMITS.yMax) && inRange(c.size, LIMITS.sizeMin, LIMITS.sizeMax)) {
        out[id] = { x: c.x, y: c.y, size: c.size };
      }
    });
    return out;
  }

  // 丸の中に置く画像の大きさと位置（CSS の % 文字列）。直貼り版と同じ式
  function cropStyle(crop) {
    var c = crop || DEFAULT_CROP;
    return {
      width: (100 / c.size) + '%',
      left: (50 - (100 * c.x) / c.size) + '%',
      top: (50 - (100 * c.y) / c.size) + '%',
    };
  }

  // 表示するキャスト: ランク入り・立ち絵あり・名前あり（直貼り版と同じ条件）
  function selectCasts(list) {
    return (Array.isArray(list) ? list : []).filter(function (c) {
      return c && RANKS.indexOf(c.rank) >= 0 && Array.isArray(c.portraits) && c.portraits.length && c.name &&
        /^[1-9][0-9]*$/.test(String(c.cast_id));
    });
  }

  // 順番をランダムに（Fisher–Yates）。start があればその人を先頭に。元の配列は変えない
  function shuffle(list, random, start) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    if (start) {
      for (var k = 0; k < a.length; k++) {
        if (String(a[k].cast_id) === String(start)) { a.unshift(a.splice(k, 1)[0]); break; }
      }
    }
    return a;
  }

  // ---------- 調整画面（slider.html）が使う計算 ----------
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function isSize(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 1 && isFinite(v); }
  function clampN(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }
  function round6(n) { return Math.round(n * 1e6) / 1e6; }

  // data/dm-faces.json の1人分の検査（portraits_lib.dm_entry_problem と同じ規則）。正しければ null、壊れていれば理由
  function entryProblem(v) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return '値がオブジェクトではありません';
    if (typeof v.source !== 'string' || !SOURCE_RE.test(v.source)) return 'source（調整した立ち絵）が不正です';
    var keys = ['x', 'y', 'size'];
    for (var i = 0; i < keys.length; i++) if (!isNum(v[keys[i]])) return keys[i] + ' が数値ではありません';
    if (!(v.x >= 0 && v.x <= LIMITS.xMax && v.y >= 0 && v.y <= LIMITS.yMax)) return 'x・y が範囲外です（x は 0〜' + LIMITS.xMax + '、y は 0〜' + LIMITS.yMax + '）';
    if (!(v.size >= LIMITS.sizeMin && v.size <= LIMITS.sizeMax)) return 'size が ' + LIMITS.sizeMin + '〜' + LIMITS.sizeMax + ' の範囲外です';
    if (!(isSize(v.w) && isSize(v.h))) return 'w・h（調整した立ち絵の大きさ）が無いか不正です';
    return null;
  }

  // 保存できる値にそろえる（範囲内・小数6桁）。yMax = その画像で丸の中心が画像の中に残る y の上限（省略時は検査の目安 3）
  function clampCrop(f, yMax) {
    var ym = Math.min(LIMITS.yMax, typeof yMax === 'number' && yMax > 0 ? yMax : LIMITS.yMax);
    return { x: round6(clampN(f.x, 0, LIMITS.xMax)), y: round6(clampN(f.y, 0, ym)), size: round6(clampN(f.size, LIMITS.sizeMin, LIMITS.sizeMax)) };
  }
  // 既定（＝未登録と同じ見え方）か
  function isDefault(fit) {
    var f = clampCrop(fit);
    return f.x === DEFAULT_CROP.x && f.y === DEFAULT_CROP.y && f.size === DEFAULT_CROP.size;
  }
  // ドラッグ: 画面上の移動量 dx・dy（px）だけ絵を動かす。imgPx = 丸の中の画像の表示幅（px）。絵を右へ動かす = 顔の中心の値は左へ
  function dragCrop(start, dx, dy, imgPx, yMax) {
    return clampCrop({ x: start.x - dx / imgPx, y: start.y - dy / imgPx, size: start.size }, yMax);
  }
  // 大きさ（拡大率 = 1/size）を変える。顔の中心はそのまま
  function zoomCrop(fit, zoom, yMax) {
    return clampCrop({ x: fit.x, y: fit.y, size: 1 / clampN(zoom, 1 / LIMITS.sizeMax, 1 / LIMITS.sizeMin) }, yMax);
  }
  // 見た目が同じか（丸の中の切り抜き＝cropStyle の結果が、実寸の丸（中の幅 106px）で 1px 未満の差）。未保存の判定に使う
  // （拡大スライダーの 0.01 刻みで触って戻しただけの差を「変更」と数えない）
  var LOOK_TOLERANCE = 100 / 106;   // % で 1px
  function sameLook(a, b) {
    var sa = cropStyle(a), sb = cropStyle(b);
    return ['width', 'left', 'top'].every(function (k) { return Math.abs(parseFloat(sa[k]) - parseFloat(sb[k])) < LOOK_TOLERANCE; });
  }

  // 丸（ボタン）と吹き出しのマークアップ。本体と調整画面のプレビューの両方がこれを使う（文言・svg を1か所に）
  var AVATAR_HTML = '<button class="avatar" type="button" aria-label="顔画像の自動切り替えを停止"><img alt=""></button>';
  function markup() {
    return '<section class="dm" aria-label="キャストからのメッセージ紹介">' +
      '<div class="notice">' + AVATAR_HTML +
      '<div class="copy"><p class="message">キャストから直接メッセージが届くことも・・・？👀</p>' +
      '<svg class="envelope" viewBox="0 0 68 54" fill="none" aria-hidden="true"><rect x="2" y="3" width="64" height="48" rx="3" stroke="currentColor" stroke-width="3"/><path d="m4 6 30 21L64 6" stroke="currentColor" stroke-width="3" stroke-linejoin="round"/></svg>' +
      '</div></div></section>';
  }

  // 直貼り版の <style> と同じ指定を、この部品の中だけに効くようにしたもの（html/body はスライダーと同じく余白なし・透明）
  var P = '#bs-dm-notice ';
  var CSS = [
    'html,body{margin:0;background:transparent}',
    '#bs-dm-notice{color:#fff;font-family:\'LINE Seed JP\',sans-serif}',
    '#bs-dm-notice,' + P + '*{box-sizing:border-box}',
    P + '.dm{width:100%;max-width:780px;margin:auto;padding:16px 12px}',
    P + '.notice{display:grid;grid-template-columns:108px minmax(0,1fr);align-items:center;gap:24px}',
    P + '.avatar{display:block;position:relative;overflow:hidden;width:100%;aspect-ratio:1;border:1px solid #ffffffa0;border-radius:50%;background:#ffffff08;padding:4px;cursor:pointer}',
    P + '.avatar img{display:block;position:absolute;width:100%;height:auto;max-width:none;left:0;top:0;border-radius:0}',
    P + '.avatar:focus-visible{outline:2px solid #ff78b7;outline-offset:5px}',
    P + '.copy{position:relative;min-height:98px;display:flex;align-items:center;padding:22px 65px 22px 26px;border:1px solid #ffffff80;border-radius:24px 24px 24px 6px;background:#171b2d26}',
    P + '.message{margin:0;font-size:19px;font-weight:400;line-height:1.8;letter-spacing:.035em;text-wrap:pretty}',
    P + '.envelope{position:absolute;right:22px;top:50%;transform:translateY(-50%);width:28px;height:28px;color:#fff;overflow:visible}',
    P + '.copy:after{content:\'\';position:absolute;right:18px;top:calc(50% - 18px);width:7px;height:7px;background:#ff328d;border-radius:50%}',
    // 切り替えはランク入りスライダー（rank-slider.js）と同じく、新しい顔を上に重ねて1秒でフェードイン
    P + '.avatar img{opacity:1;transition:opacity 1s ease}',
    // 立ち絵は背景が透明なので、古い顔を残したまま新しい顔を重ねると透けて残像になる → 古い顔は同時に薄くする（クロスフェード）
    P + '.avatar img.is-entering,' + P + '.avatar img.is-leaving{opacity:0}',
    '@media(max-width:600px){' + P + '.dm{padding:12px 4px}' + P + '.notice{grid-template-columns:66px minmax(0,1fr);gap:14px;align-items:center}' +
      P + '.avatar{padding:2px}' + P + '.copy{min-height:100px;border-radius:20px 20px 20px 5px;padding:16px 32px 16px 16px}' +
      P + '.message{font-size:14px;line-height:1.85;letter-spacing:0}' + P + '.envelope{width:19px;height:19px;right:8px;top:auto;bottom:10px;transform:none}' +
      P + '.copy:after{right:6px;top:auto;bottom:27px;width:5px;height:5px}}',
    '@media(prefers-reduced-motion:reduce){' + P + '.avatar img{transition:none}}',
  ].join('\n');

  // 切り替え間隔とフェードの長さ（ランク入りスライダーの INTERVAL・transition と同じ）
  var INTERVAL = 3000, FADE_MS = 1000;

  var lib = { INTERVAL: INTERVAL, FADE_MS: FADE_MS, RANKS: RANKS, DEFAULT_CROP: DEFAULT_CROP, LIMITS: LIMITS, normalizeCrops: normalizeCrops, cropStyle: cropStyle,
    selectCasts: selectCasts, shuffle: shuffle, CSS: CSS,
    entryProblem: entryProblem, clampCrop: clampCrop, isDefault: isDefault, dragCrop: dragCrop, zoomCrop: zoomCrop, sameLook: sameLook,
    AVATAR_HTML: AVATAR_HTML, markup: markup };

  if (typeof module === 'object' && module.exports) { module.exports = lib; return; }
  root.BsDmNotice = lib;   // 調整画面（slider.html）が同じ計算を使う

  // ---------- 画面部分 ----------
  var box = document.getElementById('bs-dm-notice');
  if (!box || box.dataset.ready) return;   // 置き場所が無い（調整画面など）・二重に読み込まれた → 何もしない
  box.dataset.ready = '1';

  // このファイルの置き場所からサイトの場所を決める（本番は backstage-unei.github.io/bs-cast-showcase-site/、ローカル確認ではローカル）
  var FALLBACK_SITE = 'https://backstage-unei.github.io/bs-cast-showcase-site/';
  var script = document.currentScript;
  var SITE = FALLBACK_SITE;
  try { if (script && script.src) SITE = new URL('../', script.src).href; } catch (e) { /* 既定のまま */ }

  if (!document.getElementById('bs-dm-notice-style')) {
    var style = document.createElement('style');
    style.id = 'bs-dm-notice-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }
  if (!document.getElementById('bs-dm-notice-font')) {
    var font = document.createElement('link');
    font.id = 'bs-dm-notice-font';
    font.rel = 'stylesheet';
    font.href = 'https://fonts.googleapis.com/css2?family=LINE+Seed+JP:wght@400;700&display=swap';
    document.head.appendChild(font);
  }

  // 直貼り版と同じマークアップ（文言・svg も同じ。データ由来の文字列は入れない）
  box.innerHTML = markup();
  // 読み込み前の高さ確保（STUDIO に貼った <style> の min-height）は、描いたら外して中身の高さに戻す
  box.style.minHeight = '0';

  var section = box.querySelector('.dm'), card = box.querySelector('.notice'), avatar = box.querySelector('img'), button = box.querySelector('button');
  var reduced = window.matchMedia ? matchMedia('(prefers-reduced-motion:reduce)') : { matches: false, addEventListener: function () {} };
  var casts = [], crops = {}, index = 0, timer = null, visible = false, userPaused = false, generation = 0;

  function srcOf(cast) { return SITE + 'assets/' + encodeURIComponent(cast.cast_id) + '_dm.webp'; }
  // 次の人の画像を先に読んでおく（3秒ごとの切り替えでも、フェードの途中で画像が空にならないように）
  function preload(i) { var c = casts[i]; if (c) { var im = new Image(); im.src = srcOf(c); } }

  // 新しい顔の img を今の顔の上に重ね、透明から1秒でフェードインさせる。終わったら下の古い顔を外す。
  // 最初の1人目と、動きを減らす設定の人はフェードなしで差し替える
  function display(i) {
    var cast = casts[i]; if (!cast) return;
    var token = ++generation, image = new Image();
    image.onload = function () {
      if (token !== generation) return;
      var s = cropStyle(crops[String(cast.cast_id)]);
      var first = !avatar.getAttribute('src');
      if (first || reduced.matches) {
        avatar.style.width = s.width; avatar.style.left = s.left; avatar.style.top = s.top;
        avatar.src = image.src;
        var olds = button.querySelectorAll('img');
        for (var k = 0; k < olds.length; k++) if (olds[k] !== avatar) button.removeChild(olds[k]);
      } else {
        var next = document.createElement('img');
        next.alt = '';
        next.className = 'is-entering';
        next.style.width = s.width; next.style.left = s.left; next.style.top = s.top;
        next.src = image.src;
        button.appendChild(next);
        var prev = avatar;
        avatar = next;
        // 透明の状態を一度ブラウザに確定させてから（offsetWidth を読む）透明を外すと、そこからフェードする。
        // 描画のタイミング（requestAnimationFrame）に頼ると、タブの状態によっては呼ばれず透明のまま残るので使わない
        void next.offsetWidth;
        next.classList.remove('is-entering');
        // 下に残っている顔（直前の顔・連打で重なった顔）は同時に薄くしていく
        var under = button.querySelectorAll('img');
        for (var u = 0; u < under.length; u++) if (under[u] !== next) under[u].classList.add('is-leaving');
        setTimeout(function () {
          // フェードが終わったら、下に残った古い顔を外す（連打で何枚も重なっても最新の1枚だけ残す）
          var all = button.querySelectorAll('img');
          for (var k = 0; k < all.length; k++) if (all[k] !== avatar && all[k] !== next) button.removeChild(all[k]);
          if (prev !== avatar && prev.parentNode) prev.parentNode.removeChild(prev);
        }, FADE_MS + 100);
      }
      if (casts.length > 1) preload((i + 1) % casts.length);
    };
    image.onerror = function () {};
    image.src = srcOf(cast);
  }
  function sync() {
    clearInterval(timer); timer = null;
    var stopped = userPaused || reduced.matches;
    button.setAttribute('aria-label', stopped ? 'キャストを切り替える' : 'キャストの自動切り替えを停止');
    button.disabled = casts.length < 2;
    if (!document.hidden && visible && !stopped && casts.length > 1) {
      timer = setInterval(function () { index = (index + 1) % casts.length; display(index); }, INTERVAL);
    }
  }
  button.onclick = function () {
    if (reduced.matches) { index = (index + 1) % casts.length; display(index); } else userPaused = !userPaused;
    sync();
  };
  document.addEventListener('visibilitychange', sync);
  if (reduced.addEventListener) reduced.addEventListener('change', sync);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) { visible = entries[0].isIntersecting; sync(); }, { threshold: 0.1 }).observe(section);
  } else visible = true;

  // 顔の位置が読めなくても、既定（画像の上の部分）で表示は続ける
  var cropsReady = fetch(SITE + 'embed/dm-faces.json', { cache: 'no-cache' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (j) { crops = normalizeCrops(j); })
    .catch(function () {});
  var data = document.createElement('script');
  data.src = SITE + 'casts-data.js';
  data.onload = function () {
    cropsReady.then(function () {
      casts = shuffle(selectCasts(window.SHOWCASE && window.SHOWCASE.casts), Math.random, box.dataset.start);
      if (casts.length) display(0);
      sync();
    });
  };
  data.onerror = function () { button.disabled = true; };
  document.head.appendChild(data);
  sync();
})(typeof self !== 'undefined' ? self : this);
