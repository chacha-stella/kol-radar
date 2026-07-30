import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ImapFlow } from 'imapflow';

const output = path.resolve('data/digest.json');
let previousDigest = null;
try { previousDigest = JSON.parse(fs.readFileSync(output, 'utf8')); } catch { /* First scan has no cache. */ }
let translationsRemaining = Number(process.env.MAX_TRANSLATIONS_PER_RUN || 3);
const password = process.env.MAIL_IMAP_PASSWORD;
const user = process.env.MAIL_IMAP_USER;
const geminiApiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_GEMINI_API_KEY || process.env.GOOGLE_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite';
const internalDomains = ['chessnutech.com'];
// These senders are platform notices or marketing services, not creator replies.
// Keep them out of the collaboration queue even when their copy contains words
// such as "collab" or "influencer".
const blockedSenderDomains = [
  'railway.app', 'afluencer.com', 'github.com', 'google.com', 'youtube.com',
  'aliyun.com', 'mailchimp.com', 'sendgrid.net'
];
let lastTranslationRequestAt = 0;

const collaborationTerms = [
  '合作', '报价', '报价单', '预算', '档期', '赞助', '推广', '评测', '产品', '媒体包',
  'media kit', 'rate card', 'sponsor', 'sponsored', 'collab', 'collaboration', 'review',
  'brand deal', 'interested', 'available', 'partnership', 'proposal', 'campaign', 'deliverables',
  'timeline', 'fee', 'price', 'pricing', 'usd', 'eur', 'sure', 'yes', 'okay', 'accept'
];
const nonCreatorTerms = [
  'seo', 'website audit', 'website optimization', 'google ranking', 'search engine',
  'exhibition', 'trade show', 'conference', 'event sponsorship', 'vendor', 'supplier',
  'wholesale', 'factory', 'manufacturing', 'bag vendor', 'web design', 'link building',
  'newsletter', 'marketing platform'
];
const automatedPrefixes = ['noreply@', 'no-reply@', 'mailer-daemon@', 'postmaster@', 'notifications@', 'notification@'];

function scoreIntent(content) {
  const value = String(content || '').toLowerCase();
  const highSignals = [
    /\b(rate card|media kit|deliverables|campaign|contract|sponsorship fee|quoted|my fee)\b/i,
    /\b(i(?:'m| am) interested|we(?:'d| would) love to|happy to collaborate|let(?:'s| us) work together)\b/i,
    /\b(available|availability|timeline|schedule|deadline|shipping address)\b/i,
    /(报价单|合作报价|预算|档期|赞助费|合同|接受合作|愿意合作|可以合作)/i
  ];
  const mediumSignals = [
    /\b(interested|partnership|collaboration|collab|review|product|proposal|details|information)\b/i,
    /(合作|推广|评测|产品|资料|了解|考虑|媒体包)/i
  ];
  const negativeSignals = [
    /\b(unsubscribe|newsletter|referral credits|build failed|password reset|order confirmation|shipping notification)\b/i,
    /(退订|验证码|订单通知|发货通知|系统通知|构建失败)/i
  ];
  const high = highSignals.filter(pattern => pattern.test(value)).length;
  const medium = mediumSignals.filter(pattern => pattern.test(value)).length;
  const negative = negativeSignals.some(pattern => pattern.test(value));
  const creatorSignals = /\b(creator|influencer|tiktok|instagram|youtube|reel|shorts|followers|audience|media kit|rate card)\b/i.test(value);
  if (negative && high === 0) return { score: 10, level: '低意向', reasons: ['系统/通知类邮件'] };
  if (creatorSignals && high >= 2) return { score: 85, level: '高意向', reasons: ['明确提到红人/内容合作', '涉及档期、报价或交付'] };
  if (creatorSignals && high >= 1) return { score: 75, level: '较高意向', reasons: ['提到红人内容合作', '已出现合作推进信号'] };
  if (high >= 2 || (high >= 1 && medium >= 1)) return { score: 85, level: '高意向', reasons: ['出现明确合作动作', '涉及档期、报价或交付'] };
  if (high === 1 || medium >= 2) return { score: 60, level: '中意向', reasons: ['提到合作或产品评测', '尚未出现明确报价/档期'] };
  return { score: 35, level: '待确认', reasons: ['只有泛合作词或上下文不足'] };
}

function extractQuote(content) {
  const value = String(content || '');
  const parse = (raw, suffix = '') => {
    const amount = Number(String(raw || '').replace(/,/g, ''));
    if (!Number.isFinite(amount)) return 0;
    return /k$/i.test(suffix) ? amount * 1000 : amount;
  };
  const patterns = [
    /(?:¥|￥|rmb|cny|usd|eur|gbp)\s*[:：]?\s*([\d,]+(?:\.\d{1,2})?)\s*([kK])?/i,
    /\$\s*([\d,]+(?:\.\d{1,2})?)\s*([kK])?/i,
    /([\d,]+(?:\.\d{1,2})?)\s*([kK])?\s*(?:usd|eur|gbp|rmb|cny)/i
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return parse(match[1], match[2]);
  }
  return 0;
}

function cleanContent(value, limit = 5000) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/=\r?\n/g, '')
    .replace(/\r/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function repairMojibake(value) {
  const text = String(value || '');
  if (!/[鈥鍙銆锛闂鐨]/.test(text)) return text;
  try {
    const repaired = Buffer.from(text, 'latin1').toString('utf8');
    return repaired.includes('\ufffd') ? text : repaired;
  } catch {
    return text;
  }
}

function summarize(content, subject) {
  const lines = String(content || '')
    .replace(/(^|\s)(On .*?wrote:|在.*写道：).*$/i, '$1')
    .split(/\n+/)
    .map(line => line.trim())
    .filter(line => line && !/^>/.test(line) && !/^[-_]{3,}$/.test(line))
    .filter(line => !/^(best regards|kind regards|regards|thanks|thank you)[,!]?$/i.test(line));
  const value = cleanContent(repairMojibake(lines.slice(0, 8).join(' ')));
  return (value || cleanContent(repairMojibake(subject)) || '无正文，仅有邮件标题').slice(0, 260);
}

function bodyText(content) {
  return String(content || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/=\r?\n/g, '')
    .replace(/\r/g, '')
    .split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim())
    .filter((line, index, lines) => line || lines[index - 1])
    .join('\n')
    .trim();
}

function hasCjk(value) {
  return /[\u3400-\u9fff]/.test(String(value || ''));
}

async function translateChunk(value, label = '正文') {
  const text = repairMojibake(String(value || '').trim());
  if (!text) return '';
  if (hasCjk(text) && !/[A-Za-z]{4,}/.test(text)) return text;
  const wait = Math.max(0, 4300 - (Date.now() - lastTranslationRequestAt));
  if (wait) await new Promise(resolve => setTimeout(resolve, wait));
  lastTranslationRequestAt = Date.now();
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(geminiApiKey)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: `把下面邮件${label}完整翻译成自然、准确的简体中文。不得删减、总结或改写。保留人名、邮箱、网址、产品名、数字、金额和原有段落。只返回翻译后的${label}纯文本，不要 Markdown，不要解释。\n\n${text}` }] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
      })
  });
  if (!response.ok) throw new Error(`translation_${response.status}`);
  const payload = await response.json();
  return payload.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('').trim() || '';
}

async function translateEmailToChinese(subject, body) {
  const title = repairMojibake(String(subject || '').trim());
  const value = repairMojibake(String(body || '').trim());
  if (!title && !value) return { subject: '', text: '', status: 'empty' };
  if (!geminiApiKey) return { subject: title, text: value, status: 'translation_not_configured' };
  try {
    const translatedSubject = await translateChunk(title, '标题');
    // Translate in bounded chunks so long threads are never silently truncated.
    const chunks = [];
    for (let offset = 0; offset < value.length; offset += 3000) chunks.push(value.slice(offset, offset + 3000));
    const translatedChunks = [];
    for (const chunk of chunks) translatedChunks.push(await translateChunk(chunk, '正文'));
    return {
      subject: translatedSubject || title,
      text: translatedChunks.join('\n\n') || value,
      status: translatedChunks.length && translatedChunks.every(Boolean) ? 'translated_to_chinese' : 'translation_partial'
    };
  } catch (error) {
    return { subject: title, text: value, status: `translation_error_${error.message || 'unknown'}` };
  }
}

function brandFor(content) {
  const value = repairMojibake(String(content || '')).toLowerCase();
  if (/dartsnut|dartnut|electronic dart|dartboard|\bdarts\b|飞镖/.test(value)) return 'Dartsnut';
  if (/chessnut|chess board|chessboard|stockfish|chess\.com|国际象棋|棋盘/.test(value)) return 'Chessnut';
  return '待识别';
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
  const boundaryMatch = type.match(/boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (boundary) {
    const parts = body.split(`--${boundary}`).filter(part => part && !/^--\s*$/.test(part.trim())).map(part => {
      const partSeparator = part.indexOf('\n\n');
      const partHeaders = parseMimeHeaders(partSeparator >= 0 ? part.slice(0, partSeparator) : part);
      const partType = String(partHeaders['content-type'] || '').toLowerCase();
      // Ignore binary attachments and inline images; they are not email prose.
      if (!partType.startsWith('text/plain') && !partType.startsWith('text/html') && !partType.startsWith('message/')) return null;
      return { type: partType, text: extractMimeText(part) };
    }).filter(part => part?.text);
    // multipart/alternative contains the same message twice; prefer plain text.
    return parts.find(part => part.type.startsWith('text/plain'))?.text
      || parts.find(part => part.type.startsWith('text/html'))?.text
      || parts.map(part => part.text).join('\n');
  }
  if (type.includes('message/rfc822')) return extractMimeText(body);
  return decodeMimeBody(body, headers['content-transfer-encoding'], headers['content-type']?.match(/charset\s*=\s*["']?([^;"']+)/i)?.[1] || 'utf-8');
}

function headerValue(raw, name) {
  const headers = parseMimeHeaders(String(raw || '').split(/\r?\n\r?\n/)[0]);
  return headers[name.toLowerCase()] || '';
}

function isAutomated(address, subject) {
  const email = String(address || '').toLowerCase();
  const title = String(subject || '').toLowerCase();
  const domain = email.split('@')[1] || '';
  return automatedPrefixes.some(prefix => email.startsWith(prefix)) ||
    blockedSenderDomains.some(value => domain === value || domain.endsWith(`.${value}`)) ||
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
  const nonCreator = nonCreatorTerms.some(term => value.includes(term.toLowerCase()));
  const creatorContext = /\b(creator|influencer|tiktok|instagram|youtube|reel|shorts|followers|audience|media kit|rate card)\b/i.test(value);
  const replyMarker = /(?:^|\s)(?:re|回复|答复|fwd|转发)\s*:/i.test(String(subject || ''));
  if (nonCreator && !creatorContext) return false;
  return hasTerms || (forwarded && (replyMarker || value.length > 20)) || replyMarker;
}

function progressFor(intent, replied) {
  if (replied) return '已回复，等待红人下一步';
  if (intent >= 85) return '高意向，待跟进';
  if (intent >= 60) return '新邮件，待判断';
  return '新邮件，待人工确认';
}

function normalizeSubject(subject) {
  return decodeMimeHeader(String(subject || ''))
    .replace(/^\s*((re|fw|fwd|回复|答复|转发)\s*[:：]\s*)+/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function messageIdentifiers(message, rawSource) {
  const envelope = message.envelope || {};
  const messageId = envelope.messageId || headerValue(rawSource, 'message-id');
  const inReplyTo = envelope.inReplyTo || headerValue(rawSource, 'in-reply-to');
  const refs = Array.isArray(envelope.references)
    ? envelope.references
    : String(headerValue(rawSource, 'references') || '').split(/\s+/).filter(Boolean);
  return { messageId: String(messageId || '').trim(), inReplyTo: String(inReplyTo || '').trim(), references: refs.map(value => String(value).trim()).filter(Boolean) };
}

function stableId(mailbox, message, rawSource, ids) {
  const sourceKey = ids.messageId || `${mailbox}:${message.uid || ''}:${message.internalDate || ''}`;
  return crypto.createHash('sha1').update(sourceKey || rawSource).digest('hex').slice(0, 20);
}

function save(data) {
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

if (!password || !user) {
  save({ scannedAt: new Date().toISOString(), status: 'missing_secret', replyCount: 0, newEmailCount: 0, repliedCount: 0, highIntentCount: 0, quoteTotal: 0, messages: [], message: '请在 GitHub Actions Secrets 填写邮箱账号和安全码。' });
  process.exit(0);
}

const client = new ImapFlow({
  host: process.env.MAIL_IMAP_HOST || 'imap.qiye.aliyun.com',
  port: Number(process.env.MAIL_IMAP_PORT || 993),
  secure: true,
  auth: { user, pass: password },
  logger: false
});

async function listMailboxes() {
  const listed = await client.list();
  return Array.isArray(listed) ? listed : [];
}

function mailboxPath(mailbox) {
  return String(mailbox?.path || mailbox?.name || '');
}

function isInbox(pathname) {
  return pathname.toLowerCase() === 'inbox' || pathname.toLowerCase().endsWith('/inbox');
}

function isSent(pathname) {
  const value = pathname.toLowerCase();
  return /(?:sent|已发送|发件|outbox|geschickt|gesendet)/i.test(value) && !isInbox(value);
}

function hasFlag(mailbox, flag) {
  return [...(mailbox?.flags || [])].some(value => String(value).toLowerCase() === flag.toLowerCase());
}

async function readMailbox(pathname, callback) {
  let lock;
  try {
    lock = await client.getMailboxLock(pathname);
    for await (const message of client.fetch('1:*', { envelope: true, source: true, internalDate: true })) {
      await callback(message, pathname);
    }
  } finally {
    lock?.release();
  }
}

try {
  await client.connect();
  const mailboxes = await listMailboxes();
  const inboxes = mailboxes.filter(mailbox => isInbox(mailboxPath(mailbox)) || hasFlag(mailbox, '\\inbox')).map(mailboxPath);
  const configuredSent = String(process.env.MAIL_IMAP_SENT_FOLDER || '').trim();
  const sentFolders = configuredSent
    ? [configuredSent]
    : mailboxes.filter(mailbox => isSent(mailboxPath(mailbox)) || hasFlag(mailbox, '\\sent')).map(mailboxPath);
  if (!inboxes.length) inboxes.push('INBOX');

  const sentReferenceIds = new Set();
  const repliedThreads = new Map();
  let scannedSentCount = 0;
  for (const folder of sentFolders) {
    await readMailbox(folder, async (message) => {
      scannedSentCount += 1;
      const rawSource = message.source?.toString('utf8') || '';
      const ids = messageIdentifiers(message, rawSource);
      const subject = message.envelope?.subject || headerValue(rawSource, 'subject');
      const thread = normalizeSubject(subject);
      const date = new Date(message.internalDate || message.envelope?.date || 0);
      if (ids.inReplyTo) sentReferenceIds.add(ids.inReplyTo);
      ids.references.forEach(value => sentReferenceIds.add(value));
      if (thread) {
        const previous = repliedThreads.get(thread);
        if (!previous || date > previous) repliedThreads.set(thread, date);
      }
    });
  }

  const results = [];
  const otherMessages = [];
  let scannedInboxCount = 0;
  let ignoredMessageCount = 0;
  const seenIds = new Set();
  for (const folder of inboxes) {
    await readMailbox(folder, async (message) => {
      scannedInboxCount += 1;
      const rawSource = message.source?.toString('utf8') || '';
      const source = cleanContent(extractMimeText(rawSource));
      const subject = message.envelope?.subject || headerValue(rawSource, 'subject');
      const combined = `${subject} ${source}`;
      const sender = message.envelope?.from?.[0] || addressInfo(headerValue(rawSource, 'from')) || {};
      const receivedAt = new Date(message.internalDate || message.envelope?.date || 0);
      const original = isInternalAddress(sender.address)
        ? (originalSenderInfo(rawSource) || originalSenderInfo(source))
        : null;
      // Never treat an arbitrary address found in the body as the sender. In
      // forwarded Aliyun mail, only an explicit original From/Reply-To header
      // is authoritative; body addresses can be signatures or quoted content.
      const externalSender = original?.address || (!isInternalAddress(sender.address) ? sender.address : '');
      const effectiveSender = externalSender || sender.address;
      const forwarded = Boolean(original);
      const ids = messageIdentifiers(message, rawSource);
      const id = stableId(folder, message, rawSource, ids);
      if (seenIds.has(id)) return;
      seenIds.add(id);
      const automated = isAutomated(effectiveSender, subject);
      const internalOnly = isInternalAddress(sender.address) && !externalSender;
      const creatorLike = isLikelyCreatorReply(combined, effectiveSender, subject, forwarded);
      if (!effectiveSender || automated || internalOnly || !creatorLike) {
        ignoredMessageCount += 1;
        const reason = automated
          ? '通知/营销/自动邮件'
          : internalOnly
            ? '公司内部邮件'
            : '普通邮件/未识别为合作';
        otherMessages.push({
          id,
          name: original?.name || sender.name || effectiveSender || '未知发件人',
          email: effectiveSender || sender.address || '',
          subject: repairMojibake(decodeMimeHeader(subject)),
          body: bodyText(extractMimeText(rawSource)),
          reason,
          receivedAt: receivedAt.toISOString()
        });
        return;
      }
      const thread = normalizeSubject(subject);
      const outgoingAt = thread ? repliedThreads.get(thread) : null;
      const repliedByHeader = Boolean(ids.messageId && sentReferenceIds.has(ids.messageId));
      const replied = repliedByHeader || Boolean(outgoingAt && outgoingAt >= receivedAt);
      const intentResult = scoreIntent(combined);
      const intent = intentResult.score;
      const originalBody = bodyText(extractMimeText(rawSource));
      const cached = (previousDigest?.messages || []).find(item => item.id === id && item.body === originalBody && item.translationStatus === 'translated_to_chinese');
      let translatedBody;
      if (cached) {
        translatedBody = { subject: cached.subject, text: cached.bodyChinese || '', status: 'translated_to_chinese' };
      } else if (geminiApiKey && translationsRemaining > 0) {
        translationsRemaining -= 1;
        try {
          translatedBody = await translateEmailToChinese(subject, originalBody);
        } catch (error) {
          translatedBody = { subject, text: originalBody, status: `translation_deferred_${error.message || 'error'}` };
        }
      } else {
        translatedBody = { subject, text: originalBody, status: geminiApiKey ? 'translation_deferred' : 'translation_not_configured' };
      }
      const brand = brandFor(`${subject} ${originalBody}`);
      results.push({
        id,
        threadId: thread || ids.messageId || id,
        name: original?.name || sender.name || effectiveSender || '未知发件人',
        email: effectiveSender || '',
        subject: translatedBody.status === 'translated_to_chinese'
          ? (translatedBody.subject || repairMojibake(decodeMimeHeader(subject)))
          : repairMojibake(decodeMimeHeader(subject)),
        summary: summarize(extractMimeText(rawSource), subject),
        body: originalBody,
        bodyChinese: translatedBody.status === 'translated_to_chinese' ? translatedBody.text : '',
        summaryChinese: translatedBody.status === 'translated_to_chinese' ? summarize(translatedBody.text, translatedBody.subject || subject) : '',
        translationStatus: translatedBody.status,
        brand,
        intent,
        intentLevel: intentResult.level,
        intentReasons: intentResult.reasons,
        quote: extractQuote(combined),
        progress: progressFor(intent, replied),
        replyStatus: replied ? '已回复' : '新邮件',
        lastOutgoingAt: outgoingAt?.toISOString() || null,
        replyUrl: '',
        action: replied ? '等待红人继续回复；必要时查看线程' : (intent >= 85 ? '今天回复并确认档期、报价和下一步' : '阅读摘要并补充红人资料'),
        receivedAt: receivedAt.toISOString(),
        lastIncomingAt: receivedAt.toISOString()
      });
    });
  }

  // A long email thread produces one IMAP message per reply. The dashboard is
  // an action queue, so keep only the latest incoming message per sender/thread
  // while retaining how many messages were folded into that row.
  results.sort((a, b) => new Date(b.receivedAt) - new Date(a.receivedAt));
  const latestByThread = new Map();
  for (const item of results) {
    const key = `${String(item.email || '').toLowerCase()}|${item.threadId || item.id}`;
    const existing = latestByThread.get(key);
    if (existing) {
      existing.threadMessageCount = (existing.threadMessageCount || 1) + 1;
      existing.firstIncomingAt = item.receivedAt;
    } else {
      item.threadMessageCount = 1;
      item.firstIncomingAt = item.receivedAt;
      latestByThread.set(key, item);
    }
  }
  const collapsedResults = [...latestByThread.values()];
  const newMessages = collapsedResults.filter(item => item.replyStatus === '新邮件');
  const repliedMessages = collapsedResults.filter(item => item.replyStatus === '已回复');
    save({
    scannedAt: new Date().toISOString(),
    status: 'success',
    scanMode: 'cumulative',
    scannedMessageCount: scannedInboxCount + scannedSentCount,
    scannedInboxCount,
    scannedSentCount,
    ignoredMessageCount,
     replyCount: collapsedResults.length,
    newEmailCount: newMessages.length,
    repliedCount: repliedMessages.length,
     highIntentCount: collapsedResults.filter(item => item.intent >= 80).length,
     quoteTotal: collapsedResults.reduce((sum, item) => sum + item.quote, 0),
     messages: collapsedResults,
     otherMessages,
     collapsedThreadCount: results.length - collapsedResults.length,
     message: `累计扫描收件箱 ${scannedInboxCount} 封、已发送 ${scannedSentCount} 封，保留 ${collapsedResults.length} 个合作线程；其中新邮件 ${newMessages.length} 个，已回复 ${repliedMessages.length} 个`,
    translationSummary: {
       translated: collapsedResults.filter(item => item.translationStatus === 'translated_to_chinese').length,
       pending: collapsedResults.filter(item => item.translationStatus !== 'translated_to_chinese').length,
      attemptedThisRun: Number(process.env.MAX_TRANSLATIONS_PER_RUN || 3) - translationsRemaining
    }
  });
  console.info(`[scan] mode=cumulative inbox=${scannedInboxCount} sent=${scannedSentCount} selected=${collapsedResults.length} collapsed=${results.length - collapsedResults.length} new=${newMessages.length} replied=${repliedMessages.length} ignored=${ignoredMessageCount}`);
  for (const item of collapsedResults) console.info(`[selected] ${item.email} | ${item.subject} | status=${item.replyStatus} | intent=${item.intent} | quote=${item.quote}`);
} catch (error) {
  const diagnostic = String(error?.message || error).slice(0, 1200);
  // Preserve a prior real digest when Aliyun closes IMAP after data was read.
  if (previousDigest?.messages?.length && Number(previousDigest.scannedMessageCount || 0) > 0) {
    save({ ...previousDigest, status: 'success', scanWarning: diagnostic });
  } else {
    save({
      scannedAt: new Date().toISOString(),
      status: 'error',
      replyCount: 0,
      newEmailCount: 0,
      repliedCount: 0,
      highIntentCount: 0,
      quoteTotal: 0,
      messages: [],
      message: '邮箱扫描失败，请检查账号、安全码或邮箱文件夹权限。',
      error: diagnostic
    });
  }
  console.error(error?.stack || error?.message || error);
  process.exitCode = 1;
} finally {
  try { await client.logout(); } catch { /* Ignore disconnect errors. */ }
}
