// ランク入りキャスト自動スライダー（iPhone枠つき）本体
// STUDIO には studio_rank_slider_snippet.html（div＋このファイルを読む script の2行）を貼る。
// iframe で包むと STUDIO がボックスの高さを測れない（2026-10-15 に 150px へ縮んだ）ため、
// 移設前の直貼りと同じく STUDIO のボックスの中に直接描く。中身を直すときはこのファイルを直す。
(() => {
  const CSS = `
html, body { margin: 0; padding: 0; background: transparent; }

.fade-slider {
  position: relative;
  width: 100%;
  aspect-ratio: 9 / 19.5;      /* 枠画像(900x1950)と同比率 */
  overflow: hidden;
  line-height: 0;
}
/* iPhone枠（最前面・共通） */
.phone-frame {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: 5;
  pointer-events: none;
}
.fade-slide {
  position: absolute;
  inset: 0;
  opacity: 0;
  transition: opacity 1s ease;
  z-index: 0;
  /* 画面形状のピクセル精度マスク（旧スライダー画像から抽出）。
     これで立ち絵・背景が枠から一切はみ出さない */
  -webkit-mask-image: url("https://backstage-unei.github.io/bs-cast-showcase-site/assets/studio_screen_mask.webp");
  -webkit-mask-size: 100% 100%;
  -webkit-mask-repeat: no-repeat;
  mask-image: url("https://backstage-unei.github.io/bs-cast-showcase-site/assets/studio_screen_mask.webp");
  mask-size: 100% 100%;
  mask-repeat: no-repeat;
}
/* フォールバック（枠込みの旧画像）はマスク不要 */
.fade-slide.full-slide {
  -webkit-mask-image: none;
  mask-image: none;
}
.fade-slide.is-active {
  opacity: 1;
  z-index: 1;
}
/* 画面領域（枠画像の実測: 左右5.33% / 上3.9% / 下5.2%） */
.fade-slide .screen {
  position: absolute;
  inset: 3.9% 5.33% 5.2% 5.33%;
  border-radius: 11.2% / 5.1%;   /* 画面の角丸（≒90px/900px） */
  overflow: hidden;
}
.fade-slide .screen img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center top;   /* {id}_slide.webp は顔基準で切り出し済み */
}
/* ポップ背景: 旧スライダーの元デザイン（薄グリッド＋水色の丸帯＋ピンクの
   斜め帯＋キラキラ）をSVGで再現し、ベース色だけ各キャストの立ち絵から
   自動抽出した色（accent_color）で塗り分ける。色が取れないキャストは既定の黄色 */
.fade-slide .screen {
  background:
    url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 900 1950'%3E%3Cdefs%3E%3Cpattern id='g' width='66' height='66' patternUnits='userSpaceOnUse'%3E%3Cpath d='M66 0H0V66' fill='none' stroke='%23ffffff' stroke-opacity='0.22' stroke-width='3'/%3E%3C/pattern%3E%3ClinearGradient id='p' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0' stop-color='%23ff9ad5'/%3E%3Cstop offset='1' stop-color='%23c9a6ff'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='900' height='1950' fill='url(%23g)'/%3E%3Crect x='-660' y='20' width='1500' height='280' rx='140' fill='%2386c9f0' fill-opacity='0.95' transform='rotate(-56 180 160)'/%3E%3Cg fill='url(%23p)' opacity='0.55' transform='rotate(38 900 0)'%3E%3Crect x='860' y='-120' width='150' height='900'/%3E%3Crect x='1060' y='-120' width='90' height='900'/%3E%3C/g%3E%3Cg fill='%23ffffff'%3E%3Cpath transform='translate(120 200) scale(1.1)' d='M0 -28C3 -8 8 -3 28 0C8 3 3 8 0 28C-3 8 -8 3 -28 0C-8 -3 -3 -8 0 -28Z'/%3E%3Cpath transform='translate(790 150) scale(0.6)' d='M0 -28C3 -8 8 -3 28 0C8 3 3 8 0 28C-3 8 -8 3 -28 0C-8 -3 -3 -8 0 -28Z'/%3E%3Cpath transform='translate(70 640) scale(0.5)' d='M0 -28C3 -8 8 -3 28 0C8 3 3 8 0 28C-3 8 -8 3 -28 0C-8 -3 -3 -8 0 -28Z'/%3E%3Cpath transform='translate(830 760) scale(0.7)' d='M0 -28C3 -8 8 -3 28 0C8 3 3 8 0 28C-3 8 -8 3 -28 0C-8 -3 -3 -8 0 -28Z'/%3E%3C/g%3E%3C/svg%3E")
      center / cover no-repeat,
    var(--bg, #ffd93b);
}
/* フォールバック時（枠込みの旧画像）は全面表示 */
.fade-slide .full {
  display: block;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  object-position: center;
}

/* モーション軽減設定の端末では切り替えを即時に（フェードを無効化） */
@media (prefers-reduced-motion: reduce) {
  .fade-slide { transition: none; }
}
`;
  const SITE = 'https://backstage-unei.github.io/bs-cast-showcase-site/';
  const INTERVAL = 3000;   // 切り替え間隔(ms)
  // データが読めないときに表示する固定画像（従来のスライダー画像・枠込み）
  const FALLBACK = [
    'https://storage.googleapis.com/studio-design-asset-files/projects/xmaZwRNDWR/s-900x1950_v-frms_webp_92c8a8cc-3028-4365-a596-5ae42df14deb.png',
    'https://storage.googleapis.com/studio-design-asset-files/projects/xmaZwRNDWR/s-900x1950_v-frms_webp_5374b2f2-95e7-41f5-9d42-50e5385197c8.png',
    'https://storage.googleapis.com/studio-design-asset-files/projects/xmaZwRNDWR/s-900x1950_v-frms_webp_f00b3c40-d482-43d2-89a0-0178b20e757c.png'
  ];

  const slider = document.getElementById('cast-fade-slider');
  if (!slider || slider.dataset.ready) return;   // 二重に読み込まれても1回だけ動かす
  slider.dataset.ready = '1';
  slider.classList.add('fade-slider');
  if (!document.getElementById('cast-fade-slider-style')) {
    const style = document.createElement('style');
    style.id = 'cast-fade-slider-style';
    style.textContent = CSS;
    document.head.appendChild(style);
  }

  let urls = [], alts = [], colors = [], isFallback = false, current = 0, timer = null;
  const slides = [];

  // スライドは必要になる直前に作る（全キャスト分を一気に読み込まない）
  const makeSlide = (i) => {
    if (slides[i] || !urls[i]) return;
    const div = document.createElement('div');
    div.className = 'fade-slide' + (isFallback ? ' full-slide' : '') + (i === 0 ? ' is-active' : '');
    if (colors[i]) div.style.setProperty('--bg', colors[i]);
    const img = document.createElement('img');
    img.src = urls[i];
    img.alt = alts[i] || '';
    img.decoding = 'async';
    if (i === 0) img.fetchPriority = 'high';
    if (isFallback) {
      img.className = 'full';
      div.appendChild(img);
    } else {
      const screen = document.createElement('div');
      screen.className = 'screen';
      screen.appendChild(img);
      div.appendChild(screen);
    }
    slider.appendChild(div);
    slides[i] = div;
  };

  const next = () => {
    if (urls.length < 2) return;
    const nxt = (current + 1) % urls.length;
    makeSlide(nxt);
    makeSlide((nxt + 1) % urls.length);   // さらに次を先読み
    slides[current].classList.remove('is-active');
    slides[nxt].classList.add('is-active');
    current = nxt;
  };
  const start = () => { if (urls.length > 1) timer ??= setInterval(next, INTERVAL); };
  const stop  = () => { clearInterval(timer); timer = null; };

  const boot = (list, names, accents, fallback) => {
    urls = list; alts = names || []; colors = accents || []; isFallback = !!fallback;
    if (!urls.length) return;
    if (!isFallback) {
      // iPhone枠（全スライド共通・最前面）
      const frame = document.createElement('img');
      frame.className = 'phone-frame';
      frame.src = SITE + 'assets/studio_frame.webp';
      frame.alt = '';
      frame.fetchPriority = 'high';
      slider.appendChild(frame);
    }
    makeSlide(0);
    makeSlide(1);
    start();
  };

  // 公開データ（window.SHOWCASE を定義するJS）を読み込む
  const s = document.createElement('script');
  s.src = SITE + 'casts-data.js';
  s.onload = () => {
    const casts = ((window.SHOWCASE && window.SHOWCASE.casts) || [])
      .filter((c) => c.portraits && c.portraits.length);
    if (!casts.length) { boot(FALLBACK, [], [], true); return; }
    // 表示順をランダムに（読み込みごとにシャッフル・Fisher–Yates）
    for (let i = casts.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [casts[i], casts[j]] = [casts[j], casts[i]];
    }
    // {id}_slide.webp = 顔基準でバストアップ切り出し済みのスライダー専用画像
    boot(casts.map((c) => SITE + 'assets/' + c.cast_id + '_slide.webp'),
         casts.map((c) => c.name || ''),
         casts.map((c) => /^#[0-9a-f]{6}$/.test(c.accent_color || '') ? c.accent_color : ''),
         false);
  };
  s.onerror = () => boot(FALLBACK, [], [], true);
  document.head.appendChild(s);

  // タブ/プレビューが非表示の間は止めて、見えないフェードを動かさない
  document.addEventListener('visibilitychange',
    () => document.hidden ? stop() : start());
})();
