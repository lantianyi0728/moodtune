/**
 * server.js —— 零依赖本地静态服务器
 * ------------------------------------------------------------
 * 为什么需要它？
 *   浏览器的 getUserMedia（摄像头）只在「安全上下文」下可用：
 *   https 或 localhost。而且用 file:// 打开页面时，浏览器会以
 *   CORS 策略拦掉所有 fetch（模型权重、songs.json 都读不到），
 *   页面会显示「模型加载失败」。
 *   所以必须把项目起在 http://localhost:<port> 上。
 *
 * 特点：
 *   - 零依赖，只要装了 Node 就能跑
 *   - 端口被占用时自动往后找（8010 → 8011 → …）
 *   - 支持 Range 请求（音频拖进度条、视频取元数据都要用）
 *   - 启动后自动打开浏览器
 *
 * 用法：双击 启动系统.vbs（推荐，无黑窗口）
 *       或双击 start.bat（有窗口，便于看报错）
 *       或命令行 node server.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const ROOT = __dirname;
const BASE_PORT = Number(process.env.PORT) || 8010;
const MAX_TRIES = 12;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.mp4': 'video/mp4',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.shard1': 'application/octet-stream',
};

function handler(req, res) {
  let urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('403 Forbidden');
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found: ' + urlPath);
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    const headers = {
      'Content-Type': type,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    };

    // 支持 Range：音频拖进度、视频跳转依赖它
    const range = req.headers.range;
    if (range && /^bytes=\d*-\d*$/.test(range)) {
      const [startStr, endStr] = range.replace('bytes=', '').split('-');
      let start = startStr ? parseInt(startStr, 10) : 0;
      let end = endStr ? parseInt(endStr, 10) : stat.size - 1;
      if (isNaN(start) || start < 0) start = 0;
      if (isNaN(end) || end >= stat.size) end = stat.size - 1;
      if (start > end) {
        res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
        return res.end();
      }
      res.writeHead(206, Object.assign({}, headers, {
        'Content-Range': `bytes ${start}-${end}/${stat.size}`,
        'Content-Length': end - start + 1,
      }));
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.writeHead(200, Object.assign({}, headers, { 'Content-Length': stat.size }));
    fs.createReadStream(filePath).pipe(res);
  });
}

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  if (process.platform === 'win32') exec(`start "" "${url}"`);
  else if (process.platform === 'darwin') exec(`open "${url}"`);
  else exec(`xdg-open "${url}"`);
}

/** 从 basePort 开始找第一个能用的端口 */
function listen(port, attempt) {
  attempt = attempt || 0;
  const server = http.createServer(handler);

  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && attempt < MAX_TRIES) {
      console.log(`  端口 ${port} 已被占用，换 ${port + 1} 试试…`);
      listen(port + 1, attempt + 1);
      return;
    }
    console.error('\n  启动失败：' + e.message);
    console.error('  可以把项目移到纯英文路径下，或换个端口：set PORT=9000 && node server.js\n');
    process.exit(1);
  });

  server.listen(port, '127.0.0.1', () => {
    const url = `http://localhost:${port}/`;
    console.log('');
    console.log('  MoodTune 情绪电台 已启动');
    console.log('  ------------------------------------------');
    console.log('  地址: ' + url);
    console.log('  请保持这个窗口开启（或使用「启动系统.vbs」静默运行）');
    console.log('  停止服务: 按 Ctrl + C');
    console.log('');
    openBrowser(url);
  });
}

listen(BASE_PORT, 0);
