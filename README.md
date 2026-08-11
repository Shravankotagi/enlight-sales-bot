# 🤖 Enlight Metals WhatsApp AI Bot — Comprehensive Setup & Operations Manual

This is the official documentation for the **WhatsApp AI Sales Bot** of Enlight Metals. Powered by **Google Gemini 1.5 Flash Lite**, **LangGraph**, and **Supabase**, this bot automates WhatsApp message processing, metal product rate sheet lookups, deal logging, and Zoho Bigin CRM sync.

---

## 🎯 What the Bot Handles (Business Capabilities)

1. 💬 **Natural Language Understanding**: Understands informal messages in **English, Hindi, and Hinglish** sent by salespersons (e.g. *"delta is asking for 50 tons"* or *"received 5 lakh from mehta"*).
2. ⚖️ **Indian Metal Tonnage Standards**: Automatically converts `ton`, `tons`, `tonne`, `tonnes`, and `MT` into **`MT`** (`1 ton = 1 MT`).
3. 🧮 **Active Rate Sheet Lookups & Price Calculation**:
   - Matches products against active rate sheets stored in Supabase (e.g. *HR Coil 8mm ₹52,000/MT*, *MS Plates ₹53,000/MT*).
   - Calculates exact quotation deal values (`50 MT * ₹52,000 = ₹26,00,000`).
4. ❓ **Smart Missing Details Prompts**: If a quantity (e.g. `50 tons`) is sent without specifying a metal product, the bot prompts:
   > *"❓ Which metal product is Delta Structural Steel asking for? (e.g. HR Coil, CR Sheet, TMT Bar, MS Plates)"*
5. 🔄 **Bi-directional Zoho Bigin CRM Sync**:
   - Pushes deals and line items to Zoho Bigin.
   - Saves layout IDs, deal names, and persistent `bigin_deal_id` references.

---

## 🛠️ Step-by-Step Local Setup Instructions

### Step 1: Open Terminal in the `bot` Folder
```bash
cd bot
```

### Step 2: Install Node.js Dependencies
```bash
npm install
```

### Step 3: Configure Environment Variables (`.env`)
Create a `.env` file inside the `bot/` folder with the following contents:

```env
# Server Port
PORT=3000

# Supabase Database Connection
SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-secret-key

# AI Model Configuration (Google Gemini Key)
GEMINI_API_KEY=your_google_gemini_api_key

# Meta WhatsApp Cloud API Integration
WHATSAPP_TOKEN=your_whatsapp_meta_access_token
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_VERIFY_TOKEN=enlight_whatsapp_verify_token_2026

# Zoho Bigin CRM Integration Keys
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REFRESH_TOKEN=your_zoho_refresh_token
```

### Step 4: Start the Server

- **Development Mode (Auto-restarts when files change)**:
  ```bash
  npm run dev
  ```
- **Production Mode**:
  ```bash
  npm start
  ```

✅ **Verification**: Look for this line in the console:
`Bot server running on port 3000`

---

## 🌐 Exposing Webhooks for WhatsApp & Zoho Bigin Locally

Meta WhatsApp Cloud API needs a public HTTPS URL to send live incoming WhatsApp messages to your local laptop. You can use **ngrok** (free tool):

1. Install **ngrok** from [https://ngrok.com/](https://ngrok.com/).
2. Run ngrok pointing to port 3000:
   ```bash
   ngrok http 3000
   ```
3. Copy the HTTPS forwarding URL (e.g. `https://abc1234.ngrok-free.app`).
4. Set your Meta WhatsApp Webhook URL to:
   `https://abc1234.ngrok-free.app/webhook`
5. Enter verify token: `enlight_whatsapp_verify_token_2026`.

---

## 🌐 HTTP Endpoints List

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/webhook` | `GET` / `POST` | Meta WhatsApp Cloud API webhook receiver. |
| `/bigin-sync` | `GET` / `POST` | Pushes all database records & live deals up to Zoho Bigin CRM. |
| `/bigin-import` | `GET` / `POST` | Pulls contacts & active deals from Zoho Bigin CRM into local database. |
| `/bigin-cleanup` | `GET` / `POST` | Clears old CRM test records and re-syncs database cleanly. |

---

## ❓ Frequently Asked Questions & Solutions

- **Q: Why does the bot reply asking for the product name?**
  - **A:** If a message contains a quantity (e.g. `50 tons`) but no specific metal product name (like *HR Coil* or *MS Plate*), the bot politely prompts for the exact product to prevent dummy data entry.

- **Q: How do I refresh Zoho Bigin tokens?**
  - **A:** The bot auto-refreshes tokens using `ZOHO_REFRESH_TOKEN`. If token expires, visit `/bigin-sync` or click **Push DB → Bigin** in the Web Dashboard.

---

*Enlight Metals OS — Intelligent WhatsApp AI Agent.*
