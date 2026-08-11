# 🚀 Enlight Sales OS — Complete Local Setup & Architecture Guide

Welcome to **Enlight Sales OS**! This comprehensive guide provides step-by-step instructions for setting up, running, and managing the entire platform on your local computer or server.

It is designed to be easily understood by **everyone** — whether you are a business manager, sales lead, or developer.

---

## 📌 System Architecture & Core Modules

The Enlight Sales OS consists of 3 synchronized modules working together:

| Module | Location | Purpose | Local Port |
| :--- | :--- | :--- | :--- |
| **Central Backend** | `/backend` | Manages database records, user authentication, KRA calculations, and Zoho Bigin CRM sync. | `http://localhost:3001` |
| **Web Dashboard** | `/frontend` | Executive web portal for sales tracking, order generation, metal price sheets, and reports. | `http://localhost:5173` |
| **WhatsApp AI Bot** | `/bot` | Automated AI assistant powered by Google Gemini 1.5 Flash Lite that processes sales messages from WhatsApp. | `http://localhost:3000` |

---

## 🛠️ Step 1: Install Required Software (One-Time Setup)

Before running the project, install the following free software on your computer:

### 1. Install Node.js (JavaScript Runtime)
- Download **Node.js v18 LTS or v20 LTS** from [https://nodejs.org/](https://nodejs.org/).
- Open the installer and click **Next** on all prompts to complete the installation.
- Verify installation by opening Command Prompt (CMD) and typing:
  ```bash
  node -v
  npm -v
  ```
  *(You should see version numbers like `v20.x.x` and `10.x.x`)*

### 2. Install Git (Version Control)
- Download **Git** from [https://git-scm.com/downloads](https://git-scm.com/downloads).
- Follow standard setup options and install.

---

## 🔑 Step 2: Environment Variables (`.env`) Setup

Each folder (`/backend`, `/frontend`, `/bot`) requires a configuration file named `.env` containing your database keys and API secrets.

### A. Central Backend (`backend/.env`)
Create a file named `.env` inside the `backend` folder and paste the following:

```env
# Server Port
PORT=3001
NODE_ENV=development

# Database Connection (Supabase)
SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_KEY=your-supabase-service-role-secret-key

# Security & Authentication
JWT_SECRET=enlight_super_secret_jwt_key_2026

# Zoho Bigin CRM API Configuration
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REFRESH_TOKEN=your_zoho_refresh_token
```

### B. Web Dashboard (`frontend/.env`)
Create a file named `.env` inside the `frontend` folder and paste:

```env
# URL of your running backend server
VITE_BACKEND_URL=http://localhost:3001
```

### C. WhatsApp AI Bot (`bot/.env`)
Create a file named `.env` inside the `bot` folder and paste:

```env
# Server Port
PORT=3000

# Supabase Database Connection
SUPABASE_URL=https://your-supabase-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-supabase-service-role-secret-key

# Google Gemini AI Key
GEMINI_API_KEY=your_google_gemini_api_key

# Meta WhatsApp Cloud API Credentials
WHATSAPP_TOKEN=your_whatsapp_meta_access_token
WHATSAPP_PHONE_NUMBER_ID=your_whatsapp_phone_number_id
WHATSAPP_VERIFY_TOKEN=enlight_whatsapp_verify_token_2026

# Zoho Bigin Integration Credentials
ZOHO_CLIENT_ID=your_zoho_client_id
ZOHO_CLIENT_SECRET=your_zoho_client_secret
ZOHO_REFRESH_TOKEN=your_zoho_refresh_token
```

---

## 🚀 Step 3: Running the Full Platform Locally

To run the full system, open **3 separate terminal / command prompt windows**:

### 🟢 Terminal 1: Start Central Backend
```bash
cd backend
npm install
npm run start:dev
```
✅ **Success Indicator:** Terminal shows `[NestApplication] Nest application successfully started` on `http://localhost:3001`.

---

### 🟢 Terminal 2: Start Web Dashboard
```bash
cd frontend
npm install
npm run dev
```
✅ **Success Indicator:** Terminal shows `Local: http://localhost:5173/`. Open Chrome and visit `http://localhost:5173`.

---

### 🟢 Terminal 3: Start WhatsApp AI Bot
```bash
cd bot
npm install
npm start
```
✅ **Success Indicator:** Terminal shows `Bot server running on port 3000`.

---

## 🎮 How to Test & Verify Local Operations

1. **Accessing the Web Dashboard**:
   - Open Chrome and visit `http://localhost:5173`.
   - Log in with Admin credentials.

2. **Testing Zoho Bigin CRM Sync**:
   - Go to the **Admin Overview** page (`/admin`).
   - Click **`Push DB → Bigin`** to push local deals to Zoho Bigin.
   - Click **`Pull Bigin → DB`** to import contacts and active deals from Bigin to your local database.

3. **Testing Rate Sheets & Quotation Calculations**:
   - Go to **Pricing** (`/pricing`) to update per MT rates for metal products (e.g. *HR Coil ₹52,000/MT*).
   - Go to **Orders** (`/orders`) to view confirmed orders and print official Metal Sales Quotations & Invoices.

---

## ❓ Troubleshooting Common Setup Errors

| Error Message | Cause | Simple Solution |
| :--- | :--- | :--- |
| `EADDRINUSE: address already in use :::3000` | Port 3000 is occupied by another program | Close existing node windows or restart your computer. |
| `invalid oauth token` | Zoho Bigin access token expired | Click **Push DB → Bigin** in the Web Dashboard to auto-refresh tokens. |
| `Cannot find module ...` | Packages not installed yet | Run `npm install` inside the affected folder (`backend`, `frontend`, or `bot`). |
| `Failed to fetch / Network Error` | Backend server is not running | Ensure Terminal 1 (`backend`) is running on `http://localhost:3001`. |

---

*For technical support or feature requests, contact Enlight Metals OS Admin.*
