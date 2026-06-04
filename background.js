// ============================================================
// Riftwalk — Background Service Worker v1.3
// ============================================================

const CACHE_KEY       = 'rw_prices_cache';
const CACHE_TTL_MS    = 6 * 60 * 60 * 1000;
const FLOAT_CACHE     = 'rw_float_cache';
const DOPPLER_CACHE   = 'rw_doppler_cache';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  switch (msg.type) {

    case 'OPEN_PORTFOLIO':
      chrome.tabs.create({ url: chrome.runtime.getURL('portfolio.html') });
      return false;

    case 'OPEN_WATCHLIST':
      chrome.tabs.create({ url: chrome.runtime.getURL('watchlist.html') });
      return false;

    case 'FETCH_ITEM_IMAGE':
      fetchItemImage(msg.name)
        .then(icon => sendResponse({ icon }))
        .catch(() => sendResponse({ icon: null }));
      return true;

    case 'FETCH':
      fetch(msg.url, msg.options || {})
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;

    case 'GET_PRICES':
      chrome.storage.local.get([CACHE_KEY]).then(result => {
        const entry = result[CACHE_KEY];
        sendResponse({ prices: entry?.data || {}, ts: entry?.ts || null });
      });
      return true;

    case 'FORCE_REFRESH':
      fetchAndCachePrices()
        .then(() => sendResponse({ ok: true }))
        .catch(e => sendResponse({ ok: false, error: e.message }));
      return true;

    case 'GET_STATUS':
      chrome.storage.local.get([CACHE_KEY, 'rw_settings']).then(r => {
        const entry = r[CACHE_KEY];
        const s = r.rw_settings || {};
        const mode = s.pricingMode || 'pricempire';
        sendResponse({
          hasKey:      !!s.pricempireKey,
          hasSkinport: mode === 'skinport',
          mode:        mode,
          lastUpdated: entry?.ts || null,
          cacheAge:    entry?.ts ? Math.round((Date.now() - entry.ts) / 60000) : null,
          itemCount:   entry?.data ? Object.keys(entry.data).length : 0,
        });
      });
      return true;

    case 'GET_STEAM_TOKEN':
      scrapeAccessToken()
        .then(token => sendResponse({ success: true, token }))
        .catch(err => sendResponse({ success: false, error: err.message || err }));
      return true;

    case 'GET_TRADE_OFFERS':
      fetchTradeOffers(msg.sent, msg.received)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message || err }));
      return true;

    case 'GET_SETTINGS':
      chrome.storage.local.get(['rw_settings']).then(r =>
        sendResponse(r.rw_settings || {})
      );
      return true;

    case 'SAVE_SETTINGS':
      chrome.storage.local.set({ rw_settings: msg.settings }).then(() =>
        sendResponse({ success: true })
      );
      return true;

    case 'GET_FLOAT': {
      getFloat(msg.inspectLink)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }

    case 'GET_DOPPLER_PRICE': {
      getDopplerPrice(msg.marketHashName, msg.paintIndex)
        .then(data => sendResponse({ success: true, data }))
        .catch(err => sendResponse({ success: false, error: err.message }));
      return true;
    }
  }
});

// ── Item image (exact match) ────────────────────────────────
function iconUrl(hash) {
  // Use the same host the portfolio tracker uses successfully (content.js).
  return `https://steamcommunity.com/economy/image/${hash}/96x96`;
}

// Loose-normalize a name for comparison: strip star/tm, collapse whitespace.
function normName(s) {
  return (s || '').toLowerCase().replace(/★|™/g, '').replace(/[|]/g, ' ').replace(/\s+/g, ' ').trim();
}

// phase → candidate paint_indexes (varies by knife type; try each)
const PHASE_TO_PAINTS = {
  'Phase 1': [418, 569, 852, 1120],
  'Phase 2': [419, 570, 853, 1121],
  'Phase 3': [420, 571, 854, 1122],
  'Phase 4': [421, 572, 855, 1123],
  'Ruby': [415],
  'Sapphire': [416, 619],
  'Black Pearl': [417, 617],
  'Emerald': [568, 1119],
};

async function fetchItemImage(name) {
  if (!name) return null;
  const target = normName(name);

  // Detect Doppler phase from the name, if any. Doppler phases share a base
  // market name on Steam (so Steam search returns one generic icon for all
  // phases). For a phase-correct image we must use CSFloat, matched by phase.
  const phaseMatch = name.match(/-\s*(Phase\s*[1-4]|Ruby|Sapphire|Black Pearl|Emerald)\s*$/i);
  const wantPhase = phaseMatch ? phaseMatch[1].replace(/\s+/g, ' ').trim() : null;

  // Build candidate queries. Steam's search wants the base market name, so we
  // strip phase suffixes (Dopplers: " - Phase 2", "- Ruby", etc.) and, as a
  // further fallback, the wear parenthetical "(Factory New)".
  const noPhase = name.replace(/\s*-\s*(Phase\s*[1-4]|Ruby|Sapphire|Black Pearl|Emerald)\s*$/i, '').trim();
  const noWear = noPhase.replace(/\s*\([^)]*\)\s*$/, '').trim();

  // For Dopplers with a known phase, query CSFloat with paint_index (the same
  // approach as the working Doppler-price call) so CSFloat filters by phase
  // server-side. Each phase maps to several possible paint_indexes depending on
  // knife type, so we try each until one returns a listing with an icon.
  if (wantPhase) {
    const candidatePaints = PHASE_TO_PAINTS[wantPhase] || [];
    const settingsData = await chrome.storage.local.get(['rw_settings']);
    const csfloatKey = settingsData.rw_settings?.csfloatKey || '';
    for (const pi of candidatePaints) {
      try {
        const params = new URLSearchParams({
          market_hash_name: noPhase,
          paint_index: String(pi),
          sort_by: 'lowest_price',
          limit: '1',
          type: 'buy_now',
        });
        const url = `https://csfloat.com/api/v1/listings?${params}`;
        const headers = {};
        if (csfloatKey) headers['Authorization'] = csfloatKey;
        const r = await fetch(url, { headers });
        if (!r.ok) continue;
        const data = await r.json();
        const listings = Array.isArray(data) ? data : (data?.data || []);
        const hash = listings[0]?.item?.icon_url;
        if (hash) return iconUrl(hash);
      } catch (e) { /* try next paint_index */ }
    }
  }

  // Build candidate queries. Steam's search wants the base market name, so we
  // strip phase suffixes and, as a further fallback, the wear parenthetical.
  const queries = [];
  for (const cand of [name, noPhase, noWear]) {
    if (cand && !queries.includes(cand)) queries.push(cand);
  }

  for (const q of queries) {
    try {
      const url = `https://steamcommunity.com/market/search/render/?query=${encodeURIComponent(q)}&start=0&count=100&search_descriptions=0&appid=730&norender=1`;
      const r = await fetch(url, { credentials: 'include' });
      const ct = r.headers.get('content-type') || '';
      if (r.ok && ct.includes('json')) {
        const data = await r.json();
        if (Array.isArray(data?.results) && data.results.length) {
          // First try an exact (normalized) name match
          let match = data.results.find(x =>
            normName(x.hash_name) === target || normName(x.name) === target
          );
          // For Dopplers, the phase-suffixed name won't match Steam's listing,
          // so fall back to matching the phase-stripped base name. Any phase's
          // icon is an acceptable representation of the skin.
          if (!match && noPhase !== name) {
            const baseTarget = normName(noPhase);
            match = data.results.find(x =>
              normName(x.hash_name) === baseTarget || normName(x.name) === baseTarget
            );
          }
          if (match?.asset_description?.icon_url) return iconUrl(match.asset_description.icon_url);
        }
      }
    } catch (e) { /* try next query / fallback */ }
  }

  // Fallback: fetch the item's market listing PAGE (HTML) and pull the economy
  // image hash out of it. Covers some items search/render won't return.
  try {
    const url = `https://steamcommunity.com/market/listings/730/${encodeURIComponent(noPhase)}`;
    const r = await fetch(url, { credentials: 'include' });
    if (r.ok) {
      const html = await r.text();
      const m = html.match(/economy\/image\/([A-Za-z0-9_-]+)\/(?:\d+fx\d+f|\d+x\d+)/);
      if (m && m[1]) return iconUrl(m[1]);
    }
  } catch (e) { /* fall through */ }

  // Fallback for high-value items that exceed Steam's wallet cap and thus have
  // NO market listings (e.g. AWP | Dragon Lore). CSFloat lists these.
  try {
    const settingsData = await chrome.storage.local.get(['rw_settings']);
    const csfloatKey = settingsData.rw_settings?.csfloatKey || '';
    const params = new URLSearchParams({
      market_hash_name: noPhase,
      sort_by: 'lowest_price',
      limit: '1',
      type: 'buy_now',
    });
    const url = `https://csfloat.com/api/v1/listings?${params}`;
    const headers = {};
    if (csfloatKey) headers['Authorization'] = csfloatKey;
    const r = await fetch(url, { headers });
    if (r.ok) {
      const data = await r.json();
      const listings = Array.isArray(data) ? data : (data?.data || []);
      const hash = listings[0]?.item?.icon_url;
      if (hash) return iconUrl(hash);
    }
  } catch (e) { /* fall through */ }

  return null;
}

async function fetchAndCachePrices() {
  const data = await chrome.storage.local.get(['rw_settings']);
  const settings = data.rw_settings || {};
  const mode = settings.pricingMode || 'pricempire';

  if (mode === 'skinport') {
    return fetchSkinportPrices(settings);
  }
  return fetchPricempirePrices(settings);
}

async function fetchPricempirePrices(settings) {
  const apiKey = settings.pricempireKey || '';
  const currency = settings.currency || 'USD';
  if (!apiKey) throw new Error('No PricEmpire API key configured');

  console.log('[Riftwalk] Fetching PricEmpire prices...');
  const url = `https://api.pricempire.com/v4/trader/items/prices`
    + `?app_id=730&sources=buff163,skins`
    + `&currency=${encodeURIComponent(currency)}`
    + `&api_key=${encodeURIComponent(apiKey)}`;

  const res = await fetch(url, { headers: { 'Authorization': `Bearer ${apiKey}` } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`PricEmpire ${res.status}: ${text.slice(0, 200)}`);
  }

  const rawData = await res.json();
  if (!Array.isArray(rawData)) throw new Error(`Unexpected: ${typeof rawData}`);

  const priceMap = {};
  for (const item of rawData) {
    const name = item.market_hash_name;
    if (!name || !Array.isArray(item.prices)) continue;
    const entry = { buff: null, skins: null };
    for (const p of item.prices) {
      if (p.provider_key === 'buff163' && p.price > 0) entry.buff  = p.price;
      if (p.provider_key === 'skins'   && p.price > 0) entry.skins = p.price;
    }
    if (entry.buff || entry.skins) priceMap[name] = entry;
  }

  console.log(`[Riftwalk] Cached ${Object.keys(priceMap).length} PricEmpire prices`);
  await chrome.storage.local.set({ [CACHE_KEY]: { data: priceMap, ts: Date.now(), mode: 'pricempire' } });

  chrome.tabs.query({ url: '*://steamcommunity.com/*' }, tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'PRICES_UPDATED' }).catch(() => {});
  });
  return priceMap;
}

// ── Skinport ────────────────────────────────────────────────
async function fetchSkinportPrices(settings) {
  const currency = settings.spCurrency || 'USD';
  console.log(`[Riftwalk] Fetching Skinport prices (${currency})...`);

  // Fetch all three endpoints in parallel
  const [itemsRes, oosRes, histRes] = await Promise.all([
    fetch(`https://api.skinport.com/v1/items?app_id=730&currency=${encodeURIComponent(currency)}&tradable=0`, { headers: { 'Accept-Encoding': 'br' } }),
    fetch(`https://api.skinport.com/v1/sales/out-of-stock?app_id=730&currency=${encodeURIComponent(currency)}`, { headers: { 'Accept-Encoding': 'br' } }).catch(() => null),
    fetch(`https://api.skinport.com/v1/sales/history?app_id=730&currency=${encodeURIComponent(currency)}`, { headers: { 'Accept-Encoding': 'br' } }).catch(() => null),
  ]);

  if (!itemsRes.ok) {
    const text = await itemsRes.text().catch(() => '');
    throw new Error(`Skinport ${itemsRes.status}: ${text.slice(0, 200)}`);
  }

  const rawData = await itemsRes.json();
  if (!Array.isArray(rawData)) throw new Error(`Unexpected Skinport data: ${typeof rawData}`);

  const priceMap = {};
  const dopplerVersions = {}; // "market_hash_name|phase" -> price in cents

  for (const item of rawData) {
    const name = item.market_hash_name;
    if (!name) continue;

    const price = item.min_price || item.suggested_price;
    if (!price || price <= 0) continue;
    const cents = Math.round(price * 100);

    // Doppler items with version field get stored separately for phase-specific pricing
    if (item.version && /Phase|Ruby|Sapphire|Black Pearl|Emerald/i.test(item.version)) {
      const versionKey = `${name}|${item.version}`;
      dopplerVersions[versionKey] = cents;
    }

    // Always store/update the base price — keep the cheapest we've seen
    if (!priceMap[name]) {
      priceMap[name] = { buff: cents, skins: cents };
    } else {
      if (cents < priceMap[name].buff) {
        priceMap[name] = { buff: cents, skins: cents };
      }
    }
  }

  // Merge out-of-stock data for items missing from main endpoint
  if (oosRes && oosRes.ok) {
    try {
      const oosData = await oosRes.json();
      if (Array.isArray(oosData)) {
        let oosAdded = 0;
        for (const item of oosData) {
          const name = item.market_hash_name;
          if (!name) continue;
          const price = item.avg_sale_price || item.suggested_price;
          if (!price || price <= 0) continue;
          const cents = Math.round(price * 100);

          // Doppler versions from out-of-stock
          if (item.version && /Phase|Ruby|Sapphire|Black Pearl|Emerald/i.test(item.version)) {
            const versionKey = `${name}|${item.version}`;
            if (!dopplerVersions[versionKey]) {
              dopplerVersions[versionKey] = cents;
              oosAdded++;
            }
          }

          // Fill in missing base prices
          if (!priceMap[name]) {
            priceMap[name] = { buff: cents, skins: cents };
            oosAdded++;
          }
        }
        console.log(`[Riftwalk] Added ${oosAdded} prices from out-of-stock endpoint`);
      }
    } catch (e) {
      console.warn('[Riftwalk] Out-of-stock merge failed:', e.message);
    }
  }

  // Merge sales history for items still missing (covers rare items like AWP Gungnir FN)
  if (histRes && histRes.ok) {
    try {
      const histData = await histRes.json();
      if (Array.isArray(histData)) {
        let histAdded = 0;
        for (const item of histData) {
          const name = item.market_hash_name;
          if (!name) continue;
          // Use 30d avg first, fallback to 90d avg
          const price = item.last_30_days?.avg || item.last_90_days?.avg;
          if (!price || price <= 0) continue;
          const cents = Math.round(price * 100);

          // Doppler versions from history
          if (item.version && /Phase|Ruby|Sapphire|Black Pearl|Emerald/i.test(item.version)) {
            const versionKey = `${name}|${item.version}`;
            if (!dopplerVersions[versionKey]) {
              dopplerVersions[versionKey] = cents;
              histAdded++;
            }
          }

          // Fill in missing base prices
          if (!priceMap[name]) {
            priceMap[name] = { buff: cents, skins: cents };
            histAdded++;
          }
        }
        console.log(`[Riftwalk] Added ${histAdded} prices from sales history endpoint`);
      }
    } catch (e) {
      console.warn('[Riftwalk] Sales history merge failed:', e.message);
    }
  }

  console.log(`[Riftwalk] Cached ${Object.keys(priceMap).length} Skinport prices + ${Object.keys(dopplerVersions).length} Doppler versions`);
  await chrome.storage.local.set({
    [CACHE_KEY]: { data: priceMap, ts: Date.now(), mode: 'skinport' },
    'rw_skinport_dopplers': dopplerVersions,
  });

  chrome.tabs.query({ url: '*://steamcommunity.com/*' }, tabs => {
    for (const tab of tabs) chrome.tabs.sendMessage(tab.id, { type: 'PRICES_UPDATED' }).catch(() => {});
  });
  return priceMap;
}

// ── CSFloat float values ────────────────────────────────────
async function getFloat(inspectLink) {
  if (!inspectLink) throw new Error('No inspect link');
  const cached = await chrome.storage.local.get([FLOAT_CACHE]);
  const fc = cached[FLOAT_CACHE] || {};
  if (fc[inspectLink] && (Date.now() - fc[inspectLink].ts) < 86400000) return fc[inspectLink].data;

  const url = `https://api.csfloat.com/?url=${encodeURIComponent(inspectLink)}`;
  const res = await fetch(url);
  if (res.status === 429) throw new Error('CSFloat rate limited');
  if (!res.ok) throw new Error(`CSFloat ${res.status}`);

  const json = await res.json();
  const info = json.iteminfo || json;

  fc[inspectLink] = { data: info, ts: Date.now() };
  const keys = Object.keys(fc);
  if (keys.length > 500) {
    const sorted = keys.sort((a, b) => (fc[a].ts || 0) - (fc[b].ts || 0));
    for (let i = 0; i < sorted.length - 400; i++) delete fc[sorted[i]];
  }
  await chrome.storage.local.set({ [FLOAT_CACHE]: fc });
  return info;
}

// ── CSFloat Doppler phase-specific pricing ──────────────────
// Queries CSFloat listings API for lowest listing with specific paint_index
// This gives accurate phase-specific prices for Doppler/Gamma Doppler
async function getDopplerPrice(marketHashName, paintIndex) {
  if (!marketHashName || !paintIndex) throw new Error('Missing params');

  // Check cache (cache for 1 hour)
  const cacheKey = `${marketHashName}|${paintIndex}`;
  const cached = await chrome.storage.local.get([DOPPLER_CACHE]);
  const dc = cached[DOPPLER_CACHE] || {};
  if (dc[cacheKey] && (Date.now() - dc[cacheKey].ts) < 3600000) {
    return dc[cacheKey].data;
  }

  // Get CSFloat API key from settings
  const settingsData = await chrome.storage.local.get(['rw_settings']);
  const csfloatKey = settingsData.rw_settings?.csfloatKey || '';

  const params = new URLSearchParams({
    market_hash_name: marketHashName,
    paint_index: paintIndex.toString(),
    sort_by: 'lowest_price',
    limit: '1',
    type: 'buy_now',
  });

  const url = `https://csfloat.com/api/v1/listings?${params}`;
  const headers = {};
  if (csfloatKey) headers['Authorization'] = csfloatKey;

  const res = await fetch(url, { headers });
  if (res.status === 429) throw new Error('CSFloat rate limited');
  if (!res.ok) throw new Error(`CSFloat listings ${res.status}`);

  const listings = await res.json();

  let result = null;
  if (Array.isArray(listings) && listings.length > 0) {
    const listing = listings[0];
    result = {
      price: listing.price, // in cents
      floatValue: listing.item?.float_value,
      paintSeed: listing.item?.paint_seed,
      listingId: listing.id,
    };
  }

  // Cache result
  dc[cacheKey] = { data: result, ts: Date.now() };
  // Keep cache manageable
  const dcKeys = Object.keys(dc);
  if (dcKeys.length > 200) {
    const sorted = dcKeys.sort((a, b) => (dc[a].ts || 0) - (dc[b].ts || 0));
    for (let i = 0; i < sorted.length - 150; i++) delete dc[sorted[i]];
  }
  await chrome.storage.local.set({ [DOPPLER_CACHE]: dc });

  return result;
}

// ── Auto-refresh ────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(maybeRefresh);
chrome.runtime.onStartup.addListener(maybeRefresh);
async function maybeRefresh() {
  const result = await chrome.storage.local.get([CACHE_KEY, 'rw_settings']);
  const entry = result[CACHE_KEY];
  const s = result.rw_settings || {};
  const mode = s.pricingMode || 'pricempire';
  const hasConfig = mode === 'skinport' || s.pricempireKey;
  if (hasConfig && (!entry?.ts || Date.now() - entry.ts > CACHE_TTL_MS))
    fetchAndCachePrices().catch(e => console.warn('[Riftwalk] Auto-refresh failed:', e.message));
}

chrome.alarms.create('refresh_prices', { periodInMinutes: 360 });
chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === 'refresh_prices')
    fetchAndCachePrices().catch(e => console.warn('[Riftwalk] Alarm refresh failed:', e.message));
});

console.log('[Riftwalk] Background ready');

// ── Steam Access Token ──────────────────────────────────────
async function scrapeAccessToken() {
  const resp = await fetch('https://steamcommunity.com/', { credentials: 'include' });
  if (!resp.ok) throw new Error(`Steam fetch failed: ${resp.status}`);
  const html = await resp.text();
  const m = html.match(/data-loyalty_webapi_token="&quot;([^&]+)&quot;"/);
  if (!m) throw new Error('Access token not found - not logged in?');
  console.log('[Riftwalk] Steam access token scraped');
  return m[1];
}

// ── Trade Offers ────────────────────────────────────────────
async function fetchTradeOffers(getSent = true, getReceived = true) {
  // Get or scrape access token
  let { rw_steam_token: token } = await chrome.storage.local.get(['rw_steam_token']);
  if (!token) {
    token = await scrapeAccessToken();
    await chrome.storage.local.set({ rw_steam_token: token });
  }

  const url = `https://api.steampowered.com/IEconService/GetTradeOffers/v1/?get_received_offers=${getReceived ? 1 : 0}&get_sent_offers=${getSent ? 1 : 0}&active_only=0&historical_only=0&get_descriptions=1&language=english&access_token=${token}`;
  
  let resp = await fetch(url);
  
  // If 403, token expired — re-scrape and retry
  if (resp.status === 403) {
    console.log('[Riftwalk] Token expired, re-scraping...');
    token = await scrapeAccessToken();
    await chrome.storage.local.set({ rw_steam_token: token });
    resp = await fetch(url.replace(/access_token=[^&]+/, `access_token=${token}`));
  }
  
  if (!resp.ok) throw new Error(`GetTradeOffers failed: ${resp.status}`);
  const body = await resp.json();
  
  if (!body.response) throw new Error('Empty response');
  console.log(`[Riftwalk] Trade offers: ${body.response.trade_offers_received?.length || 0} received, ${body.response.trade_offers_sent?.length || 0} sent, ${body.response.descriptions?.length || 0} descriptions`);
  
  return body.response;
}
