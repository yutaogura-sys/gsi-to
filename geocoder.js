/**
 * GSI (国土地理院) ジオコーディング API
 * 住所文字列から緯度・経度を取得する
 */

const GSI_GEOCODE_URL = 'https://msearch.gsi.go.jp/address-search/AddressSearch';

/**
 * 住所をジオコーディングして緯度・経度を返す
 * @param {string} address - 日本の住所文字列
 * @returns {Promise<{lat: number, lon: number, name: string}>}
 */
export async function geocode(address) {
  const url = `${GSI_GEOCODE_URL}?q=${encodeURIComponent(address)}`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`ジオコーディングAPI エラー: HTTP ${response.status}`);
  }

  const results = await response.json();

  if (!results || results.length === 0) {
    throw new Error(`住所が見つかりません: ${address}`);
  }

  // 最も関連性の高い結果を使用
  const best = results[0];
  const [lon, lat] = best.geometry.coordinates;
  const name = best.properties.title;

  return { lat, lon, name };
}
