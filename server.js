import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT || 3000);
const timezone = process.env.APP_TIMEZONE || 'Asia/Shanghai';
const scanHour = Number(process.env.SCAN_HOUR || 8);
const scanMinute = Number(process.env.SCAN_MINUTE || 30);
const graphVersion = process.env.META_GRAPH_VERSION || 'v22.0';
const replyToken = String(process.env.KOL_REPLY_TOKEN || '').trim();
const adminToken = String(process.env.KOL_ADMIN_TOKEN || replyToken).trim();
const scanToken = String(process.env.KOL_SCAN_TOKEN || '').trim();
const execFileAsync = promisify(execFile);
const replyAttempts = new Map();
let fullScanPromise = null;
let lastScheduledDate = '';

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

let latestDigest = {
  scannedAt: null,
  status: 'waiting_for_credentials',
  message: '等待邮箱首次扫描。',
  messages: [],
  otherMessages: [],
  replyCount: 0,
  newEmailCount: 0,
  repliedCount: 0,
  highIntentCount: 0,
  quoteTotal: 0
};

function digestPath() {
  return path.join(__dirname, 'data', 'digest.json');
}

function readPersistedDigest() {
  try { return JSON.parse(fs.readFileSync(digestPath(), 'utf8')); } catch { return null; }
}

function text(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function json(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  let raw = '';
  for await (const chunk of request) raw += chunk;
  if (raw.length > 25 * 1024 * 1024) throw new Error('请求内容过大');
  try { return JSON.parse(raw || '{}'); } catch { throw new Error('请求格式必须是 JSON'); }
}

function getMailConfig() {
  const user = String(process.env.MAIL_IMAP_USER || '').trim();
  const password = String(process.env.MAIL_IMAP_PASSWORD || '');
  if (!user || !password) return null;
  return {
    host: process.env.MAIL_IMAP_HOST || 'imap.qiye.aliyun.com',
    port: Number(process.env.MAIL_IMAP_PORT || 993),
    secure: String(process.env.MAIL_IMAP_TLS || 'true').toLowerCase() !== 'false',
    auth: { user, pass: password }
  };
}

function getSmtpTransport() {
  const user = process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER;
  const pass = process.env.MAIL_SMTP_PASSWORD || process.env.MAIL_IMAP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({
    host: process.env.MAIL_SMTP_HOST || 'smtp.qiye.aliyun.com',
    port: Number(process.env.MAIL_SMTP_PORT || 465),
    secure: true,
    auth: { user, pass }
  });
}

async function translateWithLibreTranslate(value, target = 'zh') {
  const base = String(process.env.LIBRETRANSLATE_URL || '').trim().replace(/\/$/, '');
  const textValue = String(value || '').trim();
  if (!base) throw new Error('翻译服务未配置：请设置 LIBRETRANSLATE_URL');
  if (!textValue) return '';
  if (!['zh', 'en'].includes(target)) throw new Error('target 只能是 zh 或 en');
  if (textValue.length > 12000) throw new Error('待翻译内容不能超过 12000 个字符');
  const response = await fetch(`${base}/translate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      q: textValue,
      source: 'auto',
      target,
      format: 'text',
      ...(process.env.LIBRETRANSLATE_API_KEY ? { api_key: process.env.LIBRETRANSLATE_API_KEY } : {})
    }),
    signal: AbortSignal.timeout(Number(process.env.LIBRETRANSLATE_TIMEOUT_MS || 30000))
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `翻译服务返回 ${response.status}`);
  const translated = String(payload.translatedText || '').trim();
  if (!translated) throw new Error('翻译服务返回空结果');
  return translated;
}

function replyAllowed(to, messageId) {
  const digest = readPersistedDigest() || latestDigest;
  return (digest.messages || []).some(item => String(item.id || '') === String(messageId || '') && String(item.email || '').toLowerCase() === String(to || '').toLowerCase());
}

function requireScanToken(request) {
  if (!scanToken || request.headers['x-kol-scan-token'] !== scanToken) {
    throw new Error('扫描上传令牌无效或未配置');
  }
}

async function runFullScanner() {
  if (fullScanPromise) return fullScanPromise;
  fullScanPromise = (async () => {
    try {
      await execFileAsync(process.execPath, [path.join(__dirname, 'scripts', 'scan-email.js')], {
        cwd: __dirname,
        env: process.env,
        maxBuffer: 20 * 1024 * 1024
      });
      latestDigest = readPersistedDigest() || latestDigest;
    } catch (error) {
      const persisted = readPersistedDigest();
      const diagnostic = [error.message, error.responseText, error.executedCommand, error.stderr, error.stdout].filter(Boolean).join('\n').slice(0, 4000);
      latestDigest = persisted?.messages?.length
        ? { ...persisted, status: 'success', scanWarning: diagnostic }
        : { ...latestDigest, scannedAt: new Date().toISOString(), status: 'error', message: '邮箱扫描失败，请检查 IMAP 账号和安全码。', error: diagnostic };
    }
    return latestDigest;
  })().finally(() => { fullScanPromise = null; });
  return fullScanPromise;
}

function getShanghaiTime() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((out, part) => ({ ...out, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function scheduleScan() {
  const now = getShanghaiTime();
  if (now.hour === scanHour && now.minute === scanMinute && lastScheduledDate !== now.date) {
    lastScheduledDate = now.date;
    runFullScanner().catch(() => {});
  }
}

function youtubeVideoId(value) {
  const parsed = new URL(value);
  if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  return parsed.searchParams.get('v') || (parsed.pathname.match(/\/(?:shorts|embed|live)\/([^/]+)/) || [])[1] || '';
}

function youtubeKey() {
  return String(process.env.YOUTUBE_API_KEY || process.env.KOL_YOUTUBE_API_KEY || '').trim();
}

async function googleAccessToken() {
  const direct = String(process.env.YOUTUBE_ACCESS_TOKEN || '').trim();
  if (direct) return direct;
  const refresh = String(process.env.YOUTUBE_REFRESH_TOKEN || '').trim();
  const clientId = String(process.env.YOUTUBE_CLIENT_ID || '').trim();
  const clientSecret = String(process.env.YOUTUBE_CLIENT_SECRET || '').trim();
  if (!refresh || !clientId || !clientSecret) return '';
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error_description || `Google OAuth ${response.status}`);
  return payload.access_token || '';
}

async function youtubeApi(endpoint, params = {}, options = {}) {
  const url = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value); });
  if (!options.accessToken) {
    const key = youtubeKey();
    if (!key) throw new Error('未配置 YOUTUBE_API_KEY');
    url.searchParams.set('key', key);
  }
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers: { ...(options.accessToken ? { authorization: `Bearer ${options.accessToken}` } : {}), ...(options.headers || {}) },
    body: options.body
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error?.message || `YouTube API ${response.status}`);
  return payload;
}

async function graphApi(pathname, params = {}, options = {}) {
  const token = String(process.env.INSTAGRAM_ACCESS_TOKEN || '').trim();
  if (!token) throw new Error('未配置 INSTAGRAM_ACCESS_TOKEN');
  const url = new URL(`https://graph.facebook.com/${graphVersion}/${pathname.replace(/^\//, '')}`);
  Object.entries(params).forEach(([key, value]) => { if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value); });
  if (options.method === 'POST') {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ ...params, access_token: token }) });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.error) throw new Error(payload.error?.message || `Meta API ${response.status}`);
    return payload;
  }
  url.searchParams.set('access_token', token);
  const response = await fetch(url);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || payload.error) throw new Error(payload.error?.message || `Meta API ${response.status}`);
  return payload;
}

function checkAllowedOrigin(request, response) {
  const allowed = process.env.CORS_ORIGIN || 'https://chacha-stella.github.io';
  if (request.headers.origin === allowed) response.setHeader('Access-Control-Allow-Origin', allowed);
  response.setHeader('Access-Control-Allow-Headers', 'content-type, x-kol-reply-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
}

function requireAdmin(request) {
  if (!adminToken || request.headers['x-kol-reply-token'] !== adminToken) throw new Error('未授权：请输入后台管理令牌');
}

async function handleRequest(request, response) {
  checkAllowedOrigin(request, response);
  const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }

  if (url.pathname === '/api/status' && request.method === 'GET') {
    return json(response, 200, {
      status: 'ok',
      imapConfigured: Boolean(getMailConfig()),
      smtpConfigured: Boolean(getSmtpTransport()),
      replyTokenConfigured: Boolean(replyToken),
      adminTokenConfigured: Boolean(adminToken),
      youtubeReadConfigured: Boolean(youtubeKey()),
      youtubeWriteConfigured: Boolean(process.env.YOUTUBE_ACCESS_TOKEN || (process.env.YOUTUBE_REFRESH_TOKEN && process.env.YOUTUBE_CLIENT_ID && process.env.YOUTUBE_CLIENT_SECRET)),
      instagramConfigured: Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID),
      translationConfigured: Boolean(String(process.env.LIBRETRANSLATE_URL || '').trim()),
      translationService: 'LibreTranslate',
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null
    });
  }

  if (url.pathname === '/api/translation/status' && request.method === 'GET') {
    const base = String(process.env.LIBRETRANSLATE_URL || '').trim().replace(/\/$/, '');
    if (!base) return json(response, 200, { status: 'not_configured', service: 'LibreTranslate' });
    try {
      const result = await fetch(`${base}/languages`, { signal: AbortSignal.timeout(Number(process.env.LIBRETRANSLATE_TIMEOUT_MS || 30000)) });
      return json(response, 200, { status: result.ok ? 'ok' : 'error', service: 'LibreTranslate', url: base });
    } catch (error) {
      return json(response, 200, { status: 'error', service: 'LibreTranslate', url: base, message: error.message });
    }
  }

  if (url.pathname === '/api/translate' && request.method === 'POST') {
    try {
      const payload = await readBody(request);
      const target = String(payload.target || 'zh').trim().toLowerCase();
      const translatedText = await translateWithLibreTranslate(payload.text, target);
      return json(response, 200, { status: 'ok', service: 'LibreTranslate', target, translatedText });
    } catch (error) {
      return json(response, 400, { status: 'error', message: error.message });
    }
  }

  if (url.pathname === '/api/digest' && request.method === 'GET') return json(response, 200, readPersistedDigest() || latestDigest);
  if (url.pathname === '/api/digest' && request.method === 'POST') {
    try {
      requireScanToken(request);
      const payload = await readBody(request);
      if (payload?.status !== 'success') throw new Error('只接受成功的邮箱扫描结果');
      if (!Array.isArray(payload.messages)) throw new Error('日报格式无效');
      fs.mkdirSync(path.dirname(digestPath()), { recursive: true });
      fs.writeFileSync(digestPath(), JSON.stringify(payload, null, 2) + '\n', 'utf8');
      latestDigest = payload;
      return json(response, 200, { status: 'stored', scannedAt: payload.scannedAt || null, messageCount: payload.messages.length });
    } catch (error) {
      return json(response, 400, { status: 'error', message: error.message });
    }
  }
  if (url.pathname === '/api/scan' && request.method === 'POST') return json(response, 200, await runFullScanner());

  if (url.pathname === '/api/reply' && request.method === 'POST') {
    try {
      if (!replyToken || request.headers['x-kol-reply-token'] !== replyToken) throw new Error('回复令牌无效或未配置');
      const payload = await readBody(request);
      const to = text(payload.to);
      const subject = text(payload.subject);
      const body = String(payload.body || '').trim();
      if (!to || !subject || !body) throw new Error('缺少收件人、主题或正文');
      if (!replyAllowed(to, payload.messageId)) throw new Error('只能回复日报中已识别的邮件');
      const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0];
      const recent = (replyAttempts.get(ip) || []).filter(value => Date.now() - value < 3600000);
      if (recent.length >= 10) throw new Error('发送过于频繁，请稍后再试');
      recent.push(Date.now()); replyAttempts.set(ip, recent);
      const transporter = getSmtpTransport();
      if (!transporter) throw new Error('未配置 SMTP 发信变量');
      const info = await transporter.sendMail({ from: process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER, to, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`, text: body });
      return json(response, 200, { status: 'sent', messageId: info.messageId });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }

  if (url.pathname === '/api/youtube/status' && request.method === 'GET') {
    return json(response, 200, { read: Boolean(youtubeKey()), write: Boolean(process.env.YOUTUBE_ACCESS_TOKEN || process.env.YOUTUBE_REFRESH_TOKEN), message: youtubeKey() ? 'YouTube 读取接口已配置' : '请配置 YOUTUBE_API_KEY' });
  }
  if (url.pathname === '/api/youtube/video' && request.method === 'GET') {
    try {
      const id = youtubeVideoId(url.searchParams.get('url') || '');
      if (!id) throw new Error('无法识别 YouTube 链接');
      const payload = await youtubeApi('videos', { part: 'snippet,statistics,status', id });
      return json(response, 200, { status: 'success', item: payload.items?.[0] || null });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/youtube/comments' && request.method === 'GET') {
    try {
      const videoId = text(url.searchParams.get('videoId'));
      if (!videoId) throw new Error('缺少 videoId');
      const payload = await youtubeApi('commentThreads', { part: 'snippet,replies', videoId, maxResults: 100, order: 'time' });
      return json(response, 200, { status: 'success', items: payload.items || [], nextPageToken: payload.nextPageToken || '' });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/youtube/comment/reply' && request.method === 'POST') {
    try {
      requireAdmin(request);
      const accessToken = await googleAccessToken();
      if (!accessToken) throw new Error('未配置 YouTube 写入授权');
      const payload = await readBody(request);
      if (!payload.parentId || !payload.text) throw new Error('缺少评论 ID 或回复内容');
      const result = await youtubeApi('comments', { part: 'snippet' }, { method: 'POST', accessToken, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ snippet: { parentId: payload.parentId, textOriginal: String(payload.text).slice(0, 10000) } }) });
      return json(response, 200, { status: 'sent', item: result });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/youtube/publish' && request.method === 'POST') {
    try {
      requireAdmin(request);
      const accessToken = await googleAccessToken();
      if (!accessToken) throw new Error('未配置 YouTube 写入授权');
      const payload = await readBody(request);
      if (!payload.videoUrl || !payload.title) throw new Error('需要公开视频 URL 和标题');
      const download = await fetch(payload.videoUrl);
      if (!download.ok) throw new Error(`视频下载失败：${download.status}`);
      const bytes = await download.arrayBuffer();
      if (bytes.byteLength > 200 * 1024 * 1024) throw new Error('视频超过 200MB');
      const form = new FormData();
      form.append('metadata', new Blob([JSON.stringify({ snippet: { title: String(payload.title).slice(0, 100), description: String(payload.description || '').slice(0, 5000), tags: Array.isArray(payload.tags) ? payload.tags.slice(0, 20) : [] }, status: { privacyStatus: payload.privacyStatus || 'private' } })], { type: 'application/json' }), 'metadata.json');
      form.append('video', new Blob([bytes], { type: download.headers.get('content-type') || 'video/mp4' }), 'video.mp4');
      const responseUpload = await fetch('https://www.googleapis.com/upload/youtube/v3/videos?uploadType=multipart&part=snippet,status', { method: 'POST', headers: { authorization: `Bearer ${accessToken}` }, body: form });
      const result = await responseUpload.json().catch(() => ({}));
      if (!responseUpload.ok) throw new Error(result.error?.message || `YouTube 发布失败：${responseUpload.status}`);
      return json(response, 200, { status: 'published', item: result });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }

  if (url.pathname === '/api/instagram/status' && request.method === 'GET') {
    return json(response, 200, { configured: Boolean(process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID), message: process.env.INSTAGRAM_ACCESS_TOKEN && process.env.INSTAGRAM_USER_ID ? 'Instagram Graph API 已配置' : '请配置 Instagram 企业/创作者账号的 Graph API 授权' });
  }
  if (url.pathname === '/api/instagram/media' && request.method === 'GET') {
    try {
      const userId = text(process.env.INSTAGRAM_USER_ID);
      if (!userId) throw new Error('未配置 INSTAGRAM_USER_ID');
      const payload = await graphApi(`${userId}/media`, { fields: 'id,caption,media_type,media_url,thumbnail_url,permalink,timestamp,like_count,comments_count', limit: Math.min(50, Number(url.searchParams.get('limit') || 25)) });
      return json(response, 200, { status: 'success', items: payload.data || [], next: payload.paging?.next || '' });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/instagram/comments' && request.method === 'GET') {
    try {
      const mediaId = text(url.searchParams.get('mediaId'));
      if (!mediaId) throw new Error('缺少 mediaId');
      const payload = await graphApi(`${mediaId}/comments`, { fields: 'id,text,username,timestamp', limit: 100 });
      return json(response, 200, { status: 'success', items: payload.data || [] });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/instagram/comment/reply' && request.method === 'POST') {
    try {
      requireAdmin(request);
      const payload = await readBody(request);
      if (!payload.commentId || !payload.text) throw new Error('缺少评论 ID 或回复内容');
      const result = await graphApi(`${payload.commentId}/replies`, { message: String(payload.text).slice(0, 1000) }, { method: 'POST' });
      return json(response, 200, { status: 'sent', item: result });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }
  if (url.pathname === '/api/instagram/publish' && request.method === 'POST') {
    try {
      requireAdmin(request);
      const userId = text(process.env.INSTAGRAM_USER_ID);
      const payload = await readBody(request);
      if (!userId || !payload.caption || (!payload.imageUrl && !payload.videoUrl)) throw new Error('需要账号、文案和公开媒体 URL');
      const isVideo = Boolean(payload.videoUrl);
      const container = await graphApi(`${userId}/media`, isVideo
        ? { media_type: 'REELS', video_url: payload.videoUrl, caption: payload.caption }
        : { image_url: payload.imageUrl, caption: payload.caption }, { method: 'POST' });
      const published = await graphApi(`${userId}/media_publish`, { creation_id: container.id }, { method: 'POST' });
      return json(response, 200, { status: 'published', item: published });
    } catch (error) { return json(response, 400, { status: 'error', message: error.message }); }
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(path.join(__dirname, 'index.html')).pipe(response);
    return;
  }
  const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const filePath = path.resolve(__dirname, relative);
  if (filePath.startsWith(__dirname) && fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const extension = path.extname(filePath).toLowerCase();
    response.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream', 'Cache-Control': extension === '.json' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(filePath).pipe(response);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
}

const server = http.createServer((request, response) => {
  handleRequest(request, response).catch(error => json(response, 500, { status: 'error', message: error.message || '服务器错误' }));
});

server.listen(port, () => {
  latestDigest = readPersistedDigest() || latestDigest;
  console.log(`KOL Radar listening on port ${port}; daily scan ${scanHour}:${String(scanMinute).padStart(2, '0')} ${timezone}`);
  runFullScanner().catch(() => {});
});

setInterval(scheduleScan, 30000);
