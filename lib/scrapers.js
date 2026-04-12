const axios = require('axios');
const cheerio = require('cheerio');

async function fetchEpicFreeGames() {
    const url = "https://store-site-backend-static.ak.epicgames.com/freeGamesPromotions?locale=en-US&country=US&allowCountries=US";
    try {
        const { data } = await axios.get(url);
        const elements = data.data.Catalog.searchStore.elements;
        return elements
            .filter(el => {
                const offerType = el.offerType.toLowerCase();
                return ["base_game", "bundle", "edition"].includes(offerType);
            })
            .map(el => {
                const promos = el.promotions?.promotionalOffers?.[0]?.promotionalOffers?.[0];
                if (!promos || promos.discountSetting?.discountPercentage !== 0) return null;
                
                return {
                    title: el.title,
                    platform: "Epic Games",
                    originalPrice: el.price.totalPrice.fmtPrice.originalPrice,
                    link: `https://store.epicgames.com/en-US/p/${el.productSlug || el.catalogNs.mappings?.[0]?.pageSlug}`,
                    category: "Game",
                    startDate: promos.startDate,
                    expiryDate: promos.endDate,
                    imageUrl: el.keyImages.find(img => img.type === "Thumbnail")?.url || el.keyImages[0]?.url
                };
            })
            .filter(Boolean);
    } catch (e) {
        console.error("Epic Scraper Error:", e.message);
        return [];
    }
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

    // 2. Secondary: Reddit FreeGameFindings (Reliable fallback for specific Steam deals)
    try {
        const redditUrl = "https://www.reddit.com/r/FreeGameFindings/new.json?limit=100";
        const { data: redditData } = await axios.get(redditUrl, { headers: { 'User-Agent': 'FreeDealScanner/1.0' } });
        
        const redditDealPromises = [];
        
        redditData.data.children.forEach(post => {
            const p = post.data;
            const title = p.title.toLowerCase();
            const flair = (p.link_flair_text || "").toLowerCase();
            
            if (flair.includes('expired')) return;
            // Steam specific or general free games that might be on Steam
            if (!(title.includes('steam') || title.includes('100% off'))) return;
            if (!(title.includes('free') || title.includes('100%'))) return;

            // Extract Steam link from URL or selftext
            let steamLink = null;
            if (p.url.includes('store.steampowered.com/app/')) {
                steamLink = p.url.split('?')[0];
            } else if (p.selftext) {
                const match = p.selftext.match(/https?:\/\/store\.steampowered\.com\/app\/(\d+)/);
                if (match) steamLink = match[0];
            }
            
            if (steamLink) {
                const appId = steamLink.match(/\/app\/(\d+)/)?.[1];
                const imageUrl = appId ? `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${appId}/header.jpg` : null;
                
                // Only add if not already found via search
                if (!deals.find(d => d.link === steamLink)) {
                    redditDealPromises.push((async () => {
                        let expiryDate = null;
                        try {
                            const { data: appData } = await axios.get(steamLink, { 
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

                        return {
                            title: p.title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').replace(/steam/gi, '').trim(),
                            platform: "Steam",
                            originalPrice: "N/A",
                            link: steamLink,
                            category: "Game",
                            imageUrl,
                            expiryDate
                        };
                    })());
                }
            }
        });
        
        const rDeals = await Promise.all(redditDealPromises);
        deals.push(...rDeals);
    } catch (e) {
        console.error("Steam Reddit Fallback Error:", e.message);
    }

    // 3. Tertiary: Generic Free-to-Keep Filter (Broadest search)
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

    return deals;
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

async function verifyMobilePrice(link, platform, redditTitle = "") {
    // Define outside try/catch for scope
    const hasPriceDropInTitle = redditTitle.match(/(?:[\$£€]\d+(?:\.\d+)?|original)\s*(?:->|↘️|=>|to|was)\s*(?:[\$£€]0(?:\.00)?|free)/i);
    
    try {
        const { data } = await axios.get(link, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            timeout: 8000 
        });
        const $ = cheerio.load(data);

        if (platform === "Google Play") {
            const priceMeta = $('meta[itemprop="price"]').attr('content');
            const priceText = $('button[aria-label*="Buy"], button[aria-label*="Install"]').text().toLowerCase();
            
            // 1. If it's not free right now, discard
            if (priceMeta && priceMeta !== "0") return { verified: false };
            
            // Check for specific "Buy" text which indicates a price
            const buyMatch = priceText.match(/buy\s*[\$£€]\d+/i);
            if (buyMatch) return { verified: false };

            // 2. Is it a DEAL or just ALWAYS FREE?
            // Look for strike-through price or "discount" indicators
            const strikePrice = $('.SUalag, .VfPpkd-v97Zbe, [aria-label*="was"]').first().text().trim();
            const hasSaleText = $('body').text().match(/sale ends|discount|limited time|was\s*[\$£€]/i);
            
            // STRICT: Must have evidence of a deal
            if (strikePrice || hasSaleText || hasPriceDropInTitle) {
                return { verified: true, originalPrice: strikePrice || "N/A" };
            }
            
            // If it's natively free, discard
            return { verified: false };
        } 
        else if (platform === "Apple Store") {
            const jsonLd = $('script[type="application/ld+json"]').first().html();
            let currentPrice = null;
            
            if (jsonLd) {
                try {
                    const meta = JSON.parse(jsonLd);
                    currentPrice = meta.offers?.price || meta.offers?.[0]?.price;
                } catch (e) {}
            }

            // 1. If it's not free right now, discard
            if (currentPrice && parseFloat(currentPrice) > 0) return { verified: false };

            // 2. Is it a DEAL or just ALWAYS FREE?
            const priceTagText = $('.app-header__list__item--price').text().toLowerCase();
            const hasSaleIndicator = priceTagText.includes('was') || priceTagText.includes('previous') || hasPriceDropInTitle;
            const pageText = $('body').text().toLowerCase();
            const hasLimitedTimeText = pageText.includes('limited time') || pageText.includes('sale ends') || pageText.includes('free for a');

            if (hasSaleIndicator || hasLimitedTimeText || hasPriceDropInTitle) {
                return { verified: true, originalPrice: "N/A" };
            }

            // If natively free, discard
            return { verified: false };
        }
        return { verified: true };
    } catch (e) {
        // If the title looks like a strong deal, keep it as a fallback
        if (hasPriceDropInTitle) {
            return { verified: true, originalPrice: "N/A" };
        }
        return { verified: false };
    }
}

async function fetchRedditDeals(subreddit, platform) {
    const url = `https://www.reddit.com/r/${subreddit}/hot.json?limit=40`;
    try {
        const { data } = await axios.get(url, { headers: { 'User-Agent': 'FreeDealScanner/1.0' } });
        const initialDeals = data.data.children
            .filter(post => {
                const p = post.data;
                const flair = (p.link_flair_text || "").toLowerCase();
                const title = p.title.toLowerCase();
                
                if (p.stickied || flair.includes('expired') || flair.includes('ended') || flair.includes('deal closed')) return false;
                
                // CRITICAL: We want deals that ARE paid but CURRENTLY free.
                // We exclude "Free to Play" or "Always Free"
                if (title.includes('free to play') || title.includes('f2p') || flair.includes('f2p')) return false;

                const hasFreeIndicator = title.includes('free') || title.includes('100% off') || title.includes('0.00') || flair.includes('free');
                const isZeroPrice = title.includes('0.00') || title.includes('$0');
                
                if (!hasFreeIndicator && !isZeroPrice) return false;

                const blacklist = [
                    'trial', 'demo', 'in-app', 'iap', 'item', 'skin', 'dlc', 'expansion', 
                    'pack', 'subscription', 'membership', 'beta', 'test', 'guide', 'hint',
                    'manual', 'wallpaper', 'icon pack', 'free shipping', 'free delivery'
                ];
                
                if (blacklist.some(word => title.includes(word))) {
                    if (!(title.includes('now free') || title.includes('is free') || title.includes('iap free'))) {
                        return false;
                    }
                }

                // Exclude generic sales that aren't 100% off
                if (/\b\d{1,2}% off\b/.test(title) && !title.includes('100% off')) return false;

                return true;
            })
            .map(post => {
                const p = post.data;
                const title = p.title;
                const lowerTitle = title.toLowerCase();
                
                let finalLink = p.url;
                if (subreddit === 'AppHookup' || subreddit === 'googleplaydeals') {
                    const isDirect = finalLink.includes('apps.apple.com') || finalLink.includes('play.google.com');
                    if (!isDirect) {
                        const appleMatch = (p.selftext || "").match(/https?:\/\/apps\.apple\.com\/[a-z]{2}\/app\/[^\s\?\)\]]+/);
                        const googleMatch = (p.selftext || "").match(/https?:\/\/play\.google\.com\/store\/apps\/details\?id=[a-z0-9\._]+/);
                        if (platform === 'Apple Store' && appleMatch) finalLink = appleMatch[0];
                        else if (platform === 'Google Play' && googleMatch) finalLink = googleMatch[0];
                    }
                }

                finalLink = finalLink.replace(/[\)\]\s\.]+$/, '');
                
                let category = "Game";
                const softwareKeywords = ["app", "tool", "icon", "wallpaper", "editor", "scanner", "utility", "camera", "pro", "manager", "player", "pdf", "clock", "gallery", "vpn", "cleaner", "converter", "tracker", "widget"];
                if (softwareKeywords.some(k => lowerTitle.includes(k))) category = "Software";
                
                // Extract original price from title if possible
                let originalPrice = "N/A";
                const priceMatch = title.match(/[\$£€]\d+(?:\.\d+)?/);
                if (priceMatch && (lowerTitle.includes('->') || lowerTitle.includes('↘️') || lowerTitle.includes('was'))) {
                    originalPrice = priceMatch[0];
                }

                return {
                    title: title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').split(/(\$|free|100%|was)/i)[0].trim(),
                    rawTitle: title,
                    platform,
                    originalPrice,
                    link: finalLink,
                    category,
                    imageUrl: p.thumbnail?.startsWith('http') ? p.thumbnail : null
                };
            })
            .filter(deal => {
                if (deal.platform === "Apple Store" && !deal.link.includes('apps.apple.com')) return false;
                if (deal.platform === "Google Play" && !deal.link.includes('play.google.com')) return false;
                if (!deal.title || deal.title.length < 3) return false;
                return true;
            });

        // Insurgent Real-Time Verification for Mobile (Parallelized for speed)
        const verificationPromises = initialDeals.map(async (deal) => {
            if (deal.platform === "Apple Store" || deal.platform === "Google Play") {
                const result = await verifyMobilePrice(deal.link, deal.platform, deal.rawTitle);
                if (result.verified) {
                    if (result.originalPrice && result.originalPrice !== "N/A") deal.originalPrice = result.originalPrice;
                    return deal;
                }
                return null;
            }
            return deal;
        });

        const verifiedResults = await Promise.all(verificationPromises);
        return verifiedResults.filter(Boolean);

    } catch (e) {
        console.error(`Reddit (${subreddit}) Error:`, e.message);
        return [];
    }
}

async function verifyConsolePrice(link, platform) {
    try {
        const { data } = await axios.get(link, { 
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36' },
            timeout: 10000 
        });
        const $ = cheerio.load(data);
        
        // 1. Check for standard "Free" text or $0.00
        const pageText = $('body').text().toLowerCase();
        const hasFreeInText = pageText.includes('free') || pageText.includes('0.00') || pageText.includes('included');
        
        // 2. Check for common price patterns that indicate it's NOT free (e.g. $19.99)
        const hasPaidPrice = /\$[1-9]/.test(pageText);

        if (platform === "Xbox") {
            const priceMeta = $('meta[property="og:price:amount"]').attr('content') || $('meta[name="twitter:data1"]').attr('content');
            if (priceMeta && parseFloat(priceMeta) > 0) return false;
            
            // Check for Game Pass specific text
            if (pageText.includes('included with game pass') && !pageText.includes('free to keep')) return "Subscription Required";
        } 
        else if (platform === "PlayStation") {
            const priceText = $('[data-qa="psw-price-buy"], .psw-t-title-m').text().toLowerCase();
            if (/\$[1-9]/.test(priceText) && !priceText.includes('free') && !priceText.includes('included')) return false;
            
            if (pageText.includes('included with playstation plus')) return "Subscription Required";
        }
        else if (platform === "Nintendo") {
            const priceText = $('[class*="price"], [class*="Price"]').text().toLowerCase();
            if (/\$[1-9]/.test(priceText) && !priceText.includes('free') && !priceText.includes('0.00')) return false;
        }

        // If it's a paid price and doesn't mention "Free", it's probably not free
        if (hasPaidPrice && !hasFreeInText) return false;

        return true;
    } catch (e) {
        // Fallback: If we can't scrape, trust the source if it's a known deal aggregator
        return true; 
    }
}

async function fetchConsoleDeals() {
    const urls = [
        { url: `https://www.reddit.com/r/FreeGameFindings/hot.json?limit=100`, platform: "Console" },
        { url: `https://www.reddit.com/r/AppHookup/hot.json?limit=50`, platform: "Console" },
        { url: `https://www.reddit.com/r/PlayStationPlus/hot.json?limit=25`, platform: "PlayStation" },
        { url: `https://www.reddit.com/r/NintendoSwitchDeals/hot.json?limit=50`, platform: "Nintendo" }
    ];
    
    try {
        const results = await Promise.allSettled(urls.map(u => axios.get(u.url, { headers: { 'User-Agent': 'FreeDealScanner/1.0' }, timeout: 8000 })));
        const allPosts = results
            .filter(r => r.status === 'fulfilled')
            .flatMap((r, idx) => r.value.data.data.children.map(child => ({ ...child, sourcePlatform: urls[idx].platform })));
        
        console.log(`Found ${allPosts.length} total posts across console subreddits.`);

        const initialDeals = allPosts
            .filter(post => {
                const p = post.data;
                const title = p.title.toLowerCase();
                const flair = (p.link_flair_text || "").toLowerCase();
                
                // Allow "Monthly Games" even if stickied, but exclude general discussions
                if (p.stickied && !title.includes('monthly games') && !title.includes('essential')) return false;
                if (flair.includes('expired') || flair.includes('ended') || flair.includes('discussion')) return false;
                
                const isConsole = title.includes('[ps') || title.includes('[playstation') || 
                                 title.includes('[xbox') || title.includes('[nintendo') || 
                                 title.includes('[switch') || flair.includes('ps plus') || 
                                 title.includes('ps+') || post.sourcePlatform === "PlayStation" ||
                                 post.sourcePlatform === "Nintendo";
                
                const isMonthlyGames = title.includes('monthly games') || title.includes('essential') || flair.includes('monthly games');
                const hasFreeIndicator = title.includes('free') || title.includes('100% off') || 
                                       title.includes('0.00') || flair.includes('free') || isMonthlyGames;
                
                return isConsole && hasFreeIndicator;
            })
            .map(post => {
                // ... (mapping logic)
                const p = post.data;
                const title = p.title;
                const lowerTitle = title.toLowerCase();
                const flair = (p.link_flair_text || "").toLowerCase();
                
                let platform = post.sourcePlatform !== "Console" ? post.sourcePlatform : "Console";
                if (lowerTitle.includes('ps') || lowerTitle.includes('playstation')) platform = "PlayStation";
                else if (lowerTitle.includes('xbox')) platform = "Xbox";
                else if (lowerTitle.includes('nintendo') || lowerTitle.includes('switch')) platform = "Nintendo";

                let imageUrl = null;
                if (p.preview?.images?.[0]?.source?.url) {
                    imageUrl = p.preview.images[0].source.url.replace(/&amp;/g, '&');
                } else if (p.url && (p.url.includes('.jpg') || p.url.includes('.png') || p.url.includes('.jpeg'))) {
                    imageUrl = p.url;
                } else if (p.thumbnail && p.thumbnail.startsWith('http')) {
                    imageUrl = p.thumbnail;
                }

                let category = "Game";
                const isSub = lowerTitle.includes('ps plus') || lowerTitle.includes('playstation plus') || 
                            lowerTitle.includes('game pass') || lowerTitle.includes('gold') || 
                            lowerTitle.includes('essential') || lowerTitle.includes('extra') || 
                            lowerTitle.includes('premium') || lowerTitle.includes('subscription') ||
                            flair.includes('monthly games');
                
                if (isSub) category = "Subscription Required";

                let cleanedTitle = title.replace(/\[.*?\]/g, '').replace(/\(.*?\)/g, '').trim();
                if (!isSub) cleanedTitle = cleanedTitle.split(/(\$|free|100%|was|monthly)/i)[0].trim();

                return {
                    title: cleanedTitle || title,
                    platform,
                    originalPrice: "N/A",
                    link: p.url.startsWith('/') ? "https://www.reddit.com" + p.url : p.url,
                    category,
                    imageUrl
                };
            });

        console.log(`Found ${initialDeals.length} initial console deals.`);

        // Unique by link to avoid PS Plus duplicates
        const uniqueInitial = Array.from(new Map(initialDeals.map(d => [d.link, d])).values());

        const verifiedDeals = await Promise.all(uniqueInitial.map(async (deal) => {
            if (deal.category === "Subscription Required") return deal; 
            
            // Only verify if it's a direct store link. If it's a reddit self-post or other, trust the title.
            if (deal.link.includes('xbox.com') || deal.link.includes('playstation.com') || deal.link.includes('nintendo.com')) {
                const verificationResult = await verifyConsolePrice(deal.link, deal.platform);
                
                if (verificationResult === "Subscription Required") {
                    deal.category = "Subscription Required";
                    return deal;
                }
                
                if (!verificationResult) {
                    console.log(`Filtering out paid console game: ${deal.title}`);
                    return null;
                }
            }
            return deal;
        }));

        const finalDeals = verifiedDeals.filter(Boolean);
        console.log(`Returning ${finalDeals.length} verified console deals.`);
        return finalDeals;
    } catch (e) {
        console.error("Console Scraper Error:", e.message);
        return [];
    }
}

async function getAllDeals() {
    const results = await Promise.allSettled([
        fetchEpicFreeGames(),
        fetchSteamFreeDeals(),
        fetchGOGDeals(),
        fetchConsoleDeals(),
        fetchRedditDeals("FreeGameFindings", "Other (FGF)"),
        fetchRedditDeals("googleplaydeals", "Google Play"),
        fetchRedditDeals("AppHookup", "Apple Store")
    ]);
    
    return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
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

module.exports = { getAllDeals, searchGamePrices, fetchSteamFreeDeals, fetchEpicFreeGames, fetchGOGDeals, fetchConsoleDeals, fetchRedditDeals };
