#!/usr/bin/env node
/**
 * GSI Map → DXF Web Server
 * ブラウザ上で地図を操作し DXF を生成・ダウンロードできるサーバー
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';

import { geocode } from './geocoder.js';
import { fetchAllFeatures } from './tile-fetcher.js';
import { CoordinateConverter, detectZone } from './projection.js';
import { getLayerConfig } from './layer-config.js';
import { DxfWriter } from './dxf-writer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── DXF 一時ストレージ (5分で自動削除) ───
const dxfStore = new Map();

function storeDxf(id, data) {
  dxfStore.set(id, data);
  setTimeout(() => dxfStore.delete(id), 5 * 60 * 1000);
}

// ─── DXF 生成ロジック (main.js から移植) ───

function addGeometryToDxf(dxf, layerName, geometry, converter) {
  const { type, coordinates } = geometry;

  switch (type) {
    case 'Point': {
      const [x, y] = converter.convert(coordinates[0], coordinates[1]);
      dxf.addPoint(layerName, x, y);
      break;
    }
    case 'MultiPoint':
      for (const c of coordinates) {
        const [x, y] = converter.convert(c[0], c[1]);
        dxf.addPoint(layerName, x, y);
      }
      break;
    case 'LineString': {
      const pts = coordinates.map((c) => converter.convert(c[0], c[1]));
      dxf.addLwPolyline(layerName, pts, false);
      break;
    }
    case 'MultiLineString':
      for (const line of coordinates) {
        const pts = line.map((c) => converter.convert(c[0], c[1]));
        dxf.addLwPolyline(layerName, pts, false);
      }
      break;
    case 'Polygon':
      for (const ring of coordinates) {
        const pts = ring.map((c) => converter.convert(c[0], c[1]));
        dxf.addLwPolyline(layerName, pts, true);
      }
      break;
    case 'MultiPolygon':
      for (const polygon of coordinates) {
        for (const ring of polygon) {
          const pts = ring.map((c) => converter.convert(c[0], c[1]));
          dxf.addLwPolyline(layerName, pts, true);
        }
      }
      break;
  }
}

async function generateDxf(lat, lon, radius, zoom, locationName, mode, onProgress) {
  const zone = detectZone(lat, lon);
  const converter = new CoordinateConverter(zone);

  onProgress?.('タイルを取得中...', 5);

  const features = await fetchAllFeatures(lat, lon, zoom, radius, (cur, total, info) => {
    const pct = 5 + Math.round((cur / total) * 70);
    onProgress?.(`タイル取得中 [${cur}/${total}]`, pct);
  });

  if (features.length === 0) {
    throw new Error('この範囲にベクトルタイルデータがありません');
  }

  onProgress?.('DXF を生成中...', 80);

  // 指定座標の変換結果をオフセット基準にする（原点付近に移動）
  const [originX, originY] = converter.convert(lon, lat);

  const dxf = new DxfWriter();
  const layerStats = {};
  let addedCount = 0;

  // オフセット付き座標変換ヘルパー
  const convertWithOffset = (lonVal, latVal) => {
    const [x, y] = converter.convert(lonVal, latVal);
    return [x - originX, y - originY];
  };

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
      if (feat.layerName === 'label' && feat.properties.knj) {
        const coords = feat.geojson.geometry.coordinates;
        if (coords?.length >= 2) {
          const [tx, ty] = convertWithOffset(coords[0], coords[1]);
          dxf.addLayer('LABEL_TEXT', 7);
          dxf.addMText('LABEL_TEXT', tx, ty, 3.0, feat.properties.knj);
        }
      }
      if (feat.layerName === 'elevation' && feat.properties.alti != null) {
        const coords = feat.geojson.geometry.coordinates;
        if (coords?.length >= 2) {
          const [tx, ty] = convertWithOffset(coords[0], coords[1]);
          dxf.addLayer('ELEV_TEXT', 3);
          dxf.addMText('ELEV_TEXT', tx + 2, ty, 2.0, String(feat.properties.alti));
        }
      }
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

    layerStats[dxfLayerName] = (layerStats[dxfLayerName] || 0) + 1;
  }

  if (addedCount === 0) {
    throw new Error('この範囲に対象の地物データがありません');
  }

  // Center marker (原点 = 指定座標)
  dxf.addLayer('CENTER', 7);
  dxf.addLine('CENTER', -10, 0, 10, 0);
  dxf.addLine('CENTER', 0, -10, 0, 10);

  // Meta info (full mode only)
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
    projection: converter.describe(),
  };
}

// ─── HTTP サーバー ───

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function serveStatic(res, filePath) {
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mime });
    res.end(content);
  } catch {
    res.writeHead(404);
    res.end('Not Found');
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  // ── 静的ファイル ──
  if (url.pathname === '/' || url.pathname === '/index.html') {
    serveStatic(res, path.join(__dirname, 'public', 'index.html'));
    return;
  }

  // ── ジオコーディング API ──
  if (url.pathname === '/api/geocode') {
    const q = url.searchParams.get('q');
    if (!q) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '検索クエリが必要です' }));
      return;
    }
    try {
      const result = await geocode(q);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── DXF 生成 (SSE ストリーム) ──
  if (url.pathname === '/api/generate') {
    const lat = parseFloat(url.searchParams.get('lat'));
    const lon = parseFloat(url.searchParams.get('lon'));
    const radius = parseFloat(url.searchParams.get('radius') || '500');
    const zoom = parseInt(url.searchParams.get('zoom') || '16', 10);
    const name = url.searchParams.get('name') || '';
    const mode = url.searchParams.get('mode') === 'full' ? 'full' : 'simple';

    if (isNaN(lat) || isNaN(lon) || lat < 20 || lat > 46 || lon < 122 || lon > 154) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '緯度・経度が無効です (日本国内の座標を指定してください)' }));
      return;
    }

    if (radius < 100 || radius > 2000) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: '半径は 100〜2000m の範囲で指定してください' }));
      return;
    }

    if (zoom < 14 || zoom > 16) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ズームレベルは 14〜16 の範囲で指定してください' }));
      return;
    }

    // SSE ヘッダー
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });

    // クライアント切断検知
    let clientDisconnected = false;
    res.on('close', () => { clientDisconnected = true; });

    const sendEvent = (event, data) => {
      if (clientDisconnected || res.writableEnded) return;
      try {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      } catch {
        clientDisconnected = true;
      }
    };

    try {
      const result = await generateDxf(lat, lon, radius, zoom, name, mode, (msg, pct) => {
        sendEvent('progress', { message: msg, percent: pct });
      });

      if (clientDisconnected) { return; }

      // DXF を一時ストレージに保存
      const id = crypto.randomUUID();
      storeDxf(id, {
        dxfString: result.dxfString,
        fileName: name ? `${name}.dxf` : 'output.dxf',
      });

      sendEvent('complete', {
        downloadUrl: `/api/download/${id}`,
        featureCount: result.featureCount,
        stats: result.stats,
        projection: result.projection,
        fileSize: (Buffer.byteLength(result.dxfString, 'utf-8') / 1024).toFixed(1) + ' KB',
      });
    } catch (err) {
      sendEvent('error', { message: err.message });
    }

    if (!res.writableEnded) res.end();
    return;
  }

  // ── DXF ダウンロード ──
  if (url.pathname.startsWith('/api/download/')) {
    const id = url.pathname.split('/').pop();
    const entry = dxfStore.get(id);

    if (!entry) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ダウンロードの有効期限が切れました' }));
      return;
    }

    const encodedName = encodeURIComponent(entry.fileName);
    res.writeHead(200, {
      'Content-Type': 'application/dxf',
      'Content-Disposition': `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`,
    });
    res.end(entry.dxfString);
    return;
  }

  // ── 404 ──
  res.writeHead(404);
  res.end('Not Found');
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log(`\n╔══════════════════════════════════════════════╗`);
  console.log(`║   GSI Map → DXF   Web サーバー起動            ║`);
  console.log(`╚══════════════════════════════════════════════╝`);
  console.log(`\n  URL: ${url}`);
  console.log(`  終了: Ctrl+C\n`);

  // ブラウザを自動で開く (execFile でコマンドインジェクション防止)
  if (process.platform === 'win32') {
    execFile('cmd', ['/c', 'start', '', url], () => {});
  } else {
    const cmd = process.platform === 'darwin' ? 'open' : 'xdg-open';
    execFile(cmd, [url], () => {});
  }
});
