// 本人文（shift-manager でキャスト本人が書いた文章）と、紹介サイトに載せている文章の違いを調べる部品。
// manage.html の一覧の印と、詳細画面の「確認済みにする」で使う。画面や通信には触らない（テストしやすくするため）。
//
// 確認済みの記録: manual.self_checked に、確認したときの本人文の「指紋」（短い文字列）を入れる。
// 本人が文章を書き換えると指紋が変わるので、印がまた出る。属性だけの更新では変わらない。
(function (root) {
  "use strict";

  // 改行の書き方（\r\n と \n）や、前後・途中の空白の違いは同じ文章とみなす
  function normalizeText(s) {
    return String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  }

  // 載っている文章と本人文で違う項目の名前を返す（同じなら空の配列）。本人文が無ければ空
  function selfDiffFields(manual, profile) {
    if (!profile) return [];
    manual = manual || {};
    var out = [];
    if (normalizeText(manual.catch) !== normalizeText(profile.catch)) out.push("キャッチコピー");
    if (normalizeText(manual.intro) !== normalizeText(profile.intro)) out.push("紹介文");
    return out;
  }

  // 本人文の指紋。キャッチと紹介文だけから作る。JS の文字（UTF-16）単位で FNV-1a 32bit を回した独自の値なので、
  // ほかの言語の標準的な FNV-1a（UTF-8 のバイト単位）とは一致しない。作るのも比べるのもこの関数だけにする
  function selfFingerprint(profile) {
    var text = normalizeText((profile || {}).catch) + "\n" + normalizeText((profile || {}).intro);
    var h = 0x811c9dc5;
    for (var i = 0; i < text.length; i++) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return "fnv1a:" + ("00000000" + h.toString(16)).slice(-8);
  }

  // 一覧の印の状態
  //   "none"    … 本人文が無い
  //   "same"    … 載っている文章と同じ
  //   "checked" … 違うが、運営が今の本人文を確認済み
  //   "differs" … 違う（運営が見ていない本人文）
  function selfStatus(manual, profile) {
    if (!profile) return "none";
    if (!selfDiffFields(manual, profile).length) return "same";
    var mark = (manual || {}).self_checked;
    if (typeof mark === "string" && mark && mark === selfFingerprint(profile)) return "checked";
    return "differs";
  }

  // 公開サイトに画像を置く人＝一覧に「本人文と違う」の印を出す人: ランク入り（引退を除く・公開前の新人も含む）。
  // showcase_lib.asset_ids_to_publish と同じ決まり。manage.html はこれを使う（決まりを変えるときは両方を直す）
  function isAssetPublished(cast) {
    var a = (cast && cast.auto) || {};
    return !!a.rank && a.retired !== true;
  }

  // 一覧の印の状態と、違う項目。isAssetPublished でない人（ランク外・引退）の "differs" は "same" として扱う
  // （詳細画面では違いを出す）
  function listSelfStatus(cast, profile) {
    var manual = (cast && cast.manual) || {};
    var st = selfStatus(manual, profile);
    if (st === "differs" && !isAssetPublished(cast)) st = "same";
    return { status: st, fields: st === "differs" ? selfDiffFields(manual, profile) : [] };
  }

  var api = { normalizeText: normalizeText, selfDiffFields: selfDiffFields, selfFingerprint: selfFingerprint, selfStatus: selfStatus,
              listSelfStatus: listSelfStatus, isAssetPublished: isAssetPublished };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.SelfDiff = api;
})(this);
