#!/usr/bin/env node
/**
 * ========================================
 *  GSI Map → DXF Converter
 *  国土地理院地図ベクトルタイル → DXF 変換ツール
 * ========================================
 *
 * 使用方法:
 *   node main.js <住所>
 *   node main.js <住所> [オプション]
 *   node main.js --lat <緯度> --lon <経度> [オプション]
 *
 * オプション:
 *   -o, --output <file>    出力ファイル名 (デフォルト: output.dxf)
 *   -r, --radius <meters>  取得範囲の半径 (デフォルト: 500)
 *   -z, --zoom <level>     ズームレベル 4-16 (デフォルト: 16)
 *   --zone <number>        平面直角座標系の系番号 1-19 (自動検出)
 *   -h, --help             ヘルプを表示
 *
 * 使用例:
 *   node main.js "東京都千代田区永田町1-7-1"
 *   node main.js "大阪市中央区" -r 300 -o osaka.dxf
 *   node main.js --lat 35.6762 --lon 139.7450
 */

import { writeFileSync } from 'node:fs';
import { geocode } from './geocoder.js';
import { fetchAllFeatures } from './tile-fetcher.js';
import { CoordinateConverter, detectZone } from './projection.js';
import { getLayerConfig } from './layer-config.js';
import { DxfWriter } from './dxf-writer.js';

// ─── 引数パーサー ───

function parseArgs(argv) {
  const args = {
    address: null,
    lat: null,
    lon: null,
    output: null,
    radius: 500,
    zoom: 16,
    zone: null,
    help: false,
  };

  const raw = argv.slice(2);
  const positional = [];

  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    switch (a) {
      case '-h': case '--help':
        args.help = true; break;
      case '-o': case '--output':
        args.output = raw[++i]; break;
      case '-r': case '--radius':
        args.radius = Number(raw[++i]); break;
      case '-z': case '--zoom':
        args.zoom = Number(raw[++i]); break;
      case '--lat':
        args.lat = Number(raw[++i]); break;
      case '--lon':
        args.lon = Number(raw[++i]); break;
      case '--zone':
        args.zone = Number(raw[++i]); break;
      default:
        positional.push(a);
    }
  }

  if (positional.length > 0) {
    args.address = positional.join(' ');
  }

  return args;
}

function printHelp() {
  console.log(`
╔══════════════════════════════════════════════╗
║   GSI Map → DXF Converter                   ║
║   国土地理院地図 → DXF 変換ツール            ║
╚══════════════════════════════════════════════╝

使用方法:
  node main.js <住所> [オプション]
  node main.js --lat <緯度> --lon <経度> [オプション]

オプション:
  -o, --output <file>    出力ファイル名 (デフォルト: output.dxf)
  -r, --radius <meters>  取得範囲の半径 (デフォルト: 500)
  -z, --zoom <level>     ズームレベル 4-16 (デフォルト: 16)
  --zone <number>        平面直角座標系の系番号 1-19 (自動検出)
  -h, --help             ヘルプを表示

使用例:
  node main.js "東京都千代田区永田町1-7-1"
  node main.js "東京都渋谷区" -r 300 -o shibuya.dxf
  node main.js --lat 35.6762 --lon 139.7450 -r 200

出力:
  1:1 スケール (1 DXF単位 = 1メートル) の DXF ファイル
  座標系: 日本平面直角座標系 (JPC) を自動選択
  データ出典: 国土地理院ベクトルタイル (experimental_bvmap)
`);
}

// ─── GeoJSON ジオメトリを DXF エンティティに変換 ───

function addGeometryToDxf(dxf, layerName, geometry, converter) {
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

// ─── メイン処理 ───

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    process.exit(0);
  }

  // 座標の決定
  let lat, lon, locationName;

  if (args.address) {
    console.log(`\n住所を検索中: ${args.address}`);
    try {
      const result = await geocode(args.address);
      lat = result.lat;
      lon = result.lon;
      locationName = result.name;
      console.log(`  → ${locationName} (${lat.toFixed(6)}, ${lon.toFixed(6)})`);
    } catch (err) {
      console.error(`エラー: ${err.message}`);
      process.exit(1);
    }
  } else if (args.lat != null && args.lon != null) {
    lat = args.lat;
    lon = args.lon;
    locationName = `${lat.toFixed(6)}, ${lon.toFixed(6)}`;
    console.log(`\n座標指定: (${locationName})`);
  } else {
    console.error('エラー: 住所または座標 (--lat, --lon) を指定してください');
    console.error('ヘルプ: node main.js --help');
    process.exit(1);
  }

  // パラメータ検証
  if (args.zoom < 4 || args.zoom > 16) {
    console.error('エラー: ズームレベルは 4～16 の範囲で指定してください');
    process.exit(1);
  }
  if (!Number.isFinite(args.radius) || args.radius < 50 || args.radius > 5000) {
    console.error('エラー: 半径は 50～5000m の範囲で指定してください');
    process.exit(1);
  }
  if (lat < 20 || lat > 46 || lon < 122 || lon > 154) {
    console.error('エラー: 緯度・経度が日本の範囲外です (lat:20-46, lon:122-154)');
    process.exit(1);
  }

  // 座標系の設定
  const zone = args.zone || detectZone(lat, lon);
  const converter = new CoordinateConverter(zone);
  console.log(`座標系: ${converter.describe()}`);
  console.log(`取得範囲: 半径 ${args.radius}m / ズーム ${args.zoom}`);

  // ベクトルタイルの取得
  console.log('\nベクトルタイルを取得中...');
  const features = await fetchAllFeatures(
    lat, lon, args.zoom, args.radius,
    (current, total, info) => {
      if (info.featureCount > 0) {
        process.stdout.write(
          `  [${current}/${total}] タイル(${info.x},${info.y}) `
          + `${info.layerCount}レイヤー / ${info.featureCount}地物\n`
        );
      } else {
        process.stdout.write(
          `  [${current}/${total}] タイル(${info.x},${info.y}) データなし\n`
        );
      }
    }
  );

  if (features.length === 0) {
    console.error('\nエラー: この範囲にベクトルタイルデータがありません');
    console.error('ヒント: ズームレベルを下げるか、範囲を広げてみてください');
    process.exit(1);
  }

  console.log(`\n合計 ${features.length} 地物を取得`);

  // DXF 生成
  console.log('DXF ファイルを生成中...');
  const dxf = new DxfWriter();

  // 指定座標の変換結果をオフセット基準にする（原点付近に移動）
  const [originX, originY] = converter.convert(lon, lat);
  const convertWithOffset = (lonVal, latVal) => {
    const [x, y] = converter.convert(lonVal, latVal);
    return [x - originX, y - originY];
  };

  // レイヤー集計
  const layerStats = {};
  let addedCount = 0;

  for (const feat of features) {
    const config = getLayerConfig(feat.layerName, 'full');
    if (!config) continue;
    const dxfLayerName = config.dxf;

    // レイヤーを登録
    dxf.addLayer(dxfLayerName, config.color);

    // ジオメトリを DXF に追加 (オフセット付き)
    addGeometryToDxf(dxf, dxfLayerName, feat.geojson.geometry, { convert: convertWithOffset });
    addedCount++;

    // ラベル (注記) の場合はテキストも追加
    if (feat.layerName === 'label' && feat.properties.knj) {
      const coords = feat.geojson.geometry.coordinates;
      if (coords?.length >= 2) {
        const [tx, ty] = convertWithOffset(coords[0], coords[1]);
        dxf.addLayer('LABEL_TEXT', 7);
        dxf.addMText('LABEL_TEXT', tx, ty, 3.0, feat.properties.knj);
      }
    }

    // 標高点の場合は標高値をテキスト表示
    if (feat.layerName === 'elevation' && feat.properties.alti != null) {
      const coords = feat.geojson.geometry.coordinates;
      if (coords?.length >= 2) {
        const [tx, ty] = convertWithOffset(coords[0], coords[1]);
        dxf.addLayer('ELEV_TEXT', 3);
        dxf.addMText('ELEV_TEXT', tx + 2, ty, 2.0, String(feat.properties.alti));
      }
    }

    // 等高線の場合は標高値をプロパティから取得して表示
    if (feat.layerName === 'contour' && feat.properties.alti != null) {
      const coords = feat.geojson.geometry.coordinates;
      const firstCoord = Array.isArray(coords[0]?.[0]) ? coords[0][0] : coords[0];
      if (firstCoord?.length >= 2) {
        const [tx, ty] = convertWithOffset(firstCoord[0], firstCoord[1]);
        dxf.addLayer('CONTOUR_TEXT', 24);
        dxf.addMText('CONTOUR_TEXT', tx, ty, 1.5, String(feat.properties.alti));
      }
    }

    // 統計
    layerStats[dxfLayerName] = (layerStats[dxfLayerName] || 0) + 1;
  }

  if (addedCount === 0) {
    console.error('\nエラー: この範囲に対象の地物データがありません');
    process.exit(1);
  }

  // 中心点にクロスマーカー (原点 = 指定座標)
  dxf.addLayer('CENTER', 1);
  dxf.addLine('CENTER', -10, 0, 10, 0);
  dxf.addLine('CENTER', 0, -10, 0, 10);

  // メタ情報テキストを追加
  dxf.addLayer('INFO', 8);
  dxf.addMText('INFO', 0, -15, 2.0,
    `Location: ${locationName}\\P${converter.describe()}\\P1unit=1m\\PGSI Vector Tile`
  );

  // ファイル書き出し
  const outputFile = args.output || 'output.dxf';
  const dxfString = dxf.toString();
  writeFileSync(outputFile, dxfString, 'utf-8');

  // 結果表示
  const fileSizeKB = (Buffer.byteLength(dxfString, 'utf-8') / 1024).toFixed(1);
  console.log(`\n✓ DXF ファイルを保存しました: ${outputFile} (${fileSizeKB} KB)`);
  console.log('\nレイヤー別地物数:');

  const sortedLayers = Object.entries(layerStats).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedLayers) {
    console.log(`  ${name.padEnd(16)} ${count}`);
  }
  console.log(`  ${'合計'.padEnd(16)} ${addedCount}`);
  console.log(`\n縮尺: 1/1 (1 DXF 単位 = 1 メートル)`);
  console.log(`座標系: ${converter.describe()}`);
}

main().catch((err) => {
  console.error(`\n予期しないエラー: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
