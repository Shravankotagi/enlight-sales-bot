# 🤖 Enlight Metals WhatsApp AI Bot — Easy Setup Guide

Welcome! This is the **WhatsApp AI Agent** for Enlight Metals. It listens to salesperson messages on WhatsApp, extracts deals, customer names, quantities, calculates rates from active rate sheets, and syncs everything with Zoho Bigin CRM.

---

## 🎯 What This Bot Does (In Simple Words)

1. 📩 **Listens to WhatsApp Messages**: Receives text, voice notes, photos, or documents sent by salespersons on WhatsApp.
2. 🧮 **Calculates Tonnage & Rates**:
   - Converts Indian tonnage terms (`ton`, `tons`, `tonne`, `MT`) to `MT`.
   - Checks active rate sheets (e.g. *HR Coil ₹52,000/MT*) and calculates exact quotation values.
3. ❓ **Asks Smart Follow-ups**: If a salesperson specifies quantity (e.g. `50 tons`) without naming a product, the bot asks:
   > *"Which metal product is Delta Structural Steel asking for? (e.g. HR Coil, CR Sheet, TMT Bar, MS Plates)"*
4. 🔄 **Zoho Bigin Sync**: Automatically updates your database and syncs live deals directly into Zoho Bigin CRM.

---

## 🚀 How to Run the Bot (Step-by-Step)

### Step 1: Open Terminal in the `bot` folder

```bash
cd bot
```

### Step 2: Install Dependencies (First Time Only)

```bash
npm install
```

### Step 3: Start the Bot Server

- **For Live Mode / Production**:
  ```bash
  npm start
  ```
- **For Development**:
  ```bash
  npm run dev
  ```

✅ **What Success Looks Like:**
You will see a green console log:
`Bot server running on port 3000`

---

## 🔑 Environment Settings (`.env` File)

The bot requires a `.env` file in the `bot/` directory.

Essential settings inside `.env`:
- `PORT=3000`
- `SUPABASE_URL` = Your Supabase database URL
- `SUPABASE_SERVICE_ROLE_KEY` = Your Supabase secret key
- `GEMINI_API_KEY` = Google Gemini AI key for understanding messages
- `WHATSAPP_TOKEN` = WhatsApp Meta Cloud API Access Token
- `ZOHO_CLIENT_ID` / `ZOHO_CLIENT_SECRET` / `ZOHO_REFRESH_TOKEN` = Zoho Bigin CRM integration keys

*(If `.env` is missing, copy `.env.example` to `.env` and fill in the values.)*

---

## 🔗 Manual Zoho Bigin Sync Links (For Admins)

If you ever need to manually trigger a sync via your browser:

- 📤 **Push Database Records $\rightarrow$ Zoho Bigin**:
  `http://localhost:3000/bigin-sync`
- 📥 **Pull Zoho Bigin $\rightarrow$ Database**:
  `http://localhost:3000/bigin-import`

---

## ❓ Simple Troubleshooting

- **Issue:** `Error: EADDRINUSE: address already in use :::3000`
  - **Solution:** Another program is using port 3000. Close any extra terminal windows or restart your computer.
- **Issue:** `invalid oauth token` from Zoho Bigin
  - **Solution:** Click the **`Push DB → Bigin`** button on your Web Dashboard to auto-refresh the token.

---

*Powered by Google Gemini AI & Enlight Sales OS.*
