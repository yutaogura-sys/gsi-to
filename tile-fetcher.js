/**
 * GSI ベクトルタイル取得・デコードモジュール
 * 国土地理院ベクトルタイル (experimental_bvmap) から地物データを取得
 */

import Protobuf from 'pbf';
import { VectorTile } from '@mapbox/vector-tile';
const GSI_TILE_BASE = 'https://cyberjapandata.gsi.go.jp/xyz/experimental_bvmap';
const REQUEST_DELAY_MS = 100;
const MAX_TILES = 200;

/**
 * 緯度経度 → タイル座標
 */
export function degToTile(lat, lon, zoom) {
  const n = 2 ** zoom;
  const latRad = (lat * Math.PI) / 180;
  const x = Math.floor(((lon + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}

/**
 * 指定範囲をカバーするタイル一覧を取得
 * @param {number} centerLat
 * @param {number} centerLon
 * @param {number} zoom
 * @param {number} radiusM - 半径 (メートル)
 * @returns {Array<{x: number, y: number}>}
 */
export function getTileGrid(centerLat, centerLon, zoom, radiusM) {
  const mPerDegLat = 111319.5;
  const mPerDegLon = 111319.5 * Math.cos((centerLat * Math.PI) / 180);

  const dLat = radiusM / mPerDegLat;
  const dLon = radiusM / mPerDegLon;

  const topLeft = degToTile(centerLat + dLat, centerLon - dLon, zoom);
  const bottomRight = degToTile(centerLat - dLat, centerLon + dLon, zoom);

  const tiles = [];
  for (let tx = topLeft.x; tx <= bottomRight.x; tx++) {
    for (let ty = topLeft.y; ty <= bottomRight.y; ty++) {
      tiles.push({ x: tx, y: ty });
    }
  }
  return tiles;
}

/**
 * 単一タイルの PBF データを取得してデコード
 * @param {number} zoom
 * @param {number} x
 * @param {number} y
 * @returns {Promise<VectorTile|null>}
 */
async function fetchTile(zoom, x, y) {
  const url = `${GSI_TILE_BASE}/${zoom}/${x}/${y}.pbf`;

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (response.status === 404) return null;
    if (!response.ok) return null;

    const buffer = await response.arrayBuffer();
    const pbf = new Protobuf(new Uint8Array(buffer));
    return new VectorTile(pbf);
  } catch {
    return null;
  }
}

/**
 * タイルから GeoJSON フィーチャーを抽出
 * @param {VectorTile} vt
 * @param {number} tx - タイル X 座標
 * @param {number} ty - タイル Y 座標
 * @param {number} zoom
 * @returns {Array<{layerName: string, geojson: object, properties: object}>}
 */
function extractFeatures(vt, tx, ty, zoom) {
  const features = [];

  for (const layerName of Object.keys(vt.layers)) {
    const layer = vt.layers[layerName];

    for (let i = 0; i < layer.length; i++) {
      const feature = layer.feature(i);

      try {
        // toGeoJSON は MVT ローカル座標 → WGS84 (lon/lat) に自動変換
        const geojson = feature.toGeoJSON(tx, ty, zoom);

        features.push({
          layerName,
          geojson,
          properties: feature.properties || {},
        });
      } catch {
        // ジオメトリ変換失敗時はスキップ
      }
    }
  }

  return features;
}

/**
 * 指定範囲のベクトルタイルから全地物を取得
 * @param {number} centerLat
 * @param {number} centerLon
 * @param {number} zoom
 * @param {number} radiusM
 * @param {function} [onProgress] - 進捗コールバック (current, total, tileInfo)
 * @returns {Promise<Array<{layerName: string, geojson: object, properties: object}>>}
 */
export async function fetchAllFeatures(centerLat, centerLon, zoom, radiusM, onProgress) {
  const tiles = getTileGrid(centerLat, centerLon, zoom, radiusM);

  if (tiles.length > MAX_TILES) {
    throw new Error(
      `タイル数が上限を超えています (${tiles.length}タイル / 上限${MAX_TILES})。半径を小さくするかズームレベルを下げてください`
    );
  }

  const allFeatures = [];
  let fetchedCount = 0;

  for (let i = 0; i < tiles.length; i++) {
    const { x, y } = tiles[i];
    const vt = await fetchTile(zoom, x, y);

    if (vt) {
      const features = extractFeatures(vt, x, y, zoom);
      allFeatures.push(...features);
      fetchedCount++;

      if (onProgress) {
        onProgress(i + 1, tiles.length, {
          x, y,
          layerCount: Object.keys(vt.layers).length,
          featureCount: features.length,
        });
      }
    } else {
      if (onProgress) {
        onProgress(i + 1, tiles.length, { x, y, layerCount: 0, featureCount: 0 });
      }
    }

    // レート制限対策: リクエスト間に待機
    if (i < tiles.length - 1) {
      await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  }

  return allFeatures;
}
