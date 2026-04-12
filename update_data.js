const fs = require('fs');
const path = require('path');
const { getAllDeals } = require('./lib/scrapers');

async function updateData() {
    console.log("🚀 Starting scheduled deal scan...");
    try {
        const deals = await getAllDeals();
        
        if (!deals || deals.length === 0) {
            console.warn("⚠️ No deals were found. This might be an error or just a quiet day.");
            // We should still write the file to update the timestamp
        }

        const dataPath = path.join(__dirname, 'data');
        
        if (!fs.existsSync(dataPath)) {
            fs.mkdirSync(dataPath, { recursive: true });
        }

        if (fs.existsSync(path.join(dataPath, 'deals.json'))) {
            try {
                fs.unlinkSync(path.join(dataPath, 'deals.json'));
            } catch (e) {
                console.warn("⚠️ Could not delete existing deals.json, attempting to overwrite...");
            }
        }

        fs.writeFileSync(
            path.join(dataPath, 'deals.json'), 
            JSON.stringify({
                lastUpdated: new Date().toISOString(),
                deals: deals || [] // Ensure deals is at least an empty array
            }, null, 2)
        );
        
        if (deals && deals.length > 0) {
            console.log(`✅ Successfully saved ${deals.length} deals to deals.json`);
        } else {
            console.log("📝 Wrote empty deals array to deals.json with updated timestamp.");
        }

    } catch (error) {
        console.error("❌ Failed to update deals due to a critical error:", error);
        // Log the full error object for more details
        if (error.stack) {
            console.error("Stack Trace:", error.stack);
        }
        process.exit(1);
    }
}

updateData();
