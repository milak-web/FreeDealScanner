const axios = require('axios');
const cheerio = require('cheerio');

async function fetchEpicFreeGames() {
    const deals = [];
    
    // We scrape the actual browse page that you provided. 
    // To avoid 403, we use a more "human" approach.
    try {
        const browseUrl = "https://store.epicgames.com/en-US/browse?sortBy=currentPrice&sortDir=ASC&priceTier=tierDiscouted&count=100&start=0";
        
        const { data: html } = await axios.get(browseUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Cache-Control': 'no-cache',
                'Pragma': 'no-cache'
            },
            timeout: 20000
        });

        const $ = cheerio.load(html);

        // Try different selectors because Epic's class names change
        $('a').each((i, el) => {
            const card = $(el);
            const text = card.text().toLowerCase();
            
            // Check if this looks like a free game card
            if ((text.includes('free') || text.includes('0.00')) && text.includes('-100%')) {
                const title = card.find('div[class*="title"], [data-testid="title"]').first().text().trim() || 
                              card.find('span').first().text().trim();
                
                const relativeLink = card.attr('href');
                if (!relativeLink || !relativeLink.includes('/p/')) return;
                
                const link = `https://store.epicgames.com${relativeLink.split('?')[0]}`;
                const originalPrice = card.find('div[class*="originalPrice"], [data-testid="original-price"]').first().text().trim() || "N/A";
                const imageUrl = card.find('img').attr('src') || card.find('img').attr('data-src');

                if (title && title.length > 2 && !deals.find(d => d.link === link)) {
                    deals.push({
                        title,
                        platform: "Epic Games",
                        originalPrice,
                        link,
                        category: "Game",
                        startDate: null,
                        expiryDate: null, 
                        imageUrl
                    });
                }
            }
        });

        // Always merge with the Promotions API (which we know works and isn't blocked)
        try {
            const promoUrl = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US";
            const { data: promoData } = await axios.get(promoUrl);
            const elements = promoData.data.Catalog.searchStore.elements;
            
            elements.forEach(el => {
                const price = el.price?.totalPrice;
                if (!price || price.discountPrice !== 0 || price.originalPrice === 0) return;

                const pageSlug = el.productSlug || el.catalogNs.mappings?.[0]?.pageSlug || el.urlSlug;
                const link = `https://store.epicgames.com/en-US/p/${pageSlug}`;
                
                const promos = el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
                const existing = deals.find(d => d.link.includes(pageSlug));
                
                if (existing) {
                    if (promos) existing.expiryDate = promos.endDate;
                } else {
                    deals.push({
                        title: el.title,
                        platform: "Epic Games",
                        originalPrice: price.fmtPrice.originalPrice,
                        link,
                        category: "Game",
                        startDate: promos?.startDate || null,
                        expiryDate: promos?.endDate || null,
                        imageUrl: el.keyImages.find(img => img.type === "Thumbnail")?.url || el.keyImages[0]?.url
                    });
                }
            });
        } catch (e) {}

    } catch (e) {
        // If HTML scraping fails (403), we still have the Promotion API results
        console.warn("Epic HTML Scraper blocked, relying on Promotion API.");
    }

    return deals;
}

async function fetchSteamFreeDeals() {
    // 1. Primary: Steam Search for 100% off deals
    const searchUrl = "https://store.steampowered.com/search/?category1=998&specials=1";
    const deals = [];
    
    try {
        const { data } = await axios.get(searchUrl, { 
            headers: { 
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        const $ = cheerio.load(data);
        
        const dealPromises = [];
        
        $('#search_resultsRows a').each((i, el) => {
            const row = $(el);
            const discountPct = row.find('.discount_pct').text().trim();
            const finalPrice = row.find('.discount_final_price').text().trim().toLowerCase();
            const isFree = finalPrice.includes('free') || finalPrice.includes('0.00');

            if (!discountPct.includes('-100%') && !isFree) return;

            const title = row.find('.title').text().trim();
            const originalPrice = row.find('.discount_original_price').text().trim() || "N/A";
            const link = row.attr('href').split('?')[0];
            const appId = link.match(/\/app\/(\d+)/)?.[1];
            const imageUrl = appId ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg` : null;

            // Add a promise to fetch the timer from the app page
            dealPromises.push((async () => {
                let expiryDate = null;
                try {
                    const { data: appData } = await axios.get(link, { 
                        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
                        timeout: 5000 
                    });
                    const $app = cheerio.load(appData);
                    const timerText = $app('.game_purchase_discount_quantity').text().trim() || 
                                     $app('.game_purchase_discount_countdown').text().trim();
                    
                    if (timerText) {
                        // Extract "25 Mar @ 10:00am" from "Free to keep when you get it before 25 Mar @ 10:00am."
                        const match = timerText.match(/before (.*?)[\.\!]/i) || timerText.match(/ends (.*?)[\.\!]/i);
                        expiryDate = match ? match[1] : timerText;
                    }
                } catch (e) {
                    console.error(`Error fetching Steam timer for ${title}:`, e.message);
                }
                
                return { title, platform: "Steam", originalPrice, link, category: "Game", imageUrl, expiryDate };
            })());
        });
        
        const searchDeals = await Promise.all(dealPromises);
        deals.push(...searchDeals);
    } catch (e) {
        console.error("Steam Search Scraper Error:", e.message);
    }

    // 3. Generic Free-to-Keep Filter (Broadest search)
    try {
        const broadUrl = "https://store.steampowered.com/search/?maxprice=free&specials=1";
        const { data } = await axios.get(broadUrl, { 
            headers: { 
                'Accept-Language': 'en-US,en;q=0.9',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 10000
        });
        const $ = cheerio.load(data);
        
        const broadPromises = [];
        
        $('#search_resultsRows a').each((i, el) => {
            const row = $(el);
            const discountPct = row.find('.discount_pct').text().trim();
            if (!discountPct.includes('-100%')) return;

            const link = row.attr('href').split('?')[0];
            if (deals.find(d => d.link === link)) return;

            const title = row.find('.title').text().trim();
            const originalPrice = row.find('.discount_original_price').text().trim() || "N/A";
            const appId = link.match(/\/app\/(\d+)/)?.[1];
            const imageUrl = appId ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg` : null;

            broadPromises.push((async () => {
                let expiryDate = null;
                try {
                    const { data: appData } = await axios.get(link, { 
                        headers: { 'Accept-Language': 'en-US,en;q=0.9' },
                        timeout: 5000 
                    });
                    const $app = cheerio.load(appData);
                    const timerText = $app('.game_purchase_discount_quantity').text().trim() || 
                                     $app('.game_purchase_discount_countdown').text().trim();
                    
                    if (timerText) {
                        const match = timerText.match(/before (.*?)[\.\!]/i) || timerText.match(/ends (.*?)[\.\!]/i);
                        expiryDate = match ? match[1] : timerText;
                    }
                } catch (e) {}

                return { title, platform: "Steam", originalPrice, link, category: "Game", imageUrl, expiryDate };
            })());
        });
        
        const bDeals = await Promise.all(broadPromises);
        deals.push(...bDeals);
    } catch (e) {
        console.error("Steam Broad Search Error:", e.message);
    }

    // De-duplicate deals by link
    const uniqueDeals = [];
    const seenLinks = new Set();
    for (const deal of deals) {
        if (!seenLinks.has(deal.link)) {
            uniqueDeals.push(deal);
            seenLinks.add(deal.link);
        }
    }
    return uniqueDeals;
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

        // De-duplicate deals by link
        const uniqueDeals = [];
        const seenLinks = new Set();
        for (const deal of deals) {
            if (!seenLinks.has(deal.link)) {
                uniqueDeals.push(deal);
                seenLinks.add(deal.link);
            }
        }

        return uniqueDeals;
    } catch (e) {
        console.error("GOG Scraper Error:", e.message);
        return deals;
    }
}

async function getAllDeals() {
    const results = await Promise.allSettled([
        fetchEpicFreeGames(),
        fetchSteamFreeDeals(),
        fetchGOGDeals()
    ]);
    
    const now = new Date();
    return results
        .flatMap(r => r.status === 'fulfilled' ? r.value : [])
        .filter(deal => {
            if (!deal || !deal.expiryDate) return true;
            
            // Try to parse the date. If it fails, keep it just in case.
            try {
                const expiry = new Date(deal.expiryDate);
                if (isNaN(expiry.getTime())) return true;
                return expiry > now;
            } catch (e) {
                return true;
            }
        });
}

async function searchGamePrices(query) {
    if (!query || query.length < 2) return [];
    
    try {
        // 1. Search for games matching the query
        const searchUrl = `https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=10`;
        const { data: games } = await axios.get(searchUrl);
        
        if (!games || games.length === 0) return [];

        // 2. For the top results, get full deal information
        // We limit to 6 results to avoid aggressive rate limiting and keep UI clean
        const topGames = games.slice(0, 6);
        const results = [];
        
        for (const game of topGames) {
            try {
                const infoUrl = `https://www.cheapshark.com/api/1.0/games?id=${game.gameID}`;
                const { data: info } = await axios.get(infoUrl);
                
                // Comprehensive Store Map (CheapShark IDs)
                // Note: Some stores like EA (8), Rockstar, and Blizzard (31) are currently inactive in CheapShark's API.
                const storeMap = {
                    "1": "Steam", "2": "GamersGate", "3": "GreenManGaming", "7": "GOG",
                    "11": "Humble Store", "13": "Ubisoft Connect", "15": "Fanatical", 
                    "21": "WinGameStore", "23": "GameBillet", "25": "Epic Games Store", 
                    "27": "Gamesplanet", "28": "Gamesload", "29": "2Game", "30": "IndieGala", 
                    "35": "DreamGame"
                };

                const deals = info.deals.map(d => ({
                    store: storeMap[d.storeID] || "Other Authorized Store",
                    price: `$${d.price}`,
                    retailPrice: `$${d.retailPrice}`,
                    savings: `${Math.round(parseFloat(d.savings))}%`,
                    link: `https://www.cheapshark.com/redirect?dealID=${d.dealID}`
                })).sort((a, b) => parseFloat(a.price.replace('$', '')) - parseFloat(b.price.replace('$', '')));

                results.push({
                    gameID: game.gameID,
                    title: game.external,
                    imageUrl: game.thumb,
                    cheapestPriceEver: `$${info.cheapestPriceEver?.price || 'N/A'}`,
                    deals: deals
                });
                
                // Small delay to be polite to the API
                await new Promise(resolve => setTimeout(resolve, 100));
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

module.exports = { getAllDeals, searchGamePrices, fetchSteamFreeDeals, fetchEpicFreeGames, fetchGOGDeals };
