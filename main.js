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
import { CoordinateConverter, detectZone } from './projection.js';
import { buildDxf } from './dxf-builder.js';

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

  // ベクトルタイルの取得 → DXF 生成 (共有モジュール buildDxf)
  console.log('\nベクトルタイルを取得中...');
  let result;
  try {
    result = await buildDxf({
      lat,
      lon,
      radius: args.radius,
      zoom: args.zoom,
      locationName,
      mode: 'full',
      zone,
      onTile: (current, total, info) => {
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
      },
    });
  } catch (err) {
    console.error(`\nエラー: ${err.message}`);
    if (err.message.includes('ベクトルタイルデータがありません')) {
      console.error('ヒント: ズームレベルを下げるか、範囲を広げてみてください');
    }
    process.exit(1);
  }

  console.log(`\n合計 ${result.rawFeatureCount} 地物を取得`);
  console.log('DXF ファイルを生成中...');

  // ファイル書き出し
  const outputFile = args.output || 'output.dxf';
  writeFileSync(outputFile, result.dxfString, 'utf-8');

  // 結果表示
  const fileSizeKB = (Buffer.byteLength(result.dxfString, 'utf-8') / 1024).toFixed(1);
  console.log(`\n✓ DXF ファイルを保存しました: ${outputFile} (${fileSizeKB} KB)`);
  console.log('\nレイヤー別地物数:');

  const sortedLayers = Object.entries(result.stats).sort((a, b) => b[1] - a[1]);
  for (const [name, count] of sortedLayers) {
    console.log(`  ${name.padEnd(16)} ${count}`);
  }
  console.log(`  ${'合計'.padEnd(16)} ${result.featureCount}`);
  console.log(`\n縮尺: 1/1 (1 DXF 単位 = 1 メートル)`);
  console.log(`座標系: ${result.projection}`);
}

main().catch((err) => {
  console.error(`\n予期しないエラー: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
