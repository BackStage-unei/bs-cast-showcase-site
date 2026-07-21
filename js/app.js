// 一覧⇔個別をページ遷移なしで切り替えるSPA
// STUDIOのsandbox iframe内では再読み込みが目立つため、DOM切り替えで瞬時に遷移し
// 一覧のスクロール位置も保持する。?id=NN 付きで開かれたら最初から個別を表示する。
// 切り替え時は .view-leave（退場160ms）→ .view-enter（要素ごとの時差fade-up）で
// アニメーションする（定義は css/cast.css。reduced-motion時は即切り替え）。
(function () {
  "use strict";
  var S = window.Showcase;
  var listView = document.getElementById("listView");
  var detailView = document.getElementById("detailView");
  var tiers = document.getElementById("tiers");
  if (!listView || !detailView || !tiers || !S) return;

  var listScrollY = 0;      // 一覧に戻ったとき復元するスクロール位置
  var canHistory = true;    // sandbox等でhistory操作が失敗したらfalseにして以後使わない
  var LEAVE_MS = 160;       // .view-leave のアニメ時間と合わせる

  function push(id) {
    if (!canHistory) return;
    try {
      history.pushState({ id: id }, "", id != null ? "./?id=" + encodeURIComponent(id) : "./");
    } catch (e) {
      canHistory = false;
    }
  }

  function reducedMotion() {
    return window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  // fromEl を退場させてから apply()（描画・表示切替・スクロール）を実行し、toEl を登場させる
  function swapViews(fromEl, toEl, apply) {
    var run = function () {
      if (fromEl) {
        fromEl.classList.remove("view-leave");
        fromEl.hidden = true;
      }
      apply();
      toEl.hidden = false;
      toEl.classList.remove("view-enter");
      void toEl.offsetWidth; // 同じビューに再入場してもアニメが再生されるようreflow
      toEl.classList.add("view-enter");
    };
    if (!fromEl || fromEl.hidden || reducedMotion()) {
      run();
      return;
    }
    fromEl.classList.add("view-leave");
    window.setTimeout(run, LEAVE_MS);
  }

  // ---------- 一覧 ----------
  var lazy = "IntersectionObserver" in window
    ? new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var img = entry.target;
          img.src = img.dataset.src;
          lazy.unobserve(img);
        });
      }, { rootMargin: "300px 0px" })
    : null;

  function avatar(cast, className, useLazy) {
    var wrap = S.el("span", className);
    if (cast.icon) {
      var img = document.createElement("img");
      img.alt = "";
      img.decoding = "async";
      img.addEventListener("error", function () {
        img.remove();
        wrap.dataset.fallback = (cast.name || "?").charAt(0);
      });
      if (useLazy && lazy) {
        img.dataset.src = cast.icon;
        lazy.observe(img);
      } else {
        img.src = cast.icon;
      }
      wrap.appendChild(img);
    } else {
      wrap.dataset.fallback = (cast.name || "?").charAt(0);
    }
    return wrap;
  }

  function spaLink(el, handler) {
    el.addEventListener("click", function (e) {
      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return; // 新規タブ系はブラウザに任せる
      e.preventDefault();
      handler();
    });
  }

  function renderList() {
    var monthEl = document.getElementById("rankMonth");
    var month = (window.SHOWCASE && window.SHOWCASE.rank_month) || "";
    if (monthEl && month) monthEl.textContent = month.replace("-", ".") + " RANKING";

    S.RANKS.forEach(function (rank) {
      var members = S.casts().filter(function (c) { return c.rank === rank; });
      if (!members.length) return;

      var tier = S.el("section", "tier tier--" + rank + " reveal");
      var head = S.el("div", "tier__head");
      var label = S.el("h2", "tier__label");
      label.appendChild(S.el("span", "tier__en", rank));
      label.appendChild(S.el("span", "tier__count", S.RANK_JA[rank] + " / " + members.length + "名"));
      head.appendChild(label);
      head.appendChild(S.el("span", "tier__stripes"));
      tier.appendChild(head);

      var grid = S.el("div", "tier__grid");
      members.forEach(function (cast) {
        var card = document.createElement("a");
        card.className = "cast-card reveal";
        card.href = "./?id=" + encodeURIComponent(cast.cast_id);
        spaLink(card, function () { showDetail(cast.cast_id, true); });
        card.appendChild(avatar(cast, "cast-card__avatar", true));
        card.appendChild(S.el("span", "cast-card__rank", cast.rank));
        card.appendChild(S.el("h3", "cast-card__name", cast.name));
        if (cast.name_reading) card.appendChild(S.el("p", "cast-card__reading", cast.name_reading));
        if (cast.catch) card.appendChild(S.el("p", "cast-card__catch", cast.catch));
        grid.appendChild(card);
      });
      tier.appendChild(grid);
      tiers.appendChild(tier);
    });

    if ("IntersectionObserver" in window) {
      var reveal = new IntersectionObserver(function (entries) {
        entries.forEach(function (entry) {
          if (entry.isIntersecting) {
            entry.target.classList.add("is-in");
            reveal.unobserve(entry.target);
          }
        });
      }, { threshold: 0.06 });
      document.querySelectorAll(".reveal").forEach(function (n) { reveal.observe(n); });
    } else {
      document.querySelectorAll(".reveal").forEach(function (n) { n.classList.add("is-in"); });
    }
  }

  // ---------- 個別（9-nineキャラページ風） ----------
  function storeBadges() {
    var wrap = S.el("div", "cta__badges");
    [
      { href: "https://apps.apple.com/jp/app/id6443913743", img: "./assets/badge-app-store.svg", alt: "App Storeでダウンロード" },
      { href: "https://play.google.com/store/apps/details?id=jp.vic_inc.app.back_stage", img: "./assets/badge-google-play.png", alt: "Google Playで手に入れよう" },
    ].forEach(function (b) {
      var a = document.createElement("a");
      a.href = b.href;
      a.target = "_blank";
      a.rel = "noopener";
      var img = document.createElement("img");
      img.src = b.img;
      img.alt = b.alt;
      img.height = 48;
      a.appendChild(img);
      wrap.appendChild(a);
    });
    return wrap;
  }

  function renderDetail(cast, index) {
    detailView.textContent = "";

    // 戻る
    var topbar = S.el("nav", "topbar");
    var back = document.createElement("a");
    back.className = "topbar__back";
    back.href = "./";
    back.textContent = "← 一覧にもどる";
    spaLink(back, function () { showList(true); });
    topbar.appendChild(back);
    detailView.appendChild(topbar);

    // キャラセクション
    var chara = S.el("section", "chara rank-" + cast.rank);

    // 背景ウォーターマーク（ランク英字）
    var watermark = S.el("span", "chara__watermark", cast.rank);
    watermark.setAttribute("aria-hidden", "true");
    chara.appendChild(watermark);

    // ビジュアル（立ち絵 > アイコン > 頭文字）
    var visual = S.el("div", "chara__visual");
    if (cast.portrait) {
      var portrait = document.createElement("img");
      portrait.className = "portrait";
      portrait.src = cast.portrait;
      portrait.alt = cast.name;
      portrait.addEventListener("error", function () {
        portrait.remove();
        visual.appendChild(avatar(cast, "avatar-lg", false));
      });
      visual.appendChild(portrait);
    } else {
      visual.appendChild(avatar(cast, "avatar-lg", false));
    }
    chara.appendChild(visual);

    // キャッチの縦書きデコ（キャッチ未設定なら出さない）
    if (cast.catch) {
      var vertical = S.el("p", "chara__vertical", cast.catch);
      vertical.setAttribute("aria-hidden", "true"); // 本文の .chara__catch と重複するため装飾扱い
      chara.appendChild(vertical);
    }

    // データ面
    var data = S.el("div", "chara__data");
    var name = S.el("p", "chara__name");
    if (cast.name_reading) name.appendChild(S.el("span", "kana", cast.name_reading));
    name.appendChild(S.el("span", "kanji", cast.name));
    data.appendChild(name);

    var rankline = S.el("p", "chara__rankline");
    rankline.appendChild(S.el("span", "chara__rank", cast.rank));
    rankline.appendChild(S.el("span", "chara__ranknote", "BACKSTAGE RANKED CAST"));
    data.appendChild(rankline);

    if (cast.catch) data.appendChild(S.el("p", "chara__catch", cast.catch));
    if (cast.intro) data.appendChild(S.el("div", "chara__detail", cast.intro));

    var links = S.el("div", "chara__links");
    var xUrl = S.safeUrl(cast.x_url);
    if (xUrl) {
      var xBtn = document.createElement("a");
      xBtn.className = "btn-x";
      xBtn.href = xUrl;
      xBtn.target = "_blank";
      xBtn.rel = "noopener";
      xBtn.textContent = "𝕏 フォローする";
      links.appendChild(xBtn);
    }
    if (links.childNodes.length) data.appendChild(links);
    chara.appendChild(data);
    detailView.appendChild(chara);

    // アプリ導線
    var cta = S.el("section", "cta");
    cta.appendChild(S.el("p", "cta__text", cast.name + " にアプリで会いに行こう"));
    cta.appendChild(storeBadges());
    detailView.appendChild(cta);

    // 前後ナビ
    var list = S.casts();
    if (list.length > 1) {
      var pager = S.el("nav", "pager");
      var prev = list[(index - 1 + list.length) % list.length];
      var next = list[(index + 1) % list.length];
      [{ cast: prev, cls: "prev", label: "← " + prev.name },
       { cast: next, cls: "next", label: next.name + " →" }].forEach(function (p) {
        var a = document.createElement("a");
        a.className = p.cls;
        a.href = "./?id=" + encodeURIComponent(p.cast.cast_id);
        a.textContent = p.label;
        spaLink(a, function () { showDetail(p.cast.cast_id, true); });
        pager.appendChild(a);
      });
      detailView.appendChild(pager);
    }
  }

  // ---------- ビュー切り替え ----------
  function showDetail(id, pushHistory) {
    var found = S.findCast(id);
    if (!found) { showList(false); return; }
    var from = !listView.hidden ? listView : (!detailView.hidden ? detailView : null);
    if (from === listView) listScrollY = window.scrollY || 0; // 一覧から来たときだけ記録
    swapViews(from, detailView, function () {
      renderDetail(found.cast, found.index);
      document.body.classList.add("cast-page");
      document.title = found.cast.name + " | BackStage ランク入りキャスト";
      window.scrollTo(0, 0);
    });
    if (pushHistory) push(id);
  }

  function showList(pushHistory) {
    var from = !detailView.hidden ? detailView : null;
    swapViews(from, listView, function () {
      detailView.textContent = "";
      document.body.classList.remove("cast-page");
      document.title = "ランク入りキャスト | BackStage";
      window.scrollTo(0, listScrollY);
    });
    if (pushHistory) push(null);
  }

  // ブラウザ・端末の「戻る/進む」にも追従（history操作が使える環境のみ）
  window.addEventListener("popstate", function () {
    var id = new URLSearchParams(location.search).get("id");
    if (id != null) showDetail(id, false);
    else showList(false);
  });

  // 起動: 一覧を描画し、?id= 付きなら最初から個別を表示
  renderList();
  var initialId = new URLSearchParams(location.search).get("id");
  if (initialId != null) showDetail(initialId, false);
})();
