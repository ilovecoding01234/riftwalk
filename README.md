# Riftwalk - CS2 Trading Extension

> Free browser extension that adds instant pricing, float values, Doppler phase detection, pattern tiers, sticker values, trade offer comparison, case opening stats, portfolio tracking, and an investment tracker directly to your Steam inventory.

![Version](https://img.shields.io/badge/version-1.5-blue)
![License](https://img.shields.io/badge/license-GPL--3.0-green)
![Chrome](https://img.shields.io/badge/platform-Chrome%20%7C%20Firefox%20%7C%20Edge%20%7C%20Brave%20%7C%20Opera-orange)

---

## Features

### Pricing
- **Two pricing modes:**
  - **PricEmpire + CSFloat** - Buff163/Skins.com prices + phase-specific Doppler pricing (requires free API keys)
  - **Skinport** - No API key required, includes built-in Doppler phase pricing
- **33,000+ items** priced from Buff163 and Skins.com via PricEmpire
- **Doppler phase-specific pricing** via CSFloat API or Skinport
- **Click any price** to open the Buff163 listing
- **Total inventory value** bar with item count

### Item Details
- **Float values** extracted from Steam's internal data
- **Fade percentage** detection for 27 weapons
- **Blue Gem tiers** - AK-47, Five-SeveN, Karambit (Scar, T1-T3)
- **Pattern tiers** - Max Pink, Max Blue, Fire & Ice (1st-10th Max), Crimson Web
- **Exterior labels** (FN/MW/FT/WW/BS) on every item
- **Rarity border glow** matching item quality

### Inspect in Browser
- **3D skin viewer** - click "Inspect in Browser" to open your exact skin in a 3D viewer with stickers and wear
- Works on any item with an inspect link

### Case Opening Stats
- **Track your case opening history** with rarity breakdown
- **Gold rate** - how many cases per knife/gloves
- **Best pull** with current market price
- **Money spent** - case cost + key cost calculated automatically
- **Compare your luck** against expected drop odds (1:385 gold, 1:156 covert, etc.)
- **Auto-scan history** with one click
- **Draggable stats panel** - move it anywhere on screen
- **Separate capsule tracking** - sticker capsules don't count as cases

### Portfolio Tracker
- **Track your inventory value** over time with interactive charts
- **Per-item price history** with sparkline trends
- **Time ranges** - 7D, 30D, 90D, 1Y, ALL for charts and item changes
- **Item detail view** with individual price charts, float, seed, and skin images
- **Export and import** portfolio data as JSON backup
- **Percentage change** alongside dollar values
- **Chart hover tooltip** showing value, date, and daily change
- **Owned since** date for every item
- **Currency mismatch warning** when viewing in a different currency than your data was recorded in

### Investment Tracker
- **Track buys and sells** of any CS2 item - not just what's in your inventory
- **Average cost, current value, unrealized and realized P&L, and ROI** per position
- **Accurate gem and Doppler pricing** (Ruby, Sapphire, Emerald, Black Pearl, and all phases) across both PricEmpire and Skinport modes
- **Smart item search** across the full catalog with price-on-hover
- **Sortable holdings table** with clickable column headers and a filter box
- **Portfolio allocation breakdown** by category (knives, gloves, weapons, stickers, charms, agents, cases, and more)
- **Best and worst performer** cards
- **Realized P&L history log** with date, quantity, price, and gain per sale
- **Configurable, fee-aware sell target** - set your profit % and marketplace fee % to see the list price needed to net that profit, plus break-even
- **Per-position notes** and full JSON export/import
- **Currency mismatch warning** when viewing in a different currency than your data was entered

### Price Watch
- **Set price alerts** on any skin (at/below or at/above) with clear hit/waiting status

### Stickers & Patches
- **Hover popup** showing all applied stickers, patches, and charms with prices
- **Individual prices** for each sticker with total value
- **Combined popup** with float, seed, and pattern info

### Trade Offers
- **Profit/loss with %** on trade offer creation page
- **PnL on incoming/sent offers** via Steam API
- **Manual price override** for Dopplers and special items
- **Fast Accept / Fast Decline** - accept or decline incoming offers straight from the offers list without opening each one

### Profile Buttons
- **Copy SteamID64** - one click copy
- **Copy Trade Link** - on your own profile
- **CSFloat Stall** - open anyone's CSFloat stall
- **CSGO-Rep** - open anyone's CSGO-Rep profile

### Trade Lock
- **Days remaining** countdown on trade-locked items
- **Context 16 support** - trade-locked items get prices and floats

### Inventory Tools
- **Fuzzy search** bar
- **Sort by price**
- **Multi-select** with Ctrl+click
- **Copy inventory list** with full details (phase, float, fade, stickers)
- **Duplicate count** badges
- **Page reload button** to re-fetch prices and labels

### Performance
- **Smart batching** for large inventories (1000+ items)
- **Visible-page-only** processing
- **Direct item link support** - floats load when navigating via shared inventory links

---

## Screenshots

| Inventory View | Doppler Detection |
|:-:|:-:|
| ![Inventory](https://rftwlk.com/ss-inventory.png) | ![Dopplers](https://rftwlk.com/ss-dopplers-v12.png) |

| Trade Offer PnL | Incoming Trade PnL |
|:-:|:-:|
| ![Trade](https://rftwlk.com/ss-tradeoffer.png) | ![Incoming](https://rftwlk.com/ss-tradepnl-v12.png) |

| Blue Gem + Stickers | Case Opening Stats |
|:-:|:-:|
| ![Blue Gem](https://rftwlk.com/ss-bluegem-v12.png) | ![Case Stats](https://rftwlk.com/ss-casestats-v12.png) |

| Portfolio Tracker | Portfolio Item Detail |
|:-:|:-:|
| ![Portfolio](https://rftwlk.com/ss-portfolio-v13.png) | ![Item Detail](https://rftwlk.com/ss-portfolio-item-v13.png) |

| Investment Tracker | Settings |
|:-:|:-:|
| ![Investment Tracker](https://rftwlk.com/ss-investment-v14.png) | ![Settings](https://rftwlk.com/ss-popup-v12.png) |

| Features | |
|:-:|:-:|
| ![Features](https://rftwlk.com/ss-features-v12.png) | |

---

## Installation

### Chrome Web Store
1. Visit the [Chrome Web Store listing](https://chromewebstore.google.com/detail/riftwalk-cs2-trading-enha/ckfkgceckiojoblhpiimilfldomfgakl)
2. Click "Add to Chrome"

### Firefox Add-ons
1. Visit the [Firefox Add-ons listing](https://addons.mozilla.org/addon/riftwalk-cs2-trading-enhancer/)
2. Click "Add to Firefox"

### Edge Add-ons
1. Visit the [Edge Add-ons listing](https://microsoftedge.microsoft.com/addons/detail/degogfidonllpadogbhpjgpjfpnomldk)
2. Click "Get"

### Manual Install (Developer Mode)
1. Download or clone this repo
2. Open `chrome://extensions/`
3. Enable **Developer mode** (top right)
4. Click **Load unpacked**
5. Select the `riftwalk` folder
6. Open any Steam inventory - Riftwalk is active!

---

## Setup

### Option 1: Skinport Mode (No API key needed)
1. Click the Riftwalk icon in your browser toolbar
2. Toggle the pricing mode switch to **Skinport**
3. Click **Save & Fetch Prices**
4. Done - prices load with zero setup!

### Option 2: PricEmpire + CSFloat Mode (More accurate)
1. Get a free API key at [pricempire.com/settings/developer](https://pricempire.com/settings/developer)
2. Click the Riftwalk icon in your browser toolbar
3. Paste your API key in the **Settings** tab
4. Click **Save & Fetch Prices**
5. (Optional) Add a CSFloat API key from [csfloat.com/profile](https://csfloat.com/profile) for Doppler phase pricing and high-value item images

---

## Changelog

### v1.5
- **Faster inventory total** - the total value loads faster and updates in fewer, larger steps instead of slowly ticking up item by item
- **Smoother large trade offers** - scrolling and paging through big inventories (hundreds of items) on the trade offer page is no longer laggy
- **Doppler price caching** - Doppler and gem prices are cached across inventories for 12 hours, so revisiting or viewing other inventories with the same knives loads instantly and hits CSFloat far less often
- **Fast Accept and Fast Decline** - accept or decline incoming trade offers directly from the offers list without opening each one, useful for bulk gift deliveries like opening lots of cases (offers where you give items still require Steam mobile confirmation as usual)

### v1.4
- **Fix** - Inventory float and pattern values now load reliably for items whose inspect links resolve after the page renders
- **Fix** - Portfolio tracker now drops items you no longer own instead of keeping them
- **Fix** - Portfolio tracker now warns when you switch to a different currency than your data was recorded in
- **Page reload button** on the inventory bar to re-fetch prices and labels
- **Investment Tracker** - track buys and sells of any CS2 item with average cost, current value, unrealized and realized P&L, and ROI. Accurate gem and Doppler pricing (Ruby, Sapphire, Emerald, Black Pearl, and all phases) across both PricEmpire and Skinport modes
- **Smart item search** across the full catalog with price-on-hover
- **Sortable holdings table** with clickable column headers and a filter box
- **Portfolio allocation breakdown** by category (knives, gloves, weapons, stickers, charms, agents, cases, and more)
- **Best and worst performer cards**
- **Realized P&L history log** with date, quantity, price, and gain per sale
- **Configurable, fee-aware sell target** - set your profit % and marketplace fee % to see the list price needed to net that profit, plus break-even
- **Per-position notes** and full JSON export/import
- **Price Watch** - set price alerts on any skin (at/below or at/above) with clear hit/waiting status
- **Multi-currency support** with up-to-date conversion across all supported currencies

### v1.3.2
- **StatTrak and Souvenir labels** - ST/SV prefix shown on all items across inventory, trade offers, and incoming trades
- **Charm template display** - Shows paintindex on charm items in inventory and trade pages
- **Improved settings import** - Shows fetch progress and error details

### v1.3.1
- **Fix** - Portfolio tracker now correctly scopes to your own inventory only

### v1.3
- **Portfolio Tracker** - Track your inventory value over time with interactive charts, per-item price history, sparkline trends, time ranges, item detail view with skin images, and data export/import
- **Fix** - Case Stats now correctly counts knives and gloves as gold items

### v1.2
- **Case Opening Stats** - Track case openings with rarity breakdown, gold rate, best pull, money spent, and luck comparison vs expected odds
- **Direct Link Fix** - Floats and patterns now load when navigating via shared inventory links
- **Open Case Stats button** - Added to inventory page header
- **Discord link** - Added to extension popup

### v1.1
- **Doppler Pricing Fix** - Correct phase-specific prices for all knife types (Butterfly, Karambit, etc.)
- **Skinport Pricing Mode** - New toggle in settings. Get prices with zero API keys required.
- **Inspect in Browser** - New button opens a 3D skin viewer with your exact skin, stickers, and wear.
- **Price Sanity Filter** - Fixed absurd pricing on items like Operation Hydra Case Key.
- **Currency Fix** - Doppler prices now correctly convert to your selected currency (EUR, GBP, CNY).

### v1.0
- Initial release

---

## Project Structure

```
riftwalk/
├── manifest.json          # Extension manifest (MV3)
├── content.js             # Main content script - inventory labeling, trade offers, case stats
├── pageworld.js           # MAIN world script - access to Steam's JS globals
├── background.js          # Service worker - PricEmpire/Skinport API, CSFloat proxy
├── skin_data.js           # Pattern databases - fade, blue gem, doppler, marble fade
├── inspect_decoder.js     # Bundled CS2 inspect link decoder
├── popup.html             # Extension popup UI
├── popup.js               # Popup logic - settings, status, import/export
├── portfolio.html         # Portfolio tracker page
├── portfolio.js           # Portfolio tracker logic - charts, items, export/import
├── watchlist.html         # Investment tracker page
├── watchlist.js           # Investment tracker logic - positions, P&L, allocation, price watch
├── settings-template.json # Default settings for import
└── icons/                 # Extension icons (16, 32, 48, 128px)
```

---

## Privacy

- **No data collection** - everything runs locally in your browser
- **No servers** - API calls go directly to PricEmpire, Skinport, CSFloat, and Steam
- **No tracking** inside the extension
- Full privacy policy at [rftwlk.com/privacy](https://rftwlk.com/privacy)

---

## Contributing

Found a bug? Have a feature idea?

- Open an [issue](../../issues)
- Join our [Discord](https://discord.gg/6MFAmebrHW)
- Submit a pull request

---

## Support

Riftwalk is 100% free. If it helped you on a trade, consider dropping a skin:

**[Copy Trade Link](https://steamcommunity.com/tradeoffer/new/?partner=394611180&token=mtORf08f)**

---

## License

GPL-3.0 License - see [LICENSE](LICENSE) for details.

---

**[rftwlk.com](https://rftwlk.com)** | **[Discord](https://discord.gg/6MFAmebrHW)** | **[Steam](https://steamcommunity.com/id/rftwlk)**
