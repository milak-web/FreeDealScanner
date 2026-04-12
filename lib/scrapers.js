const axios = require('axios');
const cheerio = require('cheerio');

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
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                'Origin': 'https://store.epicgames.com',
                'Referer': 'https://store.epicgames.com/en-US/browse?sortBy=currentPrice&sortDir=ASC&priceTier=tierDiscouted'
            }
        });

        const elements = response?.data?.Catalog?.searchStore?.elements;
        if (elements) {
            elements.forEach(el => {
                const price = el.price?.totalPrice;
                if (!price) return;

                // We only want 100% off deals (discountPrice is 0, originalPrice > 0)
                const isFree = price.discountPrice === 0 && price.originalPrice > 0;
                
                if (isFree) {
                    const pageSlug = el.productSlug || el.urlSlug || (el.url ? el.url.split('/').pop() : null);
                    if (!pageSlug && !el.url) return;

                    const link = el.url ? (el.url.startsWith('http') ? el.url : `https://store.epicgames.com${el.url}`) : `https://store.epicgames.com/en-US/p/${pageSlug}`;
                    
                    // Deduplicate
                    if (deals.find(d => d.link === link)) return;

                    const promos = el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
                    let expiryDate = promos?.endDate || null;

                    deals.push({
                        title: el.title,
                        platform: "Epic Games",
                        originalPrice: price.fmtPrice.originalPrice,
                        link,
                        category: "Game",
                        startDate: promos?.startDate || null,
                        expiryDate,
                        imageUrl: el.keyImages.find(img => img.type === "Thumbnail")?.url || 
                                  el.keyImages.find(img => img.type === "OfferImageTall")?.url || 
                                  el.keyImages[0]?.url
                    });
                }
            });
        }
    } catch (e) {
        console.error("Epic Scraper Error:", e.message);
        // Fallback to the static endpoint if GraphQL is blocked
        return fetchEpicStaticFallback();
    }

    return deals;
}

async function fetchEpicStaticFallback() {
    const deals = [];
    try {
        const url = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US&count=100";
        const { data: response } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            }
        });

        const elements = response.data.Catalog.searchStore.elements;
        if (elements) {
            elements.forEach(el => {
                const price = el.price?.totalPrice;
                if (!price) return;

                const isCurrentlyFree = price.discountPrice === 0 && price.originalPrice > 0;
                const promos = el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
                const hasActivePromo = promos && promos.discountSetting?.discountPercentage === 0;

                if (isCurrentlyFree || hasActivePromo) {
                    const pageSlug = el.productSlug || el.catalogNs.mappings?.[0]?.pageSlug || el.urlSlug;
                    const link = `https://store.epicgames.com/en-US/p/${pageSlug}`;
                    
                    if (deals.find(d => d.link === link)) return;

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
        }
    } catch (e) {
        console.error("Epic Fallback Error:", e.message);
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

async function fetchMobileDeals() {
    const deals = [];
    
    // We target the official Google Play "Top Free Games" and "New Free Games" collections.
    // This uses official Play Store endpoints to ensure data accuracy.
    const collections = [
        "https://play.google.com/store/apps/collection/cluster?clp=og4jCiEKG3RvcHNlbGxpbmdfZnJlZV9HQU1FX0pBUEFOEAcYAw%3D%3D:S:ANO1ljJ_0W8&gsr=CiXSDicKIQobdG9wc2VsbGluZ19mcmVl_GQU1FX0pBUEFOEAcYAw:S:ANO1ljL9S6U",
        "https://play.google.com/store/apps/collection/cluster?clp=0g4XChUKD3RvcG5ld2ZyZWVfR0FNRRAHGAM%3D:S:ANO1ljLp_zU&gsr=ChrSDhcKFQoPdG9wbmV3ZnJlZV9HQU1FEAcYAw%3D%3D:S:ANO1ljL0q_Y"
    ];

    for (const url of collections) {
        try {
            const { data } = await axios.get(url, { 
                headers: { 
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
                    'Accept-Language': 'en-US,en;q=0.9'
                },
                timeout: 10000 
            });
            const $ = cheerio.load(data);
            
            // Google Play Store list items
            $('.ULeU3b').each((i, el) => {
                const title = $(el).find('.nn9vS').text().trim();
                const relativeLink = $(el).find('a').attr('href');
                if (!title || !relativeLink) return;

                const link = "https://play.google.com" + relativeLink;
                const imageUrl = $(el).find('img').attr('data-src') || $(el).find('img').attr('src');
                
                // Deduplicate
                if (deals.find(d => d.link === link)) return;

                deals.push({
                    title,
                    platform: "Google Play",
                    originalPrice: "FREE", // These are from the official "Free" collections
                    link,
                    category: "Mobile",
                    imageUrl: imageUrl || "https://upload.wikimedia.org/wikipedia/commons/d/d0/Google_Play_Arrow_logo.svg"
                });
            });
        } catch (e) {
            console.error(`Mobile Scraper Error (${url}):`, e.message);
        }
    }

    return deals;
}

async function getAllDeals() {
    const results = await Promise.allSettled([
        fetchEpicFreeGames(),
        fetchSteamFreeDeals(),
        fetchGOGDeals(),
        fetchMobileDeals()
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

module.exports = { getAllDeals, fetchSteamFreeDeals, fetchEpicFreeGames, fetchGOGDeals, fetchMobileDeals };
