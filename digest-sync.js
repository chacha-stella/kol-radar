(() => {
  const apiBase = window.KOL_API_BASE || '';
  const replyTokenKey = 'kolReplyToken';
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => Number(value || 0) ? '¥' + Number(value).toLocaleString('zh-CN') : '暂无';
  const dateLabel = value => value ? new Date(value).toLocaleDateString('zh-CN') : '暂无';
  const storageKey = 'kolClosedEmails';
  let digest = null;
  let showClosed = false;
  let replyItem = null;
  let closedIds = new Set();
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) || '[]');
    closedIds = new Set(Array.isArray(saved) ? saved.map(String) : []);
  } catch { /* Ignore malformed browser storage. */ }

  function saveClosed() {
    localStorage.setItem(storageKey, JSON.stringify([...closedIds]));
  }

  function visibleMessages() {
    const messages = Array.isArray(digest?.messages) ? digest.messages : [];
    return messages
      .filter(item => showClosed || !closedIds.has(String(item.id)))
      .sort((a, b) => (a.replyStatus === '新邮件' ? -1 : 1) - (b.replyStatus === '新邮件' ? -1 : 1) || new Date(b.receivedAt) - new Date(a.receivedAt));
  }

  function renderMessages() {
    const rows = document.querySelector('#replyRows');
    if (!rows) return;
    const messages = visibleMessages();
    rows.innerHTML = messages.length ? messages.map(item => {
      const isNew = item.replyStatus !== '已回复';
      const status = item.replyStatus || (isNew ? '新邮件' : '已回复');
      return `<tr class="${closedIds.has(String(item.id)) ? 'is-closed' : ''}">
        <td><div class="person"><span class="avatar">${safe((item.name || item.email || '邮件').slice(0, 2))}</span><div><div class="person-name">${safe(item.name || '未知红人')}</div><div class="person-email">${safe(item.email || '')}</div></div></div></td>
        <td><button class="btn btn-quiet mail-subject" type="button" data-email-view="${safe(item.id)}" title="点击查看全文">${safe(item.subject || '无标题')}</button><div class="mail-summary" title="${safe(item.summaryChinese || item.summary || '')}">${safe(item.summaryChinese || item.summary || '暂无摘要')}</div></td>
        <td><span class="badge ${item.brand === 'Dartsnut' ? 'badge-purple' : 'badge-blue'}">${safe(item.brand || '待识别')}</span></td>
        <td><div class="score"><span>${safe(item.intent ?? 0)}</span><span class="score-track"><span class="score-fill" style="width:${Math.min(100, Math.max(0, Number(item.intent || 0)))}%"></span></span></div></td>
        <td class="nowrap">${safe(dateLabel(item.lastIncomingAt || item.receivedAt))}</td>
        <td><span class="badge ${isNew ? 'badge-orange' : 'badge-green'}">${safe(status)}</span></td>
        <td><div class="nowrap">${money(item.quote)}</div><div class="muted" style="margin-top:4px;font-size:11px">${safe(item.progress || '待跟进')}</div><div class="muted" style="margin-top:4px;font-size:10px">${safe(item.intentLevel || '')}</div></td>
        <td><div class="mail-actions"><button class="btn btn-primary" type="button" data-email-reply="${safe(item.id)}">回复</button><button class="btn btn-quiet" type="button" data-email-action="${closedIds.has(String(item.id)) ? 'reopen' : 'close'}" data-email-id="${safe(item.id)}">${closedIds.has(String(item.id)) ? '恢复' : '关闭'}</button></div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">${showClosed ? '暂无已关闭邮件' : '暂无未关闭的真实合作邮件'}</div></td></tr>`;
    rows.querySelectorAll('[data-email-action]').forEach(button => button.addEventListener('click', () => {
      const id = String(button.dataset.emailId || '');
      if (button.dataset.emailAction === 'close') closedIds.add(id); else closedIds.delete(id);
      saveClosed();
      renderMessages();
    }));
    rows.querySelectorAll('[data-email-view]').forEach(button => button.addEventListener('click', () => {
      const item = (digest?.messages || []).find(value => String(value.id) === String(button.dataset.emailView));
      if (!item) return;
      const reasons = Array.isArray(item.intentReasons) ? item.intentReasons : [];
      const body = document.querySelector('#emailDetailBody');
      const title = document.querySelector('#emailModalTitle');
      if (title) title.textContent = item.subject || '邮件内容';
      if (body) {
        const original = item.body || item.summary || '暂无可解析正文';
        const chinese = item.bodyChinese || '';
        const primary = chinese || original;
        const translationNote = chinese
          ? '已转换为中文'
          : item.translationStatus === 'translation_not_configured'
            ? '未配置翻译密钥，暂显示原文'
            : '中文转换失败，暂显示原文';
        body.innerHTML = `<div class="muted">${safe(item.name || item.email || '')} · ${safe(item.email || '')}</div><div class="intent-reasons"><span class="badge ${Number(item.intent || 0) >= 80 ? 'badge-green' : Number(item.intent || 0) >= 60 ? 'badge-orange' : 'badge-red'}">意向度 ${safe(item.intent ?? 0)} · ${safe(item.intentLevel || '待确认')}</span><span class="tag">品牌：${safe(item.brand || '待识别')}</span>${reasons.map(reason => `<span class="tag">${safe(reason)}</span>`).join('')}</div><div class="muted" style="margin-bottom:8px">${safe(translationNote)}</div><div class="mail-detail" id="emailPrimaryBody">${safe(primary)}</div><div class="muted" style="margin-top:10px">原始邮件保存在系统中；上方显示完整中文内容。</div>`;
      }
      document.querySelector('#emailModal')?.classList.add('is-open');
    }));
    rows.querySelectorAll('[data-email-reply]').forEach(button => button.addEventListener('click', () => {
      replyItem = (digest?.messages || []).find(value => String(value.id) === String(button.dataset.emailReply));
      if (!replyItem) return;
      document.querySelector('#replyRecipient').textContent = `${replyItem.email || ''} · ${replyItem.subject || ''}`;
      document.querySelector('#replyBody').value = '';
      document.querySelector('#replyModal')?.classList.add('is-open');
    }));
    const toggle = document.querySelector('#toggleClosedEmails');
    if (toggle) toggle.textContent = showClosed ? '隐藏已关闭' : `显示已关闭${closedIds.size ? ` (${closedIds.size})` : ''}`;
    renderActions();
  }

  function renderActions() {
    const actions = document.querySelector('#page-home .action-list');
    if (!actions) return;
    const messages = visibleMessages().filter(item => item.replyStatus !== '已回复');
    actions.innerHTML = messages.length
      ? messages.slice(0, 3).map((item, index) => `<li class="action-item"><span class="action-index">${index + 1}</span><div><div class="action-title">${safe(item.action || '跟进红人')}</div><div class="action-detail">${safe(item.name || item.email || '未知红人')} · 意向度 ${Number(item.intent || 0)} · ${safe(item.progress || '新邮件')}</div></div></li>`).join('')
      : '<li class="action-item"><span class="action-index">1</span><div><div class="action-title">暂无未回复的真实合作邮件</div><div class="action-detail">收到新的外部合作来信后，这里会显示需要优先处理的动作。</div></div></li>';
  }

  fetch('./data/digest.json?ts=' + Date.now(), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(value => {
      digest = value;
      if (!digest) return;
      const values = document.querySelectorAll('#page-home .metric-value');
      if (values[0]) values[0].textContent = digest.newEmailCount ?? digest.replyCount ?? 0;
      if (values[1]) values[1].textContent = digest.highIntentCount ?? 0;
      const report = document.querySelector('#digestSummary');
      if (report) report.textContent = digest.status === 'success'
        ? `累计扫描收件箱 ${digest.scannedInboxCount || 0} 封、已发送 ${digest.scannedSentCount || 0} 封，保留 ${digest.replyCount || 0} 封合作相关邮件；新邮件 ${digest.newEmailCount || 0} 封，已回复 ${digest.repliedCount || 0} 封。`
        : (digest.message || '暂无真实邮箱扫描结果');
      const footers = document.querySelectorAll('#page-home .metric-foot');
      if (footers[0]) footers[0].textContent = digest.status === 'success' ? '累计邮件中未关闭的新邮件' : '等待邮箱扫描';
      if (footers[1]) footers[1].textContent = digest.status === 'success' ? '按邮件内容评估' : '等待邮箱扫描';
      const syncDetail = document.querySelector('.sync-detail');
      if (syncDetail && digest.scannedAt) {
        const stamp = new Date(digest.scannedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        syncDetail.innerHTML = `邮箱累计扫描：${safe(stamp)}<br>${safe(digest.message || '日报数据已更新')}`;
      }
      renderMessages();
    })
    .catch(() => {});

  document.querySelector('#toggleClosedEmails')?.addEventListener('click', () => {
    showClosed = !showClosed;
    renderMessages();
  });
  document.querySelector('#sendReplyButton')?.addEventListener('click', async () => {
    if (!replyItem) return;
    if (!apiBase) {
      alert('尚未配置 Railway 邮件服务地址。请先点击“打开阿里云企业邮箱”，或在网页配置 KOL_API_BASE。');
      return;
    }
    const body = document.querySelector('#replyBody').value.trim();
    if (!body) return;
    const button = document.querySelector('#sendReplyButton');
    button.disabled = true;
    try {
      const token = localStorage.getItem(replyTokenKey) || prompt('请输入 Railway 中设置的 KOL_REPLY_TOKEN：');
      if (!token) throw new Error('未提供回复令牌');
      localStorage.setItem(replyTokenKey, token);
      const response = await fetch(`${apiBase}/api/reply`, { method: 'POST', headers: {'content-type': 'application/json', 'x-kol-reply-token': token}, body: JSON.stringify({to: replyItem.email, subject: replyItem.subject, body}) });
      const result = await response.json();
      if (!response.ok || result.status !== 'sent') throw new Error(result.message || '发送失败');
      document.querySelector('#replyModal')?.classList.remove('is-open');
      alert('已通过阿里云企业邮箱发送');
    } catch (error) {
      alert(`发送失败：${error.message}`);
    } finally { button.disabled = false; }
  });
})();
