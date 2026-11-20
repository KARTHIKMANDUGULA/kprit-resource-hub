/**
 * ============================================================================
 * KPRIT RESOURCE HUB — MAIN APPLICATION MODULE (app.js)
 * ============================================================================
 * Owns:
 *  1. Supabase client initialization & Google OAuth (pageshow & tab-switch safe)
 *  2. Exact lowercase RBAC (Super Admin, Faculty, CR, Student)
 *  3. Paginated cloud sync (1,000-row batching + offline metadata cache fallback)
 *  4. Student Study Portal (Year -> Branch -> Semester -> Subject hierarchy)
 *  5. Super-Admin Live Analytics, 7-day activity chart & formula-safe CSV export
 *  6. Smart in-browser PDF scan compression (up to 30 pages), validation & storage rollback
 *  7. Super-Admin Moderation Queue (PDF approval/rejection with unreferenced storage cleanup)
 *  8. Super-Admin Edit Resource (plain-text editing, blocks empty text-only saves) & Delete
 *  9. Declarative non-blocking confirmation modal & delegated event handlers
 */

import {
  initReader,
  openProtectedReader,
  closeReaderModal,
  isReaderOpen,
  clearOfflinePdfCache,
  validatePdfFile
} from './reader.js';

// ----------------------------------------------------------------------------
// 1. SUPABASE CLOUD & IMMUTABLE CONSTANTS
// ----------------------------------------------------------------------------
const SUPABASE_URL = 'https://zzklpylokfhtlxhrnqqx.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_7Ik44J6c92t43JgBmLdKLQ_UQEWIpy2';
const SUPER_ADMIN_EMAIL = 'mandugula.karthik.work@gmail.com';

const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // 50 MB Supabase free tier limit
const ALLOWED_CDN_HOSTS = new Set(['cdn.jsdelivr.net', 'raw.githubusercontent.com']);

// Single source of truth for academic hierarchy & resource classifications
const ACADEMIC_YEARS = ['1st Year']; // Add '2nd Year', '3rd Year', '4th Year' later when expanding
const BRANCHES = [
  { id: 'CSE', label: 'CSE' },
  { id: 'CSM', label: 'CSM (AI & ML)' },
  { id: 'ECE', label: 'ECE' },
  { id: 'EEE', label: 'EEE' },
  { id: 'Mechanical', label: 'Mechanical' },
  { id: 'Civil', label: 'Civil' }
];
const SEMESTERS = [
  { id: 'Sem 1', label: 'Semester 1' },
  { id: 'Sem 2', label: 'Semester 2' }
];
const RESOURCE_TYPES = ['Mid-Term Q&A', 'Lecture Notes', 'Lab Manual'];

const DEFAULT_COMPRESSION_HINT =
  'Auto-compresses PDF scans up to 30 pages to reduce file size while keeping crisp readability.';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true
  }
});

// ----------------------------------------------------------------------------
// 2. APPLICATION STATE
// ----------------------------------------------------------------------------
let activeAuthUserId = null;
let activeUserSession = null;
let cloudResources = [];
let cloudStudents = [];
let cloudRoles = [];
let hasLoadedInitialData = false;

let currentFilter = {
  year: '1st Year',
  dept: 'CSE',
  sem: 'Sem 1',
  subject: 'All'
};

let currentAdminMode = 'dashboard';
let activeAdminTab = 'analytics';
let activityQueuePromise = Promise.resolve();
let isBootDismissed = false;
let activeConfirmResolver = null;
let adminSearchTimer = null;

// ----------------------------------------------------------------------------
// 3. SECURITY, FORMATTING & DOM UTILITIES
// ----------------------------------------------------------------------------
function escapeHTML(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Neutralizes CSV formula injection (including leading whitespace and embedded newlines)
 * before RFC 4180 quoting.
 */
function sanitizeCsvCell(value) {
  let text = value === null || value === undefined ? '' : String(value);
  text = text.replace(/[\r\n]+/g, ' ');
  if (/^\s*[=+\-@\t]/.test(text)) {
    text = `'${text}`;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

/**
 * Scoped Lucide icon renderer for lucide@0.460.0 UMD.
 */
function createIconsIn(container) {
  if (!window.lucide || typeof window.lucide.createIcons !== 'function') return;
  try {
    window.lucide.createIcons({
      icons: window.lucide.icons,
      root: container || document
    });
  } catch {
    try {
      window.lucide.createIcons();
    } catch {}
  }
}

function formatBytes(bytes) {
  const b = Number(bytes) || 0;
  if (b <= 0) return '0 KB';
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / (1024 * 1024)).toFixed(2)} MB`;
}

function calcSavedPercent(origBytes, compBytes) {
  const o = Number(origBytes) || 0;
  const c = Number(compBytes) || 0;
  if (o <= 0 || c >= o) return 0;
  return Math.round(((o - c) / o) * 100);
}

function formatRelativeTime(isoStr) {
  if (!isoStr) return 'Recently';
  const d = new Date(isoStr);
  if (Number.isNaN(d.getTime())) return 'Recently';
  const diffSec = Math.floor((Date.now() - d.getTime()) / 1000);
  if (diffSec < 60) return 'Just now';
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  if (diffSec < 604800) return `${Math.floor(diffSec / 86400)}d ago`;
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

function safeDecodeURI(path) {
  try {
    return decodeURIComponent(path);
  } catch {
    return path;
  }
}

function extractStoragePath(reference) {
  if (!reference) return '';
  const cleanRef = reference.trim();
  const publicPrefix = `${SUPABASE_URL}/storage/v1/object/public/pdfs/`;
  if (cleanRef.startsWith(publicPrefix)) {
    return safeDecodeURI(cleanRef.slice(publicPrefix.length));
  }
  const signPrefix = `${SUPABASE_URL}/storage/v1/object/sign/pdfs/`;
  if (cleanRef.startsWith(signPrefix)) {
    const withoutBase = cleanRef.slice(signPrefix.length);
    return safeDecodeURI(withoutBase.split('?')[0]);
  }
  return safeDecodeURI(cleanRef);
}

function isExternalCdnUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return ALLOWED_CDN_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function validateExternalCdnUrl(rawUrl) {
  if (!rawUrl) return null;
  const trimmed = rawUrl.trim();
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('External PDF URL must be a valid, well-formed HTTPS link.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('External PDF URL must strictly use HTTPS protocol.');
  }

  if (!ALLOWED_CDN_HOSTS.has(parsed.hostname.toLowerCase())) {
    throw new Error('Only allowlisted CDN hosts (cdn.jsdelivr.net, raw.githubusercontent.com) are supported.');
  }

  if (!parsed.pathname.toLowerCase().endsWith('.pdf')) {
    throw new Error('External CDN URL must directly point to a genuine .pdf file.');
  }

  return parsed.toString();
}

function convertLegacyJsonToPlainText(raw) {
  if (!raw) return '';
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          const q = item.q || item.question || '';
          const a = item.a || item.answer || '';
          return `Q: ${q}\nA: ${a}`;
        })
        .join('\n\n');
    }
  } catch {}
  return raw;
}

// ----------------------------------------------------------------------------
// 4. TOAST NOTIFICATIONS & NON-BLOCKING CONFIRMATION MODAL
// ----------------------------------------------------------------------------
function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const toast = document.createElement('div');
  const bg =
    type === 'error'
      ? 'bg-rose-900/90 text-rose-100 border-rose-700/60'
      : type === 'info'
        ? 'bg-slate-900/90 text-slate-100 border-slate-700/60'
        : 'bg-emerald-950/90 text-emerald-100 border-emerald-700/60';

  const iconName =
    type === 'error' ? 'alert-circle' : type === 'info' ? 'info' : 'check-circle-2';

  toast.className = `flex items-center gap-3 px-4 py-3 rounded-2xl shadow-xl backdrop-blur-md border ${bg} text-xs font-semibold pointer-events-auto transform transition-all duration-300 translate-y-2 opacity-0`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
  toast.innerHTML = `
    <i data-lucide="${iconName}" class="w-4 h-4 shrink-0"></i>
    <span class="flex-1">${escapeHTML(message)}</span>
  `;

  container.appendChild(toast);
  createIconsIn(toast);

  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });

  setTimeout(() => {
    toast.classList.add('translate-y-2', 'opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 4200);
}

/**
 * Declarative non-blocking replacement for native browser confirmation dialog.
 */
function requestConfirmation({
  title = 'Confirm Action',
  message = 'Are you sure you want to proceed?',
  confirmLabel = 'Confirm',
  variant = 'danger'
}) {
  const modal = document.getElementById('confirm-modal');
  const titleEl = document.getElementById('confirm-modal-title');
  const msgEl = document.getElementById('confirm-modal-message');
  const okBtn = document.getElementById('confirm-modal-ok');
  const iconWrap = document.getElementById('confirm-modal-icon-wrap');

  if (!modal || !titleEl || !msgEl || !okBtn) {
    return Promise.resolve(false);
  }

  if (activeConfirmResolver) {
    activeConfirmResolver(false);
    activeConfirmResolver = null;
  }

  titleEl.textContent = title;
  msgEl.textContent = message;
  okBtn.textContent = confirmLabel;

  if (variant === 'danger') {
    okBtn.className =
      'px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-sm cursor-pointer';
    if (iconWrap) {
      iconWrap.className =
        'w-10 h-10 rounded-2xl bg-rose-100 text-rose-600 flex items-center justify-center shrink-0';
    }
  } else {
    okBtn.className =
      'px-4 py-2 rounded-xl text-xs font-bold bg-indigo-600 hover:bg-indigo-700 text-white shadow-sm cursor-pointer';
    if (iconWrap) {
      iconWrap.className =
        'w-10 h-10 rounded-2xl bg-indigo-100 text-indigo-600 flex items-center justify-center shrink-0';
    }
  }

  modal.classList.remove('hidden');
  modal.classList.add('flex');
  createIconsIn(modal);

  return new Promise((resolve) => {
    activeConfirmResolver = resolve;
  });
}

function resolveConfirmation(result) {
  const modal = document.getElementById('confirm-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
  if (activeConfirmResolver) {
    const resolver = activeConfirmResolver;
    activeConfirmResolver = null;
    resolver(Boolean(result));
  }
}

// ----------------------------------------------------------------------------
// 5. IN-BROWSER PDF SCAN COMPRESSION (Safety Cap: 30 Pages)
// ----------------------------------------------------------------------------
function canvasToJpegUint8(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error('Canvas JPEG conversion failed'));
          return;
        }
        blob
          .arrayBuffer()
          .then((buf) => resolve(new Uint8Array(buf)))
          .catch(reject);
      },
      'image/jpeg',
      quality
    );
  });
}

/**
 * Compresses PDF scans in-browser using PDF.js + pdf-lib.
 * Skips compression if pages > 30 to prevent mobile RAM crashes.
 * Reuses validated buffer and frees per-page canvas RAM.
 * Keeps compressed file ONLY if strictly smaller than original.
 */
async function compressPdfInBrowser(file, onProgress, preloadedBuffer = null) {
  const originalBytes = file.size;
  const shouldCompress = Boolean(document.getElementById('up-auto-compress')?.checked);

  if (!shouldCompress || !window.PDFLib || !window.pdfjsLib) {
    return {
      fileToUpload: file,
      originalSize: originalBytes,
      compressedSize: originalBytes
    };
  }

  let srcPdf = null;
  try {
    const arrayBuf = preloadedBuffer || (await file.arrayBuffer());
    srcPdf = await window.pdfjsLib.getDocument({ data: arrayBuf.slice(0) }).promise;
    const numPages = srcPdf.numPages;

    // Safety Cap: 30 pages max for client-side rasterization to avoid mobile crashes
    if (numPages > 30) {
      if (onProgress) onProgress(`PDF has ${numPages} pages (>30). Skipping browser compression to preserve stability.`);
      return {
        fileToUpload: file,
        originalSize: originalBytes,
        compressedSize: originalBytes
      };
    }

    const outPdf = await window.PDFLib.PDFDocument.create();
    const renderScale = 1.45; // ~135 DPI crisp readable scans
    const jpegQuality = 0.74;

    for (let i = 1; i <= numPages; i++) {
      if (onProgress) onProgress(`Compressing Page ${i}/${numPages}...`);

      const page = await srcPdf.getPage(i);
      const baseVp = page.getViewport({ scale: 1.0 });
      const maxSide = Math.max(baseVp.width, baseVp.height, 1);
      const safeScale = Math.min(renderScale, 1600 / maxSide);
      const renderVp = page.getViewport({ scale: safeScale });

      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d', { alpha: false });
      canvas.width = Math.floor(renderVp.width);
      canvas.height = Math.floor(renderVp.height);

      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      await page.render({ canvasContext: ctx, viewport: renderVp }).promise;
      const jpegBytes = await canvasToJpegUint8(canvas, jpegQuality);

      // Immediately free canvas memory
      canvas.width = 0;
      canvas.height = 0;
      page.cleanup();

      const jpgImage = await outPdf.embedJpg(jpegBytes);
      const outPage = outPdf.addPage([baseVp.width, baseVp.height]);
      outPage.drawImage(jpgImage, {
        x: 0,
        y: 0,
        width: baseVp.width,
        height: baseVp.height
      });
    }

    const compressedUint8 = await outPdf.save({ useObjectStreams: true });
    const compressedBytes = compressedUint8.byteLength;

    if (compressedBytes < originalBytes) {
      const compressedBlob = new Blob([compressedUint8], { type: 'application/pdf' });
      const compressedFile = new File([compressedBlob], file.name, {
        type: 'application/pdf'
      });
      return {
        fileToUpload: compressedFile,
        originalSize: originalBytes,
        compressedSize: compressedBytes
      };
    }

    return {
      fileToUpload: file,
      originalSize: originalBytes,
      compressedSize: originalBytes
    };
  } catch (err) {
    console.warn('Browser PDF compression fallback to original file:', err);
    return {
      fileToUpload: file,
      originalSize: originalBytes,
      compressedSize: originalBytes
    };
  } finally {
    if (srcPdf) {
      try {
        await srcPdf.destroy();
      } catch {}
    }
  }
}

function updateCompressionSelectionHint(file) {
  const compressCheckbox = document.getElementById('up-auto-compress');
  const statusEl = document.getElementById('compression-live-status');
  if (!file) {
    if (compressCheckbox) compressCheckbox.checked = true;
    if (statusEl) statusEl.textContent = DEFAULT_COMPRESSION_HINT;
    return;
  }

  if (compressCheckbox) compressCheckbox.checked = true;
  if (statusEl) {
    statusEl.textContent = `Selected ${formatBytes(file.size)} — Compression auto-enabled (max 30 pages); will keep original if smaller.`;
  }
}

// ----------------------------------------------------------------------------
// 6. DYNAMIC DROPDOWNS & HIERARCHY POPULATOR
// ----------------------------------------------------------------------------
function renderYearFilterPills() {
  const container = document.getElementById('year-pills-container');
  if (!container) return;

  const label = '<span class="text-xs font-semibold text-slate-400 uppercase tracking-wider mr-1 shrink-0">Year:</span>';
  const buttons = ACADEMIC_YEARS.map((yr) => {
    const isActive = yr === currentFilter.year;
    const activeClass = 'bg-indigo-600 text-white shadow-sm';
    const inactiveClass = 'bg-slate-100 text-slate-600 hover:bg-slate-200';
    return `<button type="button" data-action="filter-year" data-year="${escapeHTML(
      yr
    )}" class="filter-year-btn px-4 py-2 rounded-xl text-xs font-semibold ${
      isActive ? activeClass : inactiveClass
    } transition-all shrink-0 cursor-pointer">${escapeHTML(yr)}</button>`;
  }).join('');

  container.innerHTML = label + buttons;
}

function populateDynamicDropdowns() {
  renderYearFilterPills();

  // Student filters
  const deptFilter = document.getElementById('dept-filter');
  if (deptFilter) {
    deptFilter.innerHTML = BRANCHES.map(
      (b) => `<option value="${escapeHTML(b.id)}">Branch: ${escapeHTML(b.label)}</option>`
    ).join('');
    if (currentFilter.dept) deptFilter.value = currentFilter.dept;
  }

  const semFilter = document.getElementById('sem-filter');
  if (semFilter) {
    semFilter.innerHTML = SEMESTERS.map(
      (s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.label)}</option>`
    ).join('');
    if (currentFilter.sem) semFilter.value = currentFilter.sem;
  }

  // Upload form selects
  const upYear = document.getElementById('up-year');
  if (upYear) {
    upYear.innerHTML = ACADEMIC_YEARS.map(
      (y) => `<option value="${escapeHTML(y)}">${escapeHTML(y)}</option>`
    ).join('');
  }
  const upDept = document.getElementById('up-dept');
  if (upDept) {
    upDept.innerHTML = BRANCHES.map(
      (b) => `<option value="${escapeHTML(b.id)}">${escapeHTML(b.label)}</option>`
    ).join('');
  }
  const upSem = document.getElementById('up-sem');
  if (upSem) {
    upSem.innerHTML = SEMESTERS.map(
      (s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.id)}</option>`
    ).join('');
  }
  const upType = document.getElementById('up-type');
  if (upType) {
    upType.innerHTML = RESOURCE_TYPES.map(
      (t) => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`
    ).join('');
  }

  // Edit modal selects
  const editYear = document.getElementById('edit-res-year');
  if (editYear) {
    editYear.innerHTML = ACADEMIC_YEARS.map(
      (y) => `<option value="${escapeHTML(y)}">${escapeHTML(y)}</option>`
    ).join('');
  }
  const editDept = document.getElementById('edit-res-dept');
  if (editDept) {
    editDept.innerHTML = BRANCHES.map(
      (b) => `<option value="${escapeHTML(b.id)}">${escapeHTML(b.label)}</option>`
    ).join('');
  }
  const editSem = document.getElementById('edit-res-sem');
  if (editSem) {
    editSem.innerHTML = SEMESTERS.map(
      (s) => `<option value="${escapeHTML(s.id)}">${escapeHTML(s.id)}</option>`
    ).join('');
  }
  const editType = document.getElementById('edit-res-type');
  if (editType) {
    editType.innerHTML = RESOURCE_TYPES.map(
      (t) => `<option value="${escapeHTML(t)}">${escapeHTML(t)}</option>`
    ).join('');
  }

  // RBAC branch select
  const roleBranch = document.getElementById('role-branch');
  if (roleBranch) {
    roleBranch.innerHTML =
      '<option value="ALL">ALL Branches</option>' +
      BRANCHES.map(
        (b) => `<option value="${escapeHTML(b.id)}">${escapeHTML(b.id)} Only</option>`
      ).join('');
  }

  // Admin Resource Library branch filter
  const adminBranchFilter = document.getElementById('admin-resource-branch-filter');
  if (adminBranchFilter) {
    adminBranchFilter.innerHTML =
      '<option value="ALL">All Branches</option>' +
      BRANCHES.map(
        (b) => `<option value="${escapeHTML(b.id)}">${escapeHTML(b.label)}</option>`
      ).join('');
  }
}

// ----------------------------------------------------------------------------
// 7. CLOUD SYNC ENGINE & DETERMINISTIC PAGINATION
// ----------------------------------------------------------------------------

/**
 * Paginates Supabase queries in 1,000-row batches with a deterministic tiebreaker.
 */
async function fetchAllRows(tableName, orderCol, ascending = false, tieBreakerCol = 'id') {
  const PAGE_SIZE = 1000;
  const allRows = [];
  let from = 0;

  while (true) {
    const to = from + PAGE_SIZE - 1;
    let query = sb.from(tableName).select('*').order(orderCol, { ascending });
    if (tieBreakerCol && tieBreakerCol !== orderCol) {
      query = query.order(tieBreakerCol, { ascending: false });
    }

    const { data, error } = await query.range(from, to);
    if (error) throw error;
    if (!data || data.length === 0) break;

    allRows.push(...data);
    if (data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }

  return allRows;
}

/**
 * Synchronizes portal data from Supabase.
 * Returns true if successful, false if offline/error.
 * Employs local metadata cache fallback so offline reloads still display cached resources.
 * @param {boolean} isInitial
 * @returns {Promise<boolean>}
 */
async function syncFromSupabase(isInitial = false) {
  try {
    const session = getSession();
    if (!session) return false;

    // Resolve dynamic user role using exact lowercase .eq('email', ...)
    if (session.email === SUPER_ADMIN_EMAIL) {
      session.role = 'super_admin';
      session.assigned_branch = 'ALL';
      session.assigned_subject = 'ALL';
    } else {
      const { data: roleRow, error: roleErr } = await sb
        .from('user_roles')
        .select('role, assigned_branch, assigned_subject, is_active')
        .eq('email', session.email)
        .maybeSingle();

      if (!roleErr && roleRow && roleRow.is_active) {
        session.role = roleRow.role;
        session.assigned_branch = roleRow.assigned_branch || 'ALL';
        session.assigned_subject = roleRow.assigned_subject || 'ALL';
      } else {
        session.role = 'student';
        session.assigned_branch = null;
        session.assigned_subject = null;
      }
    }

    const isPrivileged = isContributorOrAdmin(session);
    const isSuper = isSuperAdmin(session);

    // Fetch resources and student logs
    const [resList, studentsList] = await Promise.all([
      fetchAllRows('resources', 'created_at', false, 'id'),
      isSuper ? fetchAllRows('student_logs', 'last_active', false, 'email') : Promise.resolve([])
    ]);

    // Mid-sync logout guard
    if (!getSession() || getSession().email !== session.email) return false;

    cloudResources = resList || [];
    cloudStudents = studentsList || [];

    // Save offline metadata cache in localStorage
    try {
      localStorage.setItem('kprit_offline_resources_metadata', JSON.stringify(cloudResources));
    } catch {}

    if (isSuper) {
      cloudRoles = await fetchAllRows('user_roles', 'created_at', false, 'email');
    }

    hasLoadedInitialData = true;

    updateRoleUIHeader();
    updatePendingApprovalsBadge();

    if (isPrivileged && currentAdminMode === 'dashboard') {
      renderAdminDashboard();
      renderAdminApprovalsQueue();
      renderAdminResourceManager();
      if (isSuper) renderAdminRolesManager();
    } else {
      renderStudentResources();
    }

    return true;
  } catch (err) {
    console.warn('Supabase sync notice:', err);

    // Fallback to offline cached metadata if available
    try {
      const cached = localStorage.getItem('kprit_offline_resources_metadata');
      if (cached && cloudResources.length === 0) {
        cloudResources = JSON.parse(cached) || [];
        hasLoadedInitialData = true;
        renderStudentResources();
      }
    } catch {}

    if (getSession()) {
      hasLoadedInitialData = true;
      renderStudentResources();
    }

    return false;
  }
}

// ----------------------------------------------------------------------------
// 8. GOOGLE OAUTH & STUDENT ACTIVITY LOGGING
// ----------------------------------------------------------------------------
async function signInWithGoogle() {
  const btn = document.getElementById('btn-google-login');
  if (btn) btn.disabled = true;

  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: window.location.origin
    }
  });

  if (error) {
    if (btn) btn.disabled = false;
    showToast('Google Sign-In failed: ' + error.message, 'error');
  }
}

function recordStudentActivity(name, email, docTitle) {
  const session = getSession();
  if (!session || session.role !== 'student' || !navigator.onLine) return activityQueuePromise;

  activityQueuePromise = activityQueuePromise
    .then(async () => {
      const cleanEmail = email.toLowerCase().trim();
      const safeName = String(name || 'Student').slice(0, 120);
      const safeDoc = docTitle ? String(docTitle).slice(0, 250) : null;

      const { data: ownRow } = await sb
        .from('student_logs')
        .select('docs_read, last_doc')
        .eq('email', cleanEmail)
        .maybeSingle();

      const nextReads = safeDoc ? (ownRow?.docs_read || 0) + 1 : ownRow?.docs_read || 0;
      await sb.from('student_logs').upsert(
        {
          email: cleanEmail,
          full_name: safeName,
          last_active: new Date().toISOString(),
          docs_read: nextReads,
          last_doc: safeDoc || ownRow?.last_doc || 'Logged in to Portal'
        },
        { onConflict: 'email' }
      );
    })
    .catch((err) => {
      console.warn('Activity log error:', err);
    });

  return activityQueuePromise;
}

function scrubSharedDeviceState() {
  activeAuthUserId = null;
  activeUserSession = null;
  cloudResources = [];
  cloudStudents = [];
  cloudRoles = [];
  hasLoadedInitialData = false;
  currentFilter = {
    year: '1st Year',
    dept: 'CSE',
    sem: 'Sem 1',
    subject: 'All'
  };
  currentAdminMode = 'dashboard';
  activeAdminTab = 'analytics';

  const adminSection = document.getElementById('admin-command-section');
  if (adminSection) adminSection.classList.add('hidden');
  const studentSection = document.getElementById('student-portal-section');
  if (studentSection) studentSection.classList.remove('hidden');

  try {
    localStorage.removeItem('kprit_offline_resources_metadata');
  } catch {}

  // Purge offline decrypted PDF cache from IndexedDB on shared device logout
  clearOfflinePdfCache().catch(() => {});

  // Reset forms
  document.getElementById('upload-resource-form')?.reset();
  document.getElementById('grant-role-form')?.reset();
  document.getElementById('edit-resource-form')?.reset();

  // Clear sensitive Admin DOM containers & KPI metrics
  const approvalsList = document.getElementById('admin-pending-approvals-list');
  if (approvalsList) approvalsList.innerHTML = '';
  const resourcesList = document.getElementById('admin-resources-list');
  if (resourcesList) resourcesList.innerHTML = '';
  const rolesList = document.getElementById('admin-roles-list');
  if (rolesList) rolesList.innerHTML = '';
  const studentTableBody = document.getElementById('admin-student-table-body');
  if (studentTableBody) studentTableBody.innerHTML = '';

  [
    'kpi-total-students',
    'kpi-active-today',
    'kpi-total-reads',
    'kpi-top-subject-views',
    'kpi-top-subject',
    'subject-bar-chart',
    'daily-traffic-chart'
  ].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.innerHTML = '';
  });

  // Reset standalone filter/search controls
  const adminStudentSearch = document.getElementById('admin-student-search');
  if (adminStudentSearch) adminStudentSearch.value = '';
  const deptFilter = document.getElementById('dept-filter');
  if (deptFilter) deptFilter.value = 'CSE';
  const semFilter = document.getElementById('sem-filter');
  if (semFilter) semFilter.value = 'Sem 1';
  const branchFilter = document.getElementById('admin-resource-branch-filter');
  if (branchFilter) branchFilter.value = 'ALL';
  renderYearFilterPills();
}

async function applyGoogleSession(session) {
  if (session && session.user) {
    const incomingUserId = session.user.id;

    // Tab-switch guard: prevent redundant resets/re-renders when exact same user is active
    if (activeAuthUserId && activeAuthUserId === incomingUserId && activeUserSession) {
      dismissBootLoader();
      return;
    }

    activeAuthUserId = incomingUserId;
    hasLoadedInitialData = false;

    const meta = session.user.user_metadata || {};
    const name = meta.full_name || meta.name || session.user.email.split('@')[0];
    const email = (session.user.email || '').toLowerCase().trim();

    activeUserSession = {
      role: email === SUPER_ADMIN_EMAIL ? 'super_admin' : 'student',
      name,
      email,
      assigned_branch: email === SUPER_ADMIN_EMAIL ? 'ALL' : null,
      assigned_subject: email === SUPER_ADMIN_EMAIL ? 'ALL' : null
    };

    renderApp();
    dismissBootLoader();

    await syncFromSupabase(true);

    // Log student login ONLY after RBAC confirms regular student status
    if (activeUserSession && activeUserSession.role === 'student') {
      recordStudentActivity(name, email, null);
    }
  } else {
    scrubSharedDeviceState();
    renderApp();
    dismissBootLoader();
  }
}

async function logout() {
  if (isReaderOpen()) {
    await closeReaderModal();
  }
  scrubSharedDeviceState();
  await sb.auth.signOut().catch(() => {});
  showToast('Logged out successfully', 'info');
  renderApp();
}

// ----------------------------------------------------------------------------
// 9. VIEW ROUTER & RBAC HEADER CONTROLLER
// ----------------------------------------------------------------------------
function syncAdminSwitchButtonStyles(mode) {
  const desktopActive =
    'px-3 py-1.5 rounded-lg text-xs font-semibold bg-white text-indigo-600 shadow-sm transition-all cursor-pointer';
  const desktopInactive =
    'px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:text-slate-900 transition-all cursor-pointer';
  const mobActive =
    'flex-1 py-1 rounded-lg text-xs font-semibold bg-white text-indigo-600 shadow-sm text-center cursor-pointer';
  const mobInactive =
    'flex-1 py-1 rounded-lg text-xs font-semibold text-slate-600 text-center cursor-pointer';

  const navBtnAdmin = document.getElementById('nav-btn-admin');
  const navBtnPreview = document.getElementById('nav-btn-preview');
  const mobBtnAdmin = document.getElementById('mob-btn-admin');
  const mobBtnPreview = document.getElementById('mob-btn-preview');

  if (mode === 'dashboard') {
    if (navBtnAdmin) navBtnAdmin.className = desktopActive;
    if (navBtnPreview) navBtnPreview.className = desktopInactive;
    if (mobBtnAdmin) mobBtnAdmin.className = mobActive;
    if (mobBtnPreview) mobBtnPreview.className = mobInactive;
  } else {
    if (navBtnPreview) navBtnPreview.className = desktopActive;
    if (navBtnAdmin) navBtnAdmin.className = desktopInactive;
    if (mobBtnPreview) mobBtnPreview.className = mobActive;
    if (mobBtnAdmin) mobBtnAdmin.className = mobInactive;
  }
}

function updateRoleUIHeader() {
  const session = getSession();
  if (!session) return;

  const roleBadge = document.getElementById('role-badge');
  const adminDesktopSwitch = document.getElementById('admin-nav-switch');
  const adminMobileSwitch = document.getElementById('admin-mobile-switch');
  const tabBtnAnalytics = document.getElementById('tab-btn-analytics');
  const tabBtnApprovals = document.getElementById('tab-btn-approvals');
  const tabBtnAccess = document.getElementById('tab-btn-access');

  const navBtnAdmin = document.getElementById('nav-btn-admin');
  const mobBtnAdmin = document.getElementById('mob-btn-admin');
  const adminHeaderSubtitle = document.getElementById('admin-header-subtitle');
  const adminHeaderTitle = document.getElementById('admin-header-title');

  const scopeHint = document.getElementById('upload-scope-hint');
  const cdnUrlSection = document.getElementById('cdn-url-section');
  const publishBtnText = document.querySelector('#btn-publish-resource span');

  if (isSuperAdmin(session)) {
    roleBadge.textContent = 'Super Admin';
    roleBadge.className =
      'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 shrink-0';

    adminDesktopSwitch.classList.remove('hidden');
    adminDesktopSwitch.classList.add('hidden', 'sm:inline-flex');
    adminMobileSwitch.classList.remove('hidden');
    adminMobileSwitch.classList.add('flex');

    navBtnAdmin.textContent = 'Admin Panel';
    mobBtnAdmin.textContent = 'Admin Panel';
    adminHeaderSubtitle.textContent = 'Owner Command Center';
    adminHeaderTitle.textContent = 'Admin Portal & Live Analytics';

    tabBtnAnalytics.classList.remove('hidden');
    tabBtnAnalytics.classList.add('flex');
    tabBtnApprovals.classList.remove('hidden');
    tabBtnApprovals.classList.add('flex');
    tabBtnAccess.classList.remove('hidden');
    tabBtnAccess.classList.add('flex');

    if (cdnUrlSection) cdnUrlSection.classList.remove('hidden');
    scopeHint.textContent = 'Super Admin • Instant Live Publish';
    if (publishBtnText) publishBtnText.textContent = 'Publish Live to Student Portal';

    document.getElementById('up-dept').disabled = false;
    document.getElementById('up-subject').readOnly = false;
    syncAdminSwitchButtonStyles(currentAdminMode);
  } else if (session.role === 'faculty' || session.role === 'cr') {
    const label = session.role === 'faculty' ? 'Faculty' : 'CR Manager';
    roleBadge.textContent = label;
    roleBadge.className =
      'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300 shrink-0';

    adminDesktopSwitch.classList.remove('hidden');
    adminDesktopSwitch.classList.add('hidden', 'sm:inline-flex');
    adminMobileSwitch.classList.remove('hidden');
    adminMobileSwitch.classList.add('flex');

    navBtnAdmin.textContent = `${label} Upload`;
    mobBtnAdmin.textContent = `${label} Upload`;
    adminHeaderSubtitle.textContent = `${label} Portal`;
    adminHeaderTitle.textContent = 'Upload Study Materials';

    tabBtnAnalytics.classList.add('hidden');
    tabBtnAnalytics.classList.remove('flex');
    tabBtnApprovals.classList.add('hidden');
    tabBtnApprovals.classList.remove('flex');
    tabBtnAccess.classList.add('hidden');
    tabBtnAccess.classList.remove('flex');

    // External CDN URLs strictly blocked for CR/Faculty
    if (cdnUrlSection) {
      cdnUrlSection.classList.add('hidden');
      const cdnInput = document.getElementById('up-cdn-url');
      if (cdnInput) cdnInput.value = '';
    }

    if (publishBtnText) publishBtnText.textContent = 'Submit for Super-Admin Approval';

    const branchScoped = session.assigned_branch && session.assigned_branch !== 'ALL';
    const subjectScoped = session.assigned_subject && session.assigned_subject !== 'ALL';

    if (branchScoped) {
      document.getElementById('up-dept').value = session.assigned_branch;
      document.getElementById('up-dept').disabled = true;
    } else {
      document.getElementById('up-dept').disabled = false;
    }

    if (subjectScoped) {
      document.getElementById('up-subject').value = session.assigned_subject;
      document.getElementById('up-subject').readOnly = true;
    } else {
      document.getElementById('up-subject').readOnly = false;
    }

    scopeHint.textContent = `Scoped to: ${session.assigned_branch || 'ALL'} • ${session.assigned_subject || 'ALL'}`;
    syncAdminSwitchButtonStyles(currentAdminMode);
  } else {
    roleBadge.textContent = 'Student';
    roleBadge.className =
      'text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full bg-slate-100 text-slate-700 border border-slate-200 shrink-0';

    adminDesktopSwitch.classList.add('hidden');
    adminDesktopSwitch.classList.remove('sm:inline-flex');
    adminMobileSwitch.classList.add('hidden');
    adminMobileSwitch.classList.remove('flex');

    if (cdnUrlSection) cdnUrlSection.classList.add('hidden');

    currentAdminMode = 'student-preview';
    document.getElementById('admin-command-section')?.classList.add('hidden');
    document.getElementById('student-portal-section')?.classList.remove('hidden');
  }

  createIconsIn(document.getElementById('app-view'));
}

function renderApp() {
  const session = getSession();
  const authView = document.getElementById('auth-view');
  const appView = document.getElementById('app-view');

  if (!session) {
    authView.classList.remove('hidden');
    authView.classList.add('flex');
    appView.classList.add('hidden');
    createIconsIn(authView);
    return;
  }

  authView.classList.add('hidden');
  authView.classList.remove('flex');
  appView.classList.remove('hidden');

  document.getElementById('user-display-name').textContent = session.name;
  document.getElementById('user-display-email').textContent = session.email;
  document.getElementById('user-avatar').textContent = (session.name || 'U').charAt(0).toUpperCase();

  const bannerName = document.getElementById('banner-student-name');
  if (bannerName) {
    bannerName.textContent = session.name.split(' ')[0] || session.name;
  }

  if (isContributorOrAdmin(session)) {
    currentAdminMode = 'dashboard';
    updateRoleUIHeader();
    switchAdminView('dashboard');
  } else {
    currentAdminMode = 'student-preview';
    updateRoleUIHeader();
    const adminSection = document.getElementById('admin-command-section');
    if (adminSection) adminSection.classList.add('hidden');
    const studentSection = document.getElementById('student-portal-section');
    if (studentSection) studentSection.classList.remove('hidden');
    renderStudentResources();
  }

  updatePendingApprovalsBadge();
}

function dismissBootLoader() {
  if (isBootDismissed) return;
  isBootDismissed = true;
  const loader = document.getElementById('boot-loader');
  if (loader) {
    loader.classList.add('boot-hidden');
    setTimeout(() => {
      loader.remove();
    }, 250);
  }
}

function getSession() {
  return activeUserSession;
}

function isSuperAdmin(session) {
  return session && session.role === 'super_admin';
}

function isContributorOrAdmin(session) {
  return (
    session &&
    (session.role === 'super_admin' || session.role === 'faculty' || session.role === 'cr')
  );
}

// ----------------------------------------------------------------------------
// 10. STUDENT PORTAL (Study Materials & Hierarchy Filters)
// ----------------------------------------------------------------------------
function setFilter(key, value) {
  currentFilter[key] = value;
  if (key !== 'subject') {
    currentFilter.subject = 'All';
  }

  document.querySelectorAll('.filter-year-btn').forEach((btn) => {
    if (btn.dataset.year === currentFilter.year) {
      btn.className =
        'filter-year-btn px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 text-white shadow-sm transition-all shrink-0 cursor-pointer';
    } else {
      btn.className =
        'filter-year-btn px-4 py-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-600 hover:bg-slate-200 transition-all shrink-0 cursor-pointer';
    }
  });

  renderStudentResources();
}

function renderStudentResources() {
  const grid = document.getElementById('resources-grid');
  const breadcrumb = document.getElementById('hierarchy-breadcrumb');
  const countLabel = document.getElementById('resource-count-label');

  if (breadcrumb) {
    breadcrumb.innerHTML = `
      <span>${escapeHTML(currentFilter.year)}</span>
      <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
      <span>${escapeHTML(currentFilter.dept)}</span>
      <i data-lucide="chevron-right" class="w-3.5 h-3.5"></i>
      <span class="text-indigo-600 font-semibold">${escapeHTML(currentFilter.sem)}</span>
      ${
        currentFilter.subject !== 'All'
          ? `<i data-lucide="chevron-right" class="w-3.5 h-3.5"></i><span class="text-slate-800 font-semibold">${escapeHTML(
              currentFilter.subject
            )}</span>`
          : ''
      }
    `;
    createIconsIn(breadcrumb);
  }

  // Loading skeleton before initial sync finishes
  if (!hasLoadedInitialData) {
    if (countLabel) countLabel.textContent = 'Loading study materials...';
    if (grid) {
      grid.innerHTML = Array.from({ length: 3 })
        .map(
          () => `
          <div class="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm space-y-4 animate-pulse">
            <div class="flex justify-between">
              <div class="h-5 w-24 bg-slate-100 rounded-full"></div>
              <div class="h-4 w-16 bg-slate-100 rounded"></div>
            </div>
            <div class="h-3 w-32 bg-indigo-50 rounded"></div>
            <div class="h-5 w-3/4 bg-slate-200 rounded"></div>
            <div class="pt-4 border-t border-slate-100 flex justify-between items-center">
              <div class="h-3 w-24 bg-slate-100 rounded"></div>
              <div class="h-9 w-28 bg-slate-200 rounded-xl"></div>
            </div>
          </div>
        `
        )
        .join('');
    }
    return;
  }

  const approvedResources = cloudResources.filter((r) => (r.status || 'approved') === 'approved');
  const branchFiltered = approvedResources.filter(
    (r) =>
      r.year === currentFilter.year &&
      r.dept === currentFilter.dept &&
      r.sem === currentFilter.sem
  );

  const subjects = ['All', ...new Set(branchFiltered.map((r) => r.subject))];
  const pillContainer = document.getElementById('subject-pills');
  if (pillContainer) {
    pillContainer.innerHTML = subjects
      .map((sub) => {
        const active = currentFilter.subject === sub;
        return `
          <button type="button" data-action="filter-subject" data-subject="${escapeHTML(sub)}" class="shrink-0 px-3.5 py-1.5 rounded-full text-xs font-semibold transition-all cursor-pointer ${
            active ? 'bg-slate-900 text-white shadow-sm' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
          }">
            ${escapeHTML(sub)}
          </button>
        `;
      })
      .join('');
  }

  const finalItems = branchFiltered.filter((r) => {
    return currentFilter.subject === 'All' || r.subject === currentFilter.subject;
  });

  if (countLabel) {
    countLabel.textContent = `${finalItems.length} Study Material${finalItems.length === 1 ? '' : 's'}`;
  }

  if (!grid) return;

  if (finalItems.length === 0) {
    grid.innerHTML = `
      <div class="col-span-full bg-white rounded-3xl border border-dashed border-slate-300 p-12 text-center">
        <div class="w-12 h-12 rounded-2xl bg-slate-100 text-slate-400 flex items-center justify-center mx-auto mb-3">
          <i data-lucide="folder-open" class="w-6 h-6"></i>
        </div>
        <h3 class="font-bold text-slate-800 text-base">No notes uploaded for this filter yet</h3>
        <p class="text-xs text-slate-500 mt-1 max-w-md mx-auto">
          Switch to <strong>1st Year → CSE → Sem 1</strong> or check back soon as CRs &amp; Faculty publish new study materials.
        </p>
      </div>
    `;
    createIconsIn(grid);
    return;
  }

  grid.innerHTML = finalItems
    .map((item) => {
      const badgeStyle =
        item.type === 'Mid-Term Q&A'
          ? 'bg-indigo-50 text-indigo-700 border-indigo-200'
          : item.type === 'Lab Manual'
            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
            : 'bg-amber-50 text-amber-700 border-amber-200';

      const isCdn = isExternalCdnUrl(item.pdf_url);

      return `
        <div class="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm hover:shadow-md transition-shadow flex flex-col justify-between">
          <div>
            <div class="flex items-center justify-between gap-2 mb-3">
              <span class="text-[11px] font-bold px-2.5 py-1 rounded-full border ${badgeStyle}">
                ${escapeHTML(item.type)}
              </span>
              <span class="text-[11px] font-semibold text-slate-400 flex items-center gap-1">
                <i data-lucide="eye" class="w-3.5 h-3.5"></i> ${item.views || 0}
              </span>
            </div>

            <p class="text-xs font-semibold text-indigo-600 mb-1">${escapeHTML(item.subject)}</p>
            <h3 class="font-bold text-base text-slate-900 leading-snug mb-3">${escapeHTML(item.title)}</h3>
          </div>

          <div class="pt-4 mt-2 border-t border-slate-100 flex items-center justify-between">
            <span class="text-[11px] text-slate-400 flex items-center gap-1">
              ${
                item.pdf_url
                  ? isCdn
                    ? '<i data-lucide="cloud" class="w-3.5 h-3.5 text-emerald-600"></i> Cloud CDN'
                    : '<i data-lucide="file-text" class="w-3.5 h-3.5 text-rose-500"></i> PDF File'
                  : '<i data-lucide="align-left" class="w-3.5 h-3.5 text-indigo-500"></i> Q&A Notes'
              }
            </span>
            <button type="button" data-action="open-reader" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1.5 bg-slate-900 hover:bg-indigo-600 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors cursor-pointer">
              <span>Read Notes</span>
              <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  createIconsIn(grid);
}

// ----------------------------------------------------------------------------
// 11. ADMIN COMMAND CENTER (View Switching, Approvals, Roles, Library)
// ----------------------------------------------------------------------------
function switchAdminView(mode) {
  const session = getSession();
  currentAdminMode = mode;

  const adminSection = document.getElementById('admin-command-section');
  const studentSection = document.getElementById('student-portal-section');

  syncAdminSwitchButtonStyles(mode);

  if (mode === 'dashboard' && isContributorOrAdmin(session)) {
    adminSection.classList.remove('hidden');
    studentSection.classList.add('hidden');
    switchAdminTab(isSuperAdmin(session) ? activeAdminTab : 'resources');
  } else {
    adminSection.classList.add('hidden');
    studentSection.classList.remove('hidden');
    renderStudentResources();
  }
}

function switchAdminTab(tab) {
  const session = getSession();
  const superAdmin = isSuperAdmin(session);

  if (!superAdmin && (tab === 'analytics' || tab === 'approvals' || tab === 'access')) {
    tab = 'resources';
  }
  activeAdminTab = tab;

  const tabs = ['approvals', 'resources', 'analytics', 'access'];
  tabs.forEach((t) => {
    const section = document.getElementById(`admin-tab-${t}`);
    const btn = document.getElementById(`tab-btn-${t}`);
    const isActive = t === tab;

    if (section) {
      if (isActive) {
        section.classList.remove('hidden');
        section.classList.add(t === 'resources' || t === 'access' ? 'grid' : 'block');
      } else {
        section.classList.add('hidden');
        section.classList.remove('grid', 'block');
      }
    }

    if (btn) {
      if (!superAdmin && (t === 'analytics' || t === 'approvals' || t === 'access')) {
        return;
      }
      if (isActive) {
        btn.className =
          'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold bg-white text-indigo-600 shadow-sm transition-all cursor-pointer';
      } else {
        btn.className =
          'flex items-center gap-2 px-4 py-2.5 rounded-xl text-xs font-bold text-slate-600 hover:text-slate-900 transition-all cursor-pointer';
      }
    }
  });

  if (tab === 'approvals' && superAdmin) renderAdminApprovalsQueue();
  else if (tab === 'resources') renderAdminResourceManager();
  else if (tab === 'analytics' && superAdmin) renderAdminDashboard();
  else if (tab === 'access' && superAdmin) renderAdminRolesManager();
}

function updatePendingApprovalsBadge() {
  const pendingResources = cloudResources.filter((r) => r.status === 'pending');
  const totalPending = pendingResources.length;

  const badge = document.getElementById('pending-approvals-badge');
  const queueBadge = document.getElementById('approvals-queue-count-badge');
  if (badge) badge.textContent = String(totalPending);
  if (queueBadge) queueBadge.textContent = `${totalPending} Pending`;
}

function renderAdminApprovalsQueue() {
  if (!isSuperAdmin(getSession())) return;
  updatePendingApprovalsBadge();

  const pendingResources = cloudResources.filter((r) => r.status === 'pending');
  const container = document.getElementById('admin-pending-approvals-list');
  if (!container) return;

  if (pendingResources.length === 0) {
    container.innerHTML = `
      <div class="p-10 rounded-3xl border border-dashed border-slate-200 text-center bg-slate-50/50">
        <i data-lucide="check-circle-2" class="w-10 h-10 text-emerald-500 mx-auto mb-2"></i>
        <p class="font-bold text-slate-800 text-sm">All caught up! Zero pending submissions in queue.</p>
        <p class="text-xs text-slate-500 mt-1">New PDF uploads from CRs &amp; Faculty will appear here for 1-click verification.</p>
      </div>
    `;
    createIconsIn(container);
    return;
  }

  container.innerHTML = pendingResources
    .map((item) => {
      const origSize = formatBytes(item.original_size_bytes);
      const compSize = formatBytes(item.compressed_size_bytes);
      const savedPct = calcSavedPercent(item.original_size_bytes, item.compressed_size_bytes);

      return `
        <div class="p-5 rounded-3xl border border-slate-200 bg-white shadow-sm flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div class="space-y-1.5 min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-200">
                Pending Verification
              </span>
              <span class="text-xs font-semibold text-slate-500">
                ${escapeHTML(item.year)} • ${escapeHTML(item.dept)} • ${escapeHTML(item.sem)} • ${escapeHTML(item.subject)}
              </span>
            </div>
            <h4 class="font-bold text-base text-slate-900 leading-snug">${escapeHTML(item.title)}</h4>
            <div class="flex flex-wrap items-center gap-2 text-xs text-slate-500">
              <span>Submitted by <strong>${escapeHTML(item.uploader_name || 'Contributor')}</strong> (${escapeHTML(item.uploader_email)})</span>
              ${
                item.original_size_bytes > 0
                  ? `<span class="font-mono text-[11px] bg-slate-100 px-2 py-0.5 rounded">
                       ${origSize} → ${compSize} (${savedPct}% saved)
                     </span>`
                  : ''
              }
            </div>
          </div>

          <div class="flex items-center gap-2 shrink-0">
            ${
              item.pdf_url
                ? `<button type="button" data-action="preview-pending-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer">
                     <i data-lucide="eye" class="w-3.5 h-3.5"></i> Preview PDF
                   </button>`
                : item.raw_text
                  ? `<button type="button" data-action="preview-pending-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors cursor-pointer">
                       <i data-lucide="eye" class="w-3.5 h-3.5"></i> Preview Notes
                     </button>`
                  : ''
            }
            <button type="button" data-action="approve-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white shadow-sm transition-colors cursor-pointer">
              <i data-lucide="check" class="w-3.5 h-3.5"></i> Approve
            </button>
            <button type="button" data-action="reject-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 transition-colors cursor-pointer">
              <i data-lucide="x" class="w-3.5 h-3.5"></i> Reject
            </button>
          </div>
        </div>
      `;
    })
    .join('');

  createIconsIn(container);
}

/**
 * Checks if a PDF storage blob is referenced by any other row before removal.
 */
async function safeRemoveStorageFileIfUnreferenced(target) {
  if (!target?.pdf_url || isExternalCdnUrl(target.pdf_url)) return;
  const storagePath = extractStoragePath(target.pdf_url);
  if (!storagePath || /^https?:\/\//i.test(storagePath)) return;

  const { count, error } = await sb
    .from('resources')
    .select('id', { count: 'exact', head: true })
    .eq('pdf_url', target.pdf_url)
    .neq('id', target.id);

  if (error) {
    console.warn('Storage reference check skipped deletion:', error.message);
    return;
  }

  if ((count || 0) === 0) {
    await sb.storage.from('pdfs').remove([storagePath]).catch(() => {});
  }
}

async function approvePendingResource(resourceId) {
  if (!isSuperAdmin(getSession())) return;
  const target = cloudResources.find((r) => String(r.id) === String(resourceId));
  if (!target) return;

  const { error } = await sb
    .from('resources')
    .update({ status: 'approved', rejection_reason: null })
    .eq('id', target.id);

  if (error) {
    showToast('Approval failed: ' + error.message, 'error');
    return;
  }

  showToast(`Approved "${target.title}" live!`);
  await syncFromSupabase(false);
}

async function rejectPendingResource(resourceId) {
  if (!isSuperAdmin(getSession())) return;
  const target = cloudResources.find((r) => String(r.id) === String(resourceId));
  if (!target) return;

  const confirmed = await requestConfirmation({
    title: 'Reject Pending Submission?',
    message: `Reject "${target.title}"? The PDF will be removed from cloud storage and the uploader will see the rejection status.`,
    confirmLabel: 'Reject Submission',
    variant: 'danger'
  });
  if (!confirmed) return;

  const rejectionReason = 'Submission rejected during Super-Admin verification.';

  const { error } = await sb
    .from('resources')
    .update({
      status: 'rejected',
      pdf_url: null,
      rejection_reason: rejectionReason
    })
    .eq('id', target.id);

  if (error) {
    showToast('Reject action failed: ' + error.message, 'error');
    return;
  }

  await safeRemoveStorageFileIfUnreferenced(target);

  showToast(`Rejected "${target.title}"`, 'info');
  await syncFromSupabase(false);
}

// ----------------------------------------------------------------------------
// 12. ROLE MANAGEMENT (RBAC — Exact Lowercase .eq Queries)
// ----------------------------------------------------------------------------
let isGrantingRole = false;

async function handleGrantRole(e) {
  e.preventDefault();
  if (isGrantingRole) return;
  const session = getSession();
  if (!isSuperAdmin(session)) {
    showToast('Only Super Admin can manage roles.', 'error');
    return;
  }

  isGrantingRole = true;
  const btn = document.getElementById('btn-grant-role');
  if (btn) btn.disabled = true;

  try {
    const email = (document.getElementById('role-email')?.value || '').trim().toLowerCase();
    const name = (document.getElementById('role-name')?.value || '').trim();
    const role = document.getElementById('role-type').value;
    const assigned_branch = document.getElementById('role-branch').value;
    const assigned_subject = (document.getElementById('role-subject')?.value || '').trim() || 'ALL';

    if (!email || !name) {
      throw new Error('Google Email Address and Full Name cannot be empty.');
    }

    if (email === SUPER_ADMIN_EMAIL) {
      showToast('Super Admin account is permanently locked as owner.', 'info');
      return;
    }

    const { error } = await sb.from('user_roles').upsert(
      {
        email,
        name,
        role,
        assigned_branch,
        assigned_subject,
        is_active: true
      },
      { onConflict: 'email' }
    );

    if (error) throw error;

    e.target.reset();
    document.getElementById('role-subject').value = 'ALL';
    showToast(`Granted ${role.toUpperCase()} access to ${name} (${email})!`);
    await syncFromSupabase(false);
  } catch (err) {
    showToast('Role update failed: ' + err.message, 'error');
  } finally {
    isGrantingRole = false;
    if (btn) btn.disabled = false;
  }
}

async function toggleRoleStatus(email, nextState) {
  if (!isSuperAdmin(getSession())) return;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || cleanEmail === SUPER_ADMIN_EMAIL) return;

  const { error } = await sb
    .from('user_roles')
    .update({ is_active: nextState })
    .eq('email', cleanEmail);

  if (error) {
    showToast('Status update failed: ' + error.message, 'error');
    return;
  }
  showToast(
    nextState ? `Restored access for ${cleanEmail}` : `Revoked access for ${cleanEmail}`,
    nextState ? 'success' : 'info'
  );
  await syncFromSupabase(false);
}

async function deleteRoleRecord(email) {
  if (!isSuperAdmin(getSession())) return;
  const cleanEmail = String(email || '').trim().toLowerCase();
  if (!cleanEmail || cleanEmail === SUPER_ADMIN_EMAIL) return;

  const confirmed = await requestConfirmation({
    title: 'Remove Role Access?',
    message: `Remove "${cleanEmail}" from authorized CR/Faculty managers? They will immediately revert to standard student access.`,
    confirmLabel: 'Remove Role',
    variant: 'danger'
  });
  if (!confirmed) return;

  const { error } = await sb.from('user_roles').delete().eq('email', cleanEmail);
  if (error) {
    showToast('Delete failed: ' + error.message, 'error');
    return;
  }

  showToast(`Removed ${cleanEmail} from role list`, 'info');
  await syncFromSupabase(false);
}

function renderAdminRolesManager() {
  if (!isSuperAdmin(getSession())) return;
  const activeCount = cloudRoles.filter((r) => r.is_active).length;
  document.getElementById('admin-total-roles-badge').textContent = `${activeCount} Active`;

  const container = document.getElementById('admin-roles-list');
  if (!container) return;

  container.innerHTML = cloudRoles
    .map((r) => {
      const isOwner = r.email === SUPER_ADMIN_EMAIL;
      return `
        <div class="p-4 rounded-2xl border ${
          r.is_active ? 'border-slate-200 bg-white' : 'border-rose-100 bg-rose-50/30'
        } flex items-center justify-between gap-3 shadow-sm">
          <div class="min-w-0">
            <div class="flex items-center gap-2 mb-1">
              <span class="text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-full ${
                r.role === 'super_admin'
                  ? 'bg-amber-100 text-amber-800'
                  : r.role === 'faculty'
                    ? 'bg-indigo-100 text-indigo-800'
                    : 'bg-emerald-100 text-emerald-800'
              }">${escapeHTML(r.role)}</span>
              <span class="text-xs font-bold text-slate-900 truncate">${escapeHTML(r.name)}</span>
              ${
                !r.is_active
                  ? '<span class="text-[10px] font-semibold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-md">Revoked</span>'
                  : ''
              }
            </div>
            <p class="text-xs font-mono text-slate-500 truncate">${escapeHTML(r.email)}</p>
            <p class="text-[11px] text-slate-400 mt-1">Branch: <strong>${escapeHTML(
              r.assigned_branch
            )}</strong> • Subject: <strong>${escapeHTML(r.assigned_subject)}</strong></p>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            ${
              isOwner
                ? '<span class="text-xs font-semibold text-amber-700 bg-amber-50 px-2.5 py-1 rounded-xl">Permanent Owner</span>'
                : `
                <button type="button" data-action="toggle-role" data-email="${escapeHTML(
                  r.email
                )}" data-state="${!r.is_active}" class="px-3 py-1.5 rounded-xl text-xs font-semibold ${
                  r.is_active
                    ? 'text-amber-700 bg-amber-50 hover:bg-amber-100'
                    : 'text-emerald-700 bg-emerald-50 hover:bg-emerald-100'
                } transition-colors cursor-pointer">
                  ${r.is_active ? 'Revoke' : 'Restore'}
                </button>
                <button type="button" data-action="delete-role" data-email="${escapeHTML(
                  r.email
                )}" class="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50 transition-colors cursor-pointer" title="Delete role permanently" aria-label="Delete role permanently">
                  <i data-lucide="trash-2" class="w-4 h-4"></i>
                </button>
              `
            }
          </div>
        </div>
      `;
    })
    .join('');

  createIconsIn(container);
}

// ----------------------------------------------------------------------------
// 13. LIVE ANALYTICS DASHBOARD & FORMULA-SAFE CSV EXPORT
// ----------------------------------------------------------------------------
function renderAdminDashboard() {
  if (!isSuperAdmin(getSession())) return;

  const approvedResources = cloudResources.filter((r) => (r.status || 'approved') === 'approved');
  const totalStudents = cloudStudents.length;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const days = [];

  for (let offset = 6; offset >= 0; offset--) {
    const start = new Date(todayStart.getTime() - offset * 24 * 60 * 60 * 1000);
    const end = new Date(start.getTime() + 24 * 60 * 60 * 1000);
    const count = cloudStudents.filter((s) => {
      const ts = new Date(s.last_active).getTime();
      return !Number.isNaN(ts) && ts >= start.getTime() && ts < end.getTime();
    }).length;

    days.push({
      label: offset === 0 ? 'Today' : dayNames[start.getDay()],
      val: count,
      isToday: offset === 0
    });
  }

  const activeToday = days[days.length - 1].val;
  const activeLast7d = days.reduce((sum, d) => sum + d.val, 0);
  const totalReads = approvedResources.reduce((sum, r) => sum + (r.views || 0), 0);

  const subjectMap = {};
  approvedResources.forEach((r) => {
    subjectMap[r.subject] = (subjectMap[r.subject] || 0) + (r.views || 0);
  });

  const sortedSubjects = Object.entries(subjectMap).sort((a, b) => b[1] - a[1]);
  const topSub = sortedSubjects[0] || ['None', 0];

  document.getElementById('kpi-total-students').textContent = String(totalStudents);
  document.getElementById('kpi-active-today').textContent = String(activeToday);
  document.getElementById('kpi-total-reads').textContent = String(totalReads);
  document.getElementById('kpi-top-subject').textContent = topSub[0];
  document.getElementById('kpi-top-subject-views').textContent = `${topSub[1]} total reads`;

  const maxViews = Math.max(...sortedSubjects.map((s) => s[1]), 1);
  const subjectChart = document.getElementById('subject-bar-chart');
  if (subjectChart) {
    subjectChart.innerHTML =
      sortedSubjects
        .slice(0, 5)
        .map(([sub, views]) => {
          const pct = Math.round((views / maxViews) * 100);
          return `
            <div>
              <div class="flex justify-between text-xs font-semibold mb-1.5">
                <span class="text-slate-700 truncate pr-2">${escapeHTML(sub)}</span>
                <span class="text-indigo-600 shrink-0">${views} views</span>
              </div>
              <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                <div class="h-full bg-indigo-600 rounded-full transition-all duration-500" style="width: ${pct}%"></div>
              </div>
            </div>
          `;
        })
        .join('') || '<p class="text-xs text-slate-400">No subject reads recorded yet.</p>';
  }

  const badgeEl = document.getElementById('traffic-growth-badge');
  if (badgeEl) {
    badgeEl.textContent = `${activeLast7d} Active (7d)`;
  }

  const maxDay = Math.max(...days.map((d) => d.val), 1);
  const dailyChart = document.getElementById('daily-traffic-chart');
  if (dailyChart) {
    dailyChart.innerHTML = days
      .map((d) => {
        const heightPct = d.val === 0 ? 4 : Math.max(10, Math.round((d.val / maxDay) * 100));
        return `
          <div class="flex-1 flex flex-col items-center gap-2 h-full justify-end">
            <span class="text-[10px] font-bold ${d.isToday ? 'text-indigo-600' : 'text-slate-400'}">${
              d.val
            }</span>
            <div class="w-full max-w-[34px] rounded-t-xl transition-all duration-500 ${
              d.isToday
                ? 'bg-indigo-600 shadow-md shadow-indigo-600/20'
                : 'bg-slate-200 hover:bg-indigo-300'
            }" style="height: ${heightPct}%"></div>
            <span class="text-[11px] font-semibold ${
              d.isToday ? 'text-slate-900' : 'text-slate-500'
            }">${d.label}</span>
          </div>
        `;
      })
      .join('');
  }

  const query = (document.getElementById('admin-student-search')?.value || '').trim().toLowerCase();
  const filteredStudents = cloudStudents.filter(
    (s) =>
      (s.full_name || '').toLowerCase().includes(query) ||
      (s.email || '').toLowerCase().includes(query) ||
      (s.last_doc || '').toLowerCase().includes(query)
  );

  const tbody = document.getElementById('admin-student-table-body');
  if (tbody) {
    tbody.innerHTML =
      filteredStudents
        .map(
          (s) => `
        <tr class="hover:bg-slate-50/80 transition-colors">
          <td class="py-3.5 px-6 font-semibold text-slate-900 flex items-center gap-2.5">
            <div class="w-7 h-7 rounded-full bg-indigo-100 text-indigo-700 font-bold text-xs flex items-center justify-center shrink-0">
              ${escapeHTML((s.full_name || 'S').charAt(0).toUpperCase())}
            </div>
            <span>${escapeHTML(s.full_name)}</span>
          </td>
          <td class="py-3.5 px-6 text-xs font-mono text-slate-600">${escapeHTML(s.email)}</td>
          <td class="py-3.5 px-6 text-xs text-slate-500">${formatRelativeTime(s.last_active)}</td>
          <td class="py-3.5 px-6 text-center">
            <span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-bold bg-emerald-50 text-emerald-700">
              ${s.docs_read || 0}
            </span>
          </td>
          <td class="py-3.5 px-6 text-xs text-slate-600 max-w-xs truncate">${escapeHTML(
            s.last_doc || '—'
          )}</td>
        </tr>
      `
        )
        .join('') ||
      '<tr><td colspan="5" class="py-6 px-6 text-center text-xs text-slate-400">No student Google logins recorded yet.</td></tr>';
  }
}

function exportAnalyticsCSV() {
  if (!isSuperAdmin(getSession())) return;

  const headers = ['Student Name', 'Email', 'Last Active', 'Total Docs Read', 'Last Viewed Document'];
  const rows = cloudStudents.map((s) => [
    sanitizeCsvCell(s.full_name || ''),
    sanitizeCsvCell(s.email || ''),
    sanitizeCsvCell(formatRelativeTime(s.last_active)),
    Number(s.docs_read || 0),
    sanitizeCsvCell(s.last_doc || '')
  ]);

  const csvContent = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `KPRIT_Hub_Student_Analytics_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
  showToast('Formula-safe Analytics CSV report downloaded!');
}

// ----------------------------------------------------------------------------
// 14. RESOURCE UPLOAD, EDIT MODAL & DELETE WORKFLOWS
// ----------------------------------------------------------------------------
let isUploadingResource = false;

async function handleAdminUpload(e) {
  e.preventDefault();
  if (isUploadingResource) return;
  const session = getSession();
  if (!isContributorOrAdmin(session)) {
    showToast('Unauthorized: Upload permission required.', 'error');
    return;
  }

  isUploadingResource = true;
  const btn = document.getElementById('btn-publish-resource');
  const statusText = document.getElementById('compression-live-status');
  if (btn) {
    btn.disabled = true;
    btn.querySelector('span').textContent = 'Validating & Uploading...';
  }

  let uploadedStoragePath = null;

  try {
    const title = (document.getElementById('up-title')?.value || '').trim();
    const year = document.getElementById('up-year').value;
    const dept = document.getElementById('up-dept').value;
    const sem = document.getElementById('up-sem').value;
    const type = document.getElementById('up-type').value;
    const subject = (document.getElementById('up-subject')?.value || '').trim();
    const rawText = (document.getElementById('up-content')?.value || '').trim();
    const cdnUrlInput = (document.getElementById('up-cdn-url')?.value || '').trim();
    const fileInput = document.getElementById('up-pdf-file');
    const selectedFile = fileInput?.files?.[0] || null;

    if (!title || !subject) {
      throw new Error('Document Title and Subject Name cannot be empty.');
    }

    if (!selectedFile && !cdnUrlInput && !rawText) {
      throw new Error('Please attach a PDF file, provide a CDN URL, or enter Curated Q&A / Summary Notes.');
    }

    if (selectedFile && cdnUrlInput) {
      throw new Error('Please attach EITHER a local PDF file OR an External CDN URL — not both.');
    }

    // Role scope checks
    if (!isSuperAdmin(session)) {
      if (cdnUrlInput) {
        throw new Error('External CDN URLs can only be published by the Super Admin.');
      }
      if (
        session.assigned_branch &&
        session.assigned_branch !== 'ALL' &&
        session.assigned_branch.toLowerCase() !== dept.toLowerCase()
      ) {
        throw new Error(`Your role is scoped to ${session.assigned_branch} branch only.`);
      }
      if (
        session.assigned_subject &&
        session.assigned_subject !== 'ALL' &&
        session.assigned_subject.toLowerCase() !== subject.toLowerCase()
      ) {
        throw new Error(`Your role is scoped to subject "${session.assigned_subject}" only.`);
      }
    }

    let pdfPath = null;
    let originalSizeBytes = 0;
    let compressedSizeBytes = 0;

    if (cdnUrlInput) {
      pdfPath = validateExternalCdnUrl(cdnUrlInput);
    } else if (selectedFile) {
      if (selectedFile.size > MAX_UPLOAD_BYTES) {
        throw new Error(`File is ${formatBytes(selectedFile.size)}. Maximum allowed size is 50 MB.`);
      }

      btn.querySelector('span').textContent = 'Verifying PDF integrity...';
      if (statusText) statusText.textContent = 'Checking PDF structure & encryption...';
      const { buffer: validatedBuffer } = await validatePdfFile(selectedFile);

      const compResult = await compressPdfInBrowser(
        selectedFile,
        (progressLabel) => {
          btn.querySelector('span').textContent = progressLabel;
          if (statusText) statusText.textContent = progressLabel;
        },
        validatedBuffer
      );

      originalSizeBytes = compResult.originalSize;
      compressedSizeBytes = compResult.compressedSize;
      const savedPct = calcSavedPercent(originalSizeBytes, compressedSizeBytes);
      if (statusText) {
        statusText.textContent =
          savedPct > 0
            ? `Compressed: ${formatBytes(originalSizeBytes)} → ${formatBytes(
                compressedSizeBytes
              )} (${savedPct}% saved)`
            : `Verified PDF (${formatBytes(originalSizeBytes)}) — original quality kept.`;
      }

      btn.querySelector('span').textContent = 'Uploading to Cloud Storage...';

      // Safe filename normalization: remove unsafe chars, no .., lowercase .pdf
      const baseSafeName = selectedFile.name
        .replace(/[^a-zA-Z0-9._-]/g, '_')
        .replace(/\.{2,}/g, '_')
        .replace(/\.pdf$/i, '')
        .replace(/\.+$/g, '');
      const cleanName = `${Date.now()}_${baseSafeName || 'document'}.pdf`;

      const { error: uploadErr } = await sb.storage
        .from('pdfs')
        .upload(cleanName, compResult.fileToUpload, {
          cacheControl: '3600',
          contentType: 'application/pdf',
          upsert: false
        });

      if (uploadErr) throw uploadErr;

      uploadedStoragePath = cleanName;
      pdfPath = cleanName;
    }

    const initialStatus = isSuperAdmin(session) ? 'approved' : 'pending';

    const { error: insertErr } = await sb.from('resources').insert([
      {
        title,
        year,
        dept,
        sem,
        subject,
        type,
        views: 0,
        pdf_url: pdfPath,
        raw_text: rawText || null,
        original_size_bytes: originalSizeBytes,
        compressed_size_bytes: compressedSizeBytes,
        uploader_email: session.email,
        uploader_name: session.name,
        status: initialStatus,
        rejection_reason: null
      }
    ]);

    // Automatic storage rollback on DB insert failure
    if (insertErr) {
      if (uploadedStoragePath) {
        await sb.storage.from('pdfs').remove([uploadedStoragePath]).catch(() => {});
      }
      throw insertErr;
    }

    if (initialStatus === 'pending') {
      showToast(`Submitted "${title}" to Super-Admin Approval Queue!`, 'info');
    } else {
      showToast(`Published "${title}" live to ${year} ${dept}!`);
    }

    e.target.reset();
    const compressCheckbox = document.getElementById('up-auto-compress');
    if (compressCheckbox) compressCheckbox.checked = true;
    if (statusText) statusText.textContent = DEFAULT_COMPRESSION_HINT;
    updateRoleUIHeader();
    await syncFromSupabase(false);
  } catch (err) {
    if (statusText) statusText.textContent = DEFAULT_COMPRESSION_HINT;
    showToast('Upload failed: ' + err.message, 'error');
  } finally {
    isUploadingResource = false;
    if (btn) btn.disabled = false;
    updateRoleUIHeader();
  }
}

async function deleteResource(id) {
  if (!isSuperAdmin(getSession())) return;
  const target = cloudResources.find((r) => String(r.id) === String(id));
  if (!target) return;

  const confirmed = await requestConfirmation({
    title: 'Delete Resource Permanently?',
    message: `Delete "${target.title}"? The document will be removed from student view and storage immediately.`,
    confirmLabel: 'Delete Resource',
    variant: 'danger'
  });
  if (!confirmed) return;

  const { error } = await sb.from('resources').delete().eq('id', id);
  if (error) {
    showToast('Delete failed: ' + error.message, 'error');
    return;
  }

  await safeRemoveStorageFileIfUnreferenced(target);

  showToast('Resource removed from portal', 'info');
  await syncFromSupabase(false);
}

function openEditResourceModal(id) {
  if (!isSuperAdmin(getSession())) return;
  const item = cloudResources.find((r) => String(r.id) === String(id));
  if (!item) return;

  const ensureSelectOption = (selectEl, val) => {
    if (!selectEl || !val) return;
    selectEl.querySelectorAll('option[data-legacy="true"]').forEach((opt) => opt.remove());
    const hasOption = Array.from(selectEl.options).some((opt) => opt.value === val);
    if (!hasOption) {
      const opt = document.createElement('option');
      opt.value = val;
      opt.textContent = val;
      opt.dataset.legacy = 'true';
      selectEl.appendChild(opt);
    }
    selectEl.value = val;
  };

  document.getElementById('edit-res-id').value = item.id;
  document.getElementById('edit-res-title').value = item.title || '';
  ensureSelectOption(document.getElementById('edit-res-year'), item.year || '1st Year');
  ensureSelectOption(document.getElementById('edit-res-dept'), item.dept || 'CSE');
  ensureSelectOption(document.getElementById('edit-res-sem'), item.sem || 'Sem 1');
  ensureSelectOption(document.getElementById('edit-res-type'), item.type || 'Mid-Term Q&A');
  document.getElementById('edit-res-subject').value = item.subject || '';

  const contentEl = document.getElementById('edit-res-content');
  const jsonHint = document.getElementById('edit-res-json-hint');

  // Convert legacy JSON Q&A cleanly into readable plain text for editing
  contentEl.value = convertLegacyJsonToPlainText(item.raw_text || '');
  if (jsonHint) jsonHint.classList.add('hidden');

  const modal = document.getElementById('edit-resource-modal');
  modal.classList.remove('hidden');
  modal.classList.add('flex');
  createIconsIn(modal);
}

function closeEditResourceModal() {
  const modal = document.getElementById('edit-resource-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    modal.querySelectorAll('option[data-legacy="true"]').forEach((opt) => opt.remove());
  }
}

let isSavingEdit = false;

async function handleSaveEditResource(e) {
  e.preventDefault();
  if (isSavingEdit) return;
  if (!isSuperAdmin(getSession())) return;

  isSavingEdit = true;
  const btn = document.getElementById('btn-save-edit-resource');
  if (btn) btn.disabled = true;

  try {
    const id = document.getElementById('edit-res-id').value;
    const item = cloudResources.find((r) => String(r.id) === String(id));
    const title = (document.getElementById('edit-res-title')?.value || '').trim();
    const year = document.getElementById('edit-res-year').value;
    const dept = document.getElementById('edit-res-dept').value;
    const sem = document.getElementById('edit-res-sem').value;
    const type = document.getElementById('edit-res-type').value;
    const subject = (document.getElementById('edit-res-subject')?.value || '').trim();
    const contentEl = document.getElementById('edit-res-content');
    const raw_text = contentEl.value.trim() || null;

    if (!title || !subject) {
      throw new Error('Title and Subject Name cannot be empty.');
    }

    // Block empty text-only saves when no PDF is attached
    if (!item?.pdf_url && !raw_text) {
      throw new Error('Please provide study notes or attach a PDF document.');
    }

    const { error } = await sb
      .from('resources')
      .update({ title, year, dept, sem, type, subject, raw_text })
      .eq('id', id);

    if (error) throw error;

    closeEditResourceModal();
    showToast(`Updated "${title}" successfully!`);
    await syncFromSupabase(false);
  } catch (err) {
    showToast('Failed to save changes: ' + err.message, 'error');
  } finally {
    isSavingEdit = false;
    if (btn) btn.disabled = false;
  }
}

function renderAdminResourceManager() {
  const session = getSession();
  const superAdmin = isSuperAdmin(session);

  const visibleList = superAdmin
    ? cloudResources
    : cloudResources.filter(
        (r) =>
          (r.uploader_email && r.uploader_email.toLowerCase() === session.email) ||
          (r.status || 'approved') === 'approved'
      );

  // Apply branch filter dropdown
  const branchFilter = document.getElementById('admin-resource-branch-filter')?.value || 'ALL';
  const filteredList =
    branchFilter === 'ALL'
      ? visibleList
      : visibleList.filter((r) => (r.dept || '').toLowerCase() === branchFilter.toLowerCase());

  document.getElementById('admin-total-docs-badge').textContent = `${filteredList.length} Files`;

  const container = document.getElementById('admin-resources-list');
  if (!container) return;

  container.innerHTML = filteredList
    .map((item) => {
      const st = item.status || 'approved';
      const isCdn = isExternalCdnUrl(item.pdf_url);
      const storageBadge = item.pdf_url
        ? isCdn
          ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-700">Zero-Egress CDN</span>'
          : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-100 text-rose-700">Protected PDF</span>'
        : '';

      const statusBadge =
        st === 'approved'
          ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-emerald-100 text-emerald-800">Approved &amp; Live</span>'
          : st === 'pending'
            ? '<span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-amber-100 text-amber-800">Pending Super-Admin Approval</span>'
            : '<span class="text-[10px] font-bold px-2 py-0.5 rounded-md bg-rose-100 text-rose-800">Rejected</span>';

      const savedPct = calcSavedPercent(item.original_size_bytes, item.compressed_size_bytes);
      const telemetryLine =
        item.original_size_bytes > 0
          ? `<span class="text-[11px] font-mono text-slate-500"> • ${formatBytes(
              item.original_size_bytes
            )} → ${formatBytes(item.compressed_size_bytes)}${
              savedPct > 0 ? ` (${savedPct}% saved)` : ''
            }</span>`
          : '';

      const rejectionBanner =
        st === 'rejected' && item.rejection_reason
          ? `<div class="mt-2.5 p-3 rounded-xl bg-rose-50 border border-rose-200 text-[11px] text-rose-800 flex items-start gap-2">
               <i data-lucide="alert-circle" class="w-4 h-4 text-rose-600 shrink-0 mt-0.5"></i>
               <span><strong>Rejection Note:</strong> ${escapeHTML(item.rejection_reason)}</span>
             </div>`
          : '';

      return `
        <div class="p-4 rounded-2xl border ${
          st === 'rejected'
            ? 'border-rose-200 bg-rose-50/20'
            : st === 'pending'
              ? 'border-amber-200 bg-amber-50/30'
              : 'border-slate-200 bg-slate-50/50'
        } flex flex-col justify-between gap-2">
          <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="flex flex-wrap items-center gap-1.5 mb-1">
                ${statusBadge}
                <span class="text-[10px] font-bold uppercase px-2 py-0.5 rounded-md bg-indigo-100 text-indigo-700">${escapeHTML(
                  item.year
                )} • ${escapeHTML(item.dept)} • ${escapeHTML(item.sem)}</span>
                <span class="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-slate-200 text-slate-700">${escapeHTML(
                  item.type
                )}</span>
                ${storageBadge}
              </div>
              <h4 class="font-bold text-sm text-slate-900 leading-snug">${escapeHTML(item.title)}</h4>
              <p class="text-xs text-indigo-600 font-semibold mt-0.5">${escapeHTML(item.subject)}</p>
              <div class="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-slate-500">
                <span>By: <strong>${escapeHTML(item.uploader_name || 'Contributor')}</strong> (${escapeHTML(
                  item.uploader_email || 'unknown'
                )})</span>
                <span>• Views: <strong>${item.views || 0}</strong></span>
                ${telemetryLine}
              </div>
              ${rejectionBanner}
            </div>

            <div class="flex items-center gap-2 shrink-0 self-end sm:self-center">
              ${
                item.pdf_url || item.raw_text
                  ? `<button type="button" data-action="open-reader" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 transition-colors cursor-pointer">
                       <i data-lucide="eye" class="w-3.5 h-3.5"></i> Preview
                     </button>`
                  : `<span class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-slate-50 border border-slate-200 text-slate-400 cursor-not-allowed" title="PDF file was purged upon rejection">
                       <i data-lucide="file-x" class="w-3.5 h-3.5"></i> File Removed
                     </span>`
              }
              ${
                superAdmin
                  ? `
                <button type="button" data-action="edit-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-semibold bg-indigo-50 hover:bg-indigo-100 text-indigo-700 transition-colors cursor-pointer">
                  <i data-lucide="pencil" class="w-3.5 h-3.5"></i> Edit
                </button>
                <button type="button" data-action="delete-res" data-id="${escapeHTML(item.id)}" class="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-xl text-xs font-semibold text-rose-600 hover:bg-rose-50 border border-rose-200 transition-colors cursor-pointer" title="Delete resource" aria-label="Delete resource">
                  <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
                </button>
              `
                  : ''
              }
            </div>
          </div>
        </div>
      `;
    })
    .join('') || '<p class="text-xs text-slate-400 p-6 text-center">No study materials found for this branch.</p>';

  createIconsIn(container);
}

function openPrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
  }
}

function closePrivacyModal() {
  const modal = document.getElementById('privacy-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }
}

/**
 * Handles manual sync button with honest boolean feedback.
 */
async function handleManualAdminSync(btn) {
  const icon = btn?.querySelector('i, svg');
  if (icon) icon.classList.add('animate-spin');
  try {
    const success = await syncFromSupabase(false);
    if (success) {
      showToast('Portal materials and analytics are up to date.', 'info');
    } else {
      showToast('Unable to sync — check your internet connection.', 'error');
    }
  } catch (err) {
    showToast('Sync failed: ' + (err.message || 'Network error'), 'error');
  } finally {
    if (icon) icon.classList.remove('animate-spin');
  }
}

async function handleClearOfflineCache() {
  const confirmed = await requestConfirmation({
    title: 'Clear Offline PDF Cache?',
    message: 'Remove all locally downloaded PDFs from this device? You can re-open any document anytime when you have an internet connection.',
    confirmLabel: 'Clear Cache',
    variant: 'danger'
  });
  if (!confirmed) return;

  const count = await clearOfflinePdfCache();
  try {
    localStorage.removeItem('kprit_offline_resources_metadata');
  } catch {}
  showToast(`Cleared ${count} offline PDF document${count === 1 ? '' : 's'} from local cache.`);
}

// ----------------------------------------------------------------------------
// 15. GLOBAL DELEGATED EVENT LISTENERS (Zero Inline onclick Handlers)
// ----------------------------------------------------------------------------
function bindGlobalEventListeners() {
  // Fix mobile browser back-button freeze (pageshow re-enables login button)
  window.addEventListener('pageshow', () => {
    const btn = document.getElementById('btn-google-login');
    if (btn) btn.disabled = false;
  });

  // Offline / Online connectivity toasts
  window.addEventListener('offline', () => {
    showToast('You are offline — you can still open your recently opened PDFs.', 'info');
  });

  window.addEventListener('online', () => {
    showToast('Back online — all study materials are available.', 'info');
    syncFromSupabase(false);
  });

  // Delegated click listener across the entire document
  document.addEventListener('click', async (event) => {
    // 1. Modal backdrop dismissal
    const backdropName = event.target?.dataset?.modalBackdrop;
    if (backdropName) {
      if (backdropName === 'privacy') closePrivacyModal();
      else if (backdropName === 'edit-resource') closeEditResourceModal();
      else if (backdropName === 'confirm') resolveConfirmation(false);
      return;
    }

    // 2. Delegated [data-action] buttons
    const trigger = event.target.closest('[data-action]');
    if (!trigger) return;

    const action = trigger.dataset.action;
    const asyncGuardedActions = new Set([
      'google-login',
      'approve-res',
      'reject-res',
      'delete-res',
      'toggle-role',
      'delete-role',
      'admin-sync',
      'clear-offline-cache',
      'logout'
    ]);

    if (asyncGuardedActions.has(action)) {
      if (trigger.dataset.busy === 'true') return;
      trigger.dataset.busy = 'true';
      trigger.disabled = true;
    }

    try {
      switch (action) {
        case 'google-login':
          await signInWithGoogle();
          break;
        case 'logout':
          await logout();
          break;
        case 'open-privacy':
          openPrivacyModal();
          break;
        case 'close-privacy':
          closePrivacyModal();
          break;
        case 'close-edit-resource':
          closeEditResourceModal();
          break;
        case 'admin-view':
          switchAdminView(trigger.dataset.mode || 'dashboard');
          break;
        case 'admin-tab':
          switchAdminTab(trigger.dataset.tab || 'approvals');
          break;
        case 'admin-sync':
          await handleManualAdminSync(trigger);
          break;
        case 'clear-offline-cache':
          await handleClearOfflineCache();
          break;
        case 'filter-year':
          setFilter('year', trigger.dataset.year || '1st Year');
          break;
        case 'filter-subject':
          setFilter('subject', trigger.dataset.subject || 'All');
          break;
        case 'open-reader': {
          const docId = trigger.dataset.id;
          const target = cloudResources.find((r) => String(r.id) === String(docId));
          if (target) await openProtectedReader(target);
          break;
        }
        case 'preview-pending-res': {
          const docId = trigger.dataset.id;
          const target = cloudResources.find((r) => String(r.id) === String(docId));
          if (target) await openProtectedReader(target);
          break;
        }
        case 'approve-res':
          await approvePendingResource(trigger.dataset.id);
          break;
        case 'reject-res':
          await rejectPendingResource(trigger.dataset.id);
          break;
        case 'edit-res':
          openEditResourceModal(trigger.dataset.id);
          break;
        case 'delete-res':
          await deleteResource(trigger.dataset.id);
          break;
        case 'toggle-role':
          await toggleRoleStatus(trigger.dataset.email, trigger.dataset.state === 'true');
          break;
        case 'delete-role':
          await deleteRoleRecord(trigger.dataset.email);
          break;
        case 'export-csv':
          exportAnalyticsCSV();
          break;
        default:
          break;
      }
    } catch (err) {
      console.error('Delegated click error:', err);
      showToast(err.message || 'Action failed', 'error');
    } finally {
      if (asyncGuardedActions.has(action)) {
        trigger.dataset.busy = 'false';
        trigger.disabled = false;
      }
    }
  });

  // Confirmation modal OK & Cancel buttons
  document.getElementById('confirm-modal-ok')?.addEventListener('click', () => {
    resolveConfirmation(true);
  });
  document.getElementById('confirm-modal-cancel')?.addEventListener('click', () => {
    resolveConfirmation(false);
  });

  // Global Escape key handler
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || isReaderOpen()) return;

    const confirmModal = document.getElementById('confirm-modal');
    if (confirmModal && !confirmModal.classList.contains('hidden')) {
      resolveConfirmation(false);
      return;
    }
    const editModal = document.getElementById('edit-resource-modal');
    if (editModal && !editModal.classList.contains('hidden')) {
      closeEditResourceModal();
      return;
    }
    const privacyModal = document.getElementById('privacy-modal');
    if (privacyModal && !privacyModal.classList.contains('hidden')) {
      closePrivacyModal();
    }
  });

  // Filter dropdown listeners
  document.getElementById('dept-filter')?.addEventListener('change', (e) => {
    setFilter('dept', e.target.value);
  });
  document.getElementById('sem-filter')?.addEventListener('change', (e) => {
    setFilter('sem', e.target.value);
  });

  // Admin Resource Library branch filter listener
  document.getElementById('admin-resource-branch-filter')?.addEventListener('change', () => {
    renderAdminResourceManager();
  });

  // Debounced Admin Student Search Input (clean 200ms debounce)
  document.getElementById('admin-student-search')?.addEventListener('input', () => {
    if (adminSearchTimer) clearTimeout(adminSearchTimer);
    adminSearchTimer = setTimeout(() => {
      renderAdminDashboard();
    }, 200);
  });

  // PDF Scan Compression Checkbox auto-toggling & hint updater
  document.getElementById('up-pdf-file')?.addEventListener('change', (event) => {
    const file = event.target.files?.[0];
    updateCompressionSelectionHint(file);
  });

  // Forms
  document.getElementById('upload-resource-form')?.addEventListener('submit', handleAdminUpload);
  document.getElementById('grant-role-form')?.addEventListener('submit', handleGrantRole);
  document.getElementById('edit-resource-form')?.addEventListener('submit', handleSaveEditResource);
}

// ----------------------------------------------------------------------------
// 16. APPLICATION BOOTSTRAP
// ----------------------------------------------------------------------------
function bootstrap() {
  createIconsIn(document.getElementById('boot-loader'));

  initReader({
    sb,
    getSession,
    showToast,
    escapeHTML,
    extractStoragePath,
    createIconsIn,
    onDocumentOpened: (doc) => {
      const session = getSession();
      if (!session || !doc) return;

      if ((doc.status || 'approved') === 'approved') {
        doc.views = (doc.views || 0) + 1;
        if (navigator.onLine) {
          sb.rpc('increment_views', { row_id: doc.id })
            .then(({ error }) => {
              if (error) console.warn('increment_views RPC warning:', error.message);
            })
            .catch(() => {});
        }
      }

      if (session.role === 'student') {
        recordStudentActivity(session.name, session.email, doc.title);
      }

      if (isSuperAdmin(session)) {
        renderAdminDashboard();
      }
    }
  });

  populateDynamicDropdowns();
  bindGlobalEventListeners();

  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'TOKEN_REFRESHED') return;
    applyGoogleSession(session);
  });

  // Safety fallback in case initial auth event is slow
  setTimeout(() => {
    if (!isBootDismissed) {
      sb.auth
        .getSession()
        .then(({ data }) => {
          if (!isBootDismissed) {
            applyGoogleSession(data?.session || null).catch(() => {});
          }
        })
        .catch(() => {
          if (!isBootDismissed) applyGoogleSession(null);
        });
    }
  }, 3500);
}

bootstrap();
