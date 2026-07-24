(() => {
  const safe = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const money = value => Number(value || 0) ? '¥' + Number(value).toLocaleString('zh-CN') : '暂无';
  fetch('./data/digest.json?ts=' + Date.now(), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(digest => {
      if (!digest) return;
      const values = document.querySelectorAll('#page-home .metric-value');
      if (values[0]) values[0].textContent = digest.replyCount ?? 0;
      if (values[1]) values[1].textContent = digest.highIntentCount ?? 0;
      const report = document.querySelector('#digestSummary');
      if (report) {
        report.textContent = digest.status === 'success'
          ? `过去 24 小时扫描 ${digest.scannedMessageCount || 0} 封邮件，筛选出 ${digest.replyCount || 0} 封疑似合作回复，识别出 ${digest.highIntentCount || 0} 位高意向红人，报价合计 ${money(digest.quoteTotal)}。`
          : (digest.message || '暂无真实邮箱扫描结果');
      }
      const footers = document.querySelectorAll('#page-home .metric-foot');
      if (footers[0]) footers[0].textContent = digest.status === 'success' ? '过去 24 小时真实邮件' : '等待邮箱扫描';
      if (footers[1]) footers[1].textContent = digest.status === 'success' ? '按邮件关键词评估' : '等待邮箱扫描';
      const syncDetail = document.querySelector('.sync-detail');
      if (syncDetail && digest.scannedAt) {
        const stamp = new Date(digest.scannedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        syncDetail.innerHTML = `邮箱扫描：${stamp}<br>${digest.message || '日报数据已更新'}`;
      }
      const rows = document.querySelector('#replyRows');
      const messages = Array.isArray(digest.messages) ? digest.messages : [];
      if (rows) rows.innerHTML = messages.length ? messages.map(item => `<tr><td><div class="person"><span class="avatar">${safe((item.name || item.email || '邮件').slice(0, 2))}</span><div><div class="person-name">${safe(item.name || '未知红人')}</div><div class="person-email">${safe(item.email || '')}</div></div></div></td><td>${safe(item.platform || '待识别')}</td><td>${safe(item.intent ?? 0)}</td><td class="nowrap">${safe(item.receivedAt ? new Date(item.receivedAt).toLocaleDateString('zh-CN') : '暂无')}</td><td class="nowrap">${money(item.quote)}</td><td><span class="badge ${Number(item.intent || 0) >= 80 ? 'badge-green' : 'badge-orange'}">${safe(item.progress || '待跟进')}</span></td><td>${safe(item.action || '查看邮件')}</td></tr>`).join('') : '<tr><td colspan="7"><div class="empty">暂无可展示的真实邮件明细</div></td></tr>';
      const actions = document.querySelector('#page-home .action-list');
      if (actions) {
        const actionItems = messages.length
          ? messages.slice(0, 3).map((item, index) => `<li class="action-item"><span class="action-index">${index + 1}</span><div><div class="action-title">${safe(item.action || '跟进红人')}</div><div class="action-detail">${safe(item.name || item.email || '未知红人')} · 意向度 ${Number(item.intent || 0)} · ${safe(item.progress || '待跟进')}</div></div></li>`)
          : [`<li class="action-item"><span class="action-index">1</span><div><div class="action-title">暂无需要跟进的真实回复</div><div class="action-detail">本次扫描未筛选出外部红人合作邮件；收到新回复后会自动更新。</div></div></li>`];
        actions.innerHTML = actionItems.join('');
      }
    })
    .catch(() => {});
})();
