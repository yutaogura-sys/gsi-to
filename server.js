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
import { randomUUID } from 'node:crypto';

import { geocode } from './geocoder.js';
import { buildDxf } from './dxf-builder.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// ─── DXF 一時ストレージ (5分で自動削除) ───
const dxfStore = new Map();

function storeDxf(id, data) {
  dxfStore.set(id, data);
  setTimeout(() => dxfStore.delete(id), 5 * 60 * 1000);
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
      const result = await buildDxf({
        lat, lon, radius, zoom, mode,
        locationName: name,
        onProgress: (msg, pct) => sendEvent('progress', { message: msg, percent: pct }),
      });

      if (clientDisconnected) { return; }

      // DXF を一時ストレージに保存
      const id = randomUUID();
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
