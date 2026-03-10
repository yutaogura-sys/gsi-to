/**
 * 座標変換モジュール
 * WGS84 (緯度経度) → 日本平面直角座標系 (メートル)
 */

import proj4 from 'proj4';

/**
 * 日本平面直角座標系 全19系の定義
 * 各系の原点緯度 (lat0) と中央子午線経度 (lon0) を定義
 */
const JPC_ZONES = [
  { zone: 1,  lat0: 33,   lon0: 129.5,               desc: '長崎県、鹿児島県(一部)' },
  { zone: 2,  lat0: 33,   lon0: 131.0,               desc: '福岡県、佐賀県、熊本県、大分県、宮崎県、鹿児島県' },
  { zone: 3,  lat0: 36,   lon0: 132 + 10 / 60,       desc: '山口県、島根県、広島県' },
  { zone: 4,  lat0: 33,   lon0: 133.5,               desc: '香川県、愛媛県、徳島県、高知県' },
  { zone: 5,  lat0: 36,   lon0: 134 + 20 / 60,       desc: '兵庫県、鳥取県、岡山県' },
  { zone: 6,  lat0: 36,   lon0: 136.0,               desc: '京都府、大阪府、福井県、滋賀県、三重県、奈良県、和歌山県' },
  { zone: 7,  lat0: 36,   lon0: 137 + 10 / 60,       desc: '石川県、富山県、岐阜県、愛知県' },
  { zone: 8,  lat0: 36,   lon0: 138.5,               desc: '新潟県、長野県、山梨県、静岡県' },
  { zone: 9,  lat0: 36,   lon0: 139 + 50 / 60,       desc: '東京都、福島県、栃木県、茨城県、埼玉県、千葉県、群馬県、神奈川県' },
  { zone: 10, lat0: 40,   lon0: 140 + 50 / 60,       desc: '青森県、秋田県、山形県、岩手県、宮城県' },
  { zone: 11, lat0: 44,   lon0: 140.25,              desc: '北海道(西部)' },
  { zone: 12, lat0: 44,   lon0: 142.25,              desc: '北海道(中部)' },
  { zone: 13, lat0: 44,   lon0: 144.25,              desc: '北海道(東部)' },
  { zone: 14, lat0: 26,   lon0: 142.0,               desc: '東京都(小笠原)' },
  { zone: 15, lat0: 26,   lon0: 127.5,               desc: '沖縄県' },
  { zone: 16, lat0: 26,   lon0: 124.0,               desc: '沖縄県(先島)' },
  { zone: 17, lat0: 26,   lon0: 131.0,               desc: '沖縄県(大東)' },
  { zone: 18, lat0: 20,   lon0: 136.0,               desc: '東京都(沖ノ鳥島)' },
  { zone: 19, lat0: 26,   lon0: 154.0,               desc: '東京都(南鳥島)' },
];

// proj4 に各系を登録
for (const z of JPC_ZONES) {
  proj4.defs(
    `JPC:${z.zone}`,
    `+proj=tmerc +lat_0=${z.lat0} +lon_0=${z.lon0} +k=0.9999 ` +
    `+x_0=0 +y_0=0 +ellps=GRS80 +units=m +no_defs +type=crs`
  );
}

/**
 * 緯度経度から最適な平面直角座標系の系番号を自動判定
 * @param {number} lat - 緯度
 * @param {number} lon - 経度
 * @returns {number} 系番号 (1-19)
 */
export function detectZone(lat, lon) {
  // 離島
  if (lat < 24) return 18;                          // 沖ノ鳥島
  if (lon > 150) return 19;                          // 南鳥島
  if (lon < 125 && lat < 28) return 16;              // 先島
  if (lon < 129 && lat < 28) return 15;              // 沖縄本島
  if (lon > 140 && lon < 144 && lat < 28) return 14; // 小笠原
  if (lon >= 129 && lon < 132 && lat < 28) return 17;// 大東

  // 北海道
  if (lat > 41.5) {
    if (lon < 141.0) return 11;
    if (lon < 143.0) return 12;
    return 13;
  }

  // 東北
  if (lat > 37.7 && lon > 139.0) return 10;

  // 関東
  if (lat > 34.8 && lon > 138.8) return 9;

  // 中部東部 (新潟、長野、山梨、静岡)
  if (lat > 34.5 && lon > 137.8) return 8;

  // 中部西部 (石川、富山、岐阜、愛知)
  if (lon > 136.3 && lat > 34.5) return 7;

  // 近畿
  if (lon > 134.8 && lon <= 137.0 && lat > 33.0) return 6;

  // 中国東部 / 四国
  if (lon > 133.2 && lon <= 135.0) {
    if (lat > 34.5) return 5;
    return 4;
  }

  // 中国西部
  if (lon > 131.5 && lon <= 133.2) {
    if (lat > 33.8) return 3;
    return 4;
  }

  // 九州
  if (lon > 130.0) return 2;

  return 1;
}

/**
 * 座標変換クラス
 * WGS84 (経度, 緯度) → 平面直角座標系 (X, Y メートル)
 */
export class CoordinateConverter {
  /**
   * @param {number} zone - 平面直角座標系の系番号 (1-19)
   */
  constructor(zone) {
    this.zone = zone;
    this.zoneInfo = JPC_ZONES.find((z) => z.zone === zone);
    if (!this.zoneInfo) {
      throw new Error(`無効な系番号: ${zone}`);
    }
    this._projName = `JPC:${zone}`;
  }

  /**
   * 経度・緯度 → 平面直角座標 (メートル)
   * @param {number} lon - 経度 (WGS84)
   * @param {number} lat - 緯度 (WGS84)
   * @returns {[number, number]} [x (東方向), y (北方向)]
   */
  convert(lon, lat) {
    return proj4('EPSG:4326', this._projName, [lon, lat]);
  }

  /**
   * 座標系の説明文を返す
   */
  describe() {
    return `平面直角座標系 第${this.zone}系 (${this.zoneInfo.desc})`;
  }
}
