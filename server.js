const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { getAllDeals, searchGamePrices } = require('./lib/scrapers');

const app = express();
const PORT = process.env.PORT || 5001;
const DEALS_FILE = path.join(__dirname, 'data', 'deals.json');
const ADS_FILE = path.join(__dirname, 'data', 'ads.json');
const AD_METRICS_FILE = path.join(__dirname, 'data', 'ad_metrics.json');
const REFRESH_INTERVAL_MS = Number(process.env.DEALS_REFRESH_MS || 30 * 60 * 1000);
const MIN_FORCE_GAP_MS = Number(process.env.MIN_FORCE_GAP_MS || 20 * 1000);

let dealsCache = {
    lastUpdated: null,
    deals: [],
    source: 'startup',
    error: null
};
let refreshInFlight = null;
let lastForceRefreshAt = 0;

function isDealActive(deal, now = new Date()) {
    if (!deal || !deal.expiryDate) return true;
    const expiry = new Date(deal.expiryDate);
    if (Number.isNaN(expiry.getTime())) return false;
    return expiry > now;
}

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function ensureDataDir() {
    const dir = path.dirname(DEALS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function readJsonFile(filePath, fallbackValue) {
    try {
        if (!fs.existsSync(filePath)) return fallbackValue;
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        console.error(`Failed to parse JSON file ${filePath}:`, error.message);
        return fallbackValue;
    }
}

function writeJsonFile(filePath, payload) {
    try {
        ensureDataDir();
        fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    } catch (error) {
        console.error(`Failed to write JSON file ${filePath}:`, error.message);
    }
}

function loadDealsFromDisk() {
    try {
        if (!fs.existsSync(DEALS_FILE)) return null;
        const parsed = JSON.parse(fs.readFileSync(DEALS_FILE, 'utf8'));
        const deals = Array.isArray(parsed?.deals) ? parsed.deals : [];
        return {
            lastUpdated: parsed?.lastUpdated || null,
            deals,
            source: 'disk',
            error: null
        };
    } catch (error) {
        console.error('Failed to load deals from disk:', error.message);
        return null;
    }
}

function saveDealsToDisk(snapshot) {
    writeJsonFile(DEALS_FILE, {
        lastUpdated: snapshot.lastUpdated,
        deals: snapshot.deals
    });
}

function isAdActive(ad, now = new Date()) {
    if (!ad || typeof ad !== 'object') return false;
    if ((ad.status || 'active').toLowerCase() !== 'active') return false;
    if (!ad.slot || !ad.id || !ad.link || !ad.title) return false;

    const startsAt = ad.startsAt ? new Date(ad.startsAt) : null;
    const endsAt = ad.endsAt ? new Date(ad.endsAt) : null;
    if (startsAt && Number.isNaN(startsAt.getTime())) return false;
    if (endsAt && Number.isNaN(endsAt.getTime())) return false;
    if (startsAt && startsAt > now) return false;
    if (endsAt && endsAt <= now) return false;

    return true;
}

function getMonetizationConfig() {
    const parsed = readJsonFile(ADS_FILE, {});
    const ads = Array.isArray(parsed?.ads) ? parsed.ads : [];
    const activeAds = ads.filter(ad => isAdActive(ad));
    const topBanner = activeAds.find(ad => ad.slot === 'topBanner') || null;

    return {
        enabled: parsed?.enabled !== false,
        disclosure: typeof parsed?.disclosure === 'string'
            ? parsed.disclosure
            : 'Sponsored links help keep this tracker free.',
        slots: {
            topBanner
        },
        ads: activeAds
    };
}

function loadAdMetrics() {
    const metrics = readJsonFile(AD_METRICS_FILE, null);
    if (metrics && typeof metrics === 'object' && metrics.ads && typeof metrics.ads === 'object') {
        return metrics;
    }

    return {
        updatedAt: null,
        ads: {}
    };
}

function trackAdEvent(adId, eventType) {
    const metrics = loadAdMetrics();
    const nowIso = new Date().toISOString();
    const record = metrics.ads[adId] || {
        clicks: 0,
        impressions: 0,
        lastClickAt: null,
        lastImpressionAt: null
    };

    if (eventType === 'click') {
        record.clicks += 1;
        record.lastClickAt = nowIso;
    }

    if (eventType === 'impression') {
        record.impressions += 1;
        record.lastImpressionAt = nowIso;
    }

    metrics.ads[adId] = record;
    metrics.updatedAt = nowIso;
    writeJsonFile(AD_METRICS_FILE, metrics);
}

function sanitizeHttpUrl(rawUrl) {
    try {
        const parsed = new URL(rawUrl);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.toString();
        return null;
    } catch (_) {
        return null;
    }
}

function ageMs(lastUpdated) {
    if (!lastUpdated) return Number.POSITIVE_INFINITY;
    const t = new Date(lastUpdated).getTime();
    if (Number.isNaN(t)) return Number.POSITIVE_INFINITY;
    return Date.now() - t;
}

async function refreshDeals({ force = false } = {}) {
    if (refreshInFlight) return refreshInFlight;
    if (force && Date.now() - lastForceRefreshAt < MIN_FORCE_GAP_MS) return dealsCache;

    refreshInFlight = (async () => {
        try {
            const freshDeals = await getAllDeals();
            const normalized = Array.isArray(freshDeals) ? freshDeals : [];

            // If a scrape fails silently and returns nothing, keep known good data.
            if (normalized.length === 0 && dealsCache.deals.length > 0) {
                const activeCachedDeals = dealsCache.deals.filter(d => isDealActive(d));
                dealsCache = {
                    ...dealsCache,
                    deals: activeCachedDeals,
                    source: 'cache-preserved-empty-scan',
                    error: null
                };
                return dealsCache;
            }

            dealsCache = {
                lastUpdated: new Date().toISOString(),
                deals: normalized,
                source: 'live-scan',
                error: null
            };
            saveDealsToDisk(dealsCache);
            if (force) lastForceRefreshAt = Date.now();
            return dealsCache;
        } catch (error) {
            const diskFallback = loadDealsFromDisk();
            if (diskFallback && diskFallback.deals.length > 0) {
                dealsCache = {
                    ...diskFallback,
                    source: 'disk-fallback',
                    error: error.message
                };
                return dealsCache;
            }

            dealsCache = {
                ...dealsCache,
                source: 'scan-error',
                error: error.message
            };
            throw error;
        } finally {
            refreshInFlight = null;
        }
    })();

    return refreshInFlight;
}

async function maybeBackgroundRefresh() {
    if (ageMs(dealsCache.lastUpdated) < REFRESH_INTERVAL_MS) return dealsCache;
    return refreshDeals({ force: true });
}

// API Endpoints

app.get('/api/deals', async (req, res) => {
    try {
        const force = req.query.force === '1' || req.query.force === 'true';
        const snapshot = force ? await refreshDeals({ force: true }) : await maybeBackgroundRefresh();
        res.json({
            lastUpdated: snapshot.lastUpdated,
            deals: snapshot.deals,
            source: snapshot.source,
            error: snapshot.error
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/search', async (req, res) => {
    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query required" });
    try {
        const results = await searchGamePrices(query);
        res.json(results);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/suggestions', async (req, res) => {
    const query = req.query.q;
    if (!query || query.length < 2) return res.json([]);
    try {
        console.log(`Fetching suggestions for: ${query}`);
        const { data } = await axios.get(`https://www.cheapshark.com/api/1.0/games?title=${encodeURIComponent(query)}&limit=5`);
        res.json(data.map(g => g.external));
    } catch (error) {
        console.error("Suggestions API Error:", error.message);
        res.status(500).json({ error: error.message });
    }
});

app.get('/api/status', (req, res) => {
    res.json({
        lastUpdated: dealsCache.lastUpdated,
        dealsCount: Array.isArray(dealsCache.deals) ? dealsCache.deals.length : 0,
        source: dealsCache.source,
        error: dealsCache.error,
        refreshIntervalMs: REFRESH_INTERVAL_MS
    });
});

app.get('/api/ads', (req, res) => {
    const config = getMonetizationConfig();
    res.json({
        enabled: config.enabled,
        disclosure: config.disclosure,
        slots: config.slots
    });
});

app.post('/api/ads/impression', (req, res) => {
    const adId = typeof req.body?.adId === 'string' ? req.body.adId.trim() : '';
    if (!adId) return res.status(400).json({ error: 'adId is required' });

    const config = getMonetizationConfig();
    const ad = config.ads.find(item => item.id === adId);
    if (!ad) return res.status(404).json({ error: 'Ad not found or inactive' });

    trackAdEvent(adId, 'impression');
    res.json({ ok: true });
});

app.get('/api/ads/click/:adId', (req, res) => {
    const adId = String(req.params.adId || '').trim();
    if (!adId) return res.status(400).send('Missing ad id');

    const config = getMonetizationConfig();
    const ad = config.ads.find(item => item.id === adId);
    if (!ad) return res.status(404).send('Ad not found');

    const safeTarget = sanitizeHttpUrl(ad.link);
    if (!safeTarget) return res.status(400).send('Invalid ad target');

    trackAdEvent(adId, 'click');
    res.redirect(302, safeTarget);
});

// For any other GET request, send back index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const diskBoot = loadDealsFromDisk();
if (diskBoot) dealsCache = diskBoot;

refreshDeals({ force: true }).catch((error) => {
    console.error('Initial refresh failed:', error.message);
});
setInterval(() => {
    refreshDeals({ force: true }).catch((error) => {
        console.error('Scheduled refresh failed:', error.message);
    });
}, REFRESH_INTERVAL_MS);

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
