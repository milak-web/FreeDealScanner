const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const fs = require('fs');
const { getAllDeals, searchGamePrices } = require('./lib/scrapers');

const app = express();
const PORT = process.env.PORT || 5001;
const DEALS_FILE = path.join(__dirname, 'data', 'deals.json');
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

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

function ensureDataDir() {
    const dir = path.dirname(DEALS_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
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
    try {
        ensureDataDir();
        fs.writeFileSync(DEALS_FILE, JSON.stringify({
            lastUpdated: snapshot.lastUpdated,
            deals: snapshot.deals
        }, null, 2));
    } catch (error) {
        console.error('Failed to save deals to disk:', error.message);
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
                dealsCache = {
                    ...dealsCache,
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
