# 🎮 Deal Hunter - The Ultimate Game Deal Tracker

Deal Hunter is a powerful, real-time automated service that scans multiple digital storefronts for **free games** and the **best price deals**. Never miss a giveaway again from Epic Games, Steam, GOG, or your favorite console platforms.

![Platform Support](https://img.shields.io/badge/Platforms-Epic%20|%20Steam%20|%20GOG%20|%20PlayStation%20|%20Xbox-blue)
![PWA Ready](https://img.shields.io/badge/PWA-Ready-yellow)
![Node.js](https://img.shields.io/badge/Backend-Node.js-green)

---

## 🚀 Key Features

- **🔥 Real-Time Scanning**: Automated triple-layer scanning for Steam, Epic, and GOG.
- **📱 PWA Enabled**: Optimized for mobile and can be installed as a standalone web app on your phone.
- **⭐ Smart Watchlist**: Save deals to your personal watchlist (persists in browser).
- **🔎 Autocomplete Search**: Intelligent search suggestions powered by the CheapShark database.
- **🕒 Precise Timers**: Live countdowns and expiry dates for limited-time offers.
- **🎯 Console Support**: Tracks PlayStation and Xbox deals with a smart "Subscription Required" detection system.
- **🔗 Quick Share**: One-click "Copy Link" feature for all game deals.

---

## 🛠️ Tech Stack

- **Frontend**: HTML5, Tailwind CSS, FontAwesome, Day.js.
- **Backend**: Node.js, Express.js.
- **Scraping Engine**: Axios, Cheerio (Custom scrapers for Steam, GOG, and Reddit).
- **APIs**: CheapShark API for global price comparison.

---

## 📦 Installation & Setup

1. **Clone the repository**:
   ```bash
   git clone https://github.com/milak-web/FreeDealScanner.git
   cd FreeDealScanner
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Run the server**:
   ```bash
   node server.js
   ```

4. **Access the app**:
   Open [http://localhost:5001](http://localhost:5001) in your browser.

---

## 📱 Mobile Installation

This app is a **Progressive Web App (PWA)**. To install it on your mobile device:
1. Open the app in your mobile browser (Safari/Chrome).
2. Tap the **"Share"** (iOS) or **"Menu"** (Android) button.
3. Select **"Add to Home Screen"**.

---

## ⚖️ License
This project is open-source and available under the MIT License.

*Happy Hunting!* 🏹🎮
