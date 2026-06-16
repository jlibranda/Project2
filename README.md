# SproutRipple PH — Philippine HR & Payroll Platform

A full-featured Philippine HR and payroll system built as a single-page application.

## Features
- Employee 201 Management
- Payroll Groups with criteria-based assignment
- Payroll Computation (SSS, PhilHealth, Pag-IBIG, BIR TRAIN Law)
- Pay Calendar & Cut-off Management
- Government Remittances
- Leave & Attendance Management
- Loans Module
- Bulk Upload (Employees, Adjustments, Income/Deduction Types)

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
| Role | Email | Password |
|------|-------|----------|
| Admin | admin@ph.com | admin123 |
| Employee | juan@ph.com | emp123 |
| God Mode | god@sproutripple.com | godmode2026 |
