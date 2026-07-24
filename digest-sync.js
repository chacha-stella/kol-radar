(() => {
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => Number(value || 0) ? '¥' + Number(value).toLocaleString('zh-CN') : '暂无';
  const dateLabel = value => value ? new Date(value).toLocaleDateString('zh-CN') : '暂无';
  const storageKey = 'kolClosedEmails';
  let digest = null;
  let showClosed = false;
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
      const replyUrl = item.replyUrl || `mailto:${item.email || ''}?subject=${encodeURIComponent(`Re: ${item.subject || ''}`)}`;
      return `<tr class="${closedIds.has(String(item.id)) ? 'is-closed' : ''}">
        <td><div class="person"><span class="avatar">${safe((item.name || item.email || '邮件').slice(0, 2))}</span><div><div class="person-name">${safe(item.name || '未知红人')}</div><div class="person-email">${safe(item.email || '')}</div></div></div></td>
        <td><div class="mail-subject" title="${safe(item.subject || '')}">${safe(item.subject || '无标题')}</div><div class="mail-summary" title="${safe(item.summary || '')}">${safe(item.summary || '暂无摘要')}</div></td>
        <td>${safe(item.platform || '待识别')}</td>
        <td><div class="score"><span>${safe(item.intent ?? 0)}</span><span class="score-track"><span class="score-fill" style="width:${Math.min(100, Math.max(0, Number(item.intent || 0)))}%"></span></span></div></td>
        <td class="nowrap">${safe(dateLabel(item.lastIncomingAt || item.receivedAt))}</td>
        <td><span class="badge ${isNew ? 'badge-orange' : 'badge-green'}">${safe(status)}</span></td>
        <td><div class="nowrap">${money(item.quote)}</div><div class="muted" style="margin-top:4px;font-size:11px">${safe(item.progress || '待跟进')}</div></td>
        <td><div class="mail-actions"><a class="btn btn-primary" href="${safe(replyUrl)}">回复</a><button class="btn btn-quiet" type="button" data-email-action="${closedIds.has(String(item.id)) ? 'reopen' : 'close'}" data-email-id="${safe(item.id)}">${closedIds.has(String(item.id)) ? '恢复' : '关闭'}</button></div></td>
      </tr>`;
    }).join('') : `<tr><td colspan="8"><div class="empty">${showClosed ? '暂无已关闭邮件' : '暂无未关闭的真实合作邮件'}</div></td></tr>`;
    rows.querySelectorAll('[data-email-action]').forEach(button => button.addEventListener('click', () => {
      const id = String(button.dataset.emailId || '');
      if (button.dataset.emailAction === 'close') closedIds.add(id); else closedIds.delete(id);
      saveClosed();
      renderMessages();
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
})();
