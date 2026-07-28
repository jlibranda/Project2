# SproutRipple PH — Philippine HR & Payroll Platform

A full-featured Philippine HR and payroll system built as a single-page application.

## Features
- Employee 201 Management
- Payroll Groups with criteria-based assignment
- Attendance filing with administrator approval and payroll gating
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
