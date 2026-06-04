// Riftwalk Investment Tracker
let tracker = { positions: {}, icons: {}, watch: [] };
let priceMap = {};
let dopplerMap = {}; // "name|Phase" -> cents (Skinport gem/phase dopplers)
let allItemNames = [];
let priceSource = 'buff';
let selectedItem = '';
let watchSelected = ''; // selected item for the Price Watch add form
const iconAttempted = new Set(); // names we've already tried to fetch an icon for this session

async function loadData() {
  const data = await chrome.storage.local.get(['rw_watchlist', 'rw_prices_cache', 'rw_settings', 'rw_skinport_dopplers', 'rw_csfloat_hint_dismissed']);
  tracker = data.rw_watchlist || { positions: {}, icons: {}, watch: [] };
  // Sell-target preferences (configurable, persisted with the tracker so they
  // survive export/import). targetPct1/2 = profit % targets; feePct = market fee
  // applied to target prices (break-even stays raw avg cost).
  if (!tracker.prefs) tracker.prefs = {};
  if (tracker.prefs.targetPct1 == null) tracker.prefs.targetPct1 = 10;
  if (tracker.prefs.feePct == null) tracker.prefs.feePct = 12;
  if (!tracker.positions) tracker.positions = {};
  if (!tracker.icons) tracker.icons = {};
  if (!Array.isArray(tracker.watch)) tracker.watch = [];
  const cache = data.rw_prices_cache;
  if (cache && cache.data) priceMap = cache.data;
  dopplerMap = data.rw_skinport_dopplers || {};

  // Base item names from the price cache, plus phase/gem doppler variants
  // (stored as "name|Phase") exposed as searchable "name - Phase" entries.
  const names = Object.keys(priceMap);
  for (const key of Object.keys(dopplerMap)) {
    const sep = key.lastIndexOf('|');
    if (sep === -1) continue;
    const base = key.slice(0, sep);
    const phase = key.slice(sep + 1);
    names.push(`${base} - ${phase}`);
  }
  allItemNames = [...new Set(names)].sort();
  buildSearchIndex();

  const settings = data.rw_settings || {};

  // Hint: high-value item images need a CSFloat key (shown only when none is set,
  // and only until the user dismisses it)
  const csHint = document.getElementById('csfloat-hint');
  if (csHint) {
    const hasKey = settings.csfloatKey && settings.csfloatKey.trim();
    const dismissed = data.rw_csfloat_hint_dismissed;
    csHint.style.display = (!hasKey && !dismissed) ? 'flex' : 'none';
  }

  // Warn clearly if no prices are loaded — otherwise search silently returns nothing
  const hasPrices = allItemNames.length > 0;
  const warn = document.getElementById('no-prices-warning');
  if (warn) warn.style.display = hasPrices ? 'none' : 'block';
  const search = document.getElementById('item-search');
  if (search) {
    search.disabled = !hasPrices;
    search.placeholder = hasPrices ? '🔍 Search any CS2 item...' : 'Load prices first (see warning above)';
  }

  priceSource = settings.priceSource === 'skins' ? 'skins' : 'buff';
  const cur = settings.pricingMode === 'skinport' ? (settings.spCurrency || 'USD') : (settings.currency || 'USD');
  const syms = { USD:'$',EUR:'€',GBP:'£',CNY:'¥',CAD:'C$',AUD:'A$',CHF:'Fr',SEK:'kr',PLN:'zł',BRL:'R$',TRY:'₺' };
  window.SYM = syms[cur] || '$';
  window.CUR = cur;

  // Currency mismatch guard: data is stored as raw numbers in whatever currency
  // it was entered. If the active mode's currency differs from the one the data
  // was recorded in, warn instead of silently mislabeling values.
  const hasData = Object.keys(tracker.positions).length > 0 || (tracker.watch && tracker.watch.length > 0);
  const cwarn = document.getElementById('currency-warning');
  if (cwarn) {
    if (tracker.dataCurrency && tracker.dataCurrency !== cur && hasData) {
      cwarn.style.display = 'block';
      cwarn.innerHTML = `⚠️ <strong>Currency mismatch.</strong> Your tracked data was entered in <strong>${tracker.dataCurrency}</strong>, but you're now viewing prices in <strong>${cur}</strong>. Cost-basis figures are shown with the ${cur} symbol but were not converted — switch back to ${tracker.dataCurrency} mode for accurate numbers, or clear and re-enter.`;
    } else {
      cwarn.style.display = 'none';
    }
  }

  const today = new Date().toISOString().split('T')[0];
  const dateInput = document.getElementById('tx-date');
  dateInput.value = today;
  dateInput.max = today; // disallow picking a future date
  render();
}

function fmt(cents) {
  if (!cents && cents !== 0) return '—';
  return window.SYM + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtSigned(cents) {
  if (!cents && cents !== 0) return '—';
  const sign = cents >= 0 ? '+' : '-';
  return sign + window.SYM + (Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// True if we can price this name (a base item, or a known doppler phase variant)
function itemExists(name) {
  if (priceMap[name]) return true;
  const m = name.match(/^(.*) - (Phase [1-4]|Ruby|Sapphire|Black Pearl|Emerald)$/);
  if (m) return !!dopplerMap[`${m[1]}|${m[2]}`] || !!priceMap[m[1]];
  return false;
}

function getPrice(name) {
  // Phase/gem doppler names ("... - Ruby") resolve from the doppler version map.
  const phaseMatch = name.match(/^(.*) - (Phase [1-4]|Ruby|Sapphire|Black Pearl|Emerald)$/);
  if (phaseMatch) {
    const key = `${phaseMatch[1]}|${phaseMatch[2]}`;
    if (dopplerMap[key]) return dopplerMap[key];
    // PriceEmpire returns gem/phase variants as their own market_hash_name keys
    // (e.g. "★ Karambit | Doppler (Factory New) - Ruby"), so try the full
    // phase-suffixed name directly before falling back to the base price.
    const full = priceMap[name];
    if (full) return (priceSource === 'skins' ? (full.skins || full.buff) : (full.buff || full.skins)) || 0;
    // fall back to the base item's price if no specific phase price
    const base = priceMap[phaseMatch[1]];
    if (base) return (priceSource === 'skins' ? (base.skins || base.buff) : (base.buff || base.skins)) || 0;
    return 0;
  }
  const e = priceMap[name];
  if (!e) return 0;
  return (priceSource === 'skins' ? (e.skins || e.buff) : (e.buff || e.skins)) || 0;
}

async function saveTracker() {
  await chrome.storage.local.set({ rw_watchlist: tracker });
}

function render() {
  const hasActive = Object.entries(tracker.positions).some(([, p]) => p.qty > 0);
  const hasRealized = Object.entries(tracker.positions).some(([, p]) => (p.realizedPnl || 0) !== 0);
  const hasItems = hasActive || hasRealized;
  document.getElementById('empty').style.display = hasItems ? 'none' : 'block';
  document.getElementById('stats-row').style.display = hasItems ? '' : 'none';
  document.getElementById('items-section').style.display = hasActive ? '' : 'none';
  if (hasItems) { renderStats(); renderItems(); }
  if (hasActive) { renderHighlights(); renderAllocation(); }
  else {
    document.getElementById('highlights-row').style.display = 'none';
    document.getElementById('allocation-section').style.display = 'none';
  }
  renderRealizedLog();
  renderWatch();
}

function renderRealizedLog() {
  const sec = document.getElementById('realized-section');
  const sells = [];
  for (const [name, pos] of Object.entries(tracker.positions)) {
    for (const tx of (pos.transactions || [])) {
      if (tx.type === 'sell') {
        const basis = tx.costBasis != null ? tx.costBasis : tx.price;
        sells.push({ name, date: tx.date, qty: tx.qty, price: tx.price, gain: (tx.price - basis) * tx.qty });
      }
    }
  }
  if (sells.length === 0) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  sells.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  const total = sells.reduce((s, x) => s + x.gain, 0);
  const tEl = document.getElementById('realized-total');
  tEl.textContent = fmtSigned(total);
  tEl.className = total >= 0 ? 'green' : 'red';
  document.getElementById('realized-list').innerHTML = sells.map(s =>
    `<div style="display:flex;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,.02);border-radius:6px;margin-bottom:4px;font-size:12px">
      <div style="flex:1;min-width:0;color:#c7d5e0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${s.name}</div>
      <div style="color:#6a7a8a;min-width:70px;text-align:right">${s.qty} @ ${fmt(s.price)}</div>
      <div style="color:#4a5c6d;min-width:84px;text-align:center">${s.date || '—'}</div>
      <div class="${s.gain >= 0 ? 'green' : 'red'}" style="min-width:80px;text-align:right;font-weight:600">${fmtSigned(s.gain)}</div>
    </div>`
  ).join('');
}

function renderStats() {
  let totalInvested = 0, currentValue = 0, realized = 0;
  for (const [name, pos] of Object.entries(tracker.positions)) {
    realized += pos.realizedPnl || 0;
    if (pos.qty <= 0) continue;
    totalInvested += pos.totalCost;
    currentValue += getPrice(name) * pos.qty;
  }
  const pnl = currentValue - totalInvested;
  const roi = totalInvested > 0 ? ((pnl / totalInvested) * 100).toFixed(1) : '0.0';

  document.getElementById('s-invested').textContent = fmt(totalInvested);
  document.getElementById('s-current').textContent = fmt(currentValue);

  const pnlEl = document.getElementById('s-pnl');
  pnlEl.textContent = fmtSigned(pnl);
  pnlEl.className = `stat-value ${pnl >= 0 ? 'green' : 'red'}`;

  const realizedEl = document.getElementById('s-realized');
  realizedEl.textContent = realized === 0 ? fmt(0) : fmtSigned(realized);
  realizedEl.className = `stat-value ${realized >= 0 ? 'green' : 'red'}`;

  const roiEl = document.getElementById('s-roi');
  roiEl.textContent = `${pnl >= 0 ? '+' : ''}${roi}%`;
  roiEl.className = `stat-value ${pnl >= 0 ? 'green' : 'red'}`;
}

let itemsSort = 'value';
let itemsSortDir = 'desc'; // 'asc' | 'desc'
let itemsFilter = '';

// Category detection for allocation breakdown
function categoryOf(name) {
  if (/^Sticker \|/i.test(name)) return 'Stickers';
  if (/^Charm \|/i.test(name)) return 'Charms';
  if (/^Patch \|/i.test(name)) return 'Patches';
  if (/^Music Kit/i.test(name)) return 'Music Kits';
  if (/^Sealed Graffiti/i.test(name) || /Graffiti/i.test(name)) return 'Graffiti';
  if (/Case$|Capsule|Package$|Challengers|Champions|Legends|Souvenir Package|Autograph Capsule|Sticker Capsule|Pin Capsule/i.test(name)) return 'Cases';
  if (/\bPin$/i.test(name) || /Collectible Pin/i.test(name)) return 'Pins';
  if (/\| (The Professionals|Guerrilla Warfare|Sabre(?: Footsoldier)?|NSWC SEAL|SEAL Frogman|FBI(?: HRT| Sniper| SWAT)?|SWAT|Gendarmerie Nationale|Phoenix|Elite Crew|Brave|GIGN|GSG-9|KSK|SAS|IDF|TACP Cavalry|USAF TACP|Seal Team 6|Ground Rebel|Jungle Rebel|Street Soldier|Primeiro Tenente|Soldado|Trapper(?: Aggressor)?|Frogman)$/i.test(name)
      || /\| (The Professionals|Guerrilla Warfare|Sabre|NSWC SEAL|FBI|SWAT|Phoenix|Elite Crew)\b/i.test(name)) return 'Agents';
  if (/Gloves|Wraps|Hand Wraps/i.test(name)) return 'Gloves';
  if (/★|Knife|Karambit|Bayonet|Daggers/i.test(name)) return 'Knives';
  if (/AK-47|M4A4|M4A1-S|AWP|Desert Eagle|USP-S|Glock|FAMAS|Galil|SSG|AUG|SG 553|P250|Five-SeveN|Tec-9|CZ75|P2000|R8|MAC-10|MP9|MP7|MP5|UMP|PP-Bizon|P90|Nova|XM1014|Sawed-Off|MAG-7|M249|Negev|Dual Berettas|Zeus/i.test(name)) return 'Weapons';
  return 'Other';
}

function renderItems() {
  const list = document.getElementById('items-list');
  let items = Object.entries(tracker.positions)
    .filter(([, pos]) => pos.qty > 0)
    .map(([name, pos]) => {
      const currentPrice = getPrice(name);
      const avgCost = pos.qty > 0 ? Math.round(pos.totalCost / pos.qty) : 0;
      const pnl = (currentPrice - avgCost) * pos.qty;
      const pnlPct = avgCost > 0 ? ((currentPrice - avgCost) / avgCost * 100) : 0;
      const value = currentPrice * pos.qty;
      const icon = tracker.icons[name] || '';
      return { name, avgCost, currentPrice, pnl, pnlPct, value, qty: pos.qty, icon, transactions: pos.transactions || [], note: pos.note || '' };
    });

  // Filter
  if (itemsFilter) {
    const f = itemsFilter.toLowerCase();
    items = items.filter(it => it.name.toLowerCase().includes(f));
  }

  // Sort
  const keyFns = {
    value:   it => it.value,
    pnl:     it => it.pnl,
    roi:     it => it.pnlPct,
    qty:     it => it.qty,
    avgcost: it => it.avgCost,
    current: it => it.currentPrice,
    name:    it => it.name.toLowerCase(),
  };
  const keyFn = keyFns[itemsSort] || keyFns.value;
  items.sort((a, b) => {
    const av = keyFn(a), bv = keyFn(b);
    let cmp;
    if (typeof av === 'string') cmp = av.localeCompare(bv);
    else cmp = av - bv;
    return itemsSortDir === 'asc' ? cmp : -cmp;
  });

  list.innerHTML = items.map(item => `
    <div class="item-row" data-name="${item.name.replace(/"/g, '&quot;')}">
      <div style="width:32px;height:32px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.03);display:flex;align-items:center;justify-content:center;color:#3a4a5a;font-size:14px">${item.icon ? `<img src="${item.icon}" class="rw-item-icon" style="width:32px;height:32px;object-fit:contain" alt="">` : '🎯'}</div>
      <div class="item-name">
        <div>${item.name}</div>
        <div class="sub">${item.transactions.length} transaction${item.transactions.length !== 1 ? 's' : ''}${item.note ? ' · 📝' : ''}</div>
      </div>
      <div class="item-price" style="color:#6a7a8a">${fmt(item.avgCost)}</div>
      <div class="item-price" style="color:#66c0f4">${fmt(item.currentPrice)}</div>
      <div class="item-price ${item.pnl >= 0 ? 'green' : 'red'}">${fmtSigned(item.pnl)}<div style="font-size:9px">${item.pnl >= 0 ? '+' : ''}${item.pnlPct.toFixed(1)}%</div></div>
      <div class="item-price ${item.pnlPct >= 0 ? 'green' : 'red'}" style="font-size:11px">${item.pnlPct >= 0 ? '+' : ''}${item.pnlPct.toFixed(1)}%</div>
      <div class="item-price" style="color:#fff">${fmt(item.value)}</div>
      <div class="item-qty">${item.qty}</div>
      <div class="item-remove" data-name="${item.name.replace(/"/g, '&quot;')}" title="Remove">✕</div>
    </div>
  `).join('') || `<div style="padding:20px;text-align:center;color:#3a4a5a;font-size:13px">No holdings match "${itemsFilter}".</div>`;

  // Hide any icon that fails to load (so broken items show the placeholder bg)
  list.querySelectorAll('img.rw-item-icon').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });

  list.querySelectorAll('.item-row').forEach(row => {
    row.onclick = (e) => {
      if (e.target.closest('.item-remove')) return;
      showTransactions(row.dataset.name);
    };
  });

  list.querySelectorAll('.item-remove').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const name = btn.dataset.name;
      if (confirm(`Remove "${name}" and all transactions?`)) {
        delete tracker.positions[name];
        delete tracker.icons[name];
        saveTracker();
        render();
      }
    };
  });

  // Lazily fetch any missing icons
  for (const it of items) {
    if (!tracker.icons[it.name] && !iconAttempted.has(it.name)) {
      iconAttempted.add(it.name);
      chrome.runtime.sendMessage({ type: 'FETCH_ITEM_IMAGE', name: it.name }, (resp) => {
        if (resp && resp.icon) {
          tracker.icons[it.name] = resp.icon;
          saveTracker();
          renderItems();
          renderHighlights(); // performer cards use the same icons
        }
      });
    }
  }
}

function renderHighlights() {
  const row = document.getElementById('highlights-row');
  const held = Object.entries(tracker.positions)
    .filter(([, pos]) => pos.qty > 0)
    .map(([name, pos]) => {
      const cur = getPrice(name);
      const avg = pos.qty > 0 ? Math.round(pos.totalCost / pos.qty) : 0;
      const pct = avg > 0 ? ((cur - avg) / avg * 100) : 0;
      return { name, pct, pnl: (cur - avg) * pos.qty, icon: tracker.icons[name] || '' };
    });
  if (held.length < 2) { row.style.display = 'none'; return; }
  row.style.display = 'grid';
  const byPct = [...held].sort((a, b) => b.pct - a.pct);
  const best = byPct[0], worst = byPct[byPct.length - 1];

  const card = (it, pctClass, pctSign) => `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:36px;height:36px;border-radius:5px;overflow:hidden;background:rgba(255,255,255,.03);display:flex;align-items:center;justify-content:center;color:#3a4a5a;font-size:15px;flex-shrink:0">${it.icon ? `<img src="${it.icon}" class="rw-perf-icon" style="width:36px;height:36px;object-fit:contain" alt="">` : '🎯'}</div>
      <div style="min-width:0;flex:1">
        <div style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#c7d5e0;font-size:12px">${it.name}</div>
        <div class="${pctClass}" style="font-weight:600;margin-top:2px">${pctSign}${it.pct.toFixed(1)}% · ${fmtSigned(it.pnl)}</div>
      </div>
    </div>`;

  document.getElementById('best-perf').innerHTML = card(best, best.pct >= 0 ? 'green' : 'red', best.pct >= 0 ? '+' : '');
  document.getElementById('worst-perf').innerHTML = card(worst, worst.pct >= 0 ? 'green' : 'red', worst.pct >= 0 ? '+' : '');

  // Hide broken icons gracefully
  row.querySelectorAll('img.rw-perf-icon').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });
}

function renderAllocation() {
  const sec = document.getElementById('allocation-section');
  const cats = {};
  let total = 0;
  for (const [name, pos] of Object.entries(tracker.positions)) {
    if (pos.qty <= 0) continue;
    const val = getPrice(name) * pos.qty;
    const cat = categoryOf(name);
    cats[cat] = (cats[cat] || 0) + val;
    total += val;
  }
  if (total <= 0) { sec.style.display = 'none'; return; }
  sec.style.display = 'block';
  const colors = {
    Knives: '#a78bfa', Gloves: '#f472b6', Weapons: '#66c0f4',
    Stickers: '#fbbf24', Charms: '#34d399', Cases: '#fb923c',
    Agents: '#22d3ee', Patches: '#e879f9', 'Music Kits': '#818cf8',
    Graffiti: '#a3e635', Pins: '#fda4af', Other: '#6a7a8a',
  };
  const order = ['Knives', 'Gloves', 'Weapons', 'Stickers', 'Charms', 'Cases', 'Agents', 'Patches', 'Music Kits', 'Graffiti', 'Pins', 'Other'].filter(c => cats[c]);
  document.getElementById('allocation-bar').innerHTML = order.map(c =>
    `<div style="width:${(cats[c] / total * 100).toFixed(1)}%;background:${colors[c] || '#6a7a8a'}" title="${c}"></div>`
  ).join('');
  document.getElementById('allocation-legend').innerHTML = order.map(c =>
    `<div style="display:flex;align-items:center;gap:6px"><span style="width:10px;height:10px;border-radius:2px;background:${colors[c] || '#6a7a8a'}"></span><span style="color:#c7d5e0">${c}</span> <span style="color:#6a7a8a">${(cats[c] / total * 100).toFixed(0)}% · ${fmt(cats[c])}</span></div>`
  ).join('');
}

function showTransactions(name) {
  const pos = tracker.positions[name];
  if (!pos) return;
  document.getElementById('modal-item-name').textContent = name;
  document.getElementById('modal').classList.add('active');

  const currentPrice = getPrice(name);
  const avgCost = pos.qty > 0 ? Math.round(pos.totalCost / pos.qty) : 0;
  const pnl = (currentPrice - avgCost) * pos.qty;
  const pnlPct = avgCost > 0 ? ((currentPrice - avgCost) / avgCost * 100).toFixed(1) : '0.0';
  const icon = tracker.icons[name] || '';

  let html = `<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px">`;
  if (icon) html += `<img src="${icon}" style="width:64px;height:64px;object-fit:contain;border-radius:8px;background:rgba(255,255,255,.03)">`;
  html += `<div>
    <div>Current: <span style="color:#66c0f4;font-weight:600">${fmt(currentPrice)}</span></div>
    <div>Avg Cost: <span style="color:#8a9aaa">${fmt(avgCost)}</span> × ${pos.qty}</div>
    <div>Unrealized P&L: <span class="${pnl >= 0 ? 'green' : 'red'}">${fmtSigned(pnl)} (${pnl >= 0 ? '+' : ''}${pnlPct}%)</span></div>
    ${(pos.realizedPnl || 0) !== 0 ? `<div>Realized P&L: <span class="${pos.realizedPnl >= 0 ? 'green' : 'red'}">${fmtSigned(pos.realizedPnl)}</span></div>` : ''}
  </div></div>`;

  html += `<div style="font-size:11px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Transaction History &amp; P&amp;L by date</div>`;

  const txs = pos.transactions || [];
  if (txs.length === 0) {
    html += `<div style="color:#3a4a5a;font-size:12px">No transactions recorded</div>`;
  } else {
    html += `<div style="display:flex;flex-direction:column;gap:4px">`;
    // newest first
    [...txs].reverse().forEach(tx => {
      const isBuy = tx.type === 'buy';
      let pnlHtml = '';
      if (isBuy) {
        // What this lot is worth now vs what was paid
        const lotPnl = (currentPrice - tx.price) * tx.qty;
        const lotPct = tx.price > 0 ? ((currentPrice - tx.price) / tx.price * 100).toFixed(1) : '0.0';
        pnlHtml = `<div style="text-align:right;min-width:96px" class="${lotPnl >= 0 ? 'green' : 'red'}">
            ${fmtSigned(lotPnl)}
            <div style="font-size:9px">${lotPnl >= 0 ? '+' : ''}${lotPct}% vs now</div>
          </div>`;
      } else {
        // Realized gain on this sale = (sell price - cost basis at sale) × qty
        const basis = tx.costBasis != null ? tx.costBasis : tx.price;
        const realized = (tx.price - basis) * tx.qty;
        const realizedPct = basis > 0 ? ((tx.price - basis) / basis * 100).toFixed(1) : '0.0';
        pnlHtml = `<div style="text-align:right;min-width:96px" class="${realized >= 0 ? 'green' : 'red'}">
            ${fmtSigned(realized)}
            <div style="font-size:9px">${realized >= 0 ? '+' : ''}${realizedPct}% realized</div>
          </div>`;
      }
      html += `<div style="display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 12px;background:rgba(255,255,255,.02);border-radius:6px;font-size:12px">
        <div style="min-width:64px"><span style="color:${isBuy ? '#4ade80' : '#ef4444'};font-weight:600">${isBuy ? 'BUY' : 'SELL'}</span> × ${tx.qty}</div>
        <div style="color:#8a9aaa;min-width:80px;text-align:right">${fmt(tx.price)} ea</div>
        <div style="color:#4a5c6d;min-width:88px;text-align:center">${tx.date}</div>
        ${pnlHtml}
      </div>`;
    });
    html += `</div>`;
  }

  // Break-even / target helper (only meaningful while holding)
  if (pos.qty > 0 && avgCost > 0) {
    const p1 = Number(tracker.prefs?.targetPct1) || 10;
    const fee = Math.min(Math.max(Number(tracker.prefs?.feePct) || 0, 0), 90) / 100;
    const breakeven = avgCost; // raw avg cost — what you paid (not fee-adjusted)
    // To NET a +p% gain after a fee f, you must list at: avgCost*(1+p) / (1-f)
    const listFor = (pct) => Math.round(avgCost * (1 + pct / 100) / (1 - fee));
    const netGain = (pct) => Math.round(avgCost * (pct / 100)); // net profit at that target
    const t1 = listFor(p1);
    const feeNote = fee > 0 ? ` <span style="color:#4a5c6d;text-transform:none;letter-spacing:0">(list price, after fee)</span>` : '';
    html += `<div style="margin-top:16px;display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;flex-wrap:wrap">
        <div style="font-size:11px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Targets${feeNote}</div>
        <div style="display:flex;align-items:center;gap:6px;font-size:10px;color:#6a7a8a">
          <span>target%</span><input type="number" id="tgt-pct1" value="${p1}" min="0" step="1" style="width:50px;padding:3px 6px;font-size:11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:5px;color:#c7d5e0;font-family:inherit">
          <span style="margin-left:6px">fee%</span><input type="number" id="tgt-fee" value="${(fee*100)}" min="0" max="90" step="0.5" style="width:52px;padding:3px 6px;font-size:11px;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.08);border-radius:5px;color:#c7d5e0;font-family:inherit">
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <div style="flex:1;min-width:90px;padding:10px 12px;background:rgba(255,255,255,.02);border-radius:6px">
          <div style="font-size:10px;color:#6a7a8a">Break-even</div>
          <div style="color:#c7d5e0;font-weight:600">${fmt(breakeven)}</div>
        </div>
        <div style="flex:1;min-width:90px;padding:10px 12px;background:rgba(255,255,255,.02);border-radius:6px">
          <div style="font-size:10px;color:#6a7a8a">+${p1}% net</div>
          <div style="color:#34d399;font-weight:600">${fmt(t1)}</div>
          <div style="font-size:9px;color:#4a5c6d">+${fmt(netGain(p1))} net</div>
        </div>
      </div>`;
  }

  // Notes per position
  const note = pos.note || '';
  html += `<div style="margin-top:16px;font-size:11px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Notes</div>
    <textarea id="position-note" data-name="${name.replace(/"/g, '&quot;')}" placeholder="Add a private note (e.g. 'buying more if it dips', 'trade-up candidate')..."
      style="width:100%;box-sizing:border-box;min-height:60px;background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px;color:#c7d5e0;font-family:inherit;font-size:13px;padding:10px;resize:vertical">${note.replace(/</g, '&lt;')}</textarea>`;

  document.getElementById('modal-info').innerHTML = html;

  // Sell-target controls (global prefs) — update, persist, re-render live
  const wireTgt = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('change', () => {
      let v = parseFloat(el.value);
      if (!isFinite(v) || v < 0) v = 0;
      if (key === 'feePct' && v > 90) v = 90;
      tracker.prefs[key] = v;
      saveTracker();
      showTransactions(name); // re-render modal with new targets
    });
  };
  wireTgt('tgt-pct1', 'targetPct1');
  wireTgt('tgt-fee', 'feePct');

  // Save note on edit (debounced)
  const noteEl = document.getElementById('position-note');
  if (noteEl) {
    let noteTimer;
    noteEl.addEventListener('input', () => {
      clearTimeout(noteTimer);
      noteTimer = setTimeout(() => {
        const p = tracker.positions[noteEl.dataset.name];
        if (p) { p.note = noteEl.value; saveTracker(); renderItems(); }
      }, 400);
    });
  }
}

// ── Smart search ────────────────────────────────────────────
// Token-based matching: every word in the query must appear in the item
// name (any order), so "butterfly fade" matches "★ Butterfly Knife | Fade (FN)".
let searchIndex = []; // [{ name, norm, tokens:[] }]

// Common abbreviations / slang → canonical words
const SEARCH_ALIASES = {
  bfk: 'butterfly knife', kara: 'karambit', flip: 'flip knife',
  m9: 'm9 bayonet', ak: 'ak-47', m4: 'm4a4 m4a1-s', awp: 'awp',
  bowie: 'bowie knife', huntsman: 'huntsman knife', ursus: 'ursus knife',
  talon: 'talon knife', skeleton: 'skeleton knife', stiletto: 'stiletto knife',
  navaja: 'navaja knife', shadow: 'shadow daggers', daggers: 'shadow daggers',
  gut: 'gut knife', falchion: 'falchion knife', classic: 'classic knife',
  paracord: 'paracord knife', survival: 'survival knife', nomad: 'nomad knife',
  st: 'stattrak', sv: 'souvenir', fn: 'factory new', mw: 'minimal wear',
  ft: 'field-tested', ww: 'well-worn', bs: 'battle-scarred',
};

function normalize(str) {
  return str
    .toLowerCase()
    .replace(/★|™/g, ' ')
    .replace(/[|()/,]/g, ' ')
    .replace(/-/g, ' ')        // so "ak-47" matches "ak 47"
    .replace(/\s+/g, ' ')
    .trim();
}

function buildSearchIndex() {
  searchIndex = allItemNames.map(name => {
    const norm = normalize(name);
    return { name, norm, tokens: norm.split(' ') };
  });
}

// Each query word becomes a group of acceptable alternatives (OR).
// A name matches a word if ANY alternative in its group is found.
function expandQuery(q) {
  const words = normalize(q).split(' ').filter(Boolean);
  return words.map(w => {
    const alts = new Set([w]);
    if (SEARCH_ALIASES[w]) {
      // add each alias word as its own alternative (normalized)
      for (const a of normalize(SEARCH_ALIASES[w]).split(' ')) alts.add(a);
    }
    return [...alts];
  });
}

function searchItems(query, limit = 30) {
  const groups = expandQuery(query); // [[alt,alt],[alt]...]
  if (groups.length === 0) return [];

  const results = [];
  for (const entry of searchIndex) {
    let allMatch = true;
    let score = 0;
    for (const group of groups) {
      // Best score this word group can achieve against the name
      let best = 0;
      for (const term of group) {
        if (entry.tokens.includes(term)) { best = Math.max(best, 10); continue; }
        if (entry.tokens.some(t => t.startsWith(term))) { best = Math.max(best, 5); continue; }
        if (entry.norm.includes(term)) { best = Math.max(best, 2); continue; }
      }
      if (best === 0) { allMatch = false; break; }
      score += best;
    }
    if (!allMatch) continue;
    score -= entry.norm.length * 0.02;          // prefer shorter / less noisy names
    if (entry.norm.startsWith(groups[0][0])) score += 3;
    results.push({ name: entry.name, score });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit).map(r => r.name);
}

// Autocomplete
const searchInput = document.getElementById('item-search');
const acList = document.getElementById('autocomplete');
let acTimeout;
let acIndex = -1; // currently highlighted item for keyboard nav

function chooseItem(name) {
  selectedItem = name;
  searchInput.value = name;
  acList.classList.remove('active');
  acIndex = -1;
  // Prefill the price field with the current market price as a starting point
  // (user can overwrite it — e.g. with the actual historical price they paid).
  if (getPrice(name) > 0) {
    document.getElementById("tx-price").value = (getPrice(name) / 100).toFixed(2);
  }
}

function highlightAc(items) {
  items.forEach((el, i) => el.classList.toggle('ac-active', i === acIndex));
  if (acIndex >= 0 && items[acIndex]) items[acIndex].scrollIntoView({ block: 'nearest' });
}

searchInput.addEventListener('input', () => {
  clearTimeout(acTimeout);
  acTimeout = setTimeout(() => {
    const q = searchInput.value.trim().toLowerCase();
    acIndex = -1;
    if (q.length < 2) { acList.classList.remove('active'); return; }
    const matches = searchItems(q, 25);
    if (matches.length === 0) { acList.classList.remove('active'); return; }
    acList.innerHTML = matches.map(name => `<div class="ac-item" data-name="${name.replace(/"/g, '&quot;')}"><span>${name}</span><span class="ac-price">${fmt(getPrice(name))}</span></div>`).join('');
    acList.classList.add('active');
    acList.querySelectorAll('.ac-item').forEach(item => {
      item.onclick = () => chooseItem(item.dataset.name);
    });
  }, 150);
});

searchInput.addEventListener('keydown', (e) => {
  const items = Array.from(acList.querySelectorAll('.ac-item'));
  if (e.key === 'Escape') { acList.classList.remove('active'); acIndex = -1; return; }
  if (!acList.classList.contains('active') || items.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    acIndex = Math.min(acIndex + 1, items.length - 1);
    highlightAc(items);
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    acIndex = Math.max(acIndex - 1, 0);
    highlightAc(items);
  } else if (e.key === 'Enter') {
    if (acIndex >= 0 && items[acIndex]) { e.preventDefault(); chooseItem(items[acIndex].dataset.name); }
  }
});
document.addEventListener('click', (e) => { if (!e.target.closest('.add-search')) acList.classList.remove('active'); });

// Type toggle
document.getElementById('tx-type').addEventListener('change', (e) => {
  const btn = document.getElementById('add-btn');
  const label = document.getElementById('tx-price-label');
  const priceField = document.getElementById('tx-price');
  const name = selectedItem || searchInput.value.trim();
  if (e.target.value === 'sell') {
    btn.textContent = '- Sell'; btn.className = 'add-btn sell';
    label.textContent = 'Sell price';
  } else {
    btn.textContent = '+ Buy'; btn.className = 'add-btn';
    label.textContent = 'Price paid';
  }
  // Refresh prefill to current market price for the selected item
  if (name && priceMap[name]) priceField.value = (getPrice(name) / 100).toFixed(2);
});

// Add transaction
document.getElementById('add-btn').onclick = () => {
  const name = selectedItem || searchInput.value.trim();
  if (!name) return;
  if (!itemExists(name)) { alert('Item not found in price cache. Make sure prices are fetched first.'); return; }

  const type = document.getElementById('tx-type').value;
  const priceInput = parseFloat(document.getElementById('tx-price').value) || 0;
  const priceCents = Math.round(priceInput * 100);
  const qty = parseInt(document.getElementById('tx-qty').value) || 1;
  const date = document.getElementById('tx-date').value || new Date().toISOString().split('T')[0];

  // Don't allow future-dated transactions
  const today = new Date().toISOString().split('T')[0];
  if (date > today) { alert("Date can't be in the future."); return; }

  // Record the currency the data is being entered in (first entry sets it)
  if (!tracker.dataCurrency) tracker.dataCurrency = window.CUR || 'USD';

  if (type === 'buy') {
    if (!tracker.positions[name]) tracker.positions[name] = { qty: 0, totalCost: 0, realizedPnl: 0, transactions: [] };
    if (tracker.positions[name].realizedPnl == null) tracker.positions[name].realizedPnl = 0;
    tracker.positions[name].qty += qty;
    tracker.positions[name].totalCost += priceCents * qty;
    tracker.positions[name].transactions.push({ type: 'buy', price: priceCents, qty, date });
  } else {
    if (!tracker.positions[name] || tracker.positions[name].qty < qty) {
      alert(`You only have ${tracker.positions[name]?.qty || 0} of this item.`); return;
    }
    const pos = tracker.positions[name];
    if (pos.realizedPnl == null) pos.realizedPnl = 0;
    const avgCost = Math.round(pos.totalCost / pos.qty);
    // Realized gain on this sale = (sell price - avg cost) per unit
    pos.realizedPnl += (priceCents - avgCost) * qty;
    pos.qty -= qty;
    pos.totalCost -= avgCost * qty;
    if (pos.totalCost < 0) pos.totalCost = 0;
    pos.transactions.push({ type: 'sell', price: priceCents, qty, date, costBasis: avgCost });
    if (pos.qty <= 0) { pos.qty = 0; pos.totalCost = 0; }
  }

  if (!tracker.icons[name]) {
    chrome.runtime.sendMessage({ type: 'FETCH_ITEM_IMAGE', name }, (resp) => {
      if (resp && resp.icon) { tracker.icons[name] = resp.icon; saveTracker(); renderItems(); renderHighlights(); }
    });
  }

  saveTracker();
  searchInput.value = ''; selectedItem = '';
  document.getElementById('tx-qty').value = '1';
  document.getElementById('tx-price').value = '';
  render();
};

// Modal
document.getElementById('modal-close').onclick = () => document.getElementById('modal').classList.remove('active');
document.getElementById('modal').onclick = e => { if (e.target === document.getElementById('modal')) document.getElementById('modal').classList.remove('active'); };

// Export
document.getElementById('export-btn').onclick = () => {
  const json = JSON.stringify(tracker, null, 2);
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = `riftwalk-investments-${new Date().toISOString().split('T')[0]}.json`;
  a.click();
};

// Import
document.getElementById('import-btn').onclick = () => document.getElementById('import-file').click();
document.getElementById('import-file').onchange = async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const imported = JSON.parse(await file.text());
    if (!imported.positions || typeof imported.positions !== 'object') { alert('Invalid file — no positions found.'); return; }

    const incoming = Object.entries(imported.positions);
    const existing = incoming.filter(([name]) => tracker.positions[name]).length;
    let replace = false;
    if (existing > 0) {
      replace = confirm(
        `Importing ${incoming.length} position${incoming.length !== 1 ? 's' : ''}, ` +
        `${existing} of which you already track.\n\n` +
        `OK = replace existing with imported (restore a backup).\n` +
        `Cancel = keep your current ones and only add new items.`
      );
    } else if (!confirm(`Import ${incoming.length} position${incoming.length !== 1 ? 's' : ''}?`)) {
      e.target.value = ''; return;
    }

    for (const [name, pos] of incoming) {
      if (tracker.positions[name] && !replace) continue;
      // Defensive: ensure required fields exist on imported data
      tracker.positions[name] = {
        qty: pos.qty || 0,
        totalCost: pos.totalCost || 0,
        realizedPnl: pos.realizedPnl || 0,
        transactions: Array.isArray(pos.transactions) ? pos.transactions : [],
        note: pos.note || '',
      };
    }
    if (imported.icons) tracker.icons = { ...tracker.icons, ...imported.icons };
    // Restore the data currency if this tracker had none yet (so the currency
    // mismatch guard works correctly against imported data)
    if (imported.dataCurrency && !tracker.dataCurrency) tracker.dataCurrency = imported.dataCurrency;
    // Restore sell-target preferences from the backup if present
    if (imported.prefs && typeof imported.prefs === 'object') {
      tracker.prefs = { ...tracker.prefs, ...imported.prefs };
    }
    if (Array.isArray(imported.watch)) {
      // Merge watches, avoiding exact duplicates (same name+direction+target)
      for (const w of imported.watch) {
        if (!w || !w.name) continue;
        const dup = tracker.watch.some(x => x.name === w.name && x.direction === w.direction && x.target === w.target);
        if (!dup) tracker.watch.push({ name: w.name, target: w.target, direction: w.direction === 'above' ? 'above' : 'below' });
      }
    }
    await saveTracker();
    alert('Imported successfully.');
    render();
  } catch (err) { alert('Error reading file: ' + err.message); }
  e.target.value = '';
};

// Clear
document.getElementById('clear-btn').onclick = () => {
  if (confirm('Clear all investments? This cannot be undone.')) {
    tracker = { positions: {}, icons: {}, watch: [] }; saveTracker(); render();
  }
};

// ── Price Watch ─────────────────────────────────────────────
const watchSearch = document.getElementById('watch-search');
const watchAc = document.getElementById('watch-autocomplete');
let watchAcTimeout, watchAcIndex = -1;

function watchChoose(name) {
  watchSelected = name;
  watchSearch.value = name;
  watchAc.classList.remove('active');
  watchAcIndex = -1;
  // Prefill target with current price as a starting point
  if (getPrice(name) > 0) document.getElementById('watch-target').value = (getPrice(name) / 100).toFixed(2);
}

watchSearch.addEventListener('input', () => {
  clearTimeout(watchAcTimeout);
  watchAcTimeout = setTimeout(() => {
    const q = watchSearch.value.trim().toLowerCase();
    watchAcIndex = -1;
    if (q.length < 2) { watchAc.classList.remove('active'); return; }
    const matches = searchItems(q, 25);
    if (matches.length === 0) { watchAc.classList.remove('active'); return; }
    watchAc.innerHTML = matches.map(name => `<div class="ac-item" data-name="${name.replace(/"/g, '&quot;')}"><span>${name}</span><span class="ac-price">${fmt(getPrice(name))}</span></div>`).join('');
    watchAc.classList.add('active');
    watchAc.querySelectorAll('.ac-item').forEach(item => { item.onclick = () => watchChoose(item.dataset.name); });
  }, 150);
});

watchSearch.addEventListener('keydown', (e) => {
  const items = Array.from(watchAc.querySelectorAll('.ac-item'));
  if (e.key === 'Escape') { watchAc.classList.remove('active'); return; }
  if (!watchAc.classList.contains('active') || items.length === 0) return;
  if (e.key === 'ArrowDown') { e.preventDefault(); watchAcIndex = Math.min(watchAcIndex + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle('ac-active', i === watchAcIndex)); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); watchAcIndex = Math.max(watchAcIndex - 1, 0); items.forEach((el, i) => el.classList.toggle('ac-active', i === watchAcIndex)); }
  else if (e.key === 'Enter' && watchAcIndex >= 0 && items[watchAcIndex]) { e.preventDefault(); watchChoose(items[watchAcIndex].dataset.name); }
});
document.addEventListener('click', (e) => { if (!e.target.closest('#watch-section .add-search')) watchAc.classList.remove('active'); });

document.getElementById('watch-add-btn').onclick = () => {
  const name = watchSelected || watchSearch.value.trim();
  if (!name) return;
  if (!itemExists(name)) { alert('Item not found in price cache. Make sure prices are fetched first.'); return; }
  const target = Math.round((parseFloat(document.getElementById('watch-target').value) || 0) * 100);
  if (target <= 0) { alert('Enter a target price.'); return; }
  const direction = document.getElementById('watch-dir').value;

  // Replace an existing watch on the same item+direction, else add
  const idx = tracker.watch.findIndex(w => w.name === name && w.direction === direction);
  if (idx >= 0) tracker.watch[idx].target = target;
  else tracker.watch.push({ name, target, direction });

  // Fetch icon if we don't have one
  if (!tracker.icons[name] && !iconAttempted.has(name)) {
    iconAttempted.add(name);
    chrome.runtime.sendMessage({ type: 'FETCH_ITEM_IMAGE', name }, (resp) => {
      if (resp && resp.icon) { tracker.icons[name] = resp.icon; saveTracker(); renderWatch(); }
    });
  }

  saveTracker();
  watchSearch.value = ''; watchSelected = '';
  document.getElementById('watch-target').value = '';
  renderWatch();
};

function renderWatch() {
  const list = document.getElementById('watch-list');
  const empty = document.getElementById('watch-empty');
  if (!list) return;
  if (!tracker.watch || tracker.watch.length === 0) {
    list.innerHTML = '';
    if (empty) empty.style.display = 'block';
    return;
  }
  if (empty) empty.style.display = 'none';

  list.innerHTML = tracker.watch.map((w, i) => {
    const current = getPrice(w.name);
    const hit = w.direction === 'below' ? (current > 0 && current <= w.target) : (current >= w.target);
    const icon = tracker.icons[w.name] || '';
    const dirText = w.direction === 'below' ? '≤' : '≥';
    const bg = hit ? 'rgba(52,211,153,.1)' : 'rgba(255,255,255,.02)';
    const border = hit ? 'rgba(52,211,153,.35)' : 'rgba(255,255,255,.04)';
    const badge = hit
      ? `<span style="background:rgba(52,211,153,.2);color:#34d399;font-size:10px;font-weight:700;padding:3px 10px;border-radius:5px;letter-spacing:.5px">TARGET HIT</span>`
      : `<span style="background:rgba(255,255,255,.04);color:#6a7a8a;font-size:10px;font-weight:600;padding:3px 10px;border-radius:5px">WAITING</span>`;
    return `<div style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:${bg};border:1px solid ${border};border-radius:8px;margin-bottom:6px">
      <div style="width:32px;height:32px;border-radius:4px;overflow:hidden;background:rgba(255,255,255,.03);display:flex;align-items:center;justify-content:center;color:#3a4a5a;font-size:14px">${icon ? `<img src="${icon}" class="rw-watch-icon" style="width:32px;height:32px;object-fit:contain" alt="">` : '🎯'}</div>
      <div style="flex:1;min-width:0">
        <div style="color:#fff;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${w.name}</div>
        <div style="font-size:10px;color:#4a5c6d;margin-top:1px">Alert when ${dirText} ${fmt(w.target)} · now ${fmt(current)}</div>
      </div>
      ${badge}
      <div class="watch-remove" data-idx="${i}" title="Remove" style="cursor:pointer;color:#3a4a5a;font-size:14px;transition:color .15s">✕</div>
    </div>`;
  }).join('');

  list.querySelectorAll('img.rw-watch-icon').forEach(img => {
    img.addEventListener('error', () => { img.style.display = 'none'; });
  });
  list.querySelectorAll('.watch-remove').forEach(btn => {
    btn.onclick = () => {
      tracker.watch.splice(parseInt(btn.dataset.idx), 1);
      saveTracker();
      renderWatch();
    };
  });
}

// Clickable column sort headers
function updateSortIndicators() {
  document.querySelectorAll('.sort-col').forEach(col => {
    const ind = col.querySelector('.sort-ind');
    if (col.dataset.sort === itemsSort) ind.textContent = itemsSortDir === 'asc' ? '▲' : '▼';
    else ind.textContent = '';
  });
}
document.querySelectorAll('.sort-col').forEach(col => {
  col.addEventListener('click', () => {
    const key = col.dataset.sort;
    if (itemsSort === key) {
      itemsSortDir = itemsSortDir === 'asc' ? 'desc' : 'asc';
    } else {
      itemsSort = key;
      // Sensible default direction: names ascending, numbers descending
      itemsSortDir = key === 'name' ? 'asc' : 'desc';
    }
    updateSortIndicators();
    renderItems();
  });
});
updateSortIndicators();

document.getElementById('items-filter').addEventListener('input', (e) => {
  itemsFilter = e.target.value.trim(); renderItems();
});

// CSFloat hint dismiss
const csHintClose = document.getElementById('csfloat-hint-close');
if (csHintClose) {
  csHintClose.onclick = () => {
    document.getElementById('csfloat-hint').style.display = 'none';
    chrome.storage.local.set({ rw_csfloat_hint_dismissed: true });
  };
}

loadData();
