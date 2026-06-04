// Riftwalk - Page World Script (MAIN world)
(function() {
  'use strict';

  var lastPropsCount = 0;
  var lastAssetsCount = 0;

  function dumpAssets() {
    var el = document.getElementById('rw-asset-dump');
    if (!el) { el = document.createElement('div'); el.id = 'rw-asset-dump'; el.style.display = 'none'; document.body.appendChild(el); }
    var el2 = document.getElementById('rw-descs-dump');
    if (!el2) { el2 = document.createElement('div'); el2.id = 'rw-descs-dump'; el2.style.display = 'none'; document.body.appendChild(el2); }
    var map = {}, descs = {};
    function extract(assets) {
      if (!assets) return;
      for (var id in assets) {
        if (!assets.hasOwnProperty(id)) continue;
        var item = assets[id];
        if (!item) continue;
        var name = item.market_hash_name || (item.description && item.description.market_hash_name);
        if (name && !map[id]) map[id] = name;
        if (name && !descs[id]) {
          var d = item.description || {};
          descs[id] = {
            market_hash_name: name,
            descriptions: item.descriptions || d.descriptions,
            tags: item.tags || d.tags,
            icon_url: item.icon_url || d.icon_url,
            owner_descriptions: item.owner_descriptions || d.owner_descriptions,
            type: item.type || d.type,
            tradable: item.tradable != null ? item.tradable : d.tradable
          };
        }
      }
    }
    try {
      if (typeof g_rgAssets !== 'undefined' && g_rgAssets && g_rgAssets[730] && g_rgAssets[730][2]) extract(g_rgAssets[730][2]);
      if (typeof g_ActiveInventory !== 'undefined' && g_ActiveInventory) { extract(g_ActiveInventory.m_rgAssets); extract(g_ActiveInventory.rgInventory); }
      if (typeof UserYou !== 'undefined' && UserYou && typeof UserYou.getInventory === 'function') {
        try { var inv = UserYou.getInventory(730, 2); if (inv) { extract(inv.m_rgAssets); extract(inv.rgInventory); } } catch(e2) {}
        try { var inv16 = UserYou.getInventory(730, 16); if (inv16) { extract(inv16.m_rgAssets); extract(inv16.rgInventory); } } catch(e4) {}
      }
      if (typeof UserThem !== 'undefined' && UserThem && typeof UserThem.getInventory === 'function') { try { var inv2 = UserThem.getInventory(730, 2); if (inv2) { extract(inv2.m_rgAssets); extract(inv2.rgInventory); } } catch(e3) {} }
    } catch(e) {}
    var count = Object.keys(map).length;
    if (count > 0 && count !== lastAssetsCount) {
      lastAssetsCount = count;
      console.log('[Riftwalk] Asset dump: ' + count + ' items');
    }
    el.textContent = JSON.stringify(map);
    if (Object.keys(descs).length > 0) el2.textContent = JSON.stringify(descs);
    document.dispatchEvent(new CustomEvent('rw-assets-ready'));
  }

  function dumpProperties(force) {
    var el = document.getElementById('rw-props-dump');
    if (!el) { el = document.createElement('div'); el.id = 'rw-props-dump'; el.style.display = 'none'; document.body.appendChild(el); }
    var props = {};
    function extractProps(source) {
      if (!source) return;
      for (var id in source) {
        if (!source.hasOwnProperty(id) || props[id]) continue;
        var ap = source[id];
        if (!ap || !Array.isArray(ap)) continue;
        var item = {};
        for (var i = 0; i < ap.length; i++) {
          var p = ap[i];
          if (p.propertyid === 1 && p.int_value) item.paintseed = parseInt(p.int_value);
          if (p.propertyid === 2 && p.float_value) item.floatvalue = parseFloat(p.float_value);
          if ((p.propertyid === 3 || p.propertyid === 7) && p.int_value) item.paintindex = parseInt(p.int_value);
          if (p.propertyid === 6 && p.string_value) item.inspectHex = p.string_value;
        }
        if (item.floatvalue || item.inspectHex) props[id] = item;
      }
    }
    function extractFromInventory(inv) {
      if (!inv) return;
      var items = inv.rgInventory || inv.m_rgAssets;
      if (items) {
        for (var id in items) {
          if (!items.hasOwnProperty(id) || props[id]) continue;
          var itm = items[id];
          if (itm && itm.asset_properties && Array.isArray(itm.asset_properties)) {
            var item = {};
            for (var j = 0; j < itm.asset_properties.length; j++) {
              var q = itm.asset_properties[j];
              if (q.propertyid === 1 && q.int_value) item.paintseed = parseInt(q.int_value);
              if (q.propertyid === 2 && q.float_value) item.floatvalue = parseFloat(q.float_value);
              if ((q.propertyid === 3 || q.propertyid === 7) && q.int_value) item.paintindex = parseInt(q.int_value);
              if (q.propertyid === 6 && q.string_value) item.inspectHex = q.string_value;
            }
            if (item.floatvalue || item.inspectHex) props[id] = item;
          }
        }
      }
      if (inv.m_rgAssetProperties) extractProps(inv.m_rgAssetProperties);
    }
    try {
      if (typeof g_ActiveInventory !== 'undefined' && g_ActiveInventory) {
        extractFromInventory(g_ActiveInventory);
        if (g_ActiveInventory.m_rgAssetProperties) extractProps(g_ActiveInventory.m_rgAssetProperties);
      }
      if (typeof UserYou !== 'undefined' && UserYou && typeof UserYou.getInventory === 'function') {
        try { extractFromInventory(UserYou.getInventory(730, 2)); } catch(e2) {}
      }
      if (typeof UserThem !== 'undefined' && UserThem && typeof UserThem.getInventory === 'function') {
        try { extractFromInventory(UserThem.getInventory(730, 2)); } catch(e3) {}
      }
    } catch(e) {}
    var count = Object.keys(props).length;
    var changed = count > 0 && count !== lastPropsCount;
    if (changed) {
      lastPropsCount = count;
      console.log('[Riftwalk] Extracted properties for ' + count + ' items');
    }
    if (changed || force) {
      el.textContent = JSON.stringify(props);
      document.dispatchEvent(new CustomEvent('rw-props-ready'));
    }
  }

  function exposeOwner() {
    var el = document.getElementById('rw-owner'); if (!el) { el = document.createElement('div'); el.id = 'rw-owner'; el.style.display = 'none'; document.body.appendChild(el); }
    try {
      if (typeof g_ActiveInventory !== 'undefined' && g_ActiveInventory && g_ActiveInventory.owner && g_ActiveInventory.owner.strSteamId) {
        el.textContent = g_ActiveInventory.owner.strSteamId;
        console.log('[Riftwalk] Owner SteamID: ' + el.textContent);
      }
    } catch(e) {}
  }

  function exposeViewer() {
    var el = document.getElementById('rw-viewer'); if (!el) { el = document.createElement('div'); el.id = 'rw-viewer'; el.style.display = 'none'; document.body.appendChild(el); }
    try {
      if (typeof g_steamID !== 'undefined' && g_steamID) el.textContent = g_steamID;
    } catch(e) {}
  }

  function loadFullInventory() {
    try {
      if (typeof g_ActiveInventory !== 'undefined' && g_ActiveInventory && typeof g_ActiveInventory.LoadCompleteInventory === 'function') {
        g_ActiveInventory.LoadCompleteInventory();
        console.log('[Riftwalk] LoadCompleteInventory called');
      }
    } catch(e) {}
  }

  document.addEventListener('rw-request-dump', function() { dumpAssets(); dumpProperties(); });
  document.addEventListener('rw-request-loadall', loadFullInventory);
  document.addEventListener('rw-request-owner', function() { exposeOwner(); exposeViewer(); });
  document.addEventListener('rw-request-props', function() { dumpProperties(true); });

  function initAll() { exposeOwner(); exposeViewer(); dumpAssets(); dumpProperties(true); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function() { setTimeout(initAll, 1500); });
  else setTimeout(initAll, 1500);
  setTimeout(initAll, 5000);

  // Poll for new properties every 2 seconds (Steam loads them lazily on page change)
  setInterval(function() {
    dumpAssets();
    dumpProperties();
  }, 2000);

  console.log('[Riftwalk] Page world ready');
})();
