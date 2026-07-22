(() => {
  fetch('./data/digest.json?ts=' + Date.now(), { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(digest => {
      if (!digest) return;
      const values = document.querySelectorAll('#page-home .metric-value');
      if (values[0]) values[0].textContent = digest.replyCount ?? 0;
      if (values[1]) values[1].textContent = digest.highIntentCount ?? 0;
      const syncDetail = document.querySelector('.sync-detail');
      if (syncDetail && digest.scannedAt) {
        const stamp = new Date(digest.scannedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
        syncDetail.innerHTML = `邮箱扫描：${stamp}<br>${digest.message || '日报数据已更新'}`;
      }
    })
    .catch(() => {});
})();
