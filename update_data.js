const fs = require('fs');
const path = require('path');
const { getAllDeals } = require('./lib/scrapers');

function isDealActive(deal, now = new Date()) {
    if (!deal || !deal.expiryDate) return true;
    const expiry = new Date(deal.expiryDate);
    if (Number.isNaN(expiry.getTime())) return false;
    return expiry > now;
}

async function updateData() {
    console.log('[scan] Starting scheduled deal scan...');
    try {
        const deals = await getAllDeals();
        const normalizedDeals = Array.isArray(deals) ? deals : [];

        const dataPath = path.join(__dirname, 'data');
        const outputPath = path.join(dataPath, 'deals.json');
        let previousDeals = [];

        if (fs.existsSync(outputPath)) {
            try {
                const existing = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
                previousDeals = Array.isArray(existing?.deals) ? existing.deals : [];
            } catch (_) {
                previousDeals = [];
            }
        }

        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }

        const activePreviousDeals = previousDeals.filter(d => isDealActive(d));
        const finalDeals = normalizedDeals.length > 0 ? normalizedDeals : activePreviousDeals;

        fs.writeFileSync(
            outputPath,
            JSON.stringify(
                {
                    lastUpdated: new Date().toISOString(),
                    deals: finalDeals
                },
                null,
                2
            )
        );

        if (normalizedDeals.length > 0) {
            console.log(`[scan] Saved ${normalizedDeals.length} fresh deals to deals.json`);
        } else if (activePreviousDeals.length > 0) {
            console.log(`[scan] Preserved previous active snapshot with ${activePreviousDeals.length} deals`);
        } else {
            console.log('[scan] No deals available. Wrote empty snapshot.');
        }
    } catch (error) {
        console.error('[scan] Failed to update deals due to a critical error:', error);
        if (error.stack) {
            console.error('Stack Trace:', error.stack);
        }
        process.exit(1);
    }
}

updateData();
