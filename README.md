# SproutRipple PH — Philippine HR & Payroll Platform

A full-featured Philippine HR and payroll system built as a single-page application.

## Features
- Employee 201 Management
- Payroll Groups with criteria-based assignment
- Attendance filing with administrator approval and payroll gating
- Admin-controlled attendance form catalog with visibility toggles under Company Settings
- Time In/Out correction filing and actual-log-capped OT/rest-day hour validation
- WFH approval requiring completed actual logs and OB approval creating Present attendance from declared OB times
- Shift setup under Company Settings with employee-profile assignment
- Tabbed Company Settings for General, Shift Setup, and Attendance Forms
- Batch Time In/Out corrections and temporary schedule-adjustment approvals
- Payroll preparation, approval, locking, and audit trail
- Payroll Computation (2025 SSS, 2025 PhilHealth, 2024+ Pag-IBIG, BIR Annex E 2023 onwards)
- Pay Calendar & Cut-off Management
- Downloadable SSS R3, PhilHealth RF-1, Pag-IBIG MCRF, BIR 1601-C, BIR 2316, and bank worksheets
- Resolution Center for attendance, leave, payroll, payslip, and employee-service cases
- Approval-aware payslip release with employee questions and downloadable statements
- Compliance health scoring and connected workforce analytics
- Recruitment requisitions, performance goals, check-ins, and calibration
- Workforce AI Copilot for payroll readiness, compliance risk, talent, and workforce summaries
- Leave & Attendance Management
- Loans Module
- Bulk Upload (Employees, Adjustments, Income/Deduction Types)

> Compliance note: generated CSV files are working papers for review and portal/form
> preparation. They are not substitutes for official agency forms, electronic filing
> validation, or professional tax/legal review. Company-specific policies and employee
> classifications must be configured and validated before production use.

---

## Deploy to Vercel (recommended — free)

### Option A: Vercel CLI
```bash
npm i -g vercel
vercel --prod
```

### Option B: Vercel Dashboard
1. Push this repo to GitHub
2. Go to [vercel.com](https://vercel.com) → **New Project**
3. Import your GitHub repo
4. Framework: **Other**
5. Click **Deploy** — done ✓

---

## Deploy to Railway

### Option A: Railway CLI
```bash
npm i -g @railway/cli
railway login
railway init
railway up
```

### Option B: Railway Dashboard
1. Go to [railway.app](https://railway.app) → **New Project**
2. **Deploy from GitHub repo** → select your repo
3. Railway auto-detects Node.js, sets `node server.js` as start command
4. Click **Deploy** — your URL appears in the dashboard ✓

---

## Environment Variables

Set these on your Railway service (Variables tab). Nothing here is required to run the app locally with demo data — it only matters once real client data is involved.

| Variable | Required for | Notes |
|---|---|---|
| `DATABASE_URL` | Real persistence | Without it the app still runs, but nothing is saved between requests. |
| `API_SESSION_SECRET` | **Every real deployment** | Signs login sessions. The code falls back to a public placeholder value if this isn't set — **set it before any real client uses this deployment**, e.g. `openssl rand -hex 32`. |
| `GOD_ADMIN_PASSWORD` | Platform (God Admin) login | Falls back to a public default (see Demo Accounts below) until changed here or from Settings. Settings takes priority once set. |
| `BOOTSTRAP_ADMIN_EMAIL` / `BOOTSTRAP_ADMIN_PASSWORD` | The very first tenant's admin login | Falls back to the public demo credentials below until overridden. |
| `APP_ALLOWED_ORIGINS` | CORS | Comma-separated list of frontend origins allowed to call the API. |
| `GROQ_API_KEY` | Optional AI-powered chat assistant | Free tier available at [console.groq.com](https://console.groq.com). Feature stays off (falls back to the free built-in assistant) without it. |
| `RESEND_API_KEY` | Web Bundy guest access (email OTP) | Free tier available at [resend.com](https://resend.com). Without it, the "Open Web Bundy" guest button on the login screen is unusable (fails cleanly with a clear error) rather than falling back to anything less secure. |
| `BUNDY_OTP_FROM_EMAIL` | Optional | Sender address for Web Bundy OTP emails. Defaults to Resend's sandbox address, which is fine for testing but needs a verified custom domain in Resend for reliable real-world delivery. |

---

## Run locally
```bash
npm install
npm start
# Open http://localhost:3000
```

---

## Project Structure
```
sproutripple-ph/
├── public/
│   └── index.html      ← The entire app (self-contained)
├── server.js           ← Express server (Railway / local)
├── package.json
├── railway.toml        ← Railway config
├── vercel.json         ← Vercel config
└── .gitignore
```

---

## Push to GitHub
```bash
git init
git add .
git commit -m "Initial commit — SproutRipple PH"
git remote add origin https://github.com/YOUR_USERNAME/sproutripple-ph.git
git push -u origin main
```

## Demo Accounts
These work out of the box for local development and demos only. **Before any real client's data touches a deployment, override `API_SESSION_SECRET`, `GOD_ADMIN_PASSWORD`, and `BOOTSTRAP_ADMIN_EMAIL`/`BOOTSTRAP_ADMIN_PASSWORD`** (see Environment Variables above) — these exact passwords are public in this file.

| Role | Email | Password |
|------|-------|----------|
| Admin | admin@ph.com | admin123 |
| Employee | juan@ph.com | emp123 |
| God Mode | god@sproutripple.com | godmode2026 |
