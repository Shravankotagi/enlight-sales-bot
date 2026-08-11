# 🤖 Enlight Metals WhatsApp AI Bot — Operations Manual

Welcome! This is the **WhatsApp AI Sales Bot** for Enlight Metals.

> 📖 **Complete System Architecture & Setup Guide**:  
> For full step-by-step local setup instructions across all modules, environment keys, and database connections, see **[Root Master Setup Guide (README.md)](../README.md)**.

---

## 🎯 What the Bot Handles

1. 💬 **Natural Language NLU**: Understands informal messages in **English, Hindi, and Hinglish** (e.g. *"delta is asking for 50 tons"*).
2. ⚖️ **Indian Metal Tonnage Standards**: Normalizes `ton`, `tons`, `tonne`, and `MT` into **`MT`** (`1 ton = 1 MT`).
3. 🧮 **Active Rate Sheet Lookups**: Matches products (*HR Coil*, *CR Sheet*, *MS Plate*) against live rate sheets and calculates total deal value.
4. ❓ **Smart Missing Product Prompts**: Asks for product names when only quantity is given.
5. 🔄 **Zoho Bigin CRM Sync**: Pushes deals & line items to Bigin CRM.

---

## 🚀 Quick Start (Local Launch)

```bash
cd bot
npm install
npm start
```

- Server runs on `http://localhost:3000`.
- For complete `.env` configuration details, see **[Root Master Setup Guide (README.md)](../README.md)**.

---

## 🌐 Quick Action Links

- 📤 **Push Database Records $\rightarrow$ Zoho Bigin**: `http://localhost:3000/bigin-sync`
- 📥 **Pull Zoho Bigin $\rightarrow$ Database**: `http://localhost:3000/bigin-import`

---

*Powered by Google Gemini AI & Enlight Sales OS.*
