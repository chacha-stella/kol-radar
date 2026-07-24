import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';

const output = path.resolve('data/digest.json');
const password = process.env.MAIL_IMAP_PASSWORD;
const user = process.env.MAIL_IMAP_USER;
const internalDomains = ['chessnutech.com'];

const collaborationTerms = [
  '合作', '报价', '报价单', '预算', '档期', '赞助', '推广', '评测', '产品', '媒体包',
  'media kit', 'rate card', 'sponsor', 'sponsored', 'collab', 'collaboration', 'review',
  'brand deal', 'interested', 'available', 'partnership', 'proposal', 'campaign', 'deliverables',
  'timeline', 'fee', 'price', 'pricing', 'usd', 'eur', 'sure', 'yes', 'okay', 'accept'
];
const automatedPrefixes = ['noreply@', 'no-reply@', 'mailer-daemon@', 'postmaster@', 'notifications@', 'notification@'];

function scoreIntent(content) {
  const high = ['合作', '档期', '接受', '确认', '报价单', '预算', 'contract', 'available', 'interested'];
  const medium = ['考虑', '了解', '资料', 'proposal', 'rate card', 'media kit'];
  const value = content.toLowerCase();
  if (high.some(word => value.includes(word.toLowerCase()))) return 85;
  if (medium.some(word => value.includes(word.toLowerCase()))) return 60;
  return 35;
}

function extractQuote(content) {
  const match = content.match(/(?:¥|￥|rmb\s*|cny\s*)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : 0;
}

function cleanContent(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/=\r?\n/g, '')
    .replace(/\s+/g, ' ')
    .slice(0, 5000);
}

function decodeMimeHeader(value) {
  return String(value || '').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (_, charset, encoding, payload) => {
    try {
      const bytes = encoding.toLowerCase() === 'b'
        ? Buffer.from(payload, 'base64')
        : Buffer.from(payload.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16))), 'binary');
      return new TextDecoder(charset.toLowerCase()).decode(bytes);
    } catch {
      return payload;
    }
  });
}

function parseMimeHeaders(block) {
  const unfolded = String(block || '').replace(/\r?\n[ \t]+/g, ' ');
  const headers = {};
  for (const line of unfolded.split(/\r?\n/)) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers[line.slice(0, index).trim().toLowerCase()] = decodeMimeHeader(line.slice(index + 1).trim());
  }
  return headers;
}

function decodeMimeBody(body, transferEncoding, charset = 'utf-8') {
  let bytes;
  const encoding = String(transferEncoding || '').toLowerCase();
  if (encoding.includes('base64')) {
    bytes = Buffer.from(String(body).replace(/\s+/g, ''), 'base64');
  } else if (encoding.includes('quoted-printable')) {
    const binary = String(body).replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
    bytes = Buffer.from(binary, 'binary');
  } else {
    bytes = Buffer.from(String(body), 'utf8');
  }
  try { return new TextDecoder(String(charset).split(';')[0].trim().toLowerCase() || 'utf-8').decode(bytes); }
  catch { return bytes.toString('utf8'); }
}

function extractMimeText(raw) {
  const source = String(raw || '').replace(/\r\n/g, '\n');
  const separator = source.indexOf('\n\n');
  if (separator < 0) return source;
  const headers = parseMimeHeaders(source.slice(0, separator));
  const body = source.slice(separator + 2);
  const type = String(headers['content-type'] || 'text/plain').toLowerCase();
  const boundary = type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.[1] || type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i)?.[2];
  if (boundary) {
    return body.split(`--${boundary}`).filter(part => part && !/^--\s*$/.test(part.trim())).map(extractMimeText).join('\n');
  }
  if (type.includes('message/rfc822')) return extractMimeText(body);
  return decodeMimeBody(body, headers['content-transfer-encoding'], headers['content-type']?.match(/charset\s*=\s*["']?([^;"']+)/i)?.[1] || 'utf-8');
}

function isAutomated(address, subject) {
  const email = String(address || '').toLowerCase();
  const title = String(subject || '').toLowerCase();
  return automatedPrefixes.some(prefix => email.startsWith(prefix)) ||
    /(?:delivery status|undeliverable|failure notice|自动回复|out of office|vacation reply)/i.test(title);
}

function isInternalAddress(address) {
  const value = String(address || '').toLowerCase();
  return internalDomains.some(domain => value.endsWith(`@${domain}`));
}

function addressInfo(value) {
  const text = decodeMimeHeader(String(value || '').trim());
  const address = text.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] || '';
  if (!address) return null;
  const name = text.match(/^(.*?)\s*<[^>]+>/)?.[1]?.replace(/^['"]|['"]$/g, '').trim() || '';
  return { address, name };
}

function originalSenderInfo(source) {
  const headers = String(source).match(/(?:^|\n)(?:from|发件人|sender|reply-to|回复|original-from|x-original-from|return-path):\s*([^\r\n]{0,240})/gi) || [];
  for (const line of headers) {
    const info = addressInfo(line.replace(/^[^:]+:\s*/, ''));
    if (info && !isInternalAddress(info.address) && info.address.toLowerCase() !== user.toLowerCase()) return info;
  }
  return null;
}

function externalAddressFromContent(source) {
  const candidates = source.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g) || [];
  return candidates.find(address => !isInternalAddress(address) && address.toLowerCase() !== user.toLowerCase() && !isAutomated(address, '')) || '';
}

function isLikelyCreatorReply(content, senderAddress, subject, forwarded) {
  const value = content.toLowerCase();
  const sender = String(senderAddress || '').toLowerCase();
  if (!sender || sender === user.toLowerCase() || isAutomated(sender, content)) return false;
  const hasTerms = collaborationTerms.some(term => value.includes(term.toLowerCase()));
  const replyMarker = /(?:^|\s)(?:re|回复|答复|fwd|转发)\s*:/i.test(String(subject || ''));
  return hasTerms || (forwarded && (replyMarker || value.length > 20)) || replyMarker;
}

function platformFor(content) {
  const value = content.toLowerCase();
  if (value.includes('youtube')) return 'YouTube';
  if (value.includes('instagram')) return 'Instagram';
  if (value.includes('tiktok')) return 'TikTok';
  if (value.includes('小红书') || value.includes('xiaohongshu')) return '小红书';
  if (value.includes('bilibili')) return 'Bilibili';
  return '待识别';
}

function progressFor(intent) {
  if (intent >= 85) return '高意向，待跟进';
  if (intent >= 60) return '已回复，待判断';
  return '待人工确认';
}

function save(data) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

if (!password || !user) {
  save({ scannedAt: new Date().toISOString(), status: 'missing_secret', replyCount: 0, highIntentCount: 0, quoteTotal: 0, message: '请在 GitHub Actions Secrets 填写邮箱账号和安全码。' });
  process.exit(0);
}

const client = new ImapFlow({
  host: process.env.MAIL_IMAP_HOST || 'imap.qiye.aliyun.com',
  port: Number(process.env.MAIL_IMAP_PORT || 993),
  secure: true,
  auth: { user, pass: password },
  logger: false
});

try {
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const results = [];
  let scannedMessageCount = 0;
  let ignoredMessageCount = 0;
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for await (const message of client.fetch({ since }, { envelope: true, source: true, internalDate: true })) {
      scannedMessageCount += 1;
      const rawSource = message.source?.toString('utf8') || '';
      const source = cleanContent(extractMimeText(rawSource));
      const subject = message.envelope?.subject || '';
      const combined = `${subject} ${source}`;
      const sender = message.envelope?.from?.[0] || {};
      const receivedAt = message.internalDate || new Date(0);
      const original = isInternalAddress(sender.address)
        ? (originalSenderInfo(rawSource) || originalSenderInfo(source))
        : null;
      const externalSender = original?.address || (!isInternalAddress(sender.address) ? sender.address : externalAddressFromContent(source));
      const effectiveSender = externalSender || sender.address;
      const forwarded = Boolean(original);
      if (receivedAt < since || !effectiveSender || isAutomated(effectiveSender, subject) ||
        (isInternalAddress(sender.address) && !externalSender) || !isLikelyCreatorReply(combined, effectiveSender, subject, forwarded)) {
        ignoredMessageCount += 1;
        continue;
      }
      const intent = scoreIntent(combined);
      results.push({
        name: original?.name || sender.name || effectiveSender || '未知发件人',
        email: effectiveSender || '',
        subject,
        platform: platformFor(combined),
        intent,
        quote: extractQuote(combined),
        progress: progressFor(intent),
        action: intent >= 85 ? '今天回复并确认档期、报价和下一步' : '阅读邮件并补充红人资料',
        receivedAt: receivedAt.toISOString()
      });
    }
  } finally {
    lock.release();
  }
  save({
    scannedAt: new Date().toISOString(),
    status: 'success',
    scannedMessageCount,
    ignoredMessageCount,
    replyCount: results.length,
    highIntentCount: results.filter(item => item.intent >= 80).length,
    quoteTotal: results.reduce((sum, item) => sum + item.quote, 0),
    messages: results,
    message: `过去 24 小时扫描 ${scannedMessageCount} 封邮件，筛选出 ${results.length} 封疑似合作回复`
  });
  console.info(`[scan] scanned=${scannedMessageCount} selected=${results.length} ignored=${ignoredMessageCount}`);
  for (const item of results) console.info(`[selected] ${item.email} | ${item.subject} | intent=${item.intent} | quote=${item.quote}`);
} catch (error) {
  save({ scannedAt: new Date().toISOString(), status: 'error', replyCount: 0, highIntentCount: 0, quoteTotal: 0, message: '邮箱扫描失败，请检查账号或安全码。' });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { await client.logout(); } catch { /* Ignore disconnect errors. */ }
}
