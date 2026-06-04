// Riftwalk Popup v3.0

// ── Tab switching ───────────────────────────────────────────
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

// ── Mode toggle ─────────────────────────────────────────────
function updateModeUI(isSkinport) {
  const peFields = document.getElementById('pe-fields');
  const spFields = document.getElementById('sp-fields');
  const peLabel = document.getElementById('mode-label-pe');
  const spLabel = document.getElementById('mode-label-sp');
  const modeHelp = document.getElementById('mode-help');

  if (isSkinport) {
    peFields.style.display = 'none';
    spFields.style.display = 'block';
    peLabel.classList.remove('active');
    spLabel.classList.add('active');
    modeHelp.textContent = 'Skinport marketplace prices with built-in Doppler phase pricing. No API key required.';
  } else {
    peFields.style.display = 'block';
    spFields.style.display = 'none';
    peLabel.classList.add('active');
    spLabel.classList.remove('active');
    modeHelp.textContent = 'Buff163/Skins.com prices via PricEmpire + phase-specific Doppler pricing via CSFloat. Requires API keys.';
  }
}

document.getElementById('pricing-mode').addEventListener('change', async (e) => {
  updateModeUI(e.target.checked);
  // Clear cached prices when switching modes so stale data doesn't linger
  await chrome.storage.local.remove(['rw_prices_cache', 'rw_skinport_dopplers', 'rw_doppler_cache']);
  await chrome.storage.local.set({ rw_settings: gatherSettings() });
  loadStatus();
});

// ── Settings ────────────────────────────────────────────────
async function loadSettings() {
  const s = (await chrome.storage.local.get(['rw_settings'])).rw_settings || {};
  const isSkinport = s.pricingMode === 'skinport';
  document.getElementById('pricing-mode').checked        = isSkinport;
  document.getElementById('api-key').value              = s.pricempireKey || '';
  document.getElementById('csfloat-key').value          = s.csfloatKey || '';
  document.getElementById('source').value               = s.priceSource || 'buff163';
  document.getElementById('currency').value             = s.currency || 'USD';
  document.getElementById('sp-currency').value          = s.spCurrency || 'USD';
  document.getElementById('enable-floats').checked      = s.enableFloats !== false;
  document.getElementById('enable-doppler-prices').checked = s.enableDopplerPrices !== false;
  document.getElementById('enable-stickers').checked    = s.enableStickers !== false;
  document.getElementById('enable-steamid').checked     = s.enableSteamId !== false;
  document.getElementById('enable-fade').checked        = s.enableFadeDetection !== false;
  document.getElementById('enable-bluegem').checked     = s.enableBlueGem !== false;
  document.getElementById('enable-pattern-tier').checked = s.enablePatternTier !== false;
  document.getElementById('enable-copy-unpriced').checked = s.copyUnpriced !== false;
  document.getElementById('enable-copy-prices').checked = s.copyPrices !== false;
  updateModeUI(isSkinport);
}

function gatherSettings() {
  return {
    pricingMode:         document.getElementById('pricing-mode').checked ? 'skinport' : 'pricempire',
    pricempireKey:       document.getElementById('api-key').value.trim(),
    csfloatKey:          document.getElementById('csfloat-key').value.trim(),
    priceSource:         document.getElementById('source').value,
    currency:            document.getElementById('currency').value,
    spCurrency:          document.getElementById('sp-currency').value,
    enableFloats:        document.getElementById('enable-floats').checked,
    enableDopplerPrices: document.getElementById('enable-doppler-prices').checked,
    enableStickers:      document.getElementById('enable-stickers').checked,
    enableSteamId:       document.getElementById('enable-steamid').checked,
    enableFadeDetection: document.getElementById('enable-fade').checked,
    enableBlueGem:       document.getElementById('enable-bluegem').checked,
    enablePatternTier:   document.getElementById('enable-pattern-tier').checked,
    copyUnpriced:        document.getElementById('enable-copy-unpriced').checked,
    copyPrices:          document.getElementById('enable-copy-prices').checked,
  };
}

async function loadStatus() {
  const res = await chrome.runtime.sendMessage({ type: 'GET_STATUS' });
  const dot = document.getElementById('status-dot');
  const info = document.getElementById('cache-info');
  if (!res.hasKey && !res.hasSkinport) { dot.className = 'status-dot red'; info.textContent = 'No pricing configured.'; return; }
  if (!res.lastUpdated) { dot.className = 'status-dot yellow'; info.textContent = 'Click "Save & Fetch" to load prices.'; return; }
  const age = res.cacheAge;
  dot.className = 'status-dot green';
  const src = res.mode === 'skinport' ? ' (Skinport)' : ' (PricEmpire)';
  info.innerHTML = `<span class="val">${(res.itemCount||0).toLocaleString()} prices</span> cached${src} (${age < 60 ? age + 'm' : (age/60).toFixed(1) + 'h'} ago)`;
}

function showMsg(text, type) {
  const el = document.getElementById('msg');
  el.textContent = text; el.className = `msg ${type}`; el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 5000);
}

// ── Save & Fetch ────────────────────────────────────────────
document.getElementById('save-btn').addEventListener('click', async () => {
  const s = gatherSettings();
  if (s.pricingMode === 'pricempire' && !s.pricempireKey) { showMsg('Enter PricEmpire API key.', 'error'); return; }
  await chrome.storage.local.set({ rw_settings: s });
  const btn = document.getElementById('save-btn'); btn.textContent = 'FETCHING...'; btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' });
  btn.textContent = 'SAVE & FETCH PRICES'; btn.disabled = false;
  res.ok ? (showMsg('Prices fetched!', 'success'), loadStatus()) : showMsg(res.error || 'Failed', 'error');
});

document.getElementById('refresh-btn').addEventListener('click', async () => {
  const btn = document.getElementById('refresh-btn'); btn.textContent = 'Refreshing...'; btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' });
  btn.textContent = '\u21BB Force refresh prices'; btn.disabled = false;
  res.ok ? (showMsg('Refreshed!', 'success'), loadStatus()) : showMsg(res.error || 'Failed', 'error');
});

// ── Auto-save toggles ──────────────────────────────────────
for (const id of ['enable-floats','enable-doppler-prices','enable-stickers','enable-steamid','enable-fade','enable-bluegem','enable-pattern-tier','enable-copy-unpriced','enable-copy-prices','source','currency','sp-currency'])
  document.getElementById(id).addEventListener('change', () => chrome.storage.local.set({ rw_settings: gatherSettings() }));

// ── Import / Export ─────────────────────────────────────────
document.getElementById('import-btn').addEventListener('click', () => document.getElementById('import-file').click());
document.getElementById('import-file').addEventListener('change', async (e) => {
  const file = e.target.files[0]; if (!file) return;
  try {
    const imp = JSON.parse(await file.text());
    const s = {
      pricingMode: imp.pricingMode||'pricempire',
      pricempireKey: imp.pricempireKey||'', csfloatKey: imp.csfloatKey||'',
      priceSource: imp.priceSource||'buff163', currency: imp.currency||'USD',
      spCurrency: imp.spCurrency||'USD',
      enableFloats: imp.enableFloats!==false, enableDopplerPrices: imp.enableDopplerPrices!==false,
      enableStickers: imp.enableStickers!==false,
      enableSteamId: imp.enableSteamId!==false,
      enableFadeDetection: imp.enableFadeDetection!==false,
      enableBlueGem: imp.enableBlueGem!==false,
      enablePatternTier: imp.enablePatternTier!==false,
      copyUnpriced: imp.copyUnpriced!==false,
      copyPrices: imp.copyPrices!==false,
    };
    await chrome.storage.local.set({ rw_settings: s });
    loadSettings(); showMsg('Settings imported! Fetching prices...', 'success');
    const r = await chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' });
    if (r.ok) { showMsg('Settings imported & prices fetched!', 'success'); loadStatus(); }
    else showMsg('Settings imported but price fetch failed: ' + (r.error || 'Unknown error'), 'error');
  } catch(err) { showMsg('Import failed: ' + err.message, 'error'); }
  e.target.value = '';
});
document.getElementById('export-btn').addEventListener('click', () => {
  const json = JSON.stringify(gatherSettings(), null, 2);
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
  a.download = 'riftwalk-settings.json'; a.click(); showMsg('Exported!', 'success');
});

loadSettings();
loadStatus();
