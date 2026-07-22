import fs from 'node:fs';
import path from 'node:path';
import { ImapFlow } from 'imapflow';

const output = path.resolve('data/digest.json');
const password = process.env.MAIL_IMAP_PASSWORD;
const user = process.env.MAIL_IMAP_USER;

function scoreIntent(content) {
  const high = ['合作', '档期', '接受', '确认', '报价单', '预算', 'contract', 'available', 'interested'];
  const medium = ['考虑', '了解', '资料', 'proposal', 'rate card', 'media kit'];
  const value = content.toLowerCase();
  if (high.some(word => value.includes(word.toLowerCase()))) return 85;
  if (medium.some(word => value.includes(word.toLowerCase()))) return 60;
  return 35;
}

function extractQuote(content) {
  const match = content.match(/(?:¥|￥|rmb\s*|cny\s*|\$)\s*([\d,]+(?:\.\d{1,2})?)/i);
  return match ? Number(match[1].replace(/,/g, '')) : 0;
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
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    for await (const message of client.fetch({ since }, { envelope: true, source: true, internalDate: true })) {
      const source = message.source?.toString('utf8').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').slice(0, 1400) || '';
      const subject = message.envelope?.subject || '';
      const combined = `${subject} ${source}`;
      const intent = scoreIntent(combined);
      const sender = message.envelope?.from?.[0] || {};
      results.push({
        name: sender.name || sender.address || '未知发件人',
        email: sender.address || '',
        subject,
        platform: platformFor(combined),
        intent,
        quote: extractQuote(combined),
        progress: progressFor(intent),
        action: intent >= 85 ? '今天回复并确认档期、报价和下一步' : '阅读邮件并补充红人资料',
        receivedAt: message.internalDate?.toISOString() || new Date().toISOString()
      });
    }
  } finally {
    lock.release();
  }
  save({
    scannedAt: new Date().toISOString(),
    status: 'success',
    replyCount: results.length,
    highIntentCount: results.filter(item => item.intent >= 80).length,
    quoteTotal: results.reduce((sum, item) => sum + item.quote, 0),
    messages: results,
    message: `过去 24 小时分析 ${results.length} 封邮件`
  });
} catch (error) {
  save({ scannedAt: new Date().toISOString(), status: 'error', replyCount: 0, highIntentCount: 0, quoteTotal: 0, message: '邮箱扫描失败，请检查账号或安全码。' });
  console.error(error.message);
  process.exitCode = 1;
} finally {
  try { await client.logout(); } catch { /* Ignore disconnect errors. */ }
}
