/**
 * DXF 生成の共有ロジック
 * CLI (main.js) と Web サーバー (server.js) の両方から利用する単一の生成パス。
 *
 * GeoJSON 地物 → 座標変換 → DXF エンティティ化 までを一元管理する。
 * ここを変更すれば CLI / Web 双方の出力が一致して更新される。
 */

import { fetchAllFeatures } from './tile-fetcher.js';
import { CoordinateConverter, detectZone } from './projection.js';
import { getLayerConfig } from './layer-config.js';
import { DxfWriter } from './dxf-writer.js';

// 原点クロスマーカーのレイヤー色 (ACI)
const CENTER_COLOR = 1; // 赤

/**
 * GeoJSON ジオメトリを DXF エンティティに変換して追加する
 * @param {DxfWriter} dxf
 * @param {string} layerName - DXF レイヤー名
 * @param {object} geometry - GeoJSON geometry
 * @param {{convert: (lon:number, lat:number) => [number, number]}} converter
 */
export function addGeometryToDxf(dxf, layerName, geometry, converter) {
  const { type, coordinates } = geometry;

  switch (type) {
    case 'Point': {
      const [x, y] = converter.convert(coordinates[0], coordinates[1]);
      dxf.addPoint(layerName, x, y);
      break;
    }

    case 'MultiPoint': {
      for (const coord of coordinates) {
        const [x, y] = converter.convert(coord[0], coord[1]);
        dxf.addPoint(layerName, x, y);
      }
      break;
    }

    case 'LineString': {
      const pts = coordinates.map((c) => converter.convert(c[0], c[1]));
      dxf.addLwPolyline(layerName, pts, false);
      break;
    }

    case 'MultiLineString': {
      for (const line of coordinates) {
        const pts = line.map((c) => converter.convert(c[0], c[1]));
        dxf.addLwPolyline(layerName, pts, false);
      }
      break;
    }

    case 'Polygon': {
      for (const ring of coordinates) {
        const pts = ring.map((c) => converter.convert(c[0], c[1]));
        dxf.addLwPolyline(layerName, pts, true);
      }
      break;
    }

    case 'MultiPolygon': {
      for (const polygon of coordinates) {
        for (const ring of polygon) {
          const pts = ring.map((c) => converter.convert(c[0], c[1]));
          dxf.addLwPolyline(layerName, pts, true);
        }
      }
      break;
    }
  }
}

/**
 * 注記テキスト (label / elevation / contour) を DXF に追加する (フルモードのみ)
 * @param {DxfWriter} dxf
 * @param {object} feat - { layerName, geojson, properties }
 * @param {(lon:number, lat:number) => [number, number]} convertWithOffset
 */
function addAnnotations(dxf, feat, convertWithOffset) {
  // ラベル (注記)
  if (feat.layerName === 'label' && feat.properties.knj) {
    const coords = feat.geojson.geometry.coordinates;
    if (coords?.length >= 2) {
      const [tx, ty] = convertWithOffset(coords[0], coords[1]);
      dxf.addLayer('LABEL_TEXT', 7);
      dxf.addMText('LABEL_TEXT', tx, ty, 3.0, feat.properties.knj);
    }
  }

  // 標高点
  if (feat.layerName === 'elevation' && feat.properties.alti != null) {
    const coords = feat.geojson.geometry.coordinates;
    if (coords?.length >= 2) {
      const [tx, ty] = convertWithOffset(coords[0], coords[1]);
      dxf.addLayer('ELEV_TEXT', 3);
      dxf.addMText('ELEV_TEXT', tx + 2, ty, 2.0, String(feat.properties.alti));
    }
  }

  // 等高線
  if (feat.layerName === 'contour' && feat.properties.alti != null) {
    const coords = feat.geojson.geometry.coordinates;
    const firstCoord = Array.isArray(coords[0]?.[0]) ? coords[0][0] : coords[0];
    if (firstCoord?.length >= 2) {
      const [tx, ty] = convertWithOffset(firstCoord[0], firstCoord[1]);
      dxf.addLayer('CONTOUR_TEXT', 24);
      dxf.addMText('CONTOUR_TEXT', tx, ty, 1.5, String(feat.properties.alti));
    }
  }
}

/**
 * 指定地点のベクトルタイルを取得し DXF を生成する
 *
 * @param {object}   opts
 * @param {number}   opts.lat            - 緯度 (WGS84)
 * @param {number}   opts.lon            - 経度 (WGS84)
 * @param {number}   opts.radius         - 取得範囲の半径 (メートル)
 * @param {number}   opts.zoom           - ズームレベル
 * @param {string}   [opts.locationName] - 地点名 (メタ情報に記載)
 * @param {'simple'|'full'} [opts.mode]  - 出力モード (デフォルト: 'full')
 * @param {number}   [opts.zone]         - 平面直角座標系の系番号 (省略時は自動判定)
 * @param {(message:string, percent:number) => void} [opts.onProgress] - 高レベル進捗
 * @param {(current:number, total:number, info:object) => void} [opts.onTile] - タイル単位進捗
 * @returns {Promise<{dxfString:string, stats:object, featureCount:number, rawFeatureCount:number, projection:string}>}
 */
export async function buildDxf({
  lat,
  lon,
  radius,
  zoom,
  locationName = '',
  mode = 'full',
  zone = null,
  onProgress,
  onTile,
} = {}) {
  const resolvedZone = zone || detectZone(lat, lon);
  const converter = new CoordinateConverter(resolvedZone);

  onProgress?.('タイルを取得中...', 5);

  const features = await fetchAllFeatures(lat, lon, zoom, radius, (cur, total, info) => {
    onTile?.(cur, total, info);
    const pct = 5 + Math.round((cur / total) * 70);
    onProgress?.(`タイル取得中 [${cur}/${total}]`, pct);
  });

  if (features.length === 0) {
    throw new Error('この範囲にベクトルタイルデータがありません');
  }

  onProgress?.('DXF を生成中...', 80);

  // 指定座標の変換結果をオフセット基準にする（原点付近に移動）
  const [originX, originY] = converter.convert(lon, lat);
  const convertWithOffset = (lonVal, latVal) => {
    const [x, y] = converter.convert(lonVal, latVal);
    return [x - originX, y - originY];
  };

  const dxf = new DxfWriter();
  const layerStats = {};
  let addedCount = 0;

  for (const feat of features) {
    const config = getLayerConfig(feat.layerName, mode);

    // シンプルモードで未定義レイヤーはスキップ
    if (!config) continue;

    const dxfLayerName = config.dxf;
    dxf.addLayer(dxfLayerName, config.color);
    addGeometryToDxf(dxf, dxfLayerName, feat.geojson.geometry, { convert: convertWithOffset });
    addedCount++;

    // フルモードのみ: テキスト注記を追加
    if (mode === 'full') {
      addAnnotations(dxf, feat, convertWithOffset);
    }

    layerStats[dxfLayerName] = (layerStats[dxfLayerName] || 0) + 1;
  }

  if (addedCount === 0) {
    throw new Error('この範囲に対象の地物データがありません');
  }

  // 中心点にクロスマーカー (原点 = 指定座標)
  dxf.addLayer('CENTER', CENTER_COLOR);
  dxf.addLine('CENTER', -10, 0, 10, 0);
  dxf.addLine('CENTER', 0, -10, 0, 10);

  // メタ情報テキスト (フルモードのみ)
  if (mode === 'full') {
    dxf.addLayer('INFO', 8);
    dxf.addMText('INFO', 0, -15, 2.0,
      `Location: ${locationName || ''} / ${converter.describe()} / 1unit=1m / GSI Vector Tile`
    );
  }

  onProgress?.('完了', 100);

  return {
    dxfString: dxf.toString(),
    stats: layerStats,
    featureCount: addedCount,
    rawFeatureCount: features.length,
    projection: converter.describe(),
  };
}
