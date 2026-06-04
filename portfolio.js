// Portfolio Tracker
let portfolio = { snapshots: [], items: {}, icons: {} };
let currentSort = { key: 'price', asc: false };
let selectedRange = 90;

async function loadData() {
  const data = await chrome.storage.local.get(['rw_portfolio', 'rw_settings']);
  portfolio = data.rw_portfolio || { snapshots: [], items: {} };
  const settings = data.rw_settings || {};
  const cur = settings.pricingMode === 'skinport' ? (settings.spCurrency || 'USD') : (settings.currency || 'USD');
  const syms = { USD:'$',EUR:'€',GBP:'£',CNY:'¥',CAD:'C$',AUD:'A$',CHF:'Fr',SEK:'kr',PLN:'zł',BRL:'R$',TRY:'₺' };
  window.SYM = syms[cur] || '$';

  // Currency mismatch guard: snapshots are stored in the currency active when
  // recorded. Historical values can't be accurately reconverted (each snapshot
  // would need its own date's FX rate), so warn rather than silently mislabel.
  const cwarn = document.getElementById('currency-warning');
  if (cwarn) {
    if (portfolio.dataCurrency && portfolio.dataCurrency !== cur && portfolio.snapshots.length > 0) {
      cwarn.style.display = 'block';
      cwarn.innerHTML = `⚠️ <strong>Currency mismatch.</strong> Your portfolio history was recorded in <strong>${portfolio.dataCurrency}</strong>, but you're now viewing prices in <strong>${cur}</strong>. Historical values are shown with the ${cur} symbol but were not converted — switch back to ${portfolio.dataCurrency} mode for accurate numbers.`;
    } else {
      cwarn.style.display = 'none';
    }
  }

  if (portfolio.snapshots.length === 0) {
    document.getElementById('empty').style.display = 'block';
    document.getElementById('portfolio-content').style.display = 'none';
    return;
  }
  document.getElementById('empty').style.display = 'none';
  document.getElementById('portfolio-content').style.display = 'block';

  renderStats();
  renderChart(90);
  renderItems();
}

function fmt(cents) {
  if (!cents) return '—';
  return window.SYM + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function renderStats() {
  const snaps = portfolio.snapshots;
  const latest = snaps[snaps.length - 1];
  document.getElementById('s-total').textContent = fmt(latest.total);
  document.getElementById('s-items').textContent = latest.count || '—';

  function setChange(elId, prev) {
    if (!prev) return;
    const diff = latest.total - prev.total;
    const pct = ((diff / prev.total) * 100).toFixed(1);
    const el = document.getElementById(elId);
    el.innerHTML = `${diff >= 0 ? '+' : ''}${fmt(diff)}<div style="font-size:10px;color:${diff >= 0 ? '#4ade80' : '#ef4444'};margin-top:1px">${diff >= 0 ? '+' : ''}${pct}%</div>`;
    el.className = `stat-value ${diff >= 0 ? 'green' : 'red'}`;
  }

  // 24h
  setChange('s-change-24h', snaps.length >= 2 ? snaps[snaps.length - 2] : null);
  // 7d
  setChange('s-change-7d', snaps.length > 1 ? (snaps.length >= 7 ? snaps[snaps.length - 7] : snaps[0]) : null);
  // 30d
  setChange('s-change-30d', snaps.length > 1 ? (snaps.length >= 30 ? snaps[snaps.length - 30] : snaps[0]) : null);
  // 90d
  setChange('s-change-90d', snaps.length > 1 ? (snaps.length >= 90 ? snaps[snaps.length - 90] : snaps[0]) : null);
  // All time
  setChange('s-change-all', snaps.length > 1 ? snaps[0] : null);
}

function renderChart(days) {
  const canvas = document.getElementById('chart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = 560;
  ctx.scale(2, 2);
  const w = canvas.offsetWidth, h = 280;
  ctx.clearRect(0, 0, w, h);

  let snaps = portfolio.snapshots;
  if (days > 0) snaps = snaps.slice(-days);
  if (snaps.length < 2) return;

  const prices = snaps.map(s => s.total);
  const min = Math.min(...prices) * 0.95;
  const max = Math.max(...prices) * 1.05;
  const range = max - min || 1;
  const pad = 10;

  const getX = i => (i / (snaps.length - 1)) * (w - pad * 2) + pad;
  const getY = v => h - ((v - min) / range) * (h - pad * 2) - pad;

  // Grid
  ctx.strokeStyle = 'rgba(102,192,244,0.06)';
  ctx.lineWidth = 1;
  for (let i = 1; i < 5; i++) { const y = (h / 5) * i; ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

  // Gradient fill
  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, 'rgba(102,192,244,0.15)');
  grad.addColorStop(1, 'rgba(102,192,244,0)');
  ctx.fillStyle = grad;
  ctx.beginPath();
  ctx.moveTo(getX(0), h);
  snaps.forEach((s, i) => ctx.lineTo(getX(i), getY(s.total)));
  ctx.lineTo(getX(snaps.length - 1), h);
  ctx.fill();

  // Line
  ctx.strokeStyle = '#66c0f4';
  ctx.lineWidth = 2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  snaps.forEach((s, i) => i === 0 ? ctx.moveTo(getX(i), getY(s.total)) : ctx.lineTo(getX(i), getY(s.total)));
  ctx.stroke();

  // Labels
  ctx.fillStyle = '#4a5c6d';
  ctx.font = '10px "Exo 2"';
  ctx.textAlign = 'left';
  ctx.fillText(fmt(max), 4, 14);
  ctx.fillText(fmt(min), 4, h - 4);
  ctx.fillText(snaps[0].date, pad, h - 16);
  ctx.textAlign = 'right';
  ctx.fillText(snaps[snaps.length - 1].date, w - pad, h - 16);

  // Watermark
  ctx.save();
  ctx.translate(w / 2, h / 2);
  ctx.rotate(-20 * Math.PI / 180);
  ctx.font = '600 28px "Rajdhani", sans-serif';
  ctx.fillStyle = 'rgba(102,192,244,0.06)';
  ctx.textAlign = 'center';
  ctx.fillText('RIFTWALK · rftwlk.com', 0, 0);
  ctx.restore();

  // Store chart data for hover
  window._chartData = { snaps, w, h, pad, min, range, getX, getY };

  // Hover tooltip
  if (!canvas._hoverBound) {
    canvas._hoverBound = true;
    const tooltip = document.createElement('div');
    tooltip.style.cssText = 'position:fixed;background:#1a1f2e;border:1px solid rgba(102,192,244,.2);border-radius:6px;padding:6px 10px;font-size:11px;color:#c7d5e0;pointer-events:none;z-index:100;display:none;font-family:"Exo 2",sans-serif;white-space:nowrap';
    document.body.appendChild(tooltip);

    canvas.addEventListener('mousemove', e => {
      const cd = window._chartData;
      if (!cd || cd.snaps.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = mx / rect.width;
      const idx = Math.round(ratio * (cd.snaps.length - 1));
      if (idx < 0 || idx >= cd.snaps.length) { tooltip.style.display = 'none'; return; }
      const snap = cd.snaps[idx];
      const prev = idx > 0 ? cd.snaps[idx - 1] : null;
      const diff = prev ? snap.total - prev.total : 0;
      const diffStr = prev ? ` <span style="color:${diff >= 0 ? '#4ade80' : '#ef4444'}">${diff >= 0 ? '+' : ''}${fmt(diff)}</span>` : '';
      tooltip.innerHTML = `<div style="color:#66c0f4;font-weight:600">${fmt(snap.total)}</div><div style="color:#4a5c6d;font-size:9px;margin-top:2px">${snap.date} · ${snap.count || '?'} items${diffStr}</div>`;
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX + 12) + 'px';
      tooltip.style.top = (e.clientY - 40) + 'px';
    });

    canvas.addEventListener('mouseleave', () => { tooltip.style.display = 'none'; });
    canvas.style.cursor = 'default';
  }
}

function renderItems(filter = '') {
  const list = document.getElementById('items-list');
  const cutoffDate = selectedRange > 0 ? new Date(Date.now() - selectedRange * 86400000).toISOString().split('T')[0] : null;
  const icons = portfolio.icons || {};
  const details = portfolio.details || {};
  const latestSnapshotDate = portfolio.snapshots.length > 0 ? portfolio.snapshots[portfolio.snapshots.length - 1].date : null;

  const items = Object.entries(portfolio.items)
    .filter(([name, allEntries]) => {
      if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return false;
      // Only show items present in the most recent snapshot
      if (latestSnapshotDate && allEntries[allEntries.length - 1].date !== latestSnapshotDate) return false;
      return true;
    })
    .map(([name, allEntries]) => {
      // Filter entries by selected range for change/sparkline
      const entries = cutoffDate ? allEntries.filter(e => e.date >= cutoffDate) : allEntries;
      const latest = allEntries[allEntries.length - 1];
      const rangeStart = entries.length >= 2 ? entries[0] : null;
      const change = rangeStart ? latest.price - rangeStart.price : 0;
      const icon = icons[name] || '';
      const detail = details[name] || {};
      const ownedSince = allEntries[0]?.date || '—';
      const changePct = rangeStart && rangeStart.price > 0 ? ((change / rangeStart.price) * 100).toFixed(1) : '0.0';
      return { name, price: latest.price, prev: rangeStart?.price || latest.price, change, changePct, date: latest.date, entries, allEntries, qty: latest.qty || 1, icon, detail, ownedSince };
    });

  // Sort
  items.sort((a, b) => {
    let va, vb;
    switch (currentSort.key) {
      case 'name': va = a.name; vb = b.name; return currentSort.asc ? va.localeCompare(vb) : vb.localeCompare(va);
      case 'price': va = a.price; vb = b.price; break;
      case 'change': va = a.change; vb = b.change; break;
      case 'qty': va = a.qty; vb = b.qty; break;
      default: va = a.price; vb = b.price;
    }
    return currentSort.asc ? va - vb : vb - va;
  });

  list.innerHTML = items.map(item => `
    <div class="item-row" data-name="${item.name.replace(/"/g, '&quot;')}">
      <div style="width:32px;height:32px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.03)">${item.icon ? `<img src="${item.icon}" style="width:32px;height:32px;object-fit:contain" alt="">` : ''}</div>
      <div class="item-name">
        <div>${item.name}</div>
        <div style="font-size:9px;color:#3a4a5a;margin-top:1px">${item.detail.float ? `Float: ${item.detail.float.toFixed(10).replace(/0+$/, '')}` : ''}${item.detail.seed ? ` · #${item.detail.seed}` : ''}${item.detail.phase ? ` · ${item.detail.phase}` : ''}${item.ownedSince !== '—' ? ` · Owned since ${item.ownedSince}` : ''}</div>
      </div>
      <div class="item-price">${fmt(item.price)}</div>
      <div style="display:flex;align-items:center;justify-content:center"><canvas class="sparkline" data-item="${item.name.replace(/"/g, '&quot;')}" width="50" height="20" style="width:50px;height:20px"></canvas></div>
      <div class="item-change ${item.change > 0 ? 'green' : item.change < 0 ? 'red' : 'dim'}">${item.change !== 0 ? `${item.change > 0 ? '+' : ''}${fmt(item.change)}<div style="font-size:9px">${item.change > 0 ? '+' : ''}${item.changePct}%</div>` : '—'}</div>
      <div class="item-price" style="color:#6a7a8a">${fmt(item.prev)}</div>
      <div class="item-qty">${item.qty}</div>
    </div>
  `).join('');

  // Draw sparklines using filtered range
  list.querySelectorAll('.sparkline').forEach(canvas => {
    const name = canvas.dataset.item;
    const item = items.find(i => i.name === name);
    if (!item || item.entries.length < 2) return;
    const ctx = canvas.getContext('2d');
    const w = 50, h = 20;
    const prices = item.entries.map(e => e.price);
    const min = Math.min(...prices); const max = Math.max(...prices);
    const range = max - min || 1;
    const color = prices[prices.length - 1] >= prices[0] ? '#4ade80' : '#ef4444';
    ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.lineJoin = 'round';
    ctx.beginPath();
    prices.forEach((p, i) => {
      const x = (i / (prices.length - 1)) * w;
      const y = h - ((p - min) / range) * (h - 4) - 2;
      i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
    });
    ctx.stroke();
  });

  // Click handler for item detail
  list.querySelectorAll('.item-row').forEach(row => {
    row.onclick = () => showItemDetail(row.dataset.name);
  });
}

function showItemDetail(name, range) {
  const allEntries = portfolio.items[name];
  if (!allEntries || allEntries.length === 0) return;

  const modalRange = range !== undefined ? range : selectedRange;

  // Filter entries by selected time range
  const cutoffDate = modalRange > 0 ? new Date(Date.now() - modalRange * 86400000).toISOString().split('T')[0] : null;
  const entries = cutoffDate ? allEntries.filter(e => e.date >= cutoffDate) : allEntries;
  if (entries.length === 0) return;

  document.getElementById('modal-item-name').textContent = name;
  document.getElementById('modal').classList.add('active');

  // Update active tab
  document.querySelectorAll('.modal-tab').forEach(t => {
    t.classList.toggle('active', parseInt(t.dataset.range) === modalRange);
    t.onclick = () => showItemDetail(name, parseInt(t.dataset.range));
  });

  const icons = portfolio.icons || {};
  const details = portfolio.details || {};
  const detail = details[name] || {};
  const info = document.getElementById('modal-info');
  const latest = entries[entries.length - 1];
  const oldest = entries[0];
  const allTimeDiff = latest.price - oldest.price;
  const allTimePct = oldest.price > 0 ? ((allTimeDiff / oldest.price) * 100).toFixed(1) : '0.0';
  const rangeLabel = modalRange === 0 ? 'All time' : `${modalRange}D`;
  const iconHtml = icons[name] ? `<img src="${icons[name]}" style="width:80px;height:80px;object-fit:contain;border-radius:8px;background:rgba(255,255,255,.03);margin-right:12px;vertical-align:middle">` : '';
  const detailLine = [
    detail.float ? `Float: ${detail.float.toFixed(10).replace(/0+$/, '')}` : '',
    detail.seed ? `Seed: #${detail.seed}` : '',
    detail.phase ? detail.phase : '',
  ].filter(Boolean).join(' · ');
  info.innerHTML = `
    <div style="display:flex;align-items:center;margin-bottom:12px">
      ${iconHtml}
      <div>
        <div>Current: <span style="color:#66c0f4;font-weight:600">${fmt(latest.price)}</span></div>
        <div>${rangeLabel} start: <span style="color:#8a9aaa">${fmt(oldest.price)}</span> on ${oldest.date}</div>
        <div>${rangeLabel} change: <span class="${allTimeDiff >= 0 ? 'green' : 'red'}">${allTimeDiff >= 0 ? '+' : ''}${fmt(allTimeDiff)} (${allTimeDiff >= 0 ? '+' : ''}${allTimePct}%)</span></div>
        ${detailLine ? `<div style="color:#4a5c6d;font-size:10px;margin-top:4px">${detailLine}</div>` : ''}
        <div style="color:#3a4a5a;font-size:10px;margin-top:2px">Owned since ${allEntries[0]?.date || '—'}</div>
      </div>
    </div>
  `;

  // Draw item chart
  const canvas = document.getElementById('modal-chart');
  const ctx = canvas.getContext('2d');
  canvas.width = canvas.offsetWidth * 2;
  canvas.height = 400;
  ctx.scale(2, 2);
  const w = canvas.offsetWidth, h = 200;
  ctx.clearRect(0, 0, w, h);

  if (entries.length < 2) { ctx.fillStyle = '#3a4a5a'; ctx.font = '13px "Exo 2"'; ctx.textAlign = 'center'; ctx.fillText('Need more data points', w / 2, h / 2); return; }

  const prices = entries.map(e => e.price);
  const min = Math.min(...prices) * 0.95;
  const max = Math.max(...prices) * 1.05;
  const priceRange = max - min || 1;
  const pad = 10;
  const getX = i => (i / (entries.length - 1)) * (w - pad * 2) + pad;
  const getY = v => h - ((v - min) / priceRange) * (h - pad * 2) - pad;

  const color = latest.price >= oldest.price ? '#4ade80' : '#ef4444';

  const grad = ctx.createLinearGradient(0, 0, 0, h);
  grad.addColorStop(0, color === '#4ade80' ? 'rgba(74,222,128,0.12)' : 'rgba(239,68,68,0.12)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.moveTo(getX(0), h);
  entries.forEach((e, i) => ctx.lineTo(getX(i), getY(e.price)));
  ctx.lineTo(getX(entries.length - 1), h); ctx.fill();

  ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  entries.forEach((e, i) => i === 0 ? ctx.moveTo(getX(i), getY(e.price)) : ctx.lineTo(getX(i), getY(e.price)));
  ctx.stroke();

  ctx.fillStyle = '#4a5c6d'; ctx.font = '9px "Exo 2"';
  ctx.textAlign = 'left'; ctx.fillText(entries[0].date, pad, h - 4);
  ctx.textAlign = 'right'; ctx.fillText(entries[entries.length - 1].date, w - pad, h - 4);

  // Hover tooltip for item chart
  window._modalChartData = { entries, w, h, pad, min, range };
  if (!canvas._hoverBound) {
    canvas._hoverBound = true;
    const tip = document.createElement('div');
    tip.style.cssText = 'position:fixed;background:#1a1f2e;border:1px solid rgba(102,192,244,.2);border-radius:6px;padding:6px 10px;font-size:11px;color:#c7d5e0;pointer-events:none;z-index:1001;display:none;font-family:"Exo 2",sans-serif;white-space:nowrap';
    document.body.appendChild(tip);

    canvas.addEventListener('mousemove', e => {
      const cd = window._modalChartData;
      if (!cd || cd.entries.length < 2) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const ratio = mx / rect.width;
      const idx = Math.round(ratio * (cd.entries.length - 1));
      if (idx < 0 || idx >= cd.entries.length) { tip.style.display = 'none'; return; }
      const entry = cd.entries[idx];
      const prev = idx > 0 ? cd.entries[idx - 1] : null;
      const diff = prev ? entry.price - prev.price : 0;
      const diffStr = prev ? ` <span style="color:${diff >= 0 ? '#4ade80' : '#ef4444'}">${diff >= 0 ? '+' : ''}${fmt(diff)}</span>` : '';
      tip.innerHTML = `<div style="color:#66c0f4;font-weight:600">${fmt(entry.price)}</div><div style="color:#4a5c6d;font-size:9px;margin-top:2px">${entry.date}${diffStr}</div>`;
      tip.style.display = 'block';
      tip.style.left = (e.clientX + 12) + 'px';
      tip.style.top = (e.clientY - 40) + 'px';
    });
    canvas.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
  }
}

// Event listeners
document.getElementById('search').addEventListener('input', e => renderItems(e.target.value));

document.querySelectorAll('.chart-tab').forEach(tab => {
  tab.onclick = () => {
    document.querySelectorAll('.chart-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    selectedRange = parseInt(tab.dataset.range);
    const label = selectedRange === 0 ? 'All' : selectedRange === 365 ? '1Y' : `${selectedRange}D`;
    document.getElementById('col-change').textContent = `${label} Change`;
    document.getElementById('col-prev').textContent = `${label} Start`;
    renderChart(selectedRange);
    renderItems(document.getElementById('search').value);
  };
});

document.querySelectorAll('.items-header span').forEach(col => {
  col.onclick = () => {
    const key = col.dataset.sort;
    if (currentSort.key === key) currentSort.asc = !currentSort.asc;
    else { currentSort.key = key; currentSort.asc = false; }
    renderItems(document.getElementById('search').value);
  };
});

document.getElementById('modal-close').onclick = () => document.getElementById('modal').classList.remove('active');
document.getElementById('modal').onclick = e => { if (e.target === document.getElementById('modal')) document.getElementById('modal').classList.remove('active'); };
document.getElementById('dismiss-tip')?.addEventListener('click', () => { document.getElementById('dismiss-tip').parentElement.style.display = 'none'; });
document.getElementById('watchlist-btn')?.addEventListener('click', () => { chrome.runtime.sendMessage({ type: 'OPEN_WATCHLIST' }); });

document.getElementById('import-btn').onclick = () => document.getElementById('import-file').click();

document.getElementById('import-file').onchange = async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const imported = JSON.parse(text);
    if (!imported.snapshots || !imported.items) {
      alert('Invalid portfolio file. Must contain snapshots and items.');
      return;
    }
    if (!confirm(`Import ${imported.snapshots.length} snapshots and ${Object.keys(imported.items).length} items? This will merge with your existing data.`)) return;

    const data = await chrome.storage.local.get(['rw_portfolio']);
    const existing = data.rw_portfolio || { snapshots: [], items: {}, icons: {}, details: {} };

    // Merge snapshots (deduplicate by date, keep latest value for same date)
    const snapMap = {};
    existing.snapshots.forEach(s => snapMap[s.date] = s);
    imported.snapshots.forEach(s => { if (!snapMap[s.date]) snapMap[s.date] = s; });
    existing.snapshots = Object.values(snapMap).sort((a, b) => a.date.localeCompare(b.date));

    // Merge items (deduplicate by date per item)
    for (const [name, entries] of Object.entries(imported.items)) {
      if (!existing.items[name]) existing.items[name] = [];
      const dateMap = {};
      existing.items[name].forEach(e => dateMap[e.date] = e);
      entries.forEach(e => { if (!dateMap[e.date]) dateMap[e.date] = e; });
      existing.items[name] = Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date));
    }

    // Merge icons and details
    if (imported.icons) existing.icons = { ...existing.icons, ...imported.icons };
    if (imported.details) existing.details = { ...existing.details, ...imported.details };

    await chrome.storage.local.set({ rw_portfolio: existing });
    portfolio = existing;
    alert(`Imported successfully! ${existing.snapshots.length} total snapshots, ${Object.keys(existing.items).length} items.`);
    loadData();
  } catch (err) {
    alert('Error importing file: ' + err.message);
  }
  e.target.value = '';
};

document.getElementById('export-btn').onclick = () => {
  const json = JSON.stringify(portfolio, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `riftwalk-portfolio-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
};

document.getElementById('clear-btn').onclick = () => {
  if (confirm('Clear all portfolio history? This cannot be undone.')) {
    chrome.storage.local.remove('rw_portfolio');
    portfolio = { snapshots: [], items: {} };
    document.getElementById('empty').style.display = 'block';
    document.getElementById('portfolio-content').style.display = 'none';
  }
};

loadData();
