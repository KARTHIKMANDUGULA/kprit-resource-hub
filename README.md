# 🎓 KPRIT Resource Hub

**Live Portal:** [kprit-resource-hub.vercel.app](https://kprit-resource-hub.vercel.app)

A fast, role-governed academic study vault built for **Kommuri Pratap Reddy Institute of Technology (KPRIT)** students to browse structured mid-term Q&A banks, unit-wise lecture notes, and lab manuals—engineered with zero-cost cloud scalability and offline browser caching.

---

## ✨ Key Features

- **Structured Academic Hierarchy:** Filter materials effortlessly by **Academic Year → Branch (`CSE`, `CSM`, `ECE`, `EEE`, `Mechanical`, `Civil`) → Semester → Subject** with instant quick-filter pills.
- **Offline-First PDF Reader (`reader.js`):**
  - Streams private Supabase Storage PDFs via short-lived 60-second signed URLs and supports allowlisted HTTPS CDNs.
  - **150 MB IndexedDB LRU Cache (`kprit_pdf_cache`):** Automatically caches opened PDFs locally with `QuotaExceededError` eviction recovery so repeat opens load instantaneously and consume zero cloud egress.
  - **Mobile-Optimized Rendering:** Native pinch-to-zoom support paired with dual `IntersectionObserver` lazy loading and RAM virtualization (evicting off-screen canvases to prevent mobile GPU memory crashes).
- **In-Browser PDF Compression (`app.js`):**
  - Validates PDF integrity and rejects corrupted or password-protected files before upload.
  - Automatically compresses scanned PDFs (capped at 30 pages and 1600px max edge for mobile stability) using PDF.js + `pdf-lib`, keeping the compressed output only when it reduces file size.
- **Role-Based Access Control (RBAC) & Moderation Queue:**
  - Three permission tiers (`Super Admin`, `Faculty`, and `CR`) scoped by assigned branch and subject.
  - CR and Faculty uploads enter a **Pending Approvals** queue displaying original vs. compressed size telemetry and an in-browser **Preview PDF** modal prior to 1-click approval or rejection.
- **Live Analytics & Formula-Safe CSV Export:**
  - Real-time KPIs (Registered Students, Active Today, Total Document Reads, Top Subject), Subject Popularity bar chart, 7-day student activity chart, searchable student log table, and CSV export sanitized against formula injection.

---

## 🛠️ Tech Stack

- **Frontend:** Vanilla JavaScript (ES6 Modules), HTML5, Tailwind CSS, Lucide Icons
- **PDF & Client-Side Processing:** Mozilla PDF.js (`3.11.174`), `pdf-lib` (`1.17.1`), IndexedDB
- **Backend, Auth & Storage:** Supabase (Google OAuth, PostgreSQL with Row-Level Security, Private Storage Buckets)
- **Hosting & CI/CD:** Vercel

---

## 📂 Project Structure

```text
kprit-resource-hub/
├── index.html       # App shell, student portal, admin dashboard, and reader/edit modals
├── styles.css       # Custom transitions, scrollbar utilities, and responsive PDF viewport rules
├── app.js           # Google OAuth, RBAC, filters, scan compression, moderation, and analytics
├── reader.js        # PDF.js renderer, RAM virtualization, and IndexedDB LRU offline cache
└── migration.sql    # Idempotent PostgreSQL schema, triggers, RPCs, and hardened RLS policies


👨‍💻 Author
Karthik Mandugula — B.Tech CSE, Kommuri Pratap Reddy Institute of Technology (KPRIT)

GitHub: @KARTHIKMANDUGULA

LinkedIn: Karthik Mandugula