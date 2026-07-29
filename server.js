import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ImapFlow } from 'imapflow';
import nodemailer from 'nodemailer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dashboardPath = path.join(__dirname, 'index.html');
const port = Number(process.env.PORT || 3000);
const timezone = process.env.APP_TIMEZONE || 'Asia/Shanghai';
const scanHour = Number(process.env.SCAN_HOUR || 8);
const scanMinute = Number(process.env.SCAN_MINUTE || 30);
const replyToken = String(process.env.KOL_REPLY_TOKEN || '').trim();
const replyAttempts = new Map();
const execFileAsync = promisify(execFile);
let fullScanPromise = null;

const mimeTypes = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

let latestDigest = {
  scannedAt: null,
  status: 'waiting_for_credentials',
  message: '等待在 Railway Variables 中配置邮箱安全码。',
  emails: [],
  quoteTotal: 0,
  highIntentCount: 0
};
let lastScheduledDate = '';

function text(value = '') {
  return String(value).replace(/\s+/g, ' ').trim();
}

function scoreIntent(content) {
  const high = ['合作', '档期', '可以', '接受', '确认', '报价单', '预算', 'contract', 'available', 'interested'];
  const medium = ['考虑', '了解', '资料', 'proposal', 'rate card', 'media kit'];
  const haystack = content.toLowerCase();
  if (high.some(word => haystack.includes(word.toLowerCase()))) return 85;
  if (medium.some(word => haystack.includes(word.toLowerCase()))) return 60;
  return 35;
}

function extractQuote(content) {
  const match = content.match(/(?:¥|￥|rmb\s*|cny\s*|usd\s*\$|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : 0;
}

function getMailConfig() {
  const password = process.env.MAIL_IMAP_PASSWORD;
  if (!password) return null;
  return {
    host: process.env.MAIL_IMAP_HOST || 'imap.qiye.aliyun.com',
    port: Number(process.env.MAIL_IMAP_PORT || 993),
    secure: String(process.env.MAIL_IMAP_TLS || 'true').toLowerCase() !== 'false',
    auth: {
      user: process.env.MAIL_IMAP_USER,
      pass: password
    }
  };
}

function getSmtpTransport() {
  const user = process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER;
  const pass = process.env.MAIL_SMTP_PASSWORD || process.env.MAIL_IMAP_PASSWORD;
  if (!user || !pass) return null;
  return nodemailer.createTransport({ host: process.env.MAIL_SMTP_HOST || 'smtp.qiye.aliyun.com', port: Number(process.env.MAIL_SMTP_PORT || 465), secure: true, auth: { user, pass } });
}

function replyAllowed(to, subject) {
  try {
    const digestPath = path.join(__dirname, 'data', 'digest.json');
    const digest = JSON.parse(fs.readFileSync(digestPath, 'utf8'));
    return (digest.messages || []).some(item => String(item.email || '').toLowerCase() === to.toLowerCase() && String(item.subject || '') === subject);
  } catch {
    return false;
  }
}

function readPersistedDigest() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'digest.json'), 'utf8'));
  } catch {
    return null;
  }
}

function decodeHtml(value = '') {
  return String(value)
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/gi, "'")
    .replace(/&#x2F;/gi, '/').replace(/\s+/g, ' ').trim();
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']*)["']`, 'i'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${escaped}["']`, 'i')
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1]) return decodeHtml(match[1]);
  }
  return '';
}

function firstNumber(html, patterns) {
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match?.[1] != null) return Number(String(match[1]).replace(/,/g, ''));
  }
  return null;
}

function identifyPlatform(value) {
  const host = new URL(value).hostname.toLowerCase();
  if (host.includes('instagram')) return 'Instagram';
  if (host.includes('youtube') || host === 'youtu.be') return 'YouTube';
  if (host.includes('tiktok')) return 'TikTok';
  if (host.includes('bilibili')) return 'Bilibili';
  if (host.includes('xiaohongshu')) return '小红书';
  if (host.includes('douyin')) return '抖音';
  return '未知平台';
}

function brandForContent(value) {
  const haystack = String(value || '').toLowerCase();
  if (haystack.includes('dartsnut')) return 'Dartsnut';
  if (haystack.includes('chessnut')) return 'Chessnut';
  return '待识别';
}

function inferContentModel(value, requested = '') {
  const supplied = String(requested || '').trim();
  if (supplied && supplied !== '未指定型号' && supplied !== '自动识别') return supplied;
  const match = String(value || '').match(/\b(?:chessnut|dartsnut)\s+([a-z][a-z0-9 -]{1,30})/i);
  if (match?.[1]) return `${brandForContent(value)} ${match[1].trim()}`;
  const product = String(value || '').match(/\b(move|e-one|air|pro|go|smart board|automatic chessboard)\b/i);
  return product?.[1] ? product[1].replace(/\b\w/g, c => c.toUpperCase()) : '未指定型号';
}

function evaluateContent({ views, likes, comments }) {
  const knownLikes = Number.isFinite(likes) ? likes : null;
  const knownComments = Number.isFinite(comments) ? comments : null;
  const knownViews = Number.isFinite(views) ? views : null;
  if (knownViews && knownViews > 0) {
    const rate = ((knownLikes || 0) + (knownComments || 0)) / knownViews * 100;
    const score = Math.max(0, Math.min(100, Math.round(Math.min(rate / 0.08, 1) * 100)));
    return { engagement: `${rate.toFixed(2)}%`, score, note: `已抓取真实数据：${knownViews.toLocaleString()} 播放、${(knownLikes || 0).toLocaleString()} 点赞、${(knownComments || 0).toLocaleString()} 评论。互动率按公开数据计算。` };
  }
  if (knownLikes != null || knownComments != null) {
    return { engagement: '待获取播放量', score: '--', note: `已抓取部分真实数据：${knownLikes == null ? '点赞未知' : `${knownLikes.toLocaleString()} 点赞`}、${knownComments == null ? '评论未知' : `${knownComments.toLocaleString()} 评论`}。平台未公开播放量，暂不能计算互动率。` };
  }
  return { engagement: '待抓取', score: '--', note: '平台暂未返回可验证的公开数据，没有使用虚构数值。' };
}

async function fetchPublicPage(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: { 'user-agent': 'Mozilla/5.0 (compatible; KOL-Radar/1.0)', accept: 'text/html,application/xhtml+xml' }
    });
    const html = await response.text();
    return { response, html };
  } finally {
    clearTimeout(timer);
  }
}

async function analyzeInstagram(url, model) {
  const canonical = new URL(url);
  canonical.search = '';
  let response;
  let html = '';
  try {
    ({ response, html } = await fetchPublicPage(canonical.toString()));
  } catch {
    return {
      id: `content-${Date.now()}`,
      status: 'unavailable',
      name: '待匹配红人',
      platform: 'Instagram',
      brand: '待识别',
      model: model || '未指定型号',
      url: canonical.toString(),
      date: '今天',
      views: null,
      likes: null,
      comments: null,
      engagement: '待抓取',
      score: '--',
      note: '服务器当前无法访问 Instagram，已收录链接但没有填充虚构数据。',
      title: '',
      caption: '',
      thumbnail: ''
    };
  }
  const title = metaContent(html, 'og:title');
  const description = metaContent(html, 'og:description');
  const image = metaContent(html, 'og:image');
  const combined = `${title} ${description} ${html}`;
  const likes = firstNumber(combined, [
    /["']like_count["']\s*:\s*(\d+)/i,
    /["']edge_media_preview_like["'][^\d]{0,80}["']count["']\s*:\s*(\d+)/i,
    /([\d,]+)\s+likes?/i
  ]);
  const comments = firstNumber(combined, [
    /["']comment_count["']\s*:\s*(\d+)/i,
    /["']edge_media_to_comment["'][^\d]{0,80}["']count["']\s*:\s*(\d+)/i,
    /([\d,]+)\s+comments?/i
  ]);
  const views = firstNumber(combined, [
    /["']play_count["']\s*:\s*(\d+)/i,
    /["']video_view_count["']\s*:\s*(\d+)/i,
    /["']view_count["']\s*:\s*(\d+)/i
  ]);
  const username = (combined.match(/["'](?:username|owner_username)["']\s*:\s*["']([^"']+)/i) || [])[1] || (canonical.pathname.match(/(?:reel|p)\/([^/]+)/i) || [])[1] || '待匹配红人';
  const textContent = decodeHtml(description || title || '');
  const evaluation = evaluateContent({ views, likes, comments });
  const takenAt = combined.match(/["']taken_at_timestamp["']\s*:\s*(\d+)/i);
  const unavailable = !response.ok || /post (?:is )?unavailable|page isn't available|链接可能已损坏|post无法访问/i.test(combined);
  return {
    id: `content-${Date.now()}`,
    status: unavailable ? 'unavailable' : 'success',
    name: username,
    platform: 'Instagram',
    brand: brandForContent(combined),
    model: model || '未指定型号',
    url: canonical.toString(),
    date: takenAt?.[1] ? new Date(Number(takenAt[1]) * 1000).toISOString().slice(0, 10) : '今天',
    views, likes, comments,
    engagement: evaluation.engagement,
    score: evaluation.score,
    note: unavailable ? 'Instagram 返回内容不可用或需要登录，未写入任何虚构指标。' : `${evaluation.note}${textContent ? ` 内容摘要：${textContent.slice(0, 280)}` : ''}`,
    title: title || '',
    caption: textContent,
    thumbnail: image || ''
  };
}

function youtubeVideoId(url) {
  const parsed = new URL(url);
  if (parsed.hostname === 'youtu.be') return parsed.pathname.slice(1);
  return parsed.searchParams.get('v') || (parsed.pathname.match(/\/(?:shorts|embed|live)\/([^/]+)/) || [])[1] || '';
}

async function analyzeYouTube(url, model) {
  const id = youtubeVideoId(url);
  if (!id) throw new Error('无法识别 YouTube 视频链接');
  const key = process.env.YOUTUBE_API_KEY || process.env.KOL_YOUTUBE_API_KEY;
  let item = null;
  if (key) {
    const endpoint = new URL('https://www.googleapis.com/youtube/v3/videos');
    endpoint.search = new URLSearchParams({ part: 'snippet,statistics', id, key }).toString();
    const response = await fetch(endpoint);
    const payload = await response.json();
    item = payload.items?.[0];
  }
  if (!item) {
    const { html } = await fetchPublicPage(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    try { item = JSON.parse(html); } catch { item = null; }
  }
  const stats = item?.statistics || {};
  const views = stats.viewCount == null ? null : Number(stats.viewCount);
  const likes = stats.likeCount == null ? null : Number(stats.likeCount);
  const comments = stats.commentCount == null ? null : Number(stats.commentCount);
  const evaluation = evaluateContent({ views, likes, comments });
  return { id: `content-${Date.now()}`, status: item ? 'success' : 'unavailable', name: item?.snippet?.channelTitle || '待匹配红人', platform: 'YouTube', brand: brandForContent(`${item?.snippet?.title || ''} ${item?.snippet?.description || ''}`), model: model || '未指定型号', url, date: item?.snippet?.publishedAt?.slice(0, 10) || '今天', views, likes, comments, engagement: evaluation.engagement, score: evaluation.score, note: item ? `${evaluation.note} 内容摘要：${String(item.snippet?.title || '').slice(0, 280)}` : '未获取到 YouTube 公开数据。', title: item?.snippet?.title || '', caption: item?.snippet?.description || '', thumbnail: item?.snippet?.thumbnails?.high?.url || item?.thumbnail_url || '' };
}

async function analyzeContentUrl(url, model) {
  const platform = identifyPlatform(url);
  if (platform === 'Instagram') return analyzeInstagram(url, model);
  if (platform === 'YouTube') return analyzeYouTube(url, model);
  return { id: `content-${Date.now()}`, status: 'unsupported', name: '待匹配红人', platform, brand: '待识别', model: model || '未指定型号', url, date: '今天', views: null, likes: null, comments: null, engagement: '待抓取', score: '--', note: `${platform} 暂未接入可验证的数据接口，已收录链接但未填充虚构数据。` };
}

// Use the same cumulative scanner as GitHub Actions so a manual scan from the
// dashboard produces the same filtered, translated, thread-aware digest.
async function runFullScanner() {
  if (fullScanPromise) return fullScanPromise;
  fullScanPromise = (async () => {
    try {
      await execFileAsync(process.execPath, [path.join(__dirname, 'scripts', 'scan-email.js')], {
        cwd: __dirname,
        env: process.env,
        maxBuffer: 10 * 1024 * 1024
      });
      latestDigest = readPersistedDigest() || latestDigest;
    } catch (error) {
      const persisted = readPersistedDigest();
      const diagnostic = [error.message, error.stderr, error.stdout].filter(Boolean).join('\n').slice(0, 2000);
      // The IMAP server can close the connection after all messages were read.
      // Keep a completed persisted scan instead of replacing it with a stale error.
      if (persisted && Number(persisted.scannedMessageCount || 0) > 0 && Array.isArray(persisted.messages) && persisted.messages.length > 0) {
        latestDigest = { ...persisted, status: 'success', scanWarning: diagnostic };
      } else {
        latestDigest = {
          ...(persisted || latestDigest),
          scannedAt: new Date().toISOString(),
          status: 'error',
          message: '邮箱扫描失败，请检查账号、安全码或邮箱文件夹权限。',
          error: diagnostic
        };
      }
    }
    return latestDigest;
  })().finally(() => { fullScanPromise = null; });
  return fullScanPromise;
}

async function scanInbox() {
  const config = getMailConfig();
  if (!config || !config.auth.user) {
    latestDigest = { ...latestDigest, status: 'waiting_for_credentials', message: '请在 Railway Variables 填写 MAIL_IMAP_USER 和 MAIL_IMAP_PASSWORD。' };
    return latestDigest;
  }

  const client = new ImapFlow({
    ...config,
    logger: false,
    auth: config.auth
  });

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const emails = [];
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      for await (const message of client.fetch({ since }, { envelope: true, source: true, internalDate: true })) {
        const source = message.source?.toString('utf8') || '';
        const subject = text(message.envelope?.subject || '无主题');
        const from = message.envelope?.from?.[0];
        const sender = from?.address || from?.name || '未知发件人';
        const preview = text(source.replace(/<[^>]*>/g, ' ').slice(0, 700));
        const quote = extractQuote(`${subject} ${preview}`);
        const intent = scoreIntent(`${subject} ${preview}`);
        emails.push({ sender, subject, preview, receivedAt: message.internalDate?.toISOString() || new Date().toISOString(), quote, intent });
      }
      const quoteTotal = emails.reduce((sum, email) => sum + email.quote, 0);
      latestDigest = {
        scannedAt: new Date().toISOString(),
        status: 'success',
        message: `已分析 ${emails.length} 封过去 24 小时的邮件。`,
        emails: emails.sort((a, b) => b.intent - a.intent),
        quoteTotal,
        highIntentCount: emails.filter(email => email.intent >= 80).length
      };
    } finally {
      lock.release();
    }
  } catch (error) {
    latestDigest = {
      ...latestDigest,
      scannedAt: new Date().toISOString(),
      status: 'error',
      message: '邮箱扫描失败：请检查 Railway Variables 中的邮箱地址与新安全码。',
      error: error.message
    };
    console.error('Mailbox scan failed:', error.message);
  } finally {
    try { await client.logout(); } catch { /* Connection may not have completed. */ }
  }
  return latestDigest;
}

function getShanghaiTime() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(new Date()).reduce((value, part) => ({ ...value, [part.type]: part.value }), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, hour: Number(parts.hour), minute: Number(parts.minute) };
}

function scheduleScan() {
  const now = getShanghaiTime();
  if (now.hour === scanHour && now.minute === scanMinute && lastScheduledDate !== now.date) {
    lastScheduledDate = now.date;
    runFullScanner();
  }
}

const server = http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const allowedOrigin = process.env.CORS_ORIGIN || 'https://chacha-stella.github.io';
  const requestOrigin = request.headers.origin;
  if (requestOrigin === allowedOrigin) response.setHeader('Access-Control-Allow-Origin', allowedOrigin);
  response.setHeader('Access-Control-Allow-Headers', 'content-type, x-kol-reply-token');
  response.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
  if (url.pathname === '/api/status' && request.method === 'GET') {
    // Report configuration health without exposing any credential values.
    const mailConfigured = Boolean(getMailConfig()?.auth?.user && process.env.MAIL_IMAP_PASSWORD);
    const smtpConfigured = Boolean(getSmtpTransport());
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify({
      status: 'ok',
      replyTokenConfigured: Boolean(replyToken),
      imapConfigured: mailConfigured,
      smtpConfigured,
      startedAt: process.env.RAILWAY_DEPLOYMENT_ID ? undefined : new Date().toISOString(),
      deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null
    }));
    return;
  }
  if (url.pathname === '/api/digest') {
    latestDigest = readPersistedDigest() || latestDigest;
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(latestDigest));
    return;
  }
  if (url.pathname === '/api/content/analyze' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try {
      const payload = JSON.parse(raw || '{}');
      const target = text(payload.url);
      const model = text(payload.model) || '未指定型号';
      if (!target) throw new Error('请提供内容链接');
      if (target.length > 2000) throw new Error('链接过长');
      const result = await analyzeContentUrl(target, model);
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(result));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ status: 'error', message: error.message || '内容分析失败' }));
    }
    return;
  }
  if (url.pathname === '/api/scan' && request.method === 'POST') {
    const result = await runFullScanner();
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(result));
    return;
  }
  if (url.pathname === '/api/reply' && request.method === 'POST') {
    let raw = '';
    for await (const chunk of request) raw += chunk;
    try {
      if (!replyToken || request.headers['x-kol-reply-token'] !== replyToken) throw new Error('回复令牌无效或未配置');
      const payload = JSON.parse(raw || '{}');
      const to = text(payload.to);
      const subject = text(payload.subject);
      const messageId = text(payload.messageId);
      const body = String(payload.body || '').trim();
      if (!to || !subject || !body) throw new Error('缺少收件人、主题或正文');
      if (messageId) {
        const digest = readPersistedDigest();
        const allowed = (digest?.messages || []).some(item => String(item.id || '') === messageId && String(item.email || '').toLowerCase() === to.toLowerCase());
        if (!allowed) throw new Error('只能回复日报中已识别的邮件联系人');
      } else if (!replyAllowed(to, subject)) {
        throw new Error('只能回复日报中已识别的邮件联系人');
      }
      if (body.length > 20000) throw new Error('回复正文不能超过 20000 个字符');
      const ip = String(request.headers['x-forwarded-for'] || request.socket.remoteAddress || 'unknown').split(',')[0].trim();
      const now = Date.now();
      const recent = (replyAttempts.get(ip) || []).filter(timestamp => now - timestamp < 60 * 60 * 1000);
      if (recent.length >= 10) throw new Error('发送过于频繁，请一小时后再试');
      recent.push(now);
      replyAttempts.set(ip, recent);
      const transporter = getSmtpTransport();
      if (!transporter) throw new Error('未配置 MAIL_SMTP_USER / MAIL_SMTP_PASSWORD');
      const info = await transporter.sendMail({ from: process.env.MAIL_SMTP_USER || process.env.MAIL_IMAP_USER, to, subject: subject.startsWith('Re:') ? subject : `Re: ${subject}`, text: body });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'sent', messageId: info.messageId }));
    } catch (error) {
      response.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ status: 'error', message: error.message }));
    }
    return;
  }
  if (url.pathname === '/' || url.pathname === '/index.html') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    fs.createReadStream(dashboardPath).pipe(response);
    return;
  }
  const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  const staticPath = path.resolve(__dirname, relativePath);
  if (staticPath.startsWith(__dirname) && fs.existsSync(staticPath) && fs.statSync(staticPath).isFile()) {
    const extension = path.extname(staticPath).toLowerCase();
    response.writeHead(200, { 'Content-Type': mimeTypes[extension] || 'application/octet-stream', 'Cache-Control': extension === '.json' ? 'no-store' : 'public, max-age=300' });
    fs.createReadStream(staticPath).pipe(response);
    return;
  }
  response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  response.end('Not found');
});

server.listen(port, () => {
  console.log(`KOL Radar listening on port ${port}. Scheduled scan: ${scanHour}:${String(scanMinute).padStart(2, '0')} ${timezone}`);
  latestDigest = readPersistedDigest() || latestDigest;
  runFullScanner();
});

setInterval(scheduleScan, 30 * 1000);
