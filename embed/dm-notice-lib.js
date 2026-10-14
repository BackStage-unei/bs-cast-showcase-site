// DM通知（dm-notice.html）の判定ロジック。DOM を持ち込まない純粋関数（tests/js/dm-notice-lib.test.mjs）
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.DmNotice = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var RANKS = ['GOLD', 'SILVER', 'BRONZE'];
  // 載っていないキャストは画像の中央を丸ごと使う（移設前の HTML と同じ既定値）
  var DEFAULT_CROP = { x: 0.5, y: 0.5, size: 1 };

  function inRange(v, min, max) {
    return typeof v === 'number' && isFinite(v) && v >= min && v <= max;
  }

  // face-crops.json の中身から、正しい値の行だけを残す（壊れた行は既定値に落ちる）
  function normalizeCrops(json) {
    var out = {};
    var crops = json && typeof json === 'object' ? json.crops : null;
    if (!crops || typeof crops !== 'object') return out;
    Object.keys(crops).forEach(function (id) {
      var c = crops[id];
      if (!/^[0-9]+$/.test(id) || !c) return;
      if (inRange(c.x, 0, 1) && inRange(c.y, 0, 1) && inRange(c.size, 0.05, 1)) {
        out[id] = { x: c.x, y: c.y, size: c.size };
      }
    });
    return out;
  }

  // 丸の中に置く画像の大きさと位置（CSS の % 文字列）
  function cropStyle(crop) {
    var c = crop || DEFAULT_CROP;
    return {
      width: (100 / c.size) + '%',
      left: (50 - (100 * c.x) / c.size) + '%',
      top: (50 - (100 * c.y) / c.size) + '%',
    };
  }

  // 表示するキャスト: ランク入り・立ち絵あり・名前あり
  function selectCasts(list) {
    return (Array.isArray(list) ? list : []).filter(function (c) {
      return c && RANKS.indexOf(c.rank) >= 0 && Array.isArray(c.portraits) && c.portraits.length && c.name &&
        /^[0-9]+$/.test(String(c.cast_id));
    });
  }

  // 表示対象のうち、顔の位置が未登録の cast_id
  function missingCrops(casts, crops) {
    return selectCasts(casts).map(function (c) { return String(c.cast_id); })
      .filter(function (id) { return !crops[id]; });
  }

  return { DEFAULT_CROP: DEFAULT_CROP, normalizeCrops: normalizeCrops, cropStyle: cropStyle, selectCasts: selectCasts, missingCrops: missingCrops };
});
