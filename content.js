// ============================================================
// Riftwalk — Content Script v1.9
// Phase: instant from icon_url (no click needed)
// Doppler price: CSFloat listings on page load
// Float: PricEmpire inspect API (queued, ~1/sec)
// ============================================================
(function () {
  'use strict';
  if (window.__riftwalker_loaded) return;
  window.__riftwalker_loaded = true;

  // Firefox MV3 doesn't support "world": "MAIN" — inject pageworld.js if it hasn't loaded
  // Wait briefly then check if pageworld set up its divs; if not, inject manually
  setTimeout(() => {
    try {
      if (!document.getElementById('rw-asset-dump') && !document.getElementById('rw-viewer')) {
        const pwUrl = (typeof browser !== 'undefined' ? browser : chrome).runtime.getURL('pageworld.js');
        if (!document.querySelector(`script[src="${pwUrl}"]`)) {
          const s = document.createElement('script');
          s.src = pwUrl;
          s.onload = () => s.remove();
          (document.head || document.documentElement).appendChild(s);
          console.log('[Riftwalk] Injected pageworld.js manually');
        }
      }
    } catch(e) {}
  }, 1500);

  let IS_HISTORY    = /\/inventoryhistory/.test(location.pathname);
  let IS_INVENTORY  = /\/inventory/.test(location.pathname) && !IS_HISTORY;
  let IS_TRADEOFFER = /\/tradeoffer\//.test(location.pathname);
  let IS_TRADEOFFERS_LIST = /\/tradeoffers\/?($|\?|sent)/.test(location.pathname);
  let IS_PROFILE    = /\/(profiles|id)\/[^/]+\/?$/.test(location.pathname) && !IS_INVENTORY && !IS_TRADEOFFER && !IS_TRADEOFFERS_LIST && !IS_HISTORY;

  let priceMap = {}, settings = {};
  let invDescs = new Map(), nameCache = new Map(), floatCache = new Map();
  let portfolioSnapshotSaved = false;
  let dopplerPrices = new Map(), dopplerPhases = new Map();
  let debounce = null, floatQueue = [], floatBusy = false;
  let currentOwnerSteamId = null, inventoryLoading = false;

  const CURR_SYM = { USD: '$', EUR: '€', GBP: '£', CNY: '¥', CAD: 'C$', AUD: 'A$', CHF: 'Fr', SEK: 'kr', PLN: 'zł', BRL: 'R$', TRY: '₺' };
  // CSFloat returns USD only — convert to user's currency
  // CSFloat returns USD only — convert to user's currency.
  // Static reference rates (approx, mid-2026). Used only for CSFloat-sourced
  // prices; PriceEmpire/Skinport return native currency already. TRY is volatile
  // and will drift fastest. Falls back to USD (rate 1) for any unlisted currency.
  const USD_RATES = {
    USD: 1, EUR: 0.92, GBP: 0.79, CNY: 6.77, CAD: 1.37, AUD: 1.40,
    CHF: 0.79, SEK: 9.45, PLN: 3.65, BRL: 5.45, TRY: 38.5
  };
  function activeCurrency() {
    return settings.pricingMode === 'skinport' ? (settings.spCurrency || 'USD') : (settings.currency || 'USD');
  }
  function convertFromUSD(cents) {
    const cur = activeCurrency();
    const rate = USD_RATES[cur];
    return rate && rate !== 1 ? Math.round(cents * rate) : cents;
  }
  function sym() {
    return CURR_SYM[activeCurrency()] || '$';
  }
  function fmt(c) { return (!c || c <= 0) ? null : sym() + (c / 100).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2}); }
  function getPrice(name, aid) {
    if (aid && dopplerPrices.has(aid)) return fmt(dopplerPrices.get(aid));
    if (!name) return null;
    const e = priceMap[name]; if (!e) return null;
    const cents = settings.priceSource === 'skins' ? (e.skins || e.buff) : (e.buff || e.skins);
    if (cents > 1000000 && /\bKey$/i.test(name)) return null;
    return fmt(cents);
  }
  function getCents(name, aid) {
    if (aid && dopplerPrices.has(aid)) return dopplerPrices.get(aid);
    if (!name) return 0;
    const e = priceMap[name]; if (!e) return 0;
    let cents = (settings.priceSource === 'skins' ? (e.skins || e.buff) : (e.buff || e.skins)) || 0;
    // Sanity cap: keys/tools should never exceed $100, skip obviously broken prices
    if (cents > 10000 && /\bKey$|\bKey\b.*Tag$|Capsule$|Package$|Pass$|Pin$|Sticker\s*\|/.test(name) === false && cents > 50000000) cents = 0;
    if (cents > 1000000 && /\bKey$/i.test(name)) cents = 0; // Keys over $10K are broken data
    return cents;
  }

  // ── Doppler phase detection from icon_url ─────────────────
  // Each Doppler phase has a unique icon per knife type.
  // We match desc.icon_url against known hashes — INSTANT, no API needed.
  const PHASE_CLR = {'Phase 1':'#9B59B6','Phase 2':'#E91E8C','Phase 3':'#2ECC71','Phase 4':'#3498DB','Ruby':'#FF1600','Sapphire':'#3500FA','Black Pearl':'#555','Emerald':'#00C853'};
  const GAMMA_CLR = '#2ECC71'; // All Gamma Doppler phases are green
  function getPhaseColor(phase, itemName) {
    if (itemName?.includes('Gamma Doppler')) return GAMMA_CLR;
    return PHASE_CLR[phase] || '#E91E8C';
  }

  // paint_index → phase (for inspect link decode fallback)
  const PAINT_PHASES = new Map([
    [418,'Phase 1'],[569,'Phase 1'],[852,'Phase 1'],[1120,'Phase 1'],
    [419,'Phase 2'],[570,'Phase 2'],[853,'Phase 2'],[1121,'Phase 2'],
    [420,'Phase 3'],[571,'Phase 3'],[854,'Phase 3'],[1122,'Phase 3'],
    [421,'Phase 4'],[572,'Phase 4'],[855,'Phase 4'],[1123,'Phase 4'],
    [415,'Ruby'],[416,'Sapphire'],[619,'Sapphire'],
    [417,'Black Pearl'],[617,'Black Pearl'],[568,'Emerald'],[1119,'Emerald'],
  ]);

  // icon_url hash → phase (from csgo-doppler-phase + csgo-trader, extended)
  // Key = the icon_url value from Steam inventory API description
  const ICON_PHASE_MAP = new Map();
  // Build from the csgo-doppler-phase library data (subset for common knives)
  // We also match by checking the <img> src on the item tile
  const PHASE_DB = {
    // Skeleton Knife (confirmed by user)
    '★ Skeleton Knife | Doppler': {
      'i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL6kJ_m-B1I5PeibbBiLs-SA1iUzv5mvOR7cDm7lA4i4QKJk4jxNWWTZg5zDpV4R-QOsEO7lNa2NL_h41Da34tCyCiqhyxN6yxv4OoBVqcs5OSJ2Fw1OS4C': 'Phase 2',
    },
  };
  for (const [knife, phases] of Object.entries(PHASE_DB))
    for (const [hash, phase] of Object.entries(phases))
      ICON_PHASE_MAP.set(hash, { knife, phase });

  function detectPhaseFromIconUrl(name, iconUrl) {
    if (!isDopplerItem(name) || !iconUrl) return null;
    const match = ICON_PHASE_MAP.get(iconUrl);
    if (match) return match.phase;
    return null;
  }

  // Check if item is an actual Doppler weapon (not sticker/patch/graffiti)
  function isDopplerItem(name) {
    if (!name || !name.includes('Doppler')) return false;
    if (name.startsWith('Sticker') || name.startsWith('Patch') || name.startsWith('Sealed') || name.startsWith('Graffiti')) return false;
    return name.includes(' | Doppler') || name.includes(' | Gamma Doppler');
  }

  // ── Asset ID / Item name ──────────────────────────────────
  function getAssetId(el) {
    if (el.id) { const m = el.id.match(/(\d+)_(\d+)_(\d+)/); if (m) return m[3]; }
    const link = el.querySelector('a.inventory_item_link');
    if (link) { const h = (link.getAttribute('href') || '').match(/(\d+)_(\d+)_(\d+)/); if (h) return h[3]; }
    return el.dataset?.id || el.dataset?.assetid || null;
  }
  function getItemName(el) {
    const aid = getAssetId(el); if (!aid) return null;
    const d = invDescs.get(aid); if (d?.market_hash_name) return d.market_hash_name;
    if (nameCache.has(aid)) return nameCache.get(aid);
    // Fallback: get name from the item's rgItem data (trade pages)
    const nameEl = el.querySelector('.item_desc_name, .trade_item_title');
    if (nameEl?.textContent) return nameEl.textContent.trim();
    // Fallback: data-hash-name attribute
    const hashName = el.getAttribute('data-hash-name') || el.dataset?.hashName;
    if (hashName) return hashName;
    return null;
  }
  function readPageAssets() {
    const el = document.getElementById('rw-asset-dump'); if (!el) return;
    try { for (const [id, name] of Object.entries(JSON.parse(el.textContent || '{}'))) nameCache.set(id, name); } catch(e) {}
    // Also read full descriptions (trade pages)
    const el2 = document.getElementById('rw-descs-dump'); if (!el2) return;
    try {
      const descs = JSON.parse(el2.textContent || '{}');
      for (const [id, desc] of Object.entries(descs)) {
        if (!invDescs.has(id) && desc.market_hash_name) invDescs.set(id, desc);
      }
    } catch(e) {}
  }
  document.addEventListener('rw-assets-ready', () => {
    readPageAssets();
    if (IS_INVENTORY) processItems();
    if (IS_TRADEOFFER) processTradeItems();
  });

  // Read item properties (float, paintseed, paintindex, inspect hex) from pageworld
  function readPageProps() {
    const el = document.getElementById('rw-props-dump'); if (!el) return;
    try {
      const props = JSON.parse(el.textContent || '{}');
      let newFloats = 0, newPhases = 0;
      for (const [aid, data] of Object.entries(props)) {
        // Float
        if (data.floatvalue && !floatCache.has(aid)) {
          floatCache.set(aid, { floatvalue: data.floatvalue, paintseed: data.paintseed, paintindex: data.paintindex });
          newFloats++;
        }
        // Charms have no floatvalue but have paintindex — store for template display
        if (!data.floatvalue && data.paintindex && !floatCache.has(aid)) {
          floatCache.set(aid, { paintindex: data.paintindex });
        }
        // Doppler phase from paintindex
        if (data.paintindex && !dopplerPhases.has(aid)) {
          const desc = invDescs.get(aid);
          const name = desc?.market_hash_name || nameCache.get(aid) || '';
          if (isDopplerItem(name)) {
            const phase = PAINT_PHASES.get(data.paintindex);
            if (phase) {
              dopplerPhases.set(aid, { phase });
              newPhases++;
              if (!dopplerPrices.has(aid)) fetchDopplerPrice(aid, name, phase, data.paintindex);
            }
          }
        }
        // Decode inspect hex to get paintindex (needed for Dopplers when propertyid:3 isn't available)
        if (data.inspectHex && typeof InspectDecoder !== 'undefined') {
          const cached = floatCache.get(aid);
          const needsDecode = !cached || (cached.paintindex == null);
          if (needsDecode) {
            const desc2 = invDescs.get(aid);
            const nm = desc2?.market_hash_name || nameCache.get(aid) || '';
            const isDP = isDopplerItem(nm);
            try {
              const result = InspectDecoder.decodeHex(data.inspectHex);
              if (result.paintwear != null) {
                floatCache.set(aid, { floatvalue: result.paintwear, paintindex: result.paintindex, paintseed: result.paintseed });
                if (!cached) newFloats++;
                const dname = invDescs.get(aid)?.market_hash_name || nameCache.get(aid) || '';
                if (isDopplerItem(dname) && result.paintindex && !dopplerPhases.has(aid)) {
                  const phase = PAINT_PHASES.get(result.paintindex);
                  if (phase) { dopplerPhases.set(aid, { phase }); newPhases++; if (!dopplerPrices.has(aid)) fetchDopplerPrice(aid, dname, phase, result.paintindex); }
                  else if (isDP) console.log(`[Riftwalk] paintindex ${result.paintindex} not in PAINT_PHASES map`);
                }
              } else if (isDP) {
                console.log(`[Riftwalk] Decode returned null paintwear for Doppler`);
              }
            } catch(e) { console.error(`[Riftwalk] Props decode error for ${aid}:`, e.message); }
          }
        }
      }
      if (newFloats > 0 || newPhases > 0) {
        console.log(`[Riftwalk] Properties: ${newFloats} floats, ${newPhases} Doppler phases from Steam data`);
        if (newPhases > 0) saveDopplerCache();
        processItems();
      }
    } catch(e) {}
  }
  document.addEventListener('rw-props-ready', () => {
    readPageProps();
    if (IS_TRADEOFFER) processTradeItems();
  });

  // ── SteamID ───────────────────────────────────────────────
  function getProfileSteamId() {
    if (currentOwnerSteamId) return currentOwnerSteamId;
    const m = location.href.match(/\/profiles\/(\d{17})/);
    if (m) { currentOwnerSteamId = m[1]; return m[1]; }
    const iteminfo = document.querySelector('[data-featuretarget="iteminfo"]');
    if (iteminfo) { try { const p = JSON.parse(iteminfo.dataset.props || '{}'); if (p.steamidOwner) { currentOwnerSteamId = p.steamidOwner; return p.steamidOwner; } } catch(e) {} }
    const pw = document.getElementById('rw-owner-steamid');
    if (pw?.dataset?.sid?.length >= 17) { currentOwnerSteamId = pw.dataset.sid; return pw.dataset.sid; }
    return null;
  }
  document.addEventListener('rw-owner-ready', () => {
    const el = document.getElementById('rw-owner-steamid'); const sid = el?.dataset?.sid;
    if (sid?.length >= 17 && sid !== currentOwnerSteamId) { currentOwnerSteamId = sid; if (IS_INVENTORY && invDescs.size === 0 && !inventoryLoading) { inventoryLoading = true; fetchAllDescriptions(sid); } }
    // Retry SteamID button now that we have the owner
    if ((IS_PROFILE || IS_INVENTORY) && !document.querySelector('.rw-steamid-btn')) addSteamIdButton();
  });
  function getViewerSteamId() { const el = document.getElementById('rw-viewer-steamid'); return (el?.dataset?.sid?.length >= 17) ? el.dataset.sid : null; }
  async function resolveVanityUrl() {
    const m = location.pathname.match(/\/id\/([^/]+)/); if (!m) return null;
    try { const r = await fetch(`https://steamcommunity.com/id/${m[1]}/?xml=1`); const t = await r.text(); const s = t.match(/<steamID64>(\d{17})<\/steamID64>/); return s?.[1] || null; } catch(e) { return null; }
  }

  // ── Stickers / Lock ───────────────────────────────────────
  function getStickers(desc) {
    if (!desc) return [];
    for (const d of [...(desc.descriptions || []), ...(desc.fraudwarnings || [])]) {
      const val = d.value || '';
      if (!val.includes('ticker') && !val.includes('Charm') && !val.includes('atch')) continue;
      const text = val.replace(/<[^>]*>/g, '').trim();
      let type = 'sticker', names = [];
      if (text.startsWith('Sticker:')) { type = 'sticker'; names = text.replace('Sticker:', '').split(',').map(s => s.trim()).filter(Boolean); }
      else if (text.startsWith('Charm:')) { type = 'charm'; names = text.replace('Charm:', '').split(',').map(s => s.trim()).filter(Boolean); }
      else if (text.startsWith('Patch:')) { type = 'patch'; names = text.replace('Patch:', '').split(',').map(s => s.trim()).filter(Boolean); }
      else continue;
      const imgs = []; const re = /src="([^"]+)"/gi; let mm;
      while ((mm = re.exec(val))) imgs.push(mm[1]);
      const stickers = []; for (let i = 0; i < names.length; i++) stickers.push({ name: names[i], img: imgs[i] || '', type });
      if (stickers.length) return stickers;
    }
    return [];
  }
  function getTradeLock(desc) {
    if (!desc) return null;
    for (const d of [...(desc.descriptions || []), ...(desc.owner_descriptions || [])]) {
      const val = d.value || '';
      // Match "transferred until May 03, 2026 (7:00:00) GMT" or "Tradable After May 03, 2026"
      const m = val.match(/(?:transferred until|Tradable After|Tradable\/Marketable After)\s+([A-Za-z]+ \d+,?\s*\d{4})/i);
      if (m) {
        const ts = new Date(m[1]).getTime();
        if (ts > Date.now()) return ts;
      }
    }
    return null;
  }

  // ── CSS (unchanged from v1.8) ─────────────────────────────
  function injectCSS() {
    if (document.getElementById('rw-css')) return;
    const s = document.createElement('style'); s.id = 'rw-css';
    s.textContent = `
      .rw-price{position:absolute;bottom:0;left:0;right:0;text-align:center;background:linear-gradient(transparent,rgba(0,0,0,.85));color:#66c0f4;font-size:11px;font-weight:700;padding:4px 3px 2px;pointer-events:auto;z-index:50;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-family:'Motiva Sans',Arial,sans-serif;cursor:pointer;text-decoration:none;display:block}
      .rw-price:hover{text-decoration:underline}
      .rw-float-text{position:absolute;bottom:16px;left:0;right:0;text-align:center;color:#aaa;font-size:9px;font-weight:400;pointer-events:none;z-index:90;font-family:'Motiva Sans',Arial,sans-serif}
      .rw-pattern{font-size:8px;font-weight:700;pointer-events:none;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,.7);color:#8ba3b8;font-family:'Motiva Sans',Arial,sans-serif}
      .rw-fade{font-size:7px;font-weight:700;pointer-events:none;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,.7);font-family:'Motiva Sans',Arial,sans-serif;letter-spacing:.3px}
      .rw-fade-100{color:#FFD700}.rw-fade-95{color:#FFA500}.rw-fade-90{color:#e8a832}.rw-fade-low{color:#8ba3b8}
      .rw-bluegem{font-size:7px;font-weight:700;pointer-events:none;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,.7);font-family:'Motiva Sans',Arial,sans-serif;letter-spacing:.3px}
      .rw-bluegem-scar{color:#00BFFF}.rw-bluegem-t1{color:#00BFFF}.rw-bluegem-t2{color:#4d94ff}.rw-bluegem-t3{color:#7ab8ff}
      .rw-pattern-row{position:absolute;top:2px;left:2px;display:flex;align-items:center;gap:3px;pointer-events:none;z-index:91}
      .rw-price.doppler{color:#E91E8C}.rw-price.na{color:#555;font-weight:400;font-size:10px;cursor:default}.rw-price.na:hover{text-decoration:none}.rw-price.csfloat{color:#4CAF50}
      .rw-phase{position:absolute;top:2px;left:2px;font-size:8px;font-weight:700;pointer-events:none;z-index:91;text-transform:uppercase;letter-spacing:.5px;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,.7)}
      .rw-lock{position:absolute;bottom:2px;right:2px;background:rgba(231,76,60,.85);color:#fff;font-size:8px;font-weight:700;padding:1px 4px;border-radius:2px;pointer-events:none;z-index:92}
      .rw-sticker-dots{position:absolute;bottom:30px;left:50%;transform:translateX(-50%);display:flex;gap:2px;pointer-events:none;z-index:91}
      .rw-sticker-dot{width:5px;height:5px;border-radius:50%;background:rgba(102,192,244,.5)}
      .rw-sticker-dot.patch{background:rgba(232,168,50,.7)}
      .rw-ext{position:absolute;top:2px;right:2px;font-size:8px;font-weight:700;pointer-events:none;z-index:91;padding:1px 4px;border-radius:2px;background:rgba(0,0,0,.7);color:#8ba3b8;letter-spacing:.3px}
      .rw-dup{position:absolute;bottom:17px;right:3px;font-size:9px;font-weight:700;pointer-events:none;z-index:91;color:rgba(102,192,244,.7);font-family:'Motiva Sans',Arial,sans-serif}
      .rw-rarity-border{box-shadow:inset 0 0 0 2px var(--rw-rarity-color,transparent)}
      #rw-bar{z-index:9999;background:linear-gradient(180deg,#0d1b2a,#0a1520);border:1px solid rgba(102,192,244,.15);border-radius:6px;box-shadow:0 2px 16px rgba(0,0,0,.5);margin:8px 14px;position:relative}
      #rw-bar-inner{display:flex;align-items:center;gap:10px;padding:8px 16px;font-family:'Motiva Sans',Arial,sans-serif;flex-wrap:nowrap}
      .rw-logo{font-size:13px;font-weight:700;letter-spacing:2px;color:#c7d5e0}.rw-logo b{color:#66c0f4}
      .rw-sep{width:1px;height:20px;background:rgba(102,192,244,.15)}.rw-total{font-size:15px;font-weight:700;color:#66c0f4}
      .rw-count{font-size:11px;color:#4a7a99}.rw-spacer{flex:1}
      .rw-btn{background:transparent;border:1px solid rgba(102,192,244,.2);color:#66c0f4;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;transition:all .15s;white-space:nowrap}
      .rw-btn:hover{border-color:#66c0f4;background:rgba(102,192,244,.08)}.rw-btn.on{background:#66c0f4;color:#0d1b2a;border-color:#66c0f4}
      #rw-search{background:#0a0e14;border:1px solid rgba(102,192,244,.15);border-radius:4px;color:#c7d5e0;padding:4px 8px;font-size:11px;outline:none;width:120px;font-family:'Motiva Sans',Arial,sans-serif}
      #rw-search:focus{border-color:#66c0f4}#rw-search::placeholder{color:#445}
      #rw-sticker-popup{display:none;position:fixed;z-index:999999;background:#0d1b2a;border:1px solid rgba(102,192,244,.2);border-radius:8px;padding:12px 14px;min-width:240px;max-width:360px;box-shadow:0 8px 32px rgba(0,0,0,.7);font-family:'Motiva Sans',Arial,sans-serif;pointer-events:none}
      #rw-sticker-popup h4{font-size:11px;color:#66c0f4;font-weight:700;margin-bottom:8px;padding-bottom:6px;border-bottom:1px solid rgba(102,192,244,.1)}
      .rw-stk-row{display:flex;align-items:center;gap:8px;padding:4px 0;border-bottom:1px solid rgba(255,255,255,.03)}
      .rw-stk-img{width:48px;height:36px;object-fit:contain;flex-shrink:0;background:rgba(255,255,255,.03);border-radius:3px}
      .rw-stk-info{flex:1;min-width:0}.rw-stk-name{color:#c7d5e0;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rw-stk-val{color:#66c0f4;font-weight:700;font-size:11px;white-space:nowrap}
      .rw-stk-total{color:#4CAF50;font-weight:700;font-size:12px;margin-top:6px;text-align:right;padding-top:6px;border-top:1px solid rgba(102,192,244,.1)}
      .rw-float-popup{display:none;position:fixed;z-index:999999;background:#0d1b2a;border:1px solid rgba(102,192,244,.2);border-radius:8px;padding:10px 14px;min-width:200px;box-shadow:0 8px 32px rgba(0,0,0,.7);font-family:'Motiva Sans',Arial,sans-serif;pointer-events:none}
      .rw-fl-row{display:flex;justify-content:space-between;gap:12px;padding:2px 0;font-size:11px}.rw-fl-label{color:#8ba3b8}.rw-fl-value{color:#c7d5e0;font-weight:600;font-family:monospace}
      #rw-trade-bar{background:linear-gradient(180deg,#0d1b2a,#0a1520);border:1px solid rgba(102,192,244,.15);border-radius:6px;margin:8px 0}
      #rw-trade-bar-inner{display:flex;align-items:center;gap:20px;padding:10px 20px;font-family:'Motiva Sans',Arial,sans-serif}
      .rw-ts{text-align:center;min-width:80px}.rw-ts-label{font-size:10px;color:#4a7a99;text-transform:uppercase;letter-spacing:.08em;margin-bottom:3px}
      .rw-ts-val{font-size:16px;font-weight:700;color:#66c0f4}.rw-profit-pos{color:#4CAF50!important}.rw-profit-neg{color:#e74c3c!important}.rw-arrow{color:#4a7a99;font-size:18px}
      .rw-steamid-btn{display:inline-flex;align-items:center;gap:5px;background:rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.2);color:#66c0f4;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;transition:all .15s;font-family:'Motiva Sans',Arial,sans-serif}
      .rw-steamid-btn:hover{background:rgba(102,192,244,.2);border-color:#66c0f4}.rw-steamid-btn.copied{background:rgba(76,175,80,.15);border-color:#4CAF50;color:#4CAF50}
      .rw-btn-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
      #rw-search-results{display:none;position:absolute;top:100%;left:0;right:0;background:#0a0e14;border:1px solid rgba(102,192,244,.2);border-radius:0 0 6px 6px;max-height:320px;overflow-y:auto;z-index:10000;font-family:'Motiva Sans',Arial,sans-serif;box-shadow:0 8px 24px rgba(0,0,0,.6)}
      .rw-sr-row{display:flex;align-items:center;gap:8px;padding:6px 16px;cursor:pointer;transition:background .1s;border-bottom:1px solid rgba(102,192,244,.05)}
      .rw-sr-row:hover{background:rgba(102,192,244,.08)}
      .rw-sr-name{flex:1;font-size:11px;color:#c7d5e0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .rw-sr-count{font-size:9px;color:#66c0f4;font-weight:700}
      .rw-sr-price{font-size:11px;font-weight:700;color:#66c0f4;white-space:nowrap}
      .rw-sr-total{padding:6px 16px;font-size:10px;color:#556;text-align:center;border-top:1px solid rgba(102,192,244,.1)}
      .rw-sr-empty{padding:12px 16px;font-size:11px;color:#556;text-align:center}
      .rw-selected{outline:2px solid #66c0f4!important;outline-offset:-2px}
      #rw-select-bar{display:none;position:fixed;bottom:16px;left:50%;transform:translateX(-50%);background:#0d1b2a;border:1px solid rgba(102,192,244,.3);border-radius:8px;padding:10px 20px;z-index:99999;font-family:'Motiva Sans',Arial,sans-serif;box-shadow:0 4px 24px rgba(0,0,0,.7);display:none;flex-direction:column;align-items:center;gap:8px;max-width:90vw}
      #rw-select-bar.visible{display:flex}
      .rw-sel-thumbs{display:flex;gap:4px;flex-wrap:wrap;justify-content:center;max-width:600px}
      .rw-sel-thumb{width:48px;height:48px;border-radius:4px;border:1px solid rgba(102,192,244,.2);background:#0a0e14;object-fit:contain;cursor:pointer;transition:border-color .15s}
      .rw-sel-thumb:hover{border-color:#e74c3c}
      .rw-sel-info{display:flex;align-items:center;gap:14px}
      .rw-sel-count{font-size:12px;color:#8ba3b8}.rw-sel-count b{color:#66c0f4}
      .rw-sel-total{font-size:16px;font-weight:700;color:#66c0f4}
      .rw-sel-clear{background:transparent;border:1px solid rgba(102,192,244,.2);color:#66c0f4;padding:4px 10px;border-radius:4px;cursor:pointer;font-size:11px;font-weight:600;font-family:inherit}
      .rw-sel-clear:hover{border-color:#e74c3c;color:#e74c3c}
      .rw-ctrl-hint{font-size:10px;color:#445;margin-left:6px;font-style:italic}
      .rw-offer-total{background:linear-gradient(180deg,#0d1b2a,#0a1520);border:1px solid rgba(102,192,244,.15);border-radius:4px;padding:6px 14px;margin:6px 0;font-family:'Motiva Sans',Arial,sans-serif;font-size:12px;display:flex;gap:10px;align-items:center}
      .rw-edit-btn{position:absolute;bottom:8px;right:7px;cursor:pointer;z-index:92;opacity:.4;transition:opacity .15s;pointer-events:auto;width:10px;height:10px}
      .rw-edit-btn:hover{opacity:1}
      .rw-edit-btn svg{width:10px;height:10px;fill:none;stroke:#c7d5e0;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}

    `;
    document.head.appendChild(s);
  }

  // ── Inventory fetch ───────────────────────────────────────
  async function fetchAllDescriptions(steamId) {
    let startAsset = null, page = 0;
    while (true) {
      page++;
      let url = `https://steamcommunity.com/inventory/${steamId}/730/2?l=english&count=500`;
      if (startAsset) url += `&start_assetid=${startAsset}`;
      let data = null;
      for (let retry = 0; retry < 4; retry++) {
        try {
          const res = await fetch(url);
          if (res.ok) { data = await res.json(); break; }
          if (res.status >= 500 || res.status === 429 || res.status === 403) await new Promise(r => setTimeout(r, (retry + 1) * 3000));
          else return;
        } catch(e) { await new Promise(r => setTimeout(r, 3000)); }
      }
      if (!data?.assets || !data?.descriptions) return;
      const dm = new Map();
      for (const d of data.descriptions) dm.set(`${d.classid}_${d.instanceid}`, d);
      for (const a of data.assets) { const d = dm.get(`${a.classid}_${a.instanceid}`); if (d) invDescs.set(a.assetid, d); }
      console.log(`[Riftwalk] Page ${page}: +${data.assets.length} (total: ${invDescs.size})`);
      detectDopplersFromIconUrl();
      processItems();
      if (!data.more_items || !data.last_assetid) {
        console.log(`[Riftwalk] Inventory ctx2 complete: ${invDescs.size}`);
        setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 500);
        setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 3000);
        // Also fetch context 16 (trade-locked items) — only on own inventory
        const viewerSid = document.getElementById('rw-viewer')?.textContent || '';
        const isOwn = viewerSid && viewerSid === steamId;
        const hasEditProfile = document.querySelector('.profile_edit_link, [href*="edit/info"]');
        if (isOwn || hasEditProfile) fetchContext16(steamId);
        return;
      }
      startAsset = data.last_assetid;
      await new Promise(r => setTimeout(r, 1500));
    }
  }

  // Phase name → paint_index for CSFloat query
  const PHASE_PAINT_INDEX = {
    'Phase 1': 418, 'Phase 2': 419, 'Phase 3': 420, 'Phase 4': 421,
    'Ruby': 415, 'Sapphire': 416, 'Black Pearl': 417, 'Emerald': 568,
  };

  async function fetchContext16(steamId) {
    try {
      const url = `https://steamcommunity.com/inventory/${steamId}/730/16?l=english&count=500`;
      const res = await fetch(url);
      if (!res.ok) return;
      const data = await res.json();
      if (!data?.assets || !data?.descriptions) return;
      const dm = new Map();
      for (const d of data.descriptions) dm.set(`${d.classid}_${d.instanceid}`, d);
      for (const a of data.assets) { const d = dm.get(`${a.classid}_${a.instanceid}`); if (d) invDescs.set(a.assetid, d); }
      console.log(`[Riftwalk] Context 16: +${data.assets.length} trade-locked items`);
      processItems();
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 500);
    } catch(e) {}
  }

  // ── Detect ALL Dopplers from icon_url (instant) ───────────
  async function detectDopplersFromIconUrl() {
    // Load cached doppler data first
    try {
      const cached = await chrome.storage.local.get(['rw_doppler_cache']);
      const dc = cached.rw_doppler_cache || {};
      for (const [aid, data] of Object.entries(dc)) {
        if (data.phase) dopplerPhases.set(aid, { phase: data.phase });
        if (data.price) dopplerPrices.set(aid, data.price);
      }
      if (Object.keys(dc).length) console.log(`[Riftwalk] Loaded ${Object.keys(dc).length} cached Doppler phases`);
    } catch(e) {}

    invDescs.forEach((desc, aid) => {
      if (dopplerPhases.has(aid)) return;
      const name = desc.market_hash_name || '';
      if (!isDopplerItem(name)) return;
      const iconUrl = desc.icon_url || '';
      const phase = detectPhaseFromIconUrl(name, iconUrl);
      if (phase) {
        dopplerPhases.set(aid, { phase });
        console.log(`[Riftwalk] ${name} → ${phase} (from icon_url)`);
        if (!dopplerPrices.has(aid)) fetchDopplerPrice(aid, name, phase);
      } else {
        console.log(`[Riftwalk] ${name} → phase unknown (icon not in DB), will detect on click`);
      }
    });
  }

  function saveDopplerCache() {
    const dc = {};
    dopplerPhases.forEach((data, aid) => {
      dc[aid] = { phase: data.phase, price: dopplerPrices.get(aid) || null };
    });
    chrome.storage.local.set({ rw_doppler_cache: dc });
  }

  // ── Doppler pricing via CSFloat listings ──────────────────
  // Phase name → all possible paint_indices for CSFloat query
  const PHASE_ALL_INDICES = {};
  PAINT_PHASES.forEach((phase, pi) => {
    if (!PHASE_ALL_INDICES[phase]) PHASE_ALL_INDICES[phase] = [];
    PHASE_ALL_INDICES[phase].push(pi);
  });

  const dopplerPriceCache = new Map(); // "weapon|phase" -> price in cents
  async function fetchDopplerPrice(aid, marketHashName, phase, actualPaintIndex) {
    if (settings.enableDopplerPrices === false || dopplerPrices.has(aid)) return;
    // Check weapon+phase cache first — no need to re-fetch same combo
    const cacheKey = `${marketHashName}|${phase}`;
    if (dopplerPriceCache.has(cacheKey)) {
      dopplerPrices.set(aid, dopplerPriceCache.get(cacheKey));
      saveDopplerCache();
      const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
      if (el) { const tag = el.querySelector('.rw-price'); if (tag) { tag.textContent = fmt(dopplerPriceCache.get(cacheKey)); tag.className = 'rw-price csfloat'; } }
      return;
    }

    // Skinport mode: look up from cached Skinport Doppler data (no API call needed)
    if (settings.pricingMode === 'skinport') {
      try {
        const spData = await chrome.storage.local.get(['rw_skinport_dopplers']);
        const spDopplers = spData.rw_skinport_dopplers || {};
        const spKey = `${marketHashName}|${phase}`;
        if (spDopplers[spKey]) {
          const price = spDopplers[spKey];
          dopplerPrices.set(aid, price);
          dopplerPriceCache.set(cacheKey, price);
          console.log(`[Riftwalk] Doppler ${phase} price from Skinport: ${fmt(price)}`);
          saveDopplerCache();
          const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
          if (el) { const tag = el.querySelector('.rw-price'); if (tag) { tag.textContent = fmt(price); tag.className = 'rw-price csfloat'; } }
          dopplerPhases.forEach((dp, otherId) => {
            if (otherId !== aid && dp.phase === phase && !dopplerPrices.has(otherId)) {
              const otherDesc = invDescs.get(otherId) || { market_hash_name: nameCache.get(otherId) };
              if (otherDesc?.market_hash_name === marketHashName) dopplerPrices.set(otherId, price);
            }
          });
          processItems();
        } else {
          console.log(`[Riftwalk] No Skinport Doppler price for ${spKey}`);
        }
      } catch(e) { console.warn('[Riftwalk] Skinport Doppler lookup error:', e); }
      return;
    }

    // PricEmpire + CSFloat mode: query CSFloat API
    try {
      const settingsData = await chrome.storage.local.get(['rw_settings']);
      const csfloatKey = settingsData.rw_settings?.csfloatKey || '';
      const headers = {};
      if (csfloatKey) headers['Authorization'] = csfloatKey;

      // If we have the actual paintindex, use it directly. Otherwise try all known indices for this phase.
      const indicesToTry = actualPaintIndex ? [actualPaintIndex] : (PHASE_ALL_INDICES[phase] || [PHASE_PAINT_INDEX[phase]]);
      
      let bestPrice = null;
      for (const pi of indicesToTry) {
        if (!pi) continue;
        const params = new URLSearchParams({ market_hash_name: marketHashName, sort_by: 'lowest_price', limit: '1', type: 'buy_now', paint_index: pi.toString() });
        const url = `https://csfloat.com/api/v1/listings?${params}`;
        const r = await chrome.runtime.sendMessage({ type: 'FETCH', url, options: { headers } });
        if (r?.success && r.data) {
          const listings = Array.isArray(r.data) ? r.data : (Array.isArray(r.data.data) ? r.data.data : []);
          if (listings.length > 0 && listings[0].price) {
            // CSFloat returns USD cents — convert to user's currency
            bestPrice = convertFromUSD(listings[0].price);
            console.log(`[Riftwalk] Doppler ${phase} price via pi=${pi}: ${fmt(bestPrice)}`);
            break; // Found a listing, use it
          }
        }
      }

      if (bestPrice) {
          dopplerPrices.set(aid, bestPrice);
          dopplerPriceCache.set(cacheKey, bestPrice);
          console.log(`[Riftwalk] Doppler ${phase || 'generic'} final price: ${fmt(bestPrice)}`);
          saveDopplerCache();
          const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
          if (el) { const tag = el.querySelector('.rw-price'); if (tag) { tag.textContent = fmt(bestPrice); tag.className = 'rw-price csfloat'; } }
          // Apply cached price to all other items with same weapon+phase
          dopplerPhases.forEach((dp, otherId) => {
            if (otherId !== aid && dp.phase === phase && !dopplerPrices.has(otherId)) {
              const otherDesc = invDescs.get(otherId) || { market_hash_name: nameCache.get(otherId) };
              if (otherDesc?.market_hash_name === marketHashName) {
                dopplerPrices.set(otherId, bestPrice);
              }
            }
          });
          processItems();
      }
    } catch(e) { console.warn('[Riftwalk] Doppler price error:', e); }
  }

  // ── Float: read from Steam DOM when item is clicked ────────
  let lastPanelHtml = '';
  function setupDetailPanelObserver() {
    const target = document.querySelector('.inventory_page_right') || document.querySelector('#iteminfo0')?.parentElement;
    if (!target) { setTimeout(setupDetailPanelObserver, 2000); return; }

    // Initial injection for the first item that's auto-selected on page load
    function tryInitialInject() {
      const p = document.querySelector('#iteminfo0[style*="display: block"]') || document.querySelector('#iteminfo1[style*="display: block"]');
      if (p && !p.querySelector('.rw-inspect-browser')) {
        const il = p.querySelectorAll('a[href*="csgo_econ_action_preview"]');
        if (il.length > 0) {
          const link = il[0].getAttribute('href') || '';
          const url = `https://3d.skinport.com/?link=${encodeURIComponent(link)}`;
          const btn = document.createElement('a'); btn.href = url; btn.target = '_blank'; btn.className = 'rw-inspect-browser'; btn.textContent = 'Inspect in Browser';
          btn.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 12px;background:rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.25);border-radius:4px;color:#66c0f4;font-size:12px;cursor:pointer;text-decoration:none;transition:all .15s;vertical-align:middle';
          btn.onmouseenter = () => { btn.style.background = 'rgba(102,192,244,.2)'; btn.style.borderColor = '#66c0f4'; };
          btn.onmouseleave = () => { btn.style.background = 'rgba(102,192,244,.1)'; btn.style.borderColor = 'rgba(102,192,244,.25)'; };
          il[0].parentElement.insertBefore(btn, il[0].nextSibling);
          return true;
        }
      }
      return false;
    }
    setTimeout(() => { if (!tryInitialInject()) setTimeout(() => { if (!tryInitialInject()) setTimeout(tryInitialInject, 1000); }, 500); }, 1000);

    new MutationObserver(() => {
      // Only process if the panel content actually changed
      const panel = document.querySelector('#iteminfo0[style*="display: block"]') || document.querySelector('#iteminfo1[style*="display: block"]');
      if (!panel) return;
      const panelText = panel.querySelector('h1 span')?.textContent || '';
      if (!panelText) return; // panel not rendered yet, wait for next mutation
      if (panelText === lastPanelHtml) {
        // Same item (name unchanged) — but Steam may have just resolved the
        // inspect link in-place (the %propid:6% placeholder becomes real hex).
        // This happens for items whose properties weren't preloaded (later
        // inventory pages). If we still lack a float for this item, retry the
        // decode now that the resolved hex may be present.
        const activeItemSame = document.querySelector('.item.app730.activeInfo');
        const aidSame = activeItemSame ? getAssetId(activeItemSame) : null;
        if (aidSame && !floatCache.has(aidSame) && typeof InspectDecoder !== 'undefined') {
          const links = panel.querySelectorAll('a[href*="csgo_econ_action_preview"]');
          for (const a of links) {
            const m = (a.getAttribute('href') || '').match(/csgo_econ_action_preview%20([0-9A-Fa-f]{20,})/);
            if (!m) continue; // still the placeholder, not resolved yet
            try {
              const result = InspectDecoder.decodeHex(m[1]);
              if (result.paintwear != null) {
                floatCache.set(aidSame, { floatvalue: result.paintwear, paintindex: result.paintindex, paintseed: result.paintseed });
                applyFloatToDOM(aidSame, floatCache.get(aidSame));
                const nm = getItemName(activeItemSame) || '';
                if (isDopplerItem(nm) && result.paintindex && !dopplerPhases.has(aidSame)) {
                  const phase = PAINT_PHASES.get(result.paintindex);
                  if (phase) {
                    dopplerPhases.set(aidSame, { phase });
                    if (!activeItemSame.querySelector('.rw-phase')) {
                      const pb = document.createElement('div'); pb.className = 'rw-phase';
                      pb.style.color = getPhaseColor(phase, nm); pb.textContent = phase; activeItemSame.appendChild(pb);
                    }
                    saveDopplerCache();
                    if (!dopplerPrices.has(aidSame)) fetchDopplerPrice(aidSame, nm, phase, result.paintindex);
                  }
                }
              }
            } catch(e) { /* ignore decode errors, try next link */ }
            break;
          }
        }
        // Same item — but still inject button if missing (handles timing issues)
        if (!panel.querySelector('.rw-inspect-browser')) {
          const il = panel.querySelectorAll('a[href*="csgo_econ_action_preview"]');
          if (il.length > 0) {
            const link = il[0].getAttribute('href') || '';
            const url = `https://3d.skinport.com/?link=${encodeURIComponent(link)}`;
            const b = document.createElement('a'); b.href = url; b.target = '_blank'; b.className = 'rw-inspect-browser'; b.textContent = 'Inspect in Browser';
            b.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 12px;background:rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.25);border-radius:4px;color:#66c0f4;font-size:12px;cursor:pointer;text-decoration:none;transition:all .15s;vertical-align:middle';
            b.onmouseenter = () => { b.style.background = 'rgba(102,192,244,.2)'; b.style.borderColor = '#66c0f4'; };
            b.onmouseleave = () => { b.style.background = 'rgba(102,192,244,.1)'; b.style.borderColor = 'rgba(102,192,244,.25)'; };
            il[0].parentElement.insertBefore(b, il[0].nextSibling);
          } else {
            // Retry after delay
            setTimeout(() => {
              const p = document.querySelector('#iteminfo0[style*="display: block"]') || document.querySelector('#iteminfo1[style*="display: block"]');
              if (p && !p.querySelector('.rw-inspect-browser')) {
                const il2 = p.querySelectorAll('a[href*="csgo_econ_action_preview"]');
                if (il2.length > 0) {
                  const link2 = il2[0].getAttribute('href') || '';
                  const url2 = `https://3d.skinport.com/?link=${encodeURIComponent(link2)}`;
                  const b2 = document.createElement('a'); b2.href = url2; b2.target = '_blank'; b2.className = 'rw-inspect-browser'; b2.textContent = 'Inspect in Browser';
                  b2.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 12px;background:rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.25);border-radius:4px;color:#66c0f4;font-size:12px;cursor:pointer;text-decoration:none;transition:all .15s;vertical-align:middle';
                  b2.onmouseenter = () => { b2.style.background = 'rgba(102,192,244,.2)'; b2.style.borderColor = '#66c0f4'; };
                  b2.onmouseleave = () => { b2.style.background = 'rgba(102,192,244,.1)'; b2.style.borderColor = 'rgba(102,192,244,.25)'; };
                  il2[0].parentElement.insertBefore(b2, il2[0].nextSibling);
                }
              }
            }, 500);
          }
        }
        return;
      }
      lastPanelHtml = panelText;

      // Inject "Inspect in Browser" button — with retry for late-rendering inspect links
      function injectInspectButton(p) {
        const il = p.querySelectorAll('a[href*="csgo_econ_action_preview"]');
        const old = p.querySelector('.rw-inspect-browser');
        if (old) old.remove();
        if (il.length > 0) {
          const link = il[0].getAttribute('href') || '';
          const url = `https://3d.skinport.com/?link=${encodeURIComponent(link)}`;
          const btn = document.createElement('a');
          btn.href = url; btn.target = '_blank'; btn.className = 'rw-inspect-browser'; btn.textContent = 'Inspect in Browser';
          btn.style.cssText = 'display:inline-block;margin-left:8px;padding:4px 12px;background:rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.25);border-radius:4px;color:#66c0f4;font-size:12px;cursor:pointer;text-decoration:none;transition:all .15s;vertical-align:middle';
          btn.onmouseenter = () => { btn.style.background = 'rgba(102,192,244,.2)'; btn.style.borderColor = '#66c0f4'; };
          btn.onmouseleave = () => { btn.style.background = 'rgba(102,192,244,.1)'; btn.style.borderColor = 'rgba(102,192,244,.25)'; };
          il[0].parentElement.insertBefore(btn, il[0].nextSibling);
          return true;
        }
        return false;
      }
      if (!injectInspectButton(panel)) {
        // Inspect link not in DOM yet — retry after Steam finishes rendering
        setTimeout(() => {
          const p2 = document.querySelector('#iteminfo0[style*="display: block"]') || document.querySelector('#iteminfo1[style*="display: block"]');
          if (p2) injectInspectButton(p2);
        }, 500);
      }

      const activeItem = document.querySelector('.item.app730.activeInfo');
      if (!activeItem) return;
      const aid = getAssetId(activeItem);
      if (!aid) return;
      const itemName = getItemName(activeItem) || '';

      const needsPhase = isDopplerItem(itemName) && !dopplerPhases.has(aid);
      if (floatCache.has(aid) && !needsPhase) return;
      if (itemName && panelText && !panelText.includes(itemName.split('|')[0].trim().replace('★ ', ''))) return;


      // Method 1: Decode inspect link hex from DOM
      const links = panel.querySelectorAll('a[href*="csgo_econ_action_preview"]');
      if (links.length === 0) {
        // Try broader search for any link with inspect data
        const allLinks = panel.querySelectorAll('a');
        for (const a of allLinks) {
          const h = a.getAttribute('href') || '';
          if (h.includes('csgo') || h.includes('inspect') || h.includes('preview')) {
          }
        }
      }
      for (const a of links) {
        const href = a.getAttribute('href') || '';
        const m = href.match(/csgo_econ_action_preview%20([0-9A-Fa-f]{20,})/);
        if (!m) {
          continue;
        }
        if (typeof InspectDecoder !== 'undefined') {
          try {
            const result = InspectDecoder.decodeHex(m[1]);
            if (result.paintwear != null) {
              floatCache.set(aid, { floatvalue: result.paintwear, paintindex: result.paintindex, paintseed: result.paintseed });
              applyFloatToDOM(aid, floatCache.get(aid));
              // Doppler: detect phase from paintindex and fetch price if not done yet
              if (isDopplerItem(itemName) && result.paintindex && !dopplerPhases.has(aid)) {
                const phase = PAINT_PHASES.get(result.paintindex);
                if (phase) {
                  dopplerPhases.set(aid, { phase });
                  console.log(`[Riftwalk] ${itemName} → ${phase} (from inspect link, pi=${result.paintindex})`);
                  saveDopplerCache();
                  // Add phase badge
                  if (!activeItem.querySelector('.rw-phase')) {
                    const b = document.createElement('div'); b.className = 'rw-phase';
                    b.style.color = getPhaseColor(phase, itemName); b.textContent = phase; activeItem.appendChild(b);
                  }
                  if (!dopplerPrices.has(aid)) fetchDopplerPrice(aid, itemName, phase, result.paintindex);
                }
              }
              return;
            }
          } catch(e) { console.error(`[Riftwalk] Decode error:`, e); }
        }
      }

      // Method 2: Read Wear Rating from Steam panel text
      for (const span of panel.querySelectorAll('.FYJ4NYxpWeIha0N1-jUcm')) {
        const pt = span.closest('div')?.textContent || '';
        if (pt.includes('Wear Rating')) {
          const val = parseFloat(span.textContent.trim().replace(',', '.'));
          if (!isNaN(val)) {
            floatCache.set(aid, { floatvalue: val });
            applyFloatToDOM(aid, floatCache.get(aid));
            return;
          }
        }
      }
    }).observe(target, { childList: true, subtree: true, attributes: true });
  }

  function applyFloatToDOM(aid, fd) {
    const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
    if (!el || !fd.floatvalue || el.querySelector('.rw-float-text')) return;
    const ft = document.createElement('div'); ft.className = 'rw-float-text';
    ft.textContent = fd.floatvalue.toFixed(4);
    el.appendChild(ft);
  }

  // ── Rarity border colors ────────────────────────────────────
  function getRarityColor(desc) {
    if (!desc) return null;
    const name = desc.market_hash_name || '';
    if (name.startsWith('★')) return '#e4ae39';
    if (!desc.tags) return null;
    for (const tag of desc.tags) {
      if (tag.category === 'Rarity' || tag.category === 'Quality') {
        if (tag.color) return '#' + tag.color;
      }
    }
    return null;
  }

  // ── Exterior abbreviation ─────────────────────────────────
  const EXT_MAP = { 'Factory New': 'FN', 'Minimal Wear': 'MW', 'Field-Tested': 'FT', 'Well-Worn': 'WW', 'Battle-Scarred': 'BS' };
  function getExterior(desc) {
    if (!desc?.tags) return null;
    for (const tag of desc.tags) {
      if (tag.category === 'Exterior') return EXT_MAP[tag.localized_tag_name] || EXT_MAP[tag.name] || tag.localized_tag_name || tag.name;
    }
    return null;
  }

  // ── Duplicate count ───────────────────────────────────────
  let dupCounts = new Map(); // market_hash_name → count
  function computeDuplicates() {
    const counts = new Map();
    invDescs.forEach(desc => {
      const n = desc.market_hash_name; if (!n) return;
      counts.set(n, (counts.get(n) || 0) + 1);
    });
    dupCounts = counts;
  }

  // ── Buff163 market link ───────────────────────────────────
  function getBuffLink(name) {
    if (!name) return null;
    return `https://buff.163.com/market/csgo#tab=selling&page_num=1&search=${encodeURIComponent(name)}`;
  }

  // ── Label item ────────────────────────────────────────────
  function labelItem(el) {
    const aid = getAssetId(el), name = getItemName(el);
    if (getComputedStyle(el).position === 'static') { el.style.position = 'relative'; el.style.overflow = 'hidden'; }
    const price = getPrice(name, aid), isDop = isDopplerItem(name), hasDop = aid && dopplerPrices.has(aid);
    const desc = aid ? invDescs.get(aid) : null;
    const buffUrl = getBuffLink(name);

    // Price tag — clickable to open Buff163
    let tag = el.querySelector('.rw-price');
    const priceClass = 'rw-price' + (hasDop ? ' csfloat' : !price ? ' na' : isDop ? ' doppler' : '');
    if (tag) {
      tag.textContent = price || (name ? '\u2014' : '');
      tag.className = priceClass;
    } else if (name || aid) {
      tag = document.createElement('div');
      tag.className = priceClass; tag.textContent = price || '\u2014'; el.appendChild(tag);
      if (buffUrl && price) {
        tag.addEventListener('click', (e) => { e.stopPropagation(); window.open(buffUrl, '_blank'); });
      }
    }

    if (!aid) return;

    // Rarity border glow
    if (desc && !el.classList.contains('rw-rarity-border')) {
      const rc = getRarityColor(desc);
      if (rc) { el.classList.add('rw-rarity-border'); el.style.setProperty('--rw-rarity-color', rc); }
    }

    // Exterior label (FN/MW/FT/WW/BS) with StatTrak prefix — top right, but not if trade lock is there
    if (desc && !el.querySelector('.rw-ext') && !el.querySelector('.rw-lock')) {
      const ext = getExterior(desc);
      const isST = name && name.includes('StatTrak');
      const isSV = name && name.includes('Souvenir');
      const prefix = isST ? 'ST ' : isSV ? 'SV ' : '';
      if (ext || prefix) {
        const e = document.createElement('div'); e.className = 'rw-ext';
        e.textContent = prefix + (ext || '');
        el.appendChild(e);
      }
    }

    // Duplicate count badge
    if (name && dupCounts.get(name) > 1 && !el.querySelector('.rw-dup')) {
      const d = document.createElement('div'); d.className = 'rw-dup';
      d.textContent = 'x' + dupCounts.get(name); el.appendChild(d);
    }

    // Trade lock
    if (settings.enableTradelock !== false && desc && !el.querySelector('.rw-lock')) {
      const lt = getTradeLock(desc);
      if (lt) {
        const days = Math.ceil((lt - Date.now()) / 86400000);
        const lk = document.createElement('div'); lk.className = 'rw-lock';
        lk.textContent = days + 'd';
        lk.title = 'Tradable after ' + new Date(lt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        el.appendChild(lk);
      }
    }

    // Sticker dots
    if (settings.enableStickers !== false && desc && !el.querySelector('.rw-sticker-dots')) {
      const stk = getStickers(desc);
      if (stk.length) { const dots = document.createElement('div'); dots.className = 'rw-sticker-dots'; stk.forEach(s => { const d = document.createElement('div'); d.className = 'rw-sticker-dot' + (s.type === 'patch' ? ' patch' : ''); dots.appendChild(d); }); el.appendChild(dots); attachStickerHover(el, stk); }
    }

    // Float
    if (settings.enableFloats !== false && aid && floatCache.has(aid)) applyFloatToDOM(aid, floatCache.get(aid));

    // Phase badge — from icon_url detection (instant)
    if (isDop && aid && dopplerPhases.has(aid) && !el.querySelector('.rw-phase')) {
      const dp = dopplerPhases.get(aid);
      const b = document.createElement('div'); b.className = 'rw-phase';
      b.style.color = getPhaseColor(dp.phase, name); b.textContent = dp.phase; el.appendChild(b);
      // Check for Max Pink / Max Blue pattern tier on Dopplers
      if (floatCache.has(aid) && !el.querySelector('.rw-pattern-row') && typeof getPatternTier === 'function') {
        const fd = floatCache.get(aid);
        const pi = fd.paintindex || PHASE_PAINT_INDEX[dp.phase];
        const pt = getPatternTier(desc?.market_hash_name || name || '', fd.paintseed, pi);
        if (pt) {
          const row = document.createElement('div'); row.className = 'rw-pattern-row'; row.style.top = '14px';
          const ptEl = document.createElement('div'); ptEl.className = 'rw-pattern';
          ptEl.style.color = pt.color; ptEl.textContent = pt.label;
          row.appendChild(ptEl); el.appendChild(row);
        }
      }
    }

    // Pattern template + fade/bluegem — same row, top left
    if (aid && floatCache.has(aid) && !el.querySelector('.rw-phase')) {
      const fd = floatCache.get(aid);
      const fullName = (desc?.market_hash_name || name || '');
      const existingRow = el.querySelector('.rw-pattern-row');
      // If row exists but is missing fade badge and item is a Fade, rebuild it
      if (existingRow && !existingRow.querySelector('.rw-fade') && fullName.match(/\| Fade[\s(]/)) {
        existingRow.remove();
      }
      if (!el.querySelector('.rw-pattern-row') && (fd.paintseed != null || (name && name.startsWith('Charm') && fd.paintindex != null))) {
        const isCharm = name && name.startsWith('Charm');
        const seedValue = isCharm ? fd.paintindex : fd.paintseed;
        if (seedValue == null) return;
        const row = document.createElement('div'); row.className = 'rw-pattern-row';
        // Fade %
        let hasFadeBadge = false;
        if (fullName.match(/\| Fade[\s(]/) && typeof getFadePercentage === 'function') {
          const pct = getFadePercentage(fullName, fd.paintseed);
          if (pct != null) {
            const f = document.createElement('div'); f.className = 'rw-fade';
            const cls = pct >= 98 ? 'rw-fade-100' : pct >= 95 ? 'rw-fade-95' : pct >= 90 ? 'rw-fade-90' : 'rw-fade-low';
            f.classList.add(cls);
            f.textContent = Math.round(pct) + '%';
            row.appendChild(f);
            hasFadeBadge = true;
          }
        }
        // Blue Gem tier
        if (!hasFadeBadge && fullName.includes('Case Hardened') && typeof getBlueGemTier === 'function') {
          const tier = getBlueGemTier(fullName, fd.paintseed);
          if (tier) {
            const bg = document.createElement('div'); bg.className = 'rw-bluegem';
            const cls = tier.includes('Scar') ? 'rw-bluegem-scar' : tier === 'Tier 1' ? 'rw-bluegem-t1' : tier === 'Tier 2' ? 'rw-bluegem-t2' : 'rw-bluegem-t3';
            bg.classList.add(cls);
            bg.textContent = '💎 ' + (tier.includes('Scar') ? '#1' : tier.replace('Tier ','T'));
            row.appendChild(bg);
            hasFadeBadge = true;
          }
        }
        // Pattern tier (Max Pink, Max Blue, Fire & Ice, Crimson Web)
        if (!hasFadeBadge && typeof getPatternTier === 'function') {
          const pi = fd.paintindex || (dopplerPhases.get(aid)?.phase ? PHASE_PAINT_INDEX[dopplerPhases.get(aid).phase] : null);
          const pt = getPatternTier(fullName, fd.paintseed, pi);
          if (pt) {
            const ptEl = document.createElement('div'); ptEl.className = 'rw-pattern';
            ptEl.style.color = pt.color; ptEl.textContent = pt.label;
            row.appendChild(ptEl);
            hasFadeBadge = true;
          }
        }
        // Pattern seed — only show if no fade badge (fade already shows the important info)
        if (!hasFadeBadge) {
          const p = document.createElement('div'); p.className = 'rw-pattern';
          p.textContent = '#' + seedValue;
          row.insertBefore(p, row.firstChild);
        }
        el.appendChild(row);
      }
    }

    // Hover popup — only for items WITHOUT stickers (sticker popup already includes float info)
    if (!el.dataset.rwFh) {
      el.dataset.rwFh = '1';
      if (!el.querySelector('.rw-sticker-dots')) {
        el.addEventListener('mouseenter', () => showFloatPopup(el, aid));
        el.addEventListener('mouseleave', hideFloatPopup);
      }
    }
  }

  // ── Popups ────────────────────────────────────────────────
  function attachStickerHover(el, stickers) {
    el.addEventListener('mouseenter', () => {
      let popup = document.getElementById('rw-sticker-popup');
      if (!popup) { popup = document.createElement('div'); popup.id = 'rw-sticker-popup'; document.body.appendChild(popup); }
      let total = 0;
      const itemType = stickers[0]?.type || 'sticker';
      const label = itemType === 'patch' ? 'Patches' : itemType === 'charm' ? 'Charms' : 'Stickers';
      const rows = stickers.map(s => {
        let cents = 0;
        const lookups = [`Sticker | ${s.name}`, `Patch | ${s.name}`, `Charm | ${s.name}`, s.name];
        for (const key of lookups) { const p = priceMap[key]; if (p) { cents = p.buff || p.skins || 0; break; } }
        total += cents;
        const img = s.img ? `<img class="rw-stk-img" src="${s.img}">` : `<div class="rw-stk-img" style="display:flex;align-items:center;justify-content:center;color:#445;font-size:18px">?</div>`;
        return `<div class="rw-stk-row">${img}<div class="rw-stk-info"><div class="rw-stk-name" title="${s.name}">${s.name}</div></div><span class="rw-stk-val">${cents ? fmt(cents) : '\u2014'}</span></div>`;
      }).join('');
      // Also add float/pattern info if available
      const aid = getAssetId(el);
      let infoHtml = '';
      if (aid) {
        const fd = floatCache.get(aid);
        const dp = dopplerPhases.get(aid);
        const itemName = getItemName(el) || '';
        const infoParts = [];
        if (dp) infoParts.push(`<span style="color:${getPhaseColor(dp.phase, itemName)}">${dp.phase}</span>`);
        if (fd?.floatvalue) infoParts.push(`Float: ${fd.floatvalue.toFixed(4)}`);
        if (fd?.paintseed != null) infoParts.push(`Seed: #${fd.paintseed}`);
        if (fd?.paintseed != null && itemName.match(/\| Fade[\s(]/) && typeof getFadePercentage === 'function') {
          const pct = getFadePercentage(itemName, fd.paintseed);
          if (pct != null) infoParts.push(`Fade: ${Math.round(pct)}%`);
        }
        if (fd?.paintseed != null && itemName.includes('Case Hardened') && typeof getBlueGemTier === 'function') {
          const tier = getBlueGemTier(itemName, fd.paintseed);
          if (tier) infoParts.push(`Blue Gem: ${tier}`);
        }
        if (fd?.paintseed != null && typeof getPatternTier === 'function') {
          const pi = fd.paintindex || (dp?.phase ? PHASE_PAINT_INDEX[dp.phase] : null);
          const pt = getPatternTier(itemName, fd.paintseed, pi);
          if (pt) infoParts.push(`<span style="color:${pt.color}">${pt.label}</span>`);
        }
        if (dopplerPrices.has(aid)) infoParts.push(`Phase Price: ${fmt(dopplerPrices.get(aid))}`);
        if (infoParts.length) infoHtml = `<div style="border-top:1px solid rgba(255,255,255,.06);padding-top:6px;margin-top:4px;font-size:11px;color:#8ba3b8;line-height:1.6">${infoParts.join(' <span style="color:#334">|</span> ')}</div>`;
      }
      popup.innerHTML = `<h4>${label} (${stickers.length})</h4>${rows}<div class="rw-stk-total">Total: ${total ? fmt(total) : '\u2014'}</div>${infoHtml}`;
      const r = el.getBoundingClientRect(); let l = r.right + 8; if (l + 280 > innerWidth) l = r.left - 288;
      popup.style.left = Math.max(4, l) + 'px'; popup.style.top = Math.max(4, r.top) + 'px'; popup.style.display = 'block';
    });
    el.addEventListener('mouseleave', () => { const p = document.getElementById('rw-sticker-popup'); if (p) p.style.display = 'none'; });
  }
  function showFloatPopup(el, aid) {
    const fd = floatCache.get(aid); if (!fd) return;
    let popup = document.querySelector('.rw-float-popup');
    if (!popup) { popup = document.createElement('div'); popup.className = 'rw-float-popup'; document.body.appendChild(popup); }
    const rows = [];
    if (fd.floatvalue != null) rows.push(['Float', fd.floatvalue.toFixed(14)]);
    if (fd.paintseed != null) rows.push(['Paint Seed', fd.paintseed]);
    if (fd.paintindex != null) rows.push(['Paint Index', fd.paintindex]);
    const dp = dopplerPhases.get(aid); if (dp) rows.push(['Phase', dp.phase]);
    if (dopplerPrices.has(aid)) rows.push(['Phase Price', fmt(dopplerPrices.get(aid))]);
    // Fade % and Blue Gem in popup
    const itemName = getItemName(el) || '';
    if (fd.paintseed != null && itemName.match(/\| Fade[\s(]/) && typeof getFadePercentage === 'function') {
      const pct = getFadePercentage(itemName, fd.paintseed);
      if (pct != null) rows.push(['Fade %', Math.round(pct * 10) / 10 + '%']);
    }
    if (fd.paintseed != null && itemName.includes('Case Hardened') && typeof getBlueGemTier === 'function') {
      const tier = getBlueGemTier(itemName, fd.paintseed);
      if (tier) rows.push(['Blue Gem', tier]);
    }
    if (fd.paintseed != null && typeof getPatternTier === 'function') {
      const pi = fd.paintindex || (dopplerPhases.get(aid)?.phase ? PHASE_PAINT_INDEX[dopplerPhases.get(aid).phase] : null);
      const pt = getPatternTier(itemName, fd.paintseed, pi);
      if (pt) rows.push(['Pattern', pt.label]);
    }
    popup.innerHTML = rows.map(([l,v]) => `<div class="rw-fl-row"><span class="rw-fl-label">${l}</span><span class="rw-fl-value">${v}</span></div>`).join('');
    const r = el.getBoundingClientRect(); let left = r.right + 8; if (left + 220 > innerWidth) left = r.left - 228;
    popup.style.left = Math.max(4, left) + 'px'; popup.style.top = Math.max(4, r.top) + 'px'; popup.style.display = 'block';
  }
  function hideFloatPopup() { const p = document.querySelector('.rw-float-popup'); if (p) p.style.display = 'none'; }

  // ── Process / Bar / Sort ──────────────────────────────────
  let processItemsPending = false;
  function processItems() {
    readPageAssets();
    computeDuplicates();
    // Collect visible items
    const toLabel = [];
    const pages = document.querySelectorAll('.inventory_page');
    if (pages.length > 0) {
      pages.forEach(page => {
        if (page.style.display === 'none') return;
        page.querySelectorAll('.item.app730').forEach(el => toLabel.push(el));
      });
    } else {
      document.querySelectorAll('.item.app730').forEach(el => toLabel.push(el));
    }
    // If many items visible (search results or initial load), batch to avoid CPU spike
    if (toLabel.length > 100) {
      // Only label unlabeled items first, then fill remaining with re-labels
      const unlabeled = toLabel.filter(el => !el.querySelector('.rw-price'));
      const batch = unlabeled.slice(0, 60);
      batch.forEach(el => labelItem(el));
      // Also re-label some already-priced items to add float/stickers
      const relabel = toLabel.filter(el => el.querySelector('.rw-price') && !el.querySelector('.rw-float-text') && !el.dataset.rwFh).slice(0, 20);
      relabel.forEach(el => labelItem(el));
      if ((unlabeled.length > 60 || relabel.length > 0) && !processItemsPending) {
        processItemsPending = true;
        setTimeout(() => { processItemsPending = false; processItems(); }, 200);
      }
    } else {
      toLabel.forEach(el => labelItem(el));
    }
    // Compute total from invDescs (always has all items, no DOM needed)
    let total = 0, priced = 0, count = 0;
    invDescs.forEach((desc, aid) => { const n = desc.market_hash_name; if (!n) return; count++; const c = getCents(n, aid); if (c) { total += c; priced++; } });
    updateBar(total, count, priced);
    // Save portfolio snapshot tracking
    if (total > 0 && count > 10 && currentOwnerSteamId) {
      // Only save portfolio on OWN inventory (Trade Offers button only shows on your own)
      const isOwnInventory = !!document.querySelector('.new_trade_offer_btn');
      if (!isOwnInventory) return;

      // Save after 30 seconds to allow all items + Doppler prices to load
      if (!portfolioSnapshotSaved) {
        setTimeout(() => {
          let finalTotal = 0, finalCount = 0, finalPriced = 0;
          invDescs.forEach((desc, aid) => { const n = desc.market_hash_name; if (!n) return; finalCount++; const c = getCents(n, aid); if (c) { finalTotal += c; finalPriced++; } });
          savePortfolioSnapshot(finalTotal, finalCount, finalPriced);
          portfolioSnapshotSaved = true;
        }, 30000);
      }
      // Also save on page unload with latest data
      if (!window.__rw_unload_bound) {
        window.__rw_unload_bound = true;
        window.addEventListener('beforeunload', () => {
          let finalTotal = 0, finalCount = 0, finalPriced = 0;
          invDescs.forEach((desc, aid) => { const n = desc.market_hash_name; if (!n) return; finalCount++; const c = getCents(n, aid); if (c) { finalTotal += c; finalPriced++; } });
          if (finalTotal > 0 && finalCount > 10) savePortfolioSnapshot(finalTotal, finalCount, finalPriced);
        });
      }
    }
  }
  function injectBar() {
    if (document.getElementById('rw-bar')) return;
    const bar = document.createElement('div'); bar.id = 'rw-bar';
    bar.innerHTML = `<div id="rw-bar-inner"><span class="rw-logo">RIFT<b>WALK</b></span><div class="rw-sep"></div><span class="rw-total" id="rw-total">\u2014</span><span class="rw-count" id="rw-count"></span><span class="rw-ctrl-hint">Ctrl+click to select</span><div class="rw-spacer"></div><input type="text" id="rw-search" placeholder="\uD83D\uDD0D Filter..."><button class="rw-btn" id="rw-sort">\u25B2 Sort</button><button class="rw-btn" id="rw-copy">\uD83D\uDCCB List</button><button class="rw-btn" id="rw-reload">\u21BB Page</button><button class="rw-btn" id="rw-refresh">\u21BB Prices</button></div>`;
    const invArea = document.querySelector('#inventories, .inventory_ctn, #inventory_logos');
    if (invArea) invArea.insertAdjacentElement('beforebegin', bar);
    else document.body.prepend(bar);
    document.getElementById('rw-sort').onclick = toggleSort;
    document.getElementById('rw-refresh').onclick = () => chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' });
    document.getElementById('rw-reload').onclick = () => {
      // Clear all cached data and re-label everything
      floatCache.clear(); dopplerPhases.clear(); dopplerPrices.clear();
      document.querySelectorAll('.rw-price,.rw-phase,.rw-float-text,.rw-ext,.rw-dup,.rw-pattern-row,.rw-pattern,.rw-fade,.rw-bluegem,.rw-sticker-dots').forEach(e => e.remove());
      document.querySelectorAll('[data-rw-fh],[data-rw-labeled]').forEach(e => { delete e.dataset.rwFh; delete e.dataset.rwLabeled; });
      document.querySelectorAll('.rw-rarity-border').forEach(e => { e.classList.remove('rw-rarity-border'); e.style.removeProperty('--rw-rarity-color'); });
      lastPropsRequest = 0;
      document.dispatchEvent(new CustomEvent('rw-request-dump'));
      setTimeout(() => { document.dispatchEvent(new CustomEvent('rw-request-props')); }, 500);
      setTimeout(() => { processItems(); }, 1000);
      setTimeout(() => { document.dispatchEvent(new CustomEvent('rw-request-props')); processItems(); }, 3000);
    };
    document.getElementById('rw-search').addEventListener('input', filterItems);
    document.getElementById('rw-copy').onclick = copyInventoryList;

    // Add Case Stats button near Trade Offers in the header
    function addCaseStatsHeaderBtn() {
      if (document.getElementById('rw-casestats-header')) return;
      const tradeOffersBtn = document.querySelector('.new_trade_offer_btn');
      if (!tradeOffersBtn) return;

      // Portfolio button
      const portBtn = document.createElement('a');
      portBtn.id = 'rw-portfolio-header';
      portBtn.href = '#';
      portBtn.className = 'btn_darkblue_white_innerfade btn_medium';
      portBtn.innerHTML = '<span>📈 Portfolio</span>';
      portBtn.style.cssText = 'margin-right:8px;cursor:pointer;text-decoration:none';
      portBtn.onclick = (e) => { e.preventDefault(); chrome.runtime.sendMessage({ type: 'OPEN_PORTFOLIO' }); };

      // Case Stats button
      const btn = document.createElement('a');
      btn.id = 'rw-casestats-header';
      btn.href = '#';
      btn.className = 'btn_darkblue_white_innerfade btn_medium';
      btn.innerHTML = '<span>📦 Open Case Stats</span>';
      btn.style.cssText = 'margin-right:8px;cursor:pointer;text-decoration:none';
      btn.onclick = (e) => {
        e.preventDefault();
        const profileUrl = location.pathname.match(/\/(profiles|id)\/[^/]+/)?.[0] || '';
        if (profileUrl) window.open(`https://steamcommunity.com${profileUrl}/inventoryhistory/`, '_blank');
      };

      tradeOffersBtn.parentElement.insertBefore(btn, tradeOffersBtn);
      tradeOffersBtn.parentElement.insertBefore(portBtn, btn);
    }
    setTimeout(addCaseStatsHeaderBtn, 1000);
  }

  // ── Copy inventory list ───────────────────────────────────
  function copyInventoryList() {
    const lines = [];
    const items = []; // {name, count, cents, details}
    const seen = new Map(); // name+details key → index in items
    
    invDescs.forEach((desc, aid) => {
      const n = desc.market_hash_name; if (!n) return;
      const c = getCents(n, aid);
      const fd = floatCache.get(aid);
      
      // Build details string
      const details = [];
      // Phase
      const dp = dopplerPhases.get(aid);
      if (dp) details.push(dp.phase);
      // Float
      if (fd?.floatvalue) details.push('Float: ' + fd.floatvalue.toFixed(4));
      // Fade %
      if (fd?.paintseed != null && n.match(/\| Fade[\s(]/) && typeof getFadePercentage === 'function') {
        const pct = getFadePercentage(n, fd.paintseed);
        if (pct != null) details.push('Fade: ' + Math.round(pct) + '%');
      }
      // Blue Gem
      if (fd?.paintseed != null && n.includes('Case Hardened') && typeof getBlueGemTier === 'function') {
        const tier = getBlueGemTier(n, fd.paintseed);
        if (tier) details.push('Blue Gem ' + tier);
      }
      // Pattern tier
      if (fd?.paintseed != null && typeof getPatternTier === 'function') {
        const pi = fd.paintindex || (dp?.phase ? PHASE_PAINT_INDEX[dp.phase] : null);
        const pt = getPatternTier(n, fd.paintseed, pi);
        if (pt) details.push(pt.label);
      }
      // Pattern seed
      if (fd?.paintseed != null) details.push('#' + fd.paintseed);
      // Stickers
      const stk = getStickers(desc);
      if (stk.length) {
        const type = stk[0]?.type === 'patch' ? 'Patches' : stk[0]?.type === 'charm' ? 'Charms' : 'Stickers';
        const stkCounts = new Map();
        stk.forEach(s => stkCounts.set(s.name, (stkCounts.get(s.name) || 0) + 1));
        const stkStr = [...stkCounts.entries()].map(([name, cnt]) => cnt > 1 ? `${cnt}x ${name}` : name).join(', ');
        details.push(type + ': ' + stkStr);
      }
      
      const detailStr = details.length ? ' [' + details.join(' | ') + ']' : '';
      const key = n + detailStr;
      
      if (seen.has(key)) {
        items[seen.get(key)].count++;
      } else {
        seen.set(key, items.length);
        items.push({ name: n, count: 1, cents: c, details: detailStr });
      }
    });
    
    // Sort by value descending
    items.sort((a, b) => (b.cents * b.count) - (a.cents * a.count));
    
    let totalCents = 0, totalItems = 0;
    for (const item of items) {
      // Skip unpriced items if setting is off
      if (!item.cents && settings.copyUnpriced === false) continue;
      const price = item.cents ? sym() + (item.cents / 100).toFixed(2) : '—';
      const showPrice = settings.copyPrices !== false;
      lines.push(`${item.count > 1 ? item.count + 'x ' : ''}${item.name}${item.details}${showPrice ? ' — ' + price : ''}`);
      totalCents += item.cents * item.count;
      totalItems += item.count;
    }
    lines.push('', `Total: ${sym()}${(totalCents / 100).toFixed(2)} (${items.length} unique, ${totalItems} items)`);
    navigator.clipboard.writeText(lines.join('\n')).then(() => {
      const btn = document.getElementById('rw-copy');
      if (btn) { btn.textContent = '\u2713 Copied!'; btn.classList.add('on'); setTimeout(() => { btn.textContent = '\uD83D\uDCCB List'; btn.classList.remove('on'); }, 2000); }
    });
  }

  // ── Search — lightweight dropdown, no page loading ─────────
  let searchTimeout = null;
  function filterItems() {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const raw = (document.getElementById('rw-search')?.value || '').toLowerCase().trim();
      let dropdown = document.getElementById('rw-search-results');
      if (!raw) { if (dropdown) dropdown.style.display = 'none'; return; }

      // Search invDescs (has ALL items from API, no DOM needed)
      const normalize = s => s.toLowerCase().replace(/[★|()™\-]/g, ' ').replace(/\s+/g, ' ').trim();
      const words = normalize(raw).split(/\s+/).filter(Boolean);
      const results = [];
      invDescs.forEach((desc, aid) => {
        const name = desc.market_hash_name || '';
        const norm = normalize(name);
        if (words.every(w => norm.includes(w))) {
          results.push({ aid, name, cents: getCents(name, aid) });
        }
      });
      results.sort((a, b) => b.cents - a.cents);

      // Create/update dropdown
      if (!dropdown) {
        dropdown = document.createElement('div'); dropdown.id = 'rw-search-results';
        document.getElementById('rw-bar').appendChild(dropdown);
      }
      if (!results.length) {
        dropdown.innerHTML = '<div class="rw-sr-empty">No items found</div>';
        dropdown.style.display = 'block'; return;
      }
      // Group duplicates
      const grouped = new Map();
      for (const r of results) {
        const existing = grouped.get(r.name);
        if (existing) existing.count++;
        else grouped.set(r.name, { ...r, count: 1 });
      }
      dropdown.innerHTML = [...grouped.values()].slice(0, 15).map(r => {
        const price = r.cents ? fmt(r.cents) : '\u2014';
        const countBadge = r.count > 1 ? `<span class="rw-sr-count">x${r.count}</span>` : '';
        return `<div class="rw-sr-row" data-aid="${r.aid}"><span class="rw-sr-name">${r.name}</span>${countBadge}<span class="rw-sr-price">${price}</span></div>`;
      }).join('') + `<div class="rw-sr-total">${results.length} items found</div>`;
      dropdown.style.display = 'block';

      // Click to select item if visible on current page
      dropdown.querySelectorAll('.rw-sr-row').forEach(row => {
        row.addEventListener('click', () => {
          const aid = row.dataset.aid;
          const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
          if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'center' }); el.click(); }
          dropdown.style.display = 'none';
          document.getElementById('rw-search').value = '';
        });
      });
    }, 200);
  }
  // Close dropdown when clicking outside
  document.addEventListener('click', e => {
    const dropdown = document.getElementById('rw-search-results');
    if (dropdown && !e.target.closest('#rw-bar')) dropdown.style.display = 'none';
  });
  function updateBar(total, count, priced) {
    const t = document.getElementById('rw-total'), c = document.getElementById('rw-count');
    if (t) { if (total > 0) t.textContent = 'Total inventory value: ' + sym() + (total/100).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2}); else t.textContent = Object.keys(priceMap).length ? '\u2014' : 'No prices'; }
    if (c) c.textContent = count > 0 ? `${priced} out of ${count} items with a price` : '';
  }
  let sorted = false;
  function toggleSort() {
    if (sorted) { sorted = false; location.reload(); return; }
    sorted = true; document.getElementById('rw-sort')?.classList.toggle('on', true);
    const holders = [...document.querySelectorAll('.itemHolder')].filter(h => h.querySelector('.item.app730'));
    if (!holders.length) return; const parent = holders[0].parentNode; if (!parent) return;
    holders.sort((a,b) => { const ia=a.querySelector('.item.app730'),ib=b.querySelector('.item.app730'); return getCents(getItemName(ib),getAssetId(ib))-getCents(getItemName(ia),getAssetId(ia)); });
    holders.forEach(h => parent.appendChild(h));
    document.querySelectorAll('.inventory_page').forEach(p => { p.style.display=''; p.style.height='auto'; p.style.overflow='visible'; });
    const ctn = parent.closest('.inventory_ctn,#inventories'); if (ctn) { ctn.style.height='auto'; ctn.style.overflow='visible'; }
  }

  // ── Trade ─────────────────────────────────────────────────
  function setupTradeOffer() {
    if (document.getElementById('rw-trade-bar')) return;
    const bar = document.createElement('div'); bar.id = 'rw-trade-bar';
    bar.innerHTML = `<div id="rw-trade-bar-inner"><span class="rw-logo">RIFT<b>WALK</b></span><div class="rw-sep"></div><div class="rw-ts"><div class="rw-ts-label">You Give</div><div class="rw-ts-val" id="rw-give">\u2014</div></div><div class="rw-arrow">\u2192</div><div class="rw-ts"><div class="rw-ts-label">You Receive</div><div class="rw-ts-val" id="rw-recv">\u2014</div></div><div class="rw-sep"></div><div class="rw-ts"><div class="rw-ts-label">Profit/Loss</div><div class="rw-ts-val" id="rw-prof">\u2014</div></div></div>`;
    const area = document.querySelector('.trade_area,.tradeoffer_items_header'); if (area) area.insertAdjacentElement('beforebegin', bar); else document.body.prepend(bar);
  }
  let tradeProcessing = false;
  function processTradeItems() {
    if (tradeProcessing) return;
    tradeProcessing = true;
    setTimeout(() => { tradeProcessing = false; }, 500);
    readPageAssets(); let give=0,recv=0;
    const yourItems = document.querySelectorAll("#your_slots .item,#trade_yours .item");
    const theirItems = document.querySelectorAll("#their_slots .item,#trade_theirs .item");
    yourItems.forEach(el => { labelItem(el); const c = getCents(getItemName(el),getAssetId(el)); if (c) give += c; });
    theirItems.forEach(el => { labelItem(el); const c = getCents(getItemName(el),getAssetId(el)); if (c) recv += c; });
    // Label visible pages + adjacent
    const toLabel = [];
    const pages = document.querySelectorAll('.inventory_page');
    if (pages.length > 0) {
      const visibleSet = new Set();
      pages.forEach((p, i) => { if (p.style.display !== 'none') visibleSet.add(i); });
      pages.forEach((page, i) => {
        let near = visibleSet.has(i);
        if (!near) { for (const vi of visibleSet) { if (Math.abs(i - vi) <= 1) { near = true; break; } } }
        if (!near) return;
        page.querySelectorAll('.item.app730').forEach(el => toLabel.push(el));
      });
    } else {
      document.querySelectorAll('.trade_item_box .item.app730').forEach(el => toLabel.push(el));
    }
    if (toLabel.length > 100) {
      const unlabeled = toLabel.filter(el => !el.querySelector('.rw-price'));
      unlabeled.slice(0, 60).forEach(el => labelItem(el));
      const relabel = toLabel.filter(el => el.querySelector('.rw-price') && !el.querySelector('.rw-float-text') && !el.dataset.rwFh).slice(0, 20);
      relabel.forEach(el => labelItem(el));
      if (unlabeled.length > 60 || relabel.length > 0) setTimeout(processTradeItems, 200);
    } else {
      toLabel.forEach(el => labelItem(el));
    }
    const profit = recv - give;
    const g = document.getElementById('rw-give'), r = document.getElementById('rw-recv'), p = document.getElementById('rw-prof');
    if (g) g.textContent = give ? fmt(give) : '\u2014';
    if (r) r.textContent = recv ? fmt(recv) : '\u2014';
    if (p) {
      if (give === 0 && recv === 0) { p.textContent = '\u2014'; p.className = 'rw-ts-val'; }
      else { const pct = give > 0 ? Math.round((profit / give) * 100) : 0; const pctStr = pct !== 0 ? ` (${pct > 0 ? '+' : ''}${pct}%)` : ''; p.textContent = (profit >= 0 ? '+' : '-') + fmt(Math.abs(profit)) + pctStr; p.className = 'rw-ts-val ' + (profit > 0 ? 'rw-profit-pos' : profit < 0 ? 'rw-profit-neg' : ''); }
    }
  }

  // ── SteamID button ────────────────────────────────────────
  function addSteamIdButton(retries) {
    retries=retries||0;
    if(settings.enableSteamId===false||document.querySelector('.rw-steamid-btn'))return;
    let sid=getProfileSteamId();

    // If no SteamID yet and we're on a /id/ URL, resolve the vanity URL
    if (!sid && location.pathname.match(/\/id\/[^/]+/)) {
      resolveVanityUrl().then(resolved => {
        if (resolved) { currentOwnerSteamId = resolved; addSteamIdButton(0); }
      });
      return;
    }

    if(!sid&&retries<10){setTimeout(()=>addSteamIdButton(retries+1),1500);return;}
    if(!sid)return;
    const target=document.querySelector('.persona_name')||document.querySelector('.profile_header_centered_persona');
    if(!target&&retries<10){setTimeout(()=>addSteamIdButton(retries+1),1500);return;}
    if(!target)return;

    // Create button row container
    let row = document.querySelector('.rw-btn-row');
    if (!row) { row = document.createElement('div'); row.className = 'rw-btn-row'; target.appendChild(row); }

    const btn=document.createElement('button');btn.className='rw-steamid-btn';btn.innerHTML='\uD83D\uDCCB '+sid;btn.title='Copy permanent Steam64 profile link';
    btn.onclick=()=>{navigator.clipboard.writeText(`https://steamcommunity.com/profiles/${sid}`).then(()=>{btn.classList.add('copied');btn.textContent='\u2713 Copied!';setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='\uD83D\uDCCB '+sid;},2000);});};
    row.appendChild(btn);

    // Add "Copy Trade Link" button on OWN profile only
    const viewerEl = document.getElementById('rw-viewer');
    const viewerSid = viewerEl?.textContent || '';
    const ownerEl = document.getElementById('rw-owner');
    const ownerSid = ownerEl?.textContent || '';
    // Detect own profile: viewer matches owner/sid, or page has "Edit Profile" button
    const isOwnProfile = (viewerSid && (viewerSid === sid || viewerSid === ownerSid)) || document.querySelector('.profile_edit_link, [href*="edit/info"]');
    if (isOwnProfile && !document.querySelector('.rw-tradelink-btn')) {
      const tlBtn = document.createElement('button');
      tlBtn.className = 'rw-steamid-btn rw-tradelink-btn';
      tlBtn.innerHTML = '🔗 Trade Link';
      tlBtn.title = 'Copy your trade offer URL';
      tlBtn.onclick = async () => {
        tlBtn.textContent = '⏳ Fetching...';
        try {
          // Fetch trade offer page to extract token
          const resp = await fetch(`https://steamcommunity.com/profiles/${sid}/tradeoffers/privacy`, { credentials: 'include' });
          const html = await resp.text();
          const tokenMatch = html.match(/tradeoffer\/new\/\?partner=(\d+)(?:&amp;|&)token=([A-Za-z0-9_-]+)/);
          if (tokenMatch) {
            const tradeUrl = `https://steamcommunity.com/tradeoffer/new/?partner=${tokenMatch[1]}&token=${tokenMatch[2]}`;
            await navigator.clipboard.writeText(tradeUrl);
            tlBtn.classList.add('copied'); tlBtn.textContent = '\u2713 Copied!';
            setTimeout(() => { tlBtn.classList.remove('copied'); tlBtn.innerHTML = '🔗 Trade Link'; }, 2000);
          } else {
            tlBtn.textContent = '❌ Not found';
            setTimeout(() => { tlBtn.innerHTML = '🔗 Trade Link'; }, 2000);
          }
        } catch(e) {
          tlBtn.textContent = '❌ Error';
          setTimeout(() => { tlBtn.innerHTML = '🔗 Trade Link'; }, 2000);
        }
      };
      row.appendChild(tlBtn);
    }

    // CSFloat Stall + CSGO-Rep buttons — on ALL profiles
    if (!document.querySelector('.rw-csfloat-btn')) {
      const floatBtn = document.createElement('button');
      floatBtn.className = 'rw-steamid-btn rw-csfloat-btn';
      floatBtn.innerHTML = '🏪 CSFloat Stall';
      floatBtn.title = 'Open CSFloat stall';
      floatBtn.onclick = () => window.open(`https://csfloat.com/stall/${sid}`, '_blank');
      row.appendChild(floatBtn);

      const repBtn = document.createElement('button');
      repBtn.className = 'rw-steamid-btn rw-rep-btn';
      repBtn.innerHTML = '⭐ CSGO-Rep';
      repBtn.title = 'Open CSGO-Rep profile';
      repBtn.onclick = () => window.open(`https://csgo-rep.com/profile/${sid}`, '_blank');
      row.appendChild(repBtn);
    }
  }

  // ── Multi-select items ──────────────────────────────────────
  const selectedItems = new Set();
  function setupSelection() {
    // Inject selection bar
    if (document.getElementById('rw-select-bar')) return;
    const bar = document.createElement('div'); bar.id = 'rw-select-bar';
    bar.innerHTML = `<div class="rw-sel-thumbs" id="rw-sel-thumbs"></div><div class="rw-sel-info"><span class="rw-sel-count"><b id="rw-sel-n">0</b> items selected</span><div class="rw-sep"></div><span class="rw-sel-total" id="rw-sel-total">$0.00</span><button class="rw-sel-clear" id="rw-sel-clear">✕ Clear</button></div>`;
    document.body.appendChild(bar);
    document.getElementById('rw-sel-clear').addEventListener('click', clearSelection);

    // Listen for clicks on inventory items
    document.addEventListener('click', (e) => {
      const item = e.target.closest('.item.app730');
      if (!item || !e.ctrlKey) return;
      e.preventDefault(); e.stopPropagation();
      const aid = getAssetId(item);
      if (!aid) return;
      if (selectedItems.has(aid)) { selectedItems.delete(aid); item.classList.remove('rw-selected'); }
      else { selectedItems.add(aid); item.classList.add('rw-selected'); }
      updateSelectionBar();
    }, true);
  }
  function updateSelectionBar() {
    const bar = document.getElementById('rw-select-bar');
    if (!bar) return;
    if (selectedItems.size === 0) { bar.classList.remove('visible'); return; }
    bar.classList.add('visible');
    let total = 0;
    const thumbsHtml = [];
    selectedItems.forEach(aid => {
      const desc = invDescs.get(aid);
      const name = desc?.market_hash_name || '';
      total += getCents(name, aid);
      const iconUrl = desc?.icon_url ? `https://community.cloudflare.steamstatic.com/economy/image/${desc.icon_url}/96fx96f` : '';
      if (iconUrl) thumbsHtml.push(`<img class="rw-sel-thumb" data-aid="${aid}" src="${iconUrl}" title="${name}">`);
    });
    document.getElementById('rw-sel-n').textContent = selectedItems.size;
    document.getElementById('rw-sel-total').textContent = total ? fmt(total) : '\u2014';
    const thumbsEl = document.getElementById('rw-sel-thumbs');
    if (thumbsEl) {
      thumbsEl.innerHTML = thumbsHtml.join('');
      // Click thumbnail to deselect that item
      thumbsEl.querySelectorAll('.rw-sel-thumb').forEach(img => {
        img.addEventListener('click', () => {
          const aid = img.dataset.aid;
          selectedItems.delete(aid);
          const el = document.getElementById(`730_2_${aid}`) || document.getElementById(`730_16_${aid}`) || document.getElementById(`item730_2_${aid}`) || document.getElementById(`item730_16_${aid}`);
          if (el) el.classList.remove('rw-selected');
          updateSelectionBar();
        });
      });
    }
  }
  function clearSelection() {
    selectedItems.clear();
    document.querySelectorAll('.rw-selected').forEach(el => el.classList.remove('rw-selected'));
    updateSelectionBar();
  }

  // ── Trade Offers List Page (/tradeoffers/) ──────────────────
  let tradeOffersData = null;
  let tradeDescMap = new Map(); // classid_instanceid -> description
  let tradeOfferOverrides = new Map(); // economyItem -> cents

  function recalcTradeOfferTotals() {
    document.querySelectorAll('.rw-offer-total').forEach(el => el.remove());
    document.querySelectorAll('.tradeoffer').forEach(offer => {
      const itemLists = offer.querySelectorAll('.tradeoffer_item_list');
      if (itemLists.length < 2) return;
      const headerText = offer.querySelector('.tradeoffer_header')?.textContent || '';
      const youOffered = headerText.includes('You offered');

      function sumList(list) {
        let t = 0;
        list.querySelectorAll('.trade_item').forEach(el => {
          const econItem = el.dataset?.economyItem; if (!econItem) return;
          if (tradeOfferOverrides.has(econItem)) { t += tradeOfferOverrides.get(econItem); return; }
          const parts = econItem.split('/'); if (parts.length < 4) return;
          const desc = tradeDescMap.get(`${parts[2]}_${parts[3]}`);
          if (desc) t += getCents(desc.market_hash_name, null);
        });
        return t;
      }

      const t0 = sumList(itemLists[0]), t1 = sumList(itemLists[1]);
      const giveTotal = youOffered ? t0 : t1;
      const recvTotal = youOffered ? t1 : t0;
      const profit = recvTotal - giveTotal;
      if (giveTotal === 0 && recvTotal === 0) return;
      const pct = giveTotal > 0 ? Math.round((profit / giveTotal) * 100) : 0;
      const pctStr = pct !== 0 ? ` (${pct > 0 ? '+' : ''}${pct}%)` : '';
      const profitStr = (profit >= 0 ? '+' : '-') + fmt(Math.abs(profit));
      const totalDiv = document.createElement('div');
      totalDiv.className = 'rw-offer-total';
      totalDiv.innerHTML = `<span style="color:#66c0f4">Receive: ${recvTotal ? fmt(recvTotal) : '$0'}</span> <span style="color:#4a7a99">\u2192</span> <span style="color:#66c0f4">Give: ${giveTotal ? fmt(giveTotal) : '$0'}</span> <span style="color:${profit > 0 ? '#4CAF50' : profit < 0 ? '#e74c3c' : '#4a7a99'};font-weight:700">PnL: ${profitStr}${pctStr}</span>`;
      const header = offer.querySelector('.tradeoffer_header') || offer.firstChild;
      if (header) header.insertAdjacentElement('afterend', totalDiv);
    });
  }

  async function processTradeOffersList() {
    // Fetch prices if not loaded
    if (!Object.keys(priceMap).length) {
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_PRICES' }, r));
      if (res?.prices) { priceMap = res.prices; console.log(`[Riftwalk] ${Object.keys(priceMap).length} prices loaded`); }
    }

    // Fetch trade offers from Steam API (both active and historical)
    if (!tradeOffersData) {
      console.log(`[Riftwalk] Fetching trade offers...`);
      const res = await new Promise(r => chrome.runtime.sendMessage({ type: 'GET_TRADE_OFFERS', sent: true, received: true }, r));
      if (!res?.success) { console.error('[Riftwalk] Trade offers fetch failed:', res?.error); return; }
      tradeOffersData = res.data;

      // Build description map: classid_instanceid -> desc
      if (tradeOffersData.descriptions) {
        for (const desc of tradeOffersData.descriptions) {
          const key = `${desc.classid}_${desc.instanceid}`;
          tradeDescMap.set(key, desc);
        }
        console.log(`[Riftwalk] ${tradeDescMap.size} item descriptions loaded`);
      }
    }

    // Label each trade_item on the page
    document.querySelectorAll('.trade_item').forEach(el => {
      if (el.querySelector('.rw-price')) return; // already labeled
      const econItem = el.dataset?.economyItem; // "classinfo/730/classid/instanceid"
      if (!econItem) return;
      const parts = econItem.split('/');
      if (parts.length < 4 || parts[1] !== '730') return;
      const key = `${parts[2]}_${parts[3]}`;
      const desc = tradeDescMap.get(key);
      if (!desc) return;

      // Position the item for overlays
      if (getComputedStyle(el).position === 'static') { el.style.position = 'relative'; el.style.overflow = 'hidden'; }

      const name = desc.market_hash_name;
      const price = getPrice(name, null);

      // Price tag
      const isDop = isDopplerItem(name);
      const tag = document.createElement('div');
      tag.className = 'rw-price' + (!price ? ' na' : isDop ? ' doppler' : '');
      tag.textContent = (price || '\u2014') + (isDop && price ? ' ?' : '');
      if (isDop && price) tag.title = 'Price may vary by phase (Ruby/Sapphire/BP)';
      if (price) {
        const buffUrl = getBuffLink(name);
        if (buffUrl) tag.addEventListener('click', (e) => { e.stopPropagation(); window.open(buffUrl, '_blank'); });
      }
      el.appendChild(tag);

      // Edit pencil button
      if (price) {
        const pencil = document.createElement('div');
        pencil.className = 'rw-edit-btn';
        pencil.innerHTML = '<svg viewBox="0 0 24 24"><path d="M17 3l4 4L7 21H3v-4L17 3z"/><path d="M14.5 5.5l4 4"/></svg>';
        pencil.title = 'Set custom price';
        pencil.addEventListener('click', (e) => {
          e.stopPropagation();
          const current = tag.textContent.replace(/[^0-9.]/g, '');
          const newVal = prompt('Enter custom price ($):', current);
          if (newVal !== null) {
            const val = parseFloat(newVal);
            if (val > 0) {
              tag.textContent = '$' + val.toFixed(2);
              tag.className = 'rw-price';
              const econItem = el.dataset?.economyItem;
              if (econItem) { tradeOfferOverrides.set(econItem, Math.round(val * 100)); recalcTradeOfferTotals(); }
            }
          }
        });
        el.appendChild(pencil);
      }

      // Float from descriptions
      const floatDesc = desc.descriptions?.find(d => d.value?.includes('Wear Rating'));
      // Stickers/Patches/Charms
      const stk = getStickers(desc);
      if (stk.length) {
        const dots = document.createElement('div'); dots.className = 'rw-sticker-dots';
        stk.forEach(s => { const d = document.createElement('div'); d.className = 'rw-sticker-dot' + (s.type === 'patch' ? ' patch' : ''); dots.appendChild(d); });
        el.appendChild(dots); attachStickerHover(el, stk);
      }

      // Exterior label
      if (desc.tags) {
        const isST = (desc.market_hash_name || '').includes('StatTrak');
        const isSV = (desc.market_hash_name || '').includes('Souvenir');
        const prefix = isST ? 'ST ' : isSV ? 'SV ' : '';
        for (const tag2 of desc.tags) {
          if (tag2.category === 'Exterior') {
            const ext = EXT_MAP[tag2.localized_tag_name] || EXT_MAP[tag2.name] || tag2.localized_tag_name || tag2.name;
            if (ext && !el.querySelector('.rw-ext')) {
              const e = document.createElement('div'); e.className = 'rw-ext';
              e.textContent = prefix + ext;
              el.appendChild(e);
            }
            break;
          }
        }
        // Rarity border
        const rName = desc.market_hash_name || '';
        if (rName.startsWith('\u2605')) {
          el.classList.add('rw-rarity-border'); el.style.setProperty('--rw-rarity-color', '#e4ae39');
        } else {
          for (const tag3 of desc.tags) {
            if ((tag3.category === 'Rarity' || tag3.category === 'Quality') && tag3.color) {
              el.classList.add('rw-rarity-border'); el.style.setProperty('--rw-rarity-color', '#' + tag3.color);
              break;
            }
          }
        }
      }
    });

    // Calculate totals per trade offer
    recalcTradeOfferTotals();
  }

  // ── URL change ────────────────────────────────────────────
  let lastUrl = location.href;
  let lastPropsRequest = 0;
  function requestPropsThrottled() {
    const now = Date.now();
    if (now - lastPropsRequest < 1500) return;
    lastPropsRequest = now;
    document.dispatchEvent(new CustomEvent('rw-request-props'));
  }
  function setupObserver() {
    let propsRetryTimer = null;
    new MutationObserver(() => {
      if (location.href !== lastUrl) { lastUrl = location.href; handleUrlChange(); }
      clearTimeout(debounce); debounce = setTimeout(() => {
        if (IS_INVENTORY) {
          processItems();
          requestPropsThrottled();
          // Check if any visible items still missing floats, retry if so
          clearTimeout(propsRetryTimer);
          propsRetryTimer = setTimeout(() => {
            const needsFloat = document.querySelectorAll('.item.app730 .rw-price').length > 0 &&
              document.querySelectorAll('.item.app730 .rw-float-text').length < document.querySelectorAll('.item.app730 .rw-price').length / 2;
            if (needsFloat) {
              lastPropsRequest = 0;
              document.dispatchEvent(new CustomEvent('rw-request-props'));
              setTimeout(() => processItems(), 500);
            }
          }, 1500);
        }
        if (IS_TRADEOFFER) processTradeItems();
      }, IS_TRADEOFFER ? 400 : 800);
    }).observe(document.body, { childList: true, subtree: true });
  }
  function handleUrlChange() {
    IS_INVENTORY=/\/inventory/.test(location.pathname); IS_TRADEOFFER=/\/tradeoffer\//.test(location.pathname);
    IS_PROFILE=/\/(profiles|id)\/[^/]+\/?$/.test(location.pathname)&&!IS_INVENTORY&&!IS_TRADEOFFER;
    invDescs.clear();nameCache.clear();floatCache.clear();dopplerPrices.clear();dopplerPhases.clear();
    floatQueue=[];floatBusy=false;currentOwnerSteamId=null;inventoryLoading=false;
    selectedItems.clear();
    document.querySelectorAll('.rw-price,.rw-phase,.rw-float-text,.rw-lock,.rw-sticker-dots,.rw-steamid-btn,.rw-ext,.rw-dup,.rw-pattern-row,.rw-pattern,.rw-fade,.rw-bluegem').forEach(e=>e.remove());
    document.querySelectorAll('[data-rw-fh],[data-rw-labeled]').forEach(e=>{delete e.dataset.rwFh;delete e.dataset.rwLabeled;});
    document.querySelectorAll('.rw-rarity-border').forEach(e=>{e.classList.remove('rw-rarity-border');e.style.removeProperty('--rw-rarity-color');});
    dupCounts.clear();
    updateBar(0,0,0);
    setTimeout(()=>{currentOwnerSteamId=null;document.dispatchEvent(new CustomEvent('rw-request-owner'));
      if(IS_INVENTORY){if(!document.getElementById('rw-bar'))injectBar();updateBar(0,0,0);startInventoryLoad();}
      if(IS_PROFILE||IS_INVENTORY)addSteamIdButton();
    },1000);
  }

  // ── Init ──────────────────────────────────────────────────
  async function init() {
    console.log('[Riftwalk] Init v1.9', { IS_INVENTORY, IS_TRADEOFFER, IS_PROFILE, decoder: typeof InspectDecoder !== 'undefined' });
    injectCSS();
    settings = (await chrome.storage.local.get(['rw_settings'])).rw_settings || {};
    const pr = await chrome.storage.local.get(['rw_prices_cache']);
    if (pr.rw_prices_cache?.data) { priceMap = pr.rw_prices_cache.data; console.log(`[Riftwalk] ${Object.keys(priceMap).length} prices`); }
    if (IS_INVENTORY) { injectBar(); setupDetailPanelObserver(); setupSelection(); startInventoryLoad();
      // When navigating via direct item link (#730_2_xxx), Steam loads differently — retry props+processing
      if (location.hash && location.hash.includes('730')) {
        console.log('[Riftwalk] Direct item link detected, scheduling extra retries');
        const applyAllFloats = () => {
          readPageProps();
          // Apply floats and patterns to ALL visible items, bypassing batching
          const pages = document.querySelectorAll('.inventory_page');
          const items = [];
          if (pages.length > 0) {
            pages.forEach(page => { if (page.style.display !== 'none') page.querySelectorAll('.item.app730').forEach(el => items.push(el)); });
          } else {
            document.querySelectorAll('.item.app730').forEach(el => items.push(el));
          }
          items.forEach(el => labelItem(el));
          // Also apply floats directly in case labelItem batching missed them
          floatCache.forEach((fd, aid) => applyFloatToDOM(aid, fd));
        };
        setTimeout(applyAllFloats, 3000);
        setTimeout(applyAllFloats, 6000);
        setTimeout(applyAllFloats, 10000);
      }
    }
    if (IS_TRADEOFFER) {
      setupTradeOffer();
      console.log(`[Riftwalk] Trade offer mode, priceMap has ${Object.keys(priceMap).length} prices`);
      // Request prices from background
      chrome.runtime.sendMessage({ type: 'GET_PRICES' }, res => {
        if (res?.prices && Object.keys(res.prices).length) {
          priceMap = res.prices;
          console.log(`[Riftwalk] ${Object.keys(priceMap).length} prices loaded from background`);
          processTradeItems();
        } else {
          console.log(`[Riftwalk] No prices from background, forcing refresh...`);
          chrome.runtime.sendMessage({ type: 'FORCE_REFRESH' }, () => {
            chrome.runtime.sendMessage({ type: 'GET_PRICES' }, res2 => {
              if (res2?.prices) { priceMap = res2.prices; console.log(`[Riftwalk] ${Object.keys(priceMap).length} prices after refresh`); processTradeItems(); }
            });
          });
        }
      });
      // Request asset dumps to get item names from Steam's internal data
      document.dispatchEvent(new CustomEvent('rw-request-dump'));
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-dump')), 2000);
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-dump')), 5000);
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 2000);
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 4000);
      setTimeout(() => document.dispatchEvent(new CustomEvent('rw-request-props')), 7000);
      setTimeout(processTradeItems, 3000);
      setTimeout(processTradeItems, 6000);
    }
    if (IS_TRADEOFFERS_LIST) {
      injectCSS();
      console.log(`[Riftwalk] Trade offers list page`);
      processTradeOffersList();
    }
    if (IS_PROFILE || IS_INVENTORY) addSteamIdButton();
    setupObserver();
    chrome.runtime.onMessage.addListener(msg => {
      if (msg.type === 'PRICES_UPDATED') chrome.storage.local.get(['rw_prices_cache'], r => {
        if (r.rw_prices_cache?.data) { priceMap = r.rw_prices_cache.data; if (IS_INVENTORY) processItems(); if (IS_TRADEOFFER) processTradeItems(); }
      });
    });
  }
  async function startInventoryLoad(attempt) {
    attempt=attempt||0; let sid=getProfileSteamId();
    if(!sid&&attempt<8){if(attempt===0)document.dispatchEvent(new CustomEvent('rw-request-owner'));await new Promise(r=>setTimeout(r,800));sid=getProfileSteamId();}
    if(!sid&&attempt===0){sid=await resolveVanityUrl();if(sid)currentOwnerSteamId=sid;}
    if(!sid&&attempt<8){await new Promise(r=>setTimeout(r,1000));return startInventoryLoad(attempt+1);}
    if(!sid||inventoryLoading)return;inventoryLoading=true;
    console.log(`[Riftwalk] Inventory owner: ${sid}`);fetchAllDescriptions(sid);setTimeout(processItems,2000);
  }

  // ── Portfolio Tracker ────────────────────────────────────────
  async function savePortfolioSnapshot(totalCents, itemCount, pricedCount) {
    try {
      // Check if extension context is still valid
      if (!chrome.runtime?.id) return;
      const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
      const data = await chrome.storage.local.get(['rw_portfolio']);
      const portfolio = data.rw_portfolio || { snapshots: [], items: {} };

      // Record the currency snapshots are being stored in (first snapshot sets it).
      // Used by the portfolio page to warn if the user later views a different currency.
      let stampedCurrency = false;
      if (!portfolio.dataCurrency) {
        try { portfolio.dataCurrency = activeCurrency(); } catch(e) { portfolio.dataCurrency = 'USD'; }
        stampedCurrency = true;
      }

      // Only save one snapshot per day
      const lastSnap = portfolio.snapshots[portfolio.snapshots.length - 1];
      if (lastSnap && lastSnap.date === today) {
        // Already have today's snapshot — but if we just added the currency
        // stamp to a portfolio that lacked it, persist that one change.
        if (stampedCurrency) {
          try { await chrome.storage.local.set({ rw_portfolio: portfolio }); } catch(e) {}
        }
        return;
      }

      // Save daily snapshot
      portfolio.snapshots.push({
        date: today,
        total: totalCents,
        count: itemCount,
        priced: pricedCount,
      });

      // Keep max 365 days
      if (portfolio.snapshots.length > 365) portfolio.snapshots = portfolio.snapshots.slice(-365);

      // Save individual item prices for per-item tracking
      const itemsToday = {};
      const itemQty = {};
      const itemIcons = {};
      const itemDetails = {};
      invDescs.forEach((desc, aid) => {
        const name = desc.market_hash_name;
        if (!name) return;
        const cents = getCents(name, aid);
        if (cents > 0) {
          if (!itemsToday[name] || cents > itemsToday[name]) {
            itemsToday[name] = cents;
          }
          itemQty[name] = (itemQty[name] || 0) + 1;
          if (desc.icon_url && !itemIcons[name]) {
            itemIcons[name] = `https://steamcommunity.com/economy/image/${desc.icon_url}/96x96`;
          }
          // Save float and pattern data
          if (!itemDetails[name] && floatCache.has(aid)) {
            const fd = floatCache.get(aid);
            itemDetails[name] = {};
            if (fd.floatvalue) itemDetails[name].float = fd.floatvalue;
            if (fd.paintseed) itemDetails[name].seed = fd.paintseed;
          }
          // Save Doppler phase
          if (!itemDetails[name]?.phase && dopplerPhases.has(aid)) {
            if (!itemDetails[name]) itemDetails[name] = {};
            itemDetails[name].phase = dopplerPhases.get(aid).phase;
          }
        }
      });

      // Merge into items history
      for (const [name, cents] of Object.entries(itemsToday)) {
        if (!portfolio.items[name]) portfolio.items[name] = [];
        const lastEntry = portfolio.items[name][portfolio.items[name].length - 1];
        if (!lastEntry || lastEntry.date !== today) {
          portfolio.items[name].push({ date: today, price: cents, qty: itemQty[name] || 1 });
        }
        // Save icon URL and details separately (doesn't change per day)
        if (!portfolio.icons) portfolio.icons = {};
        if (itemIcons[name]) portfolio.icons[name] = itemIcons[name];
        if (!portfolio.details) portfolio.details = {};
        if (itemDetails[name]) portfolio.details[name] = itemDetails[name];
        // Keep max 90 days per item
        if (portfolio.items[name].length > 90) portfolio.items[name] = portfolio.items[name].slice(-90);
      }

      // Clean up items not seen in 30 days
      const thirtyDaysAgo = new Date(Date.now() - 30 * 86400000).toISOString().split('T')[0];
      for (const name of Object.keys(portfolio.items)) {
        const entries = portfolio.items[name];
        if (entries.length === 0 || entries[entries.length - 1].date < thirtyDaysAgo) {
          delete portfolio.items[name];
        }
      }

      await chrome.storage.local.set({ rw_portfolio: portfolio });
      console.log(`[Riftwalk] Portfolio snapshot saved: ${sym()}${(totalCents/100).toFixed(2)} (${itemCount} items, ${Object.keys(itemsToday).length} priced)`);
    } catch (e) {
      console.warn('[Riftwalk] Portfolio save error:', e);
    }
  }

  // ── Case Opening Stats (Inventory History page) ─────────────
  function initCaseStats() {
    if (!IS_HISTORY) return;
    console.log('[Riftwalk] Case Stats: initializing on inventory history page');

    let cachedPrices = {};
    let scanningActive = false;
    let scanTimer = null;

    // Load cached prices for value calculation
    chrome.storage.local.get(['rw_prices_cache'], (r) => {
      const entry = r.rw_prices_cache;
      if (entry?.data) cachedPrices = entry.data;
      console.log(`[Riftwalk] Case Stats: loaded ${Object.keys(cachedPrices).length} cached prices`);
    });

    const RARITY_MAP = {
      '#4b69ff': { name: 'Mil-Spec', tier: 'blue' },
      '#8847ff': { name: 'Restricted', tier: 'purple' },
      '#d32ce6': { name: 'Classified', tier: 'pink' },
      '#eb4b4b': { name: 'Covert', tier: 'red' },
      '#e4ae39': { name: 'Extraordinary', tier: 'gold' },
      '#ade55c': { name: 'High Grade', tier: 'blue' },
    };

    function getRarityFromColor(color) {
      if (!color) return { name: 'Unknown', tier: 'blue' };
      const c = color.toLowerCase().replace(/\s/g, '');
      for (const [hex, data] of Object.entries(RARITY_MAP)) {
        if (c.includes(hex.replace('#', ''))) return data;
      }
      return { name: 'Unknown', tier: 'blue' };
    }

    function getItemPrice(marketName) {
      if (!marketName || Object.keys(cachedPrices).length === 0) return 0;
      // Exact match first
      if (cachedPrices[marketName]) {
        const e = cachedPrices[marketName];
        return (e.buff || e.skins || 0);
      }
      // History page names don't include wear — try matching with all wear conditions
      const wears = ['(Factory New)', '(Minimal Wear)', '(Field-Tested)', '(Well-Worn)', '(Battle-Scarred)'];
      let bestPrice = 0;
      for (const w of wears) {
        const fullName = `${marketName} ${w}`;
        if (cachedPrices[fullName]) {
          const e = cachedPrices[fullName];
          const p = e.buff || e.skins || 0;
          if (p > bestPrice) bestPrice = p;
        }
      }
      return bestPrice;
    }

    // Steam in-game key prices by currency
    const KEY_PRICE_CENTS = { USD: 249, EUR: 219, GBP: 179, CNY: 1650, CAD: 325, AUD: 395, CHF: 250, SEK: 2700, PLN: 1050, BRL: 1299, TRY: 8500 };

    function getUserCurrency() {
      return settings.pricingMode === 'skinport' ? (settings.spCurrency || 'USD') : (settings.currency || 'USD');
    }

    function getKeyCostCents() {
      return KEY_PRICE_CENTS[getUserCurrency()] || 250;
    }

    function fmtPrice(cents) {
      if (!cents) return '';
      const cur = getUserCurrency();
      const sym = { USD: '$', EUR: '€', GBP: '£', CNY: '¥', CAD: 'C$', AUD: 'A$', CHF: 'Fr', SEK: 'kr', PLN: 'zł', BRL: 'R$', TRY: '₺' }[cur] || '$';
      return `${sym}${(cents / 100).toFixed(2)}`;
    }

    function scanHistory() {
      const rows = document.querySelectorAll('.tradehistoryrow');
      const stats = {
        totalOpened: 0,
        totalEvents: rows.length,
        byRarity: { blue: 0, purple: 0, pink: 0, red: 0, gold: 0 },
        byCaseType: {},
        items: [],
        goldItems: [],
        lastGoldIndex: -1,
        bestPull: null,
        bestPullPrice: 0,
        totalCaseCost: 0,
        totalCapsules: 0,
        byCapsuleType: {},
      };

      rows.forEach((row) => {
        const desc = row.querySelector('.tradehistory_event_description')?.textContent?.trim() || '';
        if (!desc.includes('Unlocked a container')) return;

        let receivedName = '', receivedColor = '', caseName = '', hasKey = false;
        const plusGroups = row.querySelectorAll('.tradehistory_items');

        for (const group of plusGroups) {
          const pm = group.querySelector('.tradehistory_items_plusminus');
          if (pm && pm.textContent.trim() === '+') {
            const nameEl = group.querySelector('.history_item_name');
            if (nameEl) {
              receivedName = nameEl.textContent.trim();
              receivedColor = nameEl.getAttribute('style')?.match(/color:\s*(#[a-fA-F0-9]+)/)?.[1] || '';
            }
          }
          if (pm && pm.textContent.trim() === '-') {
            const minusNames = group.querySelectorAll('.history_item_name');
            for (const mn of minusNames) {
              const t = mn.textContent.trim();
              if (t.includes('Key')) hasKey = true;
              if ((t.includes('Case') || t.includes('Capsule') || t.includes('Package')) && !t.includes('Key')) caseName = t;
            }
          }
        }

        if (!receivedName) return;

        const isCapsule = !hasKey;
        const rarity = getRarityFromColor(receivedColor);
        // Force gold for knives/gloves (★ items)
        if (receivedName.startsWith('★')) rarity.tier = 'gold';

        if (isCapsule) {
          // Sticker capsule — track separately
          stats.totalCapsules++;
          if (caseName) stats.byCapsuleType[caseName] = (stats.byCapsuleType[caseName] || 0) + 1;
          return;
        }

        // Real case opening (has key)
        stats.totalOpened++;
        stats.byRarity[rarity.tier] = (stats.byRarity[rarity.tier] || 0) + 1;

        if (caseName) {
          stats.byCaseType[caseName] = (stats.byCaseType[caseName] || 0) + 1;
          // Track case cost
          const casePrice = getItemPrice(caseName);
          if (casePrice > 0) stats.totalCaseCost += casePrice;
        }

        // Check price for best pull
        const rarityRank = { blue: 1, purple: 2, pink: 3, red: 4, gold: 5 };
        const itemPrice = getItemPrice(receivedName);
        const itemRank = rarityRank[rarity.tier] || 0;
        const bestRank = stats.bestPull ? (rarityRank[stats.bestPull.rarity.tier] || 0) : 0;

        if (itemPrice > stats.bestPullPrice || (itemPrice === 0 && stats.bestPullPrice === 0 && itemRank > bestRank)) {
          stats.bestPullPrice = itemPrice;
          stats.bestPull = { name: receivedName, price: itemPrice, rarity: rarity };
        }

        if (rarity.tier === 'gold') {
          stats.goldItems.push({ name: receivedName, case: caseName, index: stats.totalOpened });
          if (stats.lastGoldIndex === -1) stats.lastGoldIndex = stats.totalOpened;
        }

        stats.items.push({ name: receivedName, rarity: rarity, case: caseName });
      });

      return stats;
    }

    function renderPanel(stats) {
      let panel = document.getElementById('rw-case-stats');
      if (!panel) {
        panel = document.createElement('div');
        panel.id = 'rw-case-stats';
        panel.style.cssText = `
          position:fixed;top:80px;right:16px;width:290px;
          background:linear-gradient(135deg,#1a1f2e,#141824);
          border:1px solid rgba(102,192,244,.12);border-radius:12px;
          padding:18px;z-index:9999;font-family:'Segoe UI',sans-serif;
          color:#c7d5e0;box-shadow:0 8px 32px rgba(0,0,0,.5);
          max-height:calc(100vh - 100px);overflow-y:auto;
          transition:box-shadow .3s;
        `;
        document.body.appendChild(panel);

        // Make panel draggable by header area
        let isDragging = false, dragOffX = 0, dragOffY = 0;
        panel.addEventListener('mousedown', (e) => {
          // Only drag from header area (first 40px)
          const rect = panel.getBoundingClientRect();
          if (e.clientY - rect.top > 40) return;
          isDragging = true; panel.style.cursor = 'grabbing';
          dragOffX = e.clientX - rect.left;
          dragOffY = e.clientY - rect.top;
          e.preventDefault();
        });
        document.addEventListener('mousemove', (e) => {
          if (!isDragging) return;
          panel.style.left = (e.clientX - dragOffX) + 'px';
          panel.style.top = (e.clientY - dragOffY) + 'px';
          panel.style.right = 'auto';
        });
        document.addEventListener('mouseup', () => { isDragging = false; panel.style.cursor = ''; });
      }

      const goldRate = stats.byRarity.gold > 0 ? Math.round(stats.totalOpened / stats.byRarity.gold) : '∞';
      const casesSinceGold = stats.lastGoldIndex > 0 ? stats.lastGoldIndex - 1 : stats.totalOpened;
      const sortedCases = Object.entries(stats.byCaseType).sort((a, b) => b[1] - a[1]);
      const totalCaseTypes = sortedCases.reduce((sum, [, c]) => sum + c, 0);

      // Preserve cases expanded state
      const casesExpanded = panel.querySelector('#rw-cases-grid')?.style.display !== 'none';

      panel.innerHTML = `
        <div style="cursor:grab;user-select:none;margin-bottom:8px">
          <div style="display:flex;align-items:center;justify-content:space-between">
            <div style="font-size:14px;font-weight:700;color:#66c0f4;letter-spacing:.5px">📦 CASE STATS</div>
            <div style="font-size:8px;color:#4a5c6d">RIFTWALK | rftwlk.com</div>
          </div>
        </div>

        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px">
          <div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#fff">${stats.totalOpened}</div>
            <div style="font-size:9px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Cases Opened</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#e4ae39">${stats.byRarity.gold}</div>
            <div style="font-size:9px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Golds</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:#66c0f4">1:${goldRate}</div>
            <div style="font-size:9px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Gold Rate</div>
          </div>
          <div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px;text-align:center">
            <div style="font-size:18px;font-weight:700;color:#ef4444">${casesSinceGold}</div>
            <div style="font-size:9px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Since Last Gold</div>
          </div>
        </div>

        <div style="margin-bottom:14px">
          <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Money Spent</div>
          <div style="background:rgba(255,255,255,.03);border-radius:8px;padding:10px">
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
              <span style="color:#6a7a8a">Case Cost</span>
              <span style="color:#fff;font-weight:600">${stats.totalCaseCost > 0 ? fmtPrice(stats.totalCaseCost) : 'N/A'}</span>
            </div>
            <div style="display:flex;justify-content:space-between;font-size:11px;margin-bottom:4px">
              <span style="color:#6a7a8a">Key Cost (${stats.totalOpened} × ${fmtPrice(getKeyCostCents())})</span>
              <span style="color:#fff;font-weight:600">${fmtPrice(stats.totalOpened * getKeyCostCents())}</span>
            </div>
            <div style="border-top:1px solid rgba(255,255,255,.06);padding-top:4px;margin-top:4px;display:flex;justify-content:space-between;font-size:12px">
              <span style="color:#ef4444;font-weight:700">Total Spent</span>
              <span style="color:#ef4444;font-weight:700">${fmtPrice((stats.totalCaseCost > 0 ? stats.totalCaseCost : 0) + (stats.totalOpened * getKeyCostCents()))}</span>
            </div>
          </div>
        </div>

        ${stats.bestPull ? `
        <div style="margin-bottom:14px">
          <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Best Pull</div>
          <div style="background:rgba(102,192,244,.06);border:1px solid rgba(102,192,244,.12);border-radius:8px;padding:8px 12px">
            <div style="font-size:12px;color:#fff;font-weight:600">${stats.bestPull.name}</div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:3px">
              ${stats.bestPull.price ? `<span style="font-size:14px;color:#4ade80;font-weight:700">${fmtPrice(stats.bestPull.price)}</span>` : ''}
              <span style="font-size:10px;color:${{blue:'#4b69ff',purple:'#8847ff',pink:'#d32ce6',red:'#eb4b4b',gold:'#e4ae39'}[stats.bestPull.rarity.tier] || '#888'}">${stats.bestPull.rarity.name}</span>
            </div>
          </div>
        </div>` : ''}

        <div style="margin-bottom:14px">
          <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:8px">Rarity Breakdown <span style="font-size:7px;color:#2a3a4a;text-transform:none;letter-spacing:0">vs expected odds</span></div>
          ${renderBar('Mil-Spec (1:1.25)', stats.byRarity.blue, stats.totalOpened, '#4b69ff', 79.92)}
          ${renderBar('Restricted (1:6)', stats.byRarity.purple, stats.totalOpened, '#8847ff', 15.98)}
          ${renderBar('Classified (1:31)', stats.byRarity.pink, stats.totalOpened, '#d32ce6', 3.2)}
          ${renderBar('Covert (1:156)', stats.byRarity.red, stats.totalOpened, '#eb4b4b', 0.64)}
          ${renderBar('Gold ★ (1:385)', stats.byRarity.gold, stats.totalOpened, '#e4ae39', 0.26)}
        </div>

        ${sortedCases.length > 0 ? `
        <div style="margin-bottom:14px">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;cursor:pointer" id="rw-cases-toggle">
            <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px">Cases Opened <span style="color:#66c0f4">×${totalCaseTypes}</span></div>
            <div style="font-size:8px;color:#66c0f4" id="rw-cases-toggle-label">${casesExpanded ? '▼ Hide' : '▶ Show All'}</div>
          </div>
          <div id="rw-cases-grid" style="display:${casesExpanded ? 'grid' : 'none'};grid-template-columns:1fr 1fr;gap:3px">
          ${sortedCases.map(([name, count]) => {
            const shortName = name.replace(/\s*Case\s*/i, '').replace(/\s*Weapon\s*/i, '').trim();
            const casePrice = getItemPrice(name);
            return `
            <div style="background:rgba(255,255,255,.03);border-radius:4px;padding:4px 6px;font-size:9px;display:flex;justify-content:space-between;align-items:center;overflow:hidden">
              <span style="color:#8a9aaa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:85px" title="${name}">${shortName}</span>
              <span style="color:#66c0f4;font-weight:600;flex-shrink:0">×${count}</span>
            </div>`;
          }).join('')}
          </div>
        </div>` : ''}

        ${stats.goldItems.length > 0 ? `
        <div style="margin-bottom:12px">
          <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Gold Unboxes ★</div>
          ${stats.goldItems.map(g => `
            <div style="background:rgba(228,174,57,.06);border:1px solid rgba(228,174,57,.1);border-radius:6px;padding:6px 10px;margin-bottom:4px;font-size:11px">
              <span style="color:#e4ae39">★</span> <span style="color:#fff">${g.name}</span>
              <span style="color:#4a5c6d;font-size:9px;margin-left:4px">#${g.index}</span>
            </div>
          `).join('')}
        </div>` : ''}

        ${stats.totalCapsules > 0 ? `
        <div style="margin-bottom:12px">
          <div style="font-size:10px;color:#4a5c6d;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px">Sticker Capsules</div>
          <div style="background:rgba(255,255,255,.03);border-radius:6px;padding:6px 10px;font-size:11px;color:#6a7a8a">
            ${stats.totalCapsules} capsules opened (no key cost)
          </div>
        </div>` : ''}

        <div style="display:flex;gap:6px;margin-bottom:10px">
          <button id="rw-scan-all" style="flex:1;background:${scanningActive ? 'rgba(239,68,68,.15);border:1px solid rgba(239,68,68,.3)' : 'rgba(102,192,244,.1);border:1px solid rgba(102,192,244,.2)'};color:${scanningActive ? '#ef4444' : '#66c0f4'};border-radius:6px;padding:7px;font-size:11px;cursor:pointer;font-weight:600;transition:all .15s">
            ${scanningActive ? `⏹ Stop Scanning (${stats.totalEvents} events...)` : '🔄 Scan All History'}
          </button>
        </div>

        <div style="font-size:8px;color:#2a3a4a;text-align:center">Scanned ${stats.totalEvents} events · ${stats.totalOpened} case openings found${scanningActive ? ' · Scanning...' : ''}</div>
      `;

      // Bind scan button
      document.getElementById('rw-scan-all').onclick = () => {
        if (scanningActive) {
          stopScanning();
        } else {
          startScanning();
        }
      };

      // Bind cases toggle
      const casesToggle = document.getElementById('rw-cases-toggle');
      if (casesToggle) {
        casesToggle.onclick = () => {
          const grid = document.getElementById('rw-cases-grid');
          const label = document.getElementById('rw-cases-toggle-label');
          if (grid && label) {
            const isVisible = grid.style.display !== 'none';
            grid.style.display = isVisible ? 'none' : 'grid';
            label.textContent = isVisible ? '▶ Show All' : '▼ Hide';
          }
        };
      }
    }

    function renderBar(label, count, total, color, expectedOdds) {
      const pct = total > 0 ? ((count / total) * 100).toFixed(1) : '0.0';
      const barWidth = total > 0 ? Math.max(2, (count / total) * 100) : 0;
      const expected = total > 0 ? Math.round(total * expectedOdds / 100) : 0;
      const luck = count > expected ? '🍀' : count < expected ? '😢' : '';
      return `
        <div style="margin-bottom:6px">
          <div style="display:flex;justify-content:space-between;font-size:10px;margin-bottom:3px">
            <span style="color:${color};font-weight:600">${label}</span>
            <span style="color:#8a9aaa">${count} <span style="color:#3a4a5a;font-size:8px">/ ${expected} expected</span> ${luck}</span>
          </div>
          <div style="background:rgba(255,255,255,.04);border-radius:3px;height:5px;overflow:hidden">
            <div style="width:${barWidth}%;height:100%;background:${color};border-radius:3px;transition:width .3s"></div>
          </div>
        </div>
      `;
    }

    function startScanning() {
      scanningActive = true;
      scanStartEvents = document.querySelectorAll('.tradehistoryrow').length;
      updateStats();
      clickLoadMore();
    }

    function stopScanning() {
      scanningActive = false;
      if (scanTimer) clearTimeout(scanTimer);
      scanTimer = null;
      updateStats();
    }

    let scanStartEvents = 0;

    function clickLoadMore() {
      if (!scanningActive) return;
      const loadBtn = document.getElementById('load_more_button');
      
      if (loadBtn && loadBtn.offsetParent !== null) {
        // Scroll to Load More button so Steam loads it
        loadBtn.scrollIntoView({ behavior: 'smooth', block: 'center' });
        
        setTimeout(() => {
          loadBtn.click();
          // Wait for content to load
          scanTimer = setTimeout(() => {
            updateStats();
            const stillVisible = document.getElementById('load_more_button');
            if (stillVisible && stillVisible.offsetParent !== null && scanningActive) {
              scanTimer = setTimeout(clickLoadMore, 3500);
            } else {
              // Check if still loading
              const isLoading = document.getElementById('inventory_history_loading');
              if (isLoading && isLoading.style.display !== 'none' && scanningActive) {
                scanTimer = setTimeout(clickLoadMore, 3000);
              } else {
                scanningActive = false;
                updateStats();
              }
            }
          }, 1000);
        }, 500);
      } else {
        // Check if loading indicator is showing
        const isLoading = document.getElementById('inventory_history_loading');
        if (isLoading && isLoading.style.display !== 'none' && scanningActive) {
          scanTimer = setTimeout(clickLoadMore, 3000);
        } else {
          scanningActive = false;
          updateStats();
        }
      }
    }

    function updateStats() {
      const stats = scanHistory();
      renderPanel(stats);
    }

    // Add toggle button at top of history page
    function addHistoryButton() {
      const pagingRow = document.querySelector('.inventory_history_pagingrow');
      if (!pagingRow || document.getElementById('rw-casestats-toggle')) return;

      const btn = document.createElement('button');
      btn.id = 'rw-casestats-toggle';
      btn.innerHTML = '📦 <b>Open Case Stats</b>';
      btn.style.cssText = `
        background:linear-gradient(135deg,#66c0f4,#4a9eda);color:#fff;border:none;
        border-radius:6px;padding:8px 18px;font-size:13px;cursor:pointer;
        font-family:'Motiva Sans',Arial,sans-serif;margin-left:16px;
        transition:all .2s;display:inline-block;vertical-align:middle;
      `;
      btn.onmouseenter = () => btn.style.filter = 'brightness(1.15)';
      btn.onmouseleave = () => btn.style.filter = '';

      let panelVisible = true;
      btn.onclick = () => {
        const panel = document.getElementById('rw-case-stats');
        if (panel) {
          panelVisible = !panelVisible;
          panel.style.display = panelVisible ? 'block' : 'none';
          btn.innerHTML = panelVisible ? '📦 <b>Hide Case Stats</b>' : '📦 <b>Open Case Stats</b>';
        }
      };

      pagingRow.appendChild(btn);
    }

    addHistoryButton();
    setTimeout(updateStats, 1500);

    // Re-scan when "Load More" adds new content
    const historyTable = document.getElementById('inventory_history_table');
    if (historyTable) {
      new MutationObserver(() => {
        setTimeout(updateStats, 500);
      }).observe(historyTable, { childList: true, subtree: true });
    }
  }

  if (IS_HISTORY) initCaseStats();

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
