const axios = require('axios');
const cheerio = require('cheerio');

const MONTH_INDEX = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    sept: 8,
    oct: 9,
    nov: 10,
    dec: 11
};

const NON_GAME_KEYWORDS = [
    'soundtrack',
    'dlc',
    'expansion',
    'season pass',
    'demo',
    'test server',
    'playtest',
    'avatar',
    'wallpaper'
];

const DEFAULT_HEADERS = {
    'Accept-Language': 'en-US,en;q=0.9',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36'
};

function normalizeLink(raw) {
    if (!raw || typeof raw !== 'string') return null;
    try {
        const u = new URL(raw);
        u.search = '';
        u.hash = '';
        return u.toString().replace(/\/$/, '');
    } catch (_) {
        return raw.split('?')[0].trim().replace(/\/$/, '');
    }
}

function hasNonGameSignal(title) {
    if (!title || typeof title !== 'string') return true;
    const t = title.toLowerCase();
    return NON_GAME_KEYWORDS.some(k => t.includes(k));
}

function isValidDate(value) {
    const d = new Date(value);
    return !Number.isNaN(d.getTime());
}

function finalizeDeals(rawDeals) {
    const now = new Date();
    const unique = [];
    const seen = new Set();

    for (const deal of rawDeals || []) {
        if (!deal || !deal.title || !deal.platform || !deal.link) continue;
        if (hasNonGameSignal(deal.title)) continue;

        const normalizedLink = normalizeLink(deal.link);
        if (!normalizedLink || !normalizedLink.startsWith('http')) continue;
        if (seen.has(normalizedLink)) continue;

        if (deal.expiryDate) {
            if (!isValidDate(deal.expiryDate)) continue;
            if (new Date(deal.expiryDate) <= now) continue;
        }

        unique.push({
            ...deal,
            link: normalizedLink
        });
        seen.add(normalizedLink);
    }

    return unique;
}

function parseSteamExpiryToIso(rawTimerText) {
    if (!rawTimerText || typeof rawTimerText !== 'string') return null;

    const normalized = rawTimerText.replace(/\s+/g, ' ').trim();
    const lower = normalized.toLowerCase();
    const extracted =
        lower.match(/before (.*?)(?:[.!]|$)/i)?.[1]?.trim() ||
        lower.match(/ends (.*?)(?:[.!]|$)/i)?.[1]?.trim() ||
        lower.match(/offer ends[:\s]+(.*?)(?:[.!]|$)/i)?.[1]?.trim() ||
        lower.match(/during this limited-time promotion.*?(\d{1,2}\s+[a-z]{3,9}.*?(?:am|pm|utc))/i)?.[1]?.trim() ||
        normalized;

    // Patterns seen on Steam:
    // "13 Apr @ 10:00am", "Apr 13 @ 10:00am", "2024 Oct 13 - 8:00pm", "26 June 2024 – 17:00:00 UTC"
    const dayMonthMatch = extracted.match(/^(\d{1,2})\s+([a-z]{3,9})\s*(?:\d{4})?\s*[@-]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
    const monthDayMatch = extracted.match(/^([a-z]{3,9})\s+(\d{1,2})\s*(?:,?\s*\d{4})?\s*[@-]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
    const yearMonthDayMatch = extracted.match(/^(\d{4})\s+([a-z]{3,9})\s+(\d{1,2})\s*[@-]\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)$/i);
    const utcStyleMatch = extracted.match(/^(\d{1,2})\s+([a-z]{3,9})\s+(\d{4})\s*[–-]\s*(\d{1,2}):(\d{2}):(\d{2})\s*utc$/i);

    if (utcStyleMatch) {
        const day = Number(utcStyleMatch[1]);
        const monthToken = utcStyleMatch[2].toLowerCase().slice(0, 4);
        const month = MONTH_INDEX[monthToken] ?? MONTH_INDEX[monthToken.slice(0, 3)];
        const year = Number(utcStyleMatch[3]);
        const hour = Number(utcStyleMatch[4]);
        const minute = Number(utcStyleMatch[5]);
        const second = Number(utcStyleMatch[6]);
        if (month === undefined) return null;
        const date = new Date(Date.UTC(year, month, day, hour, minute, second, 0));
        return Number.isNaN(date.getTime()) ? null : date.toISOString();
    }

    if (yearMonthDayMatch) {
        const year = Number(yearMonthDayMatch[1]);
        const monthToken = yearMonthDayMatch[2].toLowerCase().slice(0, 4);
        const month = MONTH_INDEX[monthToken] ?? MONTH_INDEX[monthToken.slice(0, 3)];
        const day = Number(yearMonthDayMatch[3]);
        const hour12 = Number(yearMonthDayMatch[4]);
        const minute = Number(yearMonthDayMatch[5]);
        const ampm = yearMonthDayMatch[7].toLowerCase();
        if (month === undefined) return null;
        let hour24 = hour12 % 12;
        if (ampm === 'pm') hour24 += 12;
        const candidate = new Date(year, month, day, hour24, minute, 0, 0);
        return Number.isNaN(candidate.getTime()) ? null : candidate.toISOString();
    }

    const match = dayMonthMatch || monthDayMatch;
    if (!match) return null;

    const hasDayFirst = Boolean(dayMonthMatch);
    const day = Number(hasDayFirst ? match[1] : match[2]);
    const monthToken = (hasDayFirst ? match[2] : match[1]).toLowerCase().slice(0, 4);
    const month = MONTH_INDEX[monthToken] ?? MONTH_INDEX[monthToken.slice(0, 3)];
    const hour12 = Number(match[3]);
    const minute = Number(match[4]);
    const ampm = match[6].toLowerCase();

    if (!Number.isInteger(day) || month === undefined || !Number.isInteger(hour12) || !Number.isInteger(minute)) {
        return null;
    }

    let hour24 = hour12 % 12;
    if (ampm === 'pm') hour24 += 12;

    const now = new Date();
    let year = now.getFullYear();
    let candidate = new Date(year, month, day, hour24, minute, 0, 0);

    // Steam timers around year boundaries can refer to next year.
    if (candidate.getTime() < now.getTime() - (24 * 60 * 60 * 1000)) {
        year += 1;
        candidate = new Date(year, month, day, hour24, minute, 0, 0);
    }

    return Number.isNaN(candidate.getTime()) ? null : candidate.toISOString();
}

function extractSteamExpiryFromPage(appData) {
    if (!appData || typeof appData !== 'string') return null;
    const $ = cheerio.load(appData);

    const directTimers = [
        $('.game_purchase_discount_quantity').text().trim(),
        $('.game_purchase_discount_countdown').text().trim(),
        $('.sale_ends_date').text().trim(),
        $('.discount_block .discount_notice').text().trim()
    ].filter(Boolean);

    for (const timerText of directTimers) {
        const parsed = parseSteamExpiryToIso(timerText);
        if (parsed) return parsed;
    }

    const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
    const textPatterns = [
        /free to keep when you get it before ([^.!\n]+)/i,
        /offer ends[:\s]+([^.!\n]+)/i,
        /(\d{1,2}\s+[a-z]{3,9}\s+\d{4}\s*[–-]\s*\d{1,2}:\d{2}:\d{2}\s*utc)/i,
        /([a-z]{3,9}\s+\d{1,2}\s*[,@-]\s*\d{1,2}:\d{2}\s*(?:am|pm))/i,
        /(\d{1,2}\s+[a-z]{3,9}\s*[@-]\s*\d{1,2}:\d{2}\s*(?:am|pm))/i
    ];

    for (const pattern of textPatterns) {
        const m = bodyText.match(pattern);
        if (!m || !m[1]) continue;
        const parsed = parseSteamExpiryToIso(m[1]);
        if (parsed) return parsed;
    }

    return null;
}

function getEpicPromoWindows(promotions) {
    const windows = [];
    const groups = [
        ...(promotions?.promotionalOffers || []),
        ...(promotions?.upcomingPromotionalOffers || [])
    ];
    for (const group of groups) {
        for (const promo of (group?.promotionalOffers || [])) {
            windows.push({
                startDate: promo.startDate || null,
                endDate: promo.endDate || null,
                discountPercentage: promo.discountSetting?.discountPercentage
            });
        }
    }
    return windows;
}

function pickEpicActivePromo(promotions) {
    const now = Date.now();
    const windows = getEpicPromoWindows(promotions)
        .filter(w => w.startDate && w.endDate && isValidDate(w.startDate) && isValidDate(w.endDate))
        .filter(w => new Date(w.startDate).getTime() <= now && new Date(w.endDate).getTime() > now)
        .sort((a, b) => new Date(a.endDate) - new Date(b.endDate));

    return windows[0] || null;
}

function buildEpicDeal(el) {
    const price = el?.price?.totalPrice;
    if (!price || !el?.title) return null;

    const activePromo = pickEpicActivePromo(el.promotions);
    const isCurrentlyFree = price.discountPrice === 0 && price.originalPrice > 0;
    const hasActiveFreePromo = activePromo && activePromo.discountPercentage === 0;
    if (!isCurrentlyFree && !hasActiveFreePromo) return null;

    const productSlug = typeof el.productSlug === 'string' ? el.productSlug.replace(/\/home$/i, '').trim() : null;
    const pageSlug =
        productSlug ||
        el.offerMappings?.[0]?.pageSlug ||
        el.catalogNs?.mappings?.[0]?.pageSlug ||
        el.urlSlug ||
        (el.url ? el.url.split('/').pop() : null);
    if (!pageSlug && !el.url) return null;

    const link = el.url
        ? (el.url.startsWith('http') ? el.url : `https://store.epicgames.com${el.url}`)
        : `https://store.epicgames.com/en-US/p/${pageSlug}`;

    const imageUrl =
        el.keyImages?.find(img => img.type === "Thumbnail")?.url ||
        el.keyImages?.find(img => img.type === "DieselStoreFrontWide")?.url ||
        el.keyImages?.find(img => img.type === "OfferImageTall")?.url ||
        el.keyImages?.[0]?.url ||
        null;

    return {
        title: el.title,
        platform: "Epic Games",
        originalPrice: price?.fmtPrice?.originalPrice || "N/A",
        link,
        category: "Game",
        startDate: activePromo?.startDate || null,
        expiryDate: activePromo?.endDate || null,
        imageUrl
    };
}

async function fetchEpicFreeGames() {
    const deals = [];
    const url = "https://store.epicgames.com/graphql";
    
    // This GraphQL query mimics the "Browse" page with sorting by price.
    // It captures ALL games that are currently 100% off.
    const query = `
    query searchStoreQuery($allowCountries: String, $category: String, $count: Int, $country: String!, $keywords: String, $locale: String, $namespace: String, $sortBy: String, $sortDir: String, $start: Int, $tag: String, $withPrice: Boolean = false, $onSale: Boolean = false) {
      Catalog {
        searchStore(allowCountries: $allowCountries, category: $category, count: $count, country: $country, keywords: $keywords, locale: $locale, namespace: $namespace, sortBy: $sortBy, sortDir: $sortDir, start: $start, tag: $tag, withPrice: $withPrice, onSale: $onSale) {
          elements {
            title
            keyImages {
              type
              url
            }
            productSlug
            urlSlug
            url
            items {
              id
              namespace
            }
            price {
              totalPrice {
                discountPrice
                originalPrice
                fmtPrice {
                  originalPrice
                  discountPrice
                }
              }
            }
            promotions {
              promotionalOffers {
                promotionalOffers {
                  startDate
                  endDate
                  discountSetting {
                    discountType
                    discountPercentage
                  }
                }
              }
            }
          }
        }
      }
    }`;

    const variables = {
        allowCountries: "US",
        category: "games/edition/base|software/edition/base",
        count: 100, // We take more to ensure we catch all free items
        country: "US",
        locale: "en-US",
        sortBy: "currentPrice",
        sortDir: "ASC",
        withPrice: true,
        onSale: true // This matches the "Discounted" filter in the browse link
    };

    try {
        const { data: response } = await axios.post(url, { query, variables }, {
            headers: {
                'Content-Type': 'application/json',
                ...DEFAULT_HEADERS,
                'Origin': 'https://store.epicgames.com',
                'Referer': 'https://store.epicgames.com/en-US/browse?sortBy=currentPrice&sortDir=ASC&priceTier=tierDiscouted'
            }
        });

        const elements = response?.data?.Catalog?.searchStore?.elements;
        if (elements) {
            elements.forEach(el => {
                const deal = buildEpicDeal(el);
                if (deal) deals.push(deal);
            });
        }
    } catch (e) {
        console.error("Epic Scraper Error:", e.message);
        // Fallback to the static endpoint if GraphQL is blocked
        return fetchEpicStaticFallback();
    }

    return finalizeDeals(deals);
}

async function fetchEpicStaticFallback() {
    const deals = [];
    try {
        const url = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US&count=100";
        const { data: response } = await axios.get(url, {
            headers: DEFAULT_HEADERS
        });

        const elements = response?.data?.Catalog?.searchStore?.elements;
        if (elements) {
            elements.forEach(el => {
                const deal = buildEpicDeal(el);
                if (deal) deals.push(deal);
            });
        }
    } catch (e) {
        console.error("Epic Fallback Error:", e.message);
    }
    return finalizeDeals(deals);
}

async function fetchSteamFreeDeals() {
    // 1. Primary: Steam Search for 100% off deals
    const searchUrl = "https://store.steampowered.com/search/?category1=998&specials=1";
    const deals = [];
    
    try {
        const { data } = await axios.get(searchUrl, { 
            headers: DEFAULT_HEADERS,
            timeout: 10000
        });
        const $ = cheerio.load(data);
        
        const dealPromises = [];
        
        $('#search_resultsRows a').each((i, el) => {
            const row = $(el);
            const discountPct = row.find('.discount_pct').text().trim();
            const finalPrice = row.find('.discount_final_price').text().trim().toLowerCase();
            const isFree = finalPrice.includes('free') || finalPrice.includes('0.00') || finalPrice.includes('$0');

            if (!discountPct.includes('-100%') || !isFree) return;

            const title = row.find('.title').text().trim();
            if (!title || hasNonGameSignal(title)) return;

            const originalPrice = row.find('.discount_original_price').text().trim() || "N/A";
            const href = row.attr('href');
            if (!href) return;

            const link = href.split('?')[0];
            if (!/\/app\/\d+/.test(link)) return;

            const appId = link.match(/\/app\/(\d+)/)?.[1];
            const imageUrl = appId ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg` : null;

            // Add a promise to fetch the timer from the app page
            dealPromises.push((async () => {
                let expiryDate = null;
                try {
                    const { data: appData } = await axios.get(link, { 
                        headers: DEFAULT_HEADERS,
                        timeout: 5000 
                    });
                    expiryDate = extractSteamExpiryFromPage(appData);
                } catch (e) {
                    console.error(`Error fetching Steam timer for ${title}:`, e.message);
                }

                // No reliable timer means high false-positive risk (for example always-free titles).
                if (!expiryDate || !isValidDate(expiryDate)) return null;

                return { title, platform: "Steam", originalPrice, link, category: "Game", imageUrl, expiryDate };
            })());
        });
        
        const searchDeals = await Promise.all(dealPromises);
        deals.push(...searchDeals.filter(Boolean));
    } catch (e) {
        console.error("Steam Search Scraper Error:", e.message);
    }

    return finalizeDeals(deals);
}

async function fetchGOGDeals() {
    const deals = [];
    
    // 1. Check for active giveaways on the home page (Most accurate for limited time)
    try {
        const { data: homeData } = await axios.get("https://www.gog.com/en/", { timeout: 5000 });
        const $home = cheerio.load(homeData);
        
        $home('a[href*="giveaway"]').each((i, el) => {
            const href = $home(el).attr('href');
            if (!href) return;
            const link = href.startsWith('http') ? href : "https://www.gog.com" + href;
            
            // Try to find a title in the giveaway banner
            const title = $home(el).find('.giveaway-banner__title, .giveaway-banner__game-title, h2, h3').first().text().trim();
            
            if (title) {
                deals.push({
                    title: title,
                    platform: "GOG Giveaway",
                    originalPrice: "N/A",
                    link,
                    category: "Game",
                    imageUrl: null 
                });
            }
        });
    } catch (e) {
        console.error("GOG Home Scraper Error:", e.message);
    }

    // 2. Check the catalog specifically for 100% off deals
    const url = "https://www.gog.com/en/games?onSale=true&order=desc:updated";
    try {
        const { data } = await axios.get(url, { timeout: 5000 });
        const $ = cheerio.load(data);
        
        // GOG uses .product-tile as a link or inside it
        $('a.product-tile, product-tile a, a[href*="/game/"]').each((i, el) => {
            const tileLink = $(el);
            const tile = tileLink.closest('product-tile').length ? tileLink.closest('product-tile') : tileLink;
            
            // Strictly check for -100% discount badge
            const discount = tile.find('.product-tile__discount, .price-discount').text().trim();
            if (discount !== '-100%') return;

            // Double check price - it must be FREE
            const finalPrice = tile.find('.product-tile__price-final, .price-final, .product-tile__price-discounted').text().trim().toUpperCase();
            if (finalPrice && !finalPrice.includes('FREE') && !finalPrice.includes('0.00')) return;

            const title = tile.find('.product-tile__title, .product-title, .title').first().text().trim();
            if (!title) return;

            const originalPrice = tile.find('.product-tile__price-original, .price-old').first().text().trim() || "N/A";
            const href = tileLink.attr('href') || tile.attr('href');
            if (!href) return;
            const link = href.startsWith('http') ? href : "https://www.gog.com" + href;
            
            // Improved GOG Image Extraction
            let imageUrl = tile.find('source').first().attr('srcset')?.split(',')[0].split(' ')[0] || 
                           tile.find('img').attr('data-src') || 
                           tile.find('img').attr('src');
            
            if (imageUrl && imageUrl.startsWith('//')) imageUrl = 'https:' + imageUrl;
            // Filter out base64 placeholders or trackers
            if (imageUrl && (imageUrl.startsWith('data:image') || imageUrl.includes('pixel'))) imageUrl = null;

            deals.push({
                title,
                platform: "GOG",
                originalPrice,
                link,
                category: "Game",
                imageUrl
            });
        });
        
        // 3. NO generic "Free Collection" - user doesn't want permanently free games, 
        // they want the ones that are usually paid but are currently free.

        return finalizeDeals(deals);
    } catch (e) {
        console.error("GOG Scraper Error:", e.message);
        return finalizeDeals(deals);
    }
}

async function fetchMobileDeals() {
    // Google Play pages return large sets of always-free apps and cannot reliably
    // distinguish temporary paid-to-free deals. Keep this source opt-in.
    if (process.env.ENABLE_MOBILE_EXPERIMENTAL !== 'true') {
        return [];
    }

    const deals = [];
    
    // We target official Google Play Store search results for 100% off games.
    // This uses a direct search URL which is more stable than specific collection clusters.
    const searchUrls = [
        "https://play.google.com/store/search?q=free%20games&c=apps",
        "https://play.google.com/store/games"
    ];

    for (const url of searchUrls) {
        try {
            const { data } = await axios.get(url, { 
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                    'Referer': 'https://play.google.com/'
                },
                timeout: 10000 
            });
            const $ = cheerio.load(data);
            
            // Search result and grid item selectors for Google Play Store
            $('a[href*="/store/apps/details"]').each((i, el) => {
                const relativeLink = $(el).attr('href');
                if (!relativeLink) return;

                const link = relativeLink.startsWith('http') ? relativeLink : "https://play.google.com" + relativeLink;
                
                // Find title and image relative to the link
                const parent = $(el).closest('.ULeU3b, .VfPpkd-LgbsSe, div[role="listitem"]');
                const title = $(el).find('.vP6uB, .nn9vS').text().trim() || 
                             $(el).attr('aria-label') || 
                             parent.find('.vP6uB, .nn9vS').text().trim();
                
                if (!title) return;
                if (deals.find(d => d.link === link)) return;

                const imageUrl = parent.find('img').attr('data-src') || parent.find('img').attr('src');

                deals.push({
                    title: title.replace('Install', '').trim(),
                    platform: "Google Play",
                    originalPrice: "FREE",
                    link,
                    category: "Mobile",
                    imageUrl: imageUrl || "https://upload.wikimedia.org/wikipedia/commons/d/d0/Google_Play_Arrow_logo.svg"
                });
            });
        } catch (e) {
            console.error(`Mobile Scraper Error (${url}):`, e.message);
        }
    }

    return finalizeDeals(deals);
}

async function searchGamePrices(query) {
    if (!query || query.length < 2) return [];

    try {
        const searchUrl = `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=10`;
        const { data: games } = await axios.get(searchUrl, { timeout: 10000 });
        if (!games || games.length === 0) return [];

        const storeMap = {
            "1": "Steam",
            "2": "GamersGate",
            "3": "GreenManGaming",
            "7": "GOG",
            "11": "Humble Store",
            "13": "Ubisoft Connect",
            "15": "Fanatical",
            "21": "WinGameStore",
            "23": "GameBillet",
            "25": "Epic Games Store",
            "27": "Gamesplanet",
            "28": "Gamesload",
            "29": "2Game",
            "30": "IndieGala",
            "35": "DreamGame"
        };

        const topGames = games.slice(0, 6);
        const results = [];
        for (const game of topGames) {
            try {
                const infoUrl = `https://www.cheapshark.com/api/1.0/games?id=${game.gameID}`;
                const { data: info } = await axios.get(infoUrl, { timeout: 10000 });
                if (!info || !Array.isArray(info.deals)) continue;

                const deals = info.deals
                    .map(d => ({
                        store: storeMap[d.storeID] || "Other Authorized Store",
                        price: `$${d.price}`,
                        retailPrice: `$${d.retailPrice}`,
                        savings: `${Math.round(parseFloat(d.savings || 0))}%`,
                        link: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
                    }))
                    .sort((a, b) => parseFloat(a.price.replace('$', '')) - parseFloat(b.price.replace('$', '')));

                results.push({
                    gameID: game.gameID,
                    title: game.external,
                    imageUrl: game.thumb,
                    cheapestPriceEver: `$${info.cheapestPriceEver?.price || 'N/A'}`,
                    deals
                });
            } catch (e) {
                console.error(`Error fetching info for game ${game.gameID}:`, e.message);
            }
        }

        return results;
    } catch (e) {
        console.error("Search Error:", e.message);
        return [];
    }
}

async function getAllDeals() {
    const scanTasks = [
        fetchEpicFreeGames(),
        fetchSteamFreeDeals(),
        fetchGOGDeals()
    ];

    if (process.env.ENABLE_MOBILE_EXPERIMENTAL === 'true') {
        scanTasks.push(fetchMobileDeals());
    }

    const results = await Promise.allSettled(scanTasks);
    const mergedDeals = results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
    return finalizeDeals(mergedDeals);
}

module.exports = { getAllDeals, searchGamePrices, fetchSteamFreeDeals, fetchEpicFreeGames, fetchGOGDeals, fetchMobileDeals };
