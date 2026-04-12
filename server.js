const express = require('express');
const cors = require('cors');
const path = require('path');
const axios = require('axios');
const { getAllDeals, searchGamePrices } = require('./lib/scrapers');

const app = express();
const PORT = process.env.PORT || 5001;

app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

// API Endpoints

app.get('/api/deals', async (req, res) => {
    try {
        const deals = await getAllDeals();
        res.json(deals);
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

// For any other GET request, send back index.html
app.get(/^(?!\/api\/).*/, (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
