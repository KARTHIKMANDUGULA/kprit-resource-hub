/**
 * ============================================================================
 * KPRIT RESOURCE HUB — PDF READER & OFFLINE CACHE MODULE (reader.js)
 * ============================================================================
 * Owns:
 *  1. IndexedDB LRU PDF Cache (`kprit_pdf_cache`, 150 MB cap, single DB connection)
 *  2. Hybrid PDF loader (60s Supabase signed URLs + allowlisted external HTTPS CDNs)
 *  3. PDF upload validation (rejects corrupted & password-protected PDFs)
 *  4. Native pinch-to-zoom friendly responsive slots with safe GPU pixel cap
 *  5. Dual IntersectionObservers with persistent visibleHeightsMap RAM virtualization
 *  6. 1-click Retry button in reader error UI for weak/offline networks
 *  7. Deferred view counting (triggered ONLY after PDF or text note successfully loads)
 *  8. Text Q&A viewer rendering legacy JSON arrays and plain-text study notes
 */

// ----------------------------------------------------------------------------
// 1. MODULE CONFIGURATION & SHARED DEPENDENCIES
// ----------------------------------------------------------------------------
const PDF_WORKER_URL = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
const IDB_NAME = 'kprit_pdf_cache';
const IDB_STORE = 'pdfs';
const MAX_CACHE_BYTES = 150 * 1024 * 1024; // 150 MB LRU cap
const MAX_SINGLE_CACHE_FILE_BYTES = 45 * 1024 * 1024; // Skip caching single files > 45 MB
const VIRTUALIZATION_KEEP_RADIUS = 3; // Keep active page +/- 3 pages in canvas RAM

// Configure Mozilla PDF.js worker once on module evaluation
if (window.pdfjsLib) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
}

// Injected dependencies from app.js (avoids circular module imports)
let deps = {
  sb: null,
  getSession: () => null,
  showToast: () => {},
  escapeHTML: (s) => String(s ?? ''),
  extractStoragePath: (ref) => ref,
  onDocumentOpened: () => {},
  createIconsIn: () => {}
};

// Active reader state
let activeDoc = null;
let activePdfDoc = null;
let currentRenderId = 0;

// Virtualization trackers
const activeRenderTasks = new Map(); // pageNum -> PDFRenderTask
const renderedPagesSet = new Set();  // Set<number> of currently mounted/rendering pages
const visibleHeightsMap = new Map(); // pageNum -> visibleHeight in viewport
const inFlightDownloads = new Map(); // cacheKey -> Promise<ArrayBuffer>
let pdfRenderObserver = null;
let pdfPageTrackObserver = null;

// Reused single IndexedDB connection promise
let dbPromise = null;

// Debounce state
let resizeRescaleTimer = null;
let lastViewportWidth = window.innerWidth;

// ----------------------------------------------------------------------------
// 2. INDEXEDDB LRU CACHE ENGINE (Reused Connection & Quota Recovery)
// ----------------------------------------------------------------------------

/**
 * Reuses a single IndexedDB connection promise for the cache lifecycle.
 * @returns {Promise<IDBDatabase|null>}
 */
function openPdfCacheDB() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve) => {
      if (!window.indexedDB) {
        resolve(null);
        return;
      }
      try {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (event) => {
          const db = event.target.result;
          if (!db.objectStoreNames.contains(IDB_STORE)) {
            db.createObjectStore(IDB_STORE, { keyPath: 'cacheKey' });
          }
        };
        req.onsuccess = () => {
          const db = req.result;
          db.onclose = () => { dbPromise = null; };
          db.onerror = () => { dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => {
          dbPromise = null;
          resolve(null);
        };
        req.onblocked = () => {
          dbPromise = null;
          resolve(null);
        };
      } catch {
        dbPromise = null;
        resolve(null);
      }
    });
  }
  return dbPromise;
}

/**
 * Retrieves a cached PDF ArrayBuffer by cacheKey and touches its LRU timestamp.
 * @param {string} cacheKey
 * @returns {Promise<ArrayBuffer|null>}
 */
async function getCachedPdfBuffer(cacheKey) {
  try {
    const db = await openPdfCacheDB();
    if (!db) return null;

    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const getReq = store.get(cacheKey);

      getReq.onsuccess = () => {
        const rec = getReq.result;
        if (rec && rec.buffer) {
          rec.lastAccessed = Date.now();
          try {
            store.put(rec);
          } catch {
            // Non-fatal if timestamp touch fails under tight quota
          }
          resolve(rec.buffer.slice(0));
        } else {
          resolve(null);
        }
      };
      getReq.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

/**
 * Helper to fetch all cached records sorted oldest-first (LRU order).
 * Uses an IDB cursor to avoid loading all large binary ArrayBuffers into memory at once.
 * @param {IDBDatabase} db
 * @returns {Promise<Array<{cacheKey: string, size: number, lastAccessed: number}>>}
 */
function getAllCacheRecordsSortedLRU(db) {
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(IDB_STORE, 'readonly');
      const store = tx.objectStore(IDB_STORE);
      const list = [];
      const req = store.openCursor();
      req.onsuccess = (e) => {
        const cursor = e.target.result;
        if (cursor) {
          const val = cursor.value;
          list.push({
            cacheKey: val.cacheKey,
            size: val.size || (val.buffer ? val.buffer.byteLength : 0),
            lastAccessed: val.lastAccessed || 0
          });
          cursor.continue();
        } else {
          list.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
          resolve(list);
        }
      };
      req.onerror = () => resolve([]);
      tx.onabort = () => resolve([]);
    } catch {
      resolve([]);
    }
  });
}

/**
 * Attempts a single IndexedDB transaction to evict keys and write the new entry.
 */
function writeCacheEntryWithEvictions(db, keysToEvict, entry) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    const store = tx.objectStore(IDB_STORE);

    keysToEvict.forEach((k) => store.delete(k));
    store.put(entry);

    tx.oncomplete = () => resolve(true);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    tx.onerror = () => reject(tx.error || new Error('IndexedDB transaction failed'));
  });
}

function isQuotaError(err) {
  if (!err) return false;
  return (
    err.name === 'QuotaExceededError' ||
    err.name === 'NS_ERROR_DOM_QUOTA_REACHED' ||
    err.code === 22 ||
    err.code === 1014 ||
    String(err.message || '').toLowerCase().includes('quota')
  );
}

/**
 * Stores a PDF ArrayBuffer in IndexedDB under a 150 MB LRU cap.
 * If the browser throws QuotaExceededError, iteratively evicts oldest entries (including the final victim) and retries.
 * @param {string} cacheKey
 * @param {ArrayBuffer} arrayBuffer
 */
async function setCachedPdfBuffer(cacheKey, arrayBuffer) {
  try {
    const db = await openPdfCacheDB();
    if (!db || !arrayBuffer) return;

    const sizeBytes = arrayBuffer.byteLength || 0;
    if (sizeBytes <= 0 || sizeBytes > MAX_SINGLE_CACHE_FILE_BYTES) return;

    let records = await getAllCacheRecordsSortedLRU(db);
    records = records.filter((item) => item.cacheKey !== cacheKey);

    let totalBytes = records.reduce((acc, item) => acc + (item.size || 0), 0);
    const initialEvictKeys = [];

    while (records.length > 0 && totalBytes + sizeBytes > MAX_CACHE_BYTES) {
      const oldest = records.shift();
      initialEvictKeys.push(oldest.cacheKey);
      totalBytes -= oldest.size || 0;
    }

    const entry = {
      cacheKey,
      buffer: arrayBuffer,
      size: sizeBytes,
      lastAccessed: Date.now()
    };

    try {
      await writeCacheEntryWithEvictions(db, initialEvictKeys, entry);
      return;
    } catch (writeErr) {
      if (!isQuotaError(writeErr)) {
        console.warn('IndexedDB cache write skipped:', writeErr);
        return;
      }

      // QuotaExceededError recovery: iteratively delete victims and retry
      let remaining = await getAllCacheRecordsSortedLRU(db);
      remaining = remaining.filter((item) => item.cacheKey !== cacheKey);

      while (remaining.length > 0) {
        const victim = remaining.shift();
        await new Promise((res) => {
          const delTx = db.transaction(IDB_STORE, 'readwrite');
          delTx.objectStore(IDB_STORE).delete(victim.cacheKey);
          delTx.oncomplete = () => res();
          delTx.onerror = () => res();
          delTx.onabort = () => res();
        });

        try {
          await writeCacheEntryWithEvictions(db, [], entry);
          return; // Successfully saved
        } catch (retryErr) {
          if (!isQuotaError(retryErr)) {
            console.warn('IndexedDB retry aborted:', retryErr);
            return;
          }
        }
      }
    }
  } catch (err) {
    console.warn('IndexedDB cache error:', err);
  }
}

/**
 * Clears all locally cached PDFs from IndexedDB.
 * @returns {Promise<number>} Number of cached documents cleared
 */
export async function clearOfflinePdfCache() {
  try {
    const db = await openPdfCacheDB();
    if (!db) return 0;

    return await new Promise((resolve) => {
      const tx = db.transaction(IDB_STORE, 'readwrite');
      const store = tx.objectStore(IDB_STORE);
      const countReq = store.count();

      countReq.onsuccess = () => {
        const total = countReq.result || 0;
        const clearReq = store.clear();
        clearReq.onsuccess = () => resolve(total);
        clearReq.onerror = () => resolve(0);
      };
      countReq.onerror = () => resolve(0);
    });
  } catch {
    return 0;
  }
}

// ----------------------------------------------------------------------------
// 3. STORAGE & PDF DOWNLOAD ENGINE
// ----------------------------------------------------------------------------

function isExternalCdnUrl(url) {
  if (!url) return false;
  return /^https:\/\/(cdn\.jsdelivr\.net|raw\.githubusercontent\.com)\//i.test(url);
}

/**
 * Downloads or loads a cached PDF buffer via 60s signed Supabase URL or allowlisted CDN.
 * @param {object} doc
 * @returns {Promise<ArrayBuffer|null>}
 */
async function fetchOrCachePdfBuffer(doc) {
  if (!doc || !doc.pdf_url) return null;

  const isCdn = isExternalCdnUrl(doc.pdf_url);
  const cacheKey = isCdn ? `cdn:${doc.pdf_url}` : `sb:${doc.id}:${deps.extractStoragePath(doc.pdf_url)}`;

  // 1. Try local IndexedDB cache first (already sliced by getCachedPdfBuffer)
  const cached = await getCachedPdfBuffer(cacheKey);
  if (cached) return cached;

  // 2. Deduplicate concurrent downloads for the exact same document
  if (inFlightDownloads.has(cacheKey)) {
    const buf = await inFlightDownloads.get(cacheKey);
    return buf ? buf.slice(0) : null;
  }

  const downloadPromise = (async () => {
    // Determine download URL
    let fetchUrl = null;
    if (isCdn) {
      fetchUrl = doc.pdf_url;
    } else {
      const storagePath = deps.extractStoragePath(doc.pdf_url);
      if (!storagePath) throw new Error('Invalid storage path for document.');

      const { data, error } = await deps.sb.storage
        .from('pdfs')
        .createSignedUrl(storagePath, 60);

      if (error || !data?.signedUrl) {
        throw new Error(error?.message || 'Failed to generate secure temporary download link.');
      }
      fetchUrl = data.signedUrl;
    }

    // Fetch binary stream
    const response = await fetch(fetchUrl, isCdn ? { mode: 'cors' } : {});
    if (!response.ok) {
      throw new Error(`HTTP error ${response.status}: Failed to download PDF.`);
    }

    const arrayBuffer = await response.arrayBuffer();
    if (!arrayBuffer || arrayBuffer.byteLength === 0) {
      throw new Error('Received empty PDF stream from cloud storage.');
    }

    // Save into IndexedDB cache (clone buffer so Web Worker transfer cannot detach it)
    await setCachedPdfBuffer(cacheKey, arrayBuffer.slice(0));

    return arrayBuffer;
  })();

  inFlightDownloads.set(cacheKey, downloadPromise);

  try {
    const resultBuffer = await downloadPromise;
    return resultBuffer ? resultBuffer.slice(0) : null;
  } finally {
    inFlightDownloads.delete(cacheKey);
  }
}

// ----------------------------------------------------------------------------
// 4. PDF UPLOAD VALIDATION HELPER
// ----------------------------------------------------------------------------

/**
 * Validates that a File object is a readable, non-encrypted, valid PDF using PDF.js.
 * @param {File} file
 * @returns {Promise<{numPages: number, buffer: ArrayBuffer}>}
 */
export async function validatePdfFile(file) {
  if (!file) {
    throw new Error('No PDF file selected.');
  }

  const isPdfMime = file.type === 'application/pdf';
  const isPdfExt = /\.pdf$/i.test(file.name || '');
  if (!isPdfMime && !isPdfExt) {
    throw new Error('Invalid file type. Please select a genuine .pdf document.');
  }

  if (!window.pdfjsLib) {
    throw new Error('PDF validation engine is still loading. Please try again.');
  }

  let testPdf = null;
  try {
    const rawBuf = await file.arrayBuffer();
    testPdf = await window.pdfjsLib.getDocument({ data: rawBuf.slice(0) }).promise;

    if (!testPdf || testPdf.numPages < 1) {
      throw new Error('This PDF contains no readable pages.');
    }

    const firstPage = await testPdf.getPage(1);
    firstPage.cleanup();

    return { numPages: testPdf.numPages, buffer: rawBuf };
  } catch (err) {
    if (err && err.name === 'PasswordException') {
      throw new Error('Password-protected PDFs are not allowed. Please unlock the PDF and try again.');
    }
    if (
      err &&
      (err.name === 'InvalidPDFException' ||
        err.name === 'MissingPDFException' ||
        err.name === 'UnexpectedResponseException')
    ) {
      throw new Error('This PDF appears corrupted or unreadable. Please verify the file and try again.');
    }
    throw err;
  } finally {
    if (testPdf) {
      try {
        await testPdf.destroy();
      } catch {}
    }
  }
}

// ----------------------------------------------------------------------------
// 5. RESPONSIVE PDF.JS VIEWER & RAM VIRTUALIZATION
// ----------------------------------------------------------------------------

/**
 * Cancels in-flight tasks and unmounts distant canvases to preserve iOS Safari canvas memory.
 * Never evicts centerPage or any page currently visible in visibleHeightsMap.
 * Includes missing-slot leak guard for renderedPagesSet.
 * @param {number} centerPage
 */
function evictDistantPdfCanvases(centerPage) {
  if (!activePdfDoc) return;

  Array.from(renderedPagesSet).forEach((pageNum) => {
    // Missing-slot leak guard
    const slot = document.getElementById(`pdf-page-slot-${pageNum}`);
    if (!slot) {
      renderedPagesSet.delete(pageNum);
      return;
    }

    // Keep active page +/- keepRadius, AND never evict any page currently visible in viewport
    if (Math.abs(pageNum - centerPage) <= VIRTUALIZATION_KEEP_RADIUS || visibleHeightsMap.has(pageNum)) {
      return;
    }

    // 1. Cancel in-flight task
    const inFlightTask = activeRenderTasks.get(pageNum);
    if (inFlightTask) {
      try {
        inFlightTask.cancel();
      } catch {}
      activeRenderTasks.delete(pageNum);
    }

    // 2. Mark page as evicted
    renderedPagesSet.delete(pageNum);

    // 3. Release canvas GPU memory & restore lightweight placeholder
    slot.querySelectorAll('canvas').forEach((c) => {
      c.width = 0;
      c.height = 0;
      c.remove();
    });

    const placeholder = slot.querySelector('.pdf-page-placeholder');
    if (placeholder) {
      placeholder.classList.remove('hidden');
    }

    // 4. Re-arm IntersectionObserver
    if (pdfRenderObserver) {
      pdfRenderObserver.unobserve(slot);
      pdfRenderObserver.observe(slot);
    }
  });
}

/**
 * Pre-allocates responsive page slots and attaches dual IntersectionObservers.
 * @param {number} renderId
 */
async function setupOrderedPdfSlotsAndLazyRender(renderId) {
  if (!activePdfDoc || renderId !== currentRenderId) return;

  const wrapper = document.getElementById('pdf-canvas-wrapper');
  const viewportEl = document.getElementById('reader-viewport');
  const scrollContainer = document.getElementById('pdf-scroll-container');
  if (!wrapper || !viewportEl) return;

  wrapper.innerHTML = '';
  renderedPagesSet.clear();
  visibleHeightsMap.clear();
  activeRenderTasks.forEach((t) => {
    try {
      t.cancel();
    } catch {}
  });
  activeRenderTasks.clear();

  // Disconnect previous observers
  if (pdfRenderObserver) pdfRenderObserver.disconnect();
  if (pdfPageTrackObserver) pdfPageTrackObserver.disconnect();

  const numPages = activePdfDoc.numPages;

  // Sample Page 1 aspect ratio safely
  let sampleAspect = 1.414;
  let firstPage = null;
  try {
    firstPage = await activePdfDoc.getPage(1);
    if (renderId !== currentRenderId) return;
    const sampleVp = firstPage.getViewport({ scale: 1.0 });
    sampleAspect = sampleVp.height / sampleVp.width;
  } finally {
    if (firstPage) {
      try {
        firstPage.cleanup();
      } catch {}
    }
  }

  const containerWidth = Math.min(scrollContainer?.clientWidth || viewportEl.clientWidth || window.innerWidth, 896);
  const targetSlotWidth = Math.max(260, Math.min(containerWidth - 24, 820));
  const estimatedSlotHeight = Math.floor(targetSlotWidth * sampleAspect);

  const slots = [];
  for (let i = 1; i <= numPages; i++) {
    const slot = document.createElement('div');
    slot.id = `pdf-page-slot-${i}`;
    slot.className = 'pdf-page-slot w-full';
    slot.dataset.page = String(i);
    slot.style.width = `${targetSlotWidth}px`;
    slot.style.minHeight = `${estimatedSlotHeight}px`;

    slot.innerHTML = `
      <div class="pdf-page-placeholder flex flex-col items-center justify-center p-8 text-slate-400 gap-2">
        <div class="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
        <span class="text-[11px] font-semibold text-slate-500">Page ${i}</span>
      </div>
    `;

    wrapper.appendChild(slot);
    slots.push(slot);
  }

  // Observer 1: Lazy loading nearby pages (500px pre-render margin)
  pdfRenderObserver = new IntersectionObserver(
    (entries) => {
      if (renderId !== currentRenderId) return;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        const pNum = parseInt(entry.target.dataset.page, 10);
        if (pNum && !renderedPagesSet.has(pNum)) {
          renderSinglePdfPageSlot(pNum, renderId);
        }
      });
    },
    {
      root: viewportEl,
      rootMargin: '500px 0px',
      threshold: 0.01
    }
  );

  // Observer 2: Visible height tracker using persistent visibleHeightsMap
  pdfPageTrackObserver = new IntersectionObserver(
    (entries) => {
      if (renderId !== currentRenderId) return;

      entries.forEach((entry) => {
        const pNum = parseInt(entry.target.dataset.page, 10);
        if (!pNum) return;

        if (entry.isIntersecting) {
          const visibleHeight = entry.intersectionRect ? entry.intersectionRect.height : 0;
          visibleHeightsMap.set(pNum, visibleHeight);
        } else {
          visibleHeightsMap.delete(pNum);
        }
      });

      // Find the page currently occupying the most vertical space in the viewport
      let bestPage = null;
      let maxVisibleHeight = 0;
      for (const [pNum, h] of visibleHeightsMap.entries()) {
        if (h > maxVisibleHeight) {
          maxVisibleHeight = h;
          bestPage = pNum;
        }
      }

      if (bestPage) {
        // Ensure visible page and neighbors are rendered
        if (!renderedPagesSet.has(bestPage)) {
          renderSinglePdfPageSlot(bestPage, renderId);
        }
        if (bestPage + 1 <= numPages && !renderedPagesSet.has(bestPage + 1)) {
          renderSinglePdfPageSlot(bestPage + 1, renderId);
        }
        if (bestPage - 1 >= 1 && !renderedPagesSet.has(bestPage - 1)) {
          renderSinglePdfPageSlot(bestPage - 1, renderId);
        }

        evictDistantPdfCanvases(bestPage);
      }
    },
    {
      root: viewportEl,
      rootMargin: '0px',
      threshold: [0.01, 0.1, 0.25, 0.5, 0.75]
    }
  );

  slots.forEach((slot) => {
    pdfRenderObserver.observe(slot);
    pdfPageTrackObserver.observe(slot);
  });
}

/**
 * Renders a single PDF page into its allocated slot with high sharpness and safe GPU pixel cap.
 * @param {number} pageNum
 * @param {number} renderId
 */
async function renderSinglePdfPageSlot(pageNum, renderId) {
  if (!activePdfDoc || renderId !== currentRenderId || renderedPagesSet.has(pageNum)) {
    return;
  }

  // Missing-slot leak guard
  const slot = document.getElementById(`pdf-page-slot-${pageNum}`);
  if (!slot) {
    renderedPagesSet.delete(pageNum);
    return;
  }

  renderedPagesSet.add(pageNum);

  let page = null;
  try {
    page = await activePdfDoc.getPage(pageNum);
    if (renderId !== currentRenderId || !renderedPagesSet.has(pageNum)) {
      if (page) page.cleanup();
      return;
    }

    const unscaledVp = page.getViewport({ scale: 1.0 });
    const scrollContainer = document.getElementById('pdf-scroll-container') || document.getElementById('reader-viewport');
    const containerWidth = Math.min(scrollContainer?.clientWidth || window.innerWidth, 896);
    const fitWidth = Math.max(260, Math.min(containerWidth - 24, 820));
    const fitScale = fitWidth / unscaledVp.width;

    // High mobile sharpness with safe GPU canvas pixel cap for iOS Safari
    const dpr = Math.min(window.devicePixelRatio || 1, 2.0);
    let renderScale = fitScale * dpr;

    // GPU cap: ensure canvas pixels do not exceed 3,500,000 (~3.5M pixels)
    const MAX_CANVAS_PIXELS = 3_500_000;
    if (unscaledVp.width * renderScale * unscaledVp.height * renderScale > MAX_CANVAS_PIXELS) {
      renderScale = Math.sqrt(MAX_CANVAS_PIXELS / (unscaledVp.width * unscaledVp.height));
    }

    const canvasWidth = Math.floor(unscaledVp.width * renderScale);
    const canvasHeight = Math.floor(unscaledVp.height * renderScale);
    const cssWidth = Math.floor(unscaledVp.width * fitScale);
    const cssHeight = Math.floor(unscaledVp.height * fitScale);

    slot.style.width = `${cssWidth}px`;
    slot.style.minHeight = `${cssHeight}px`;

    const canvas = document.createElement('canvas');
    canvas.width = canvasWidth;
    canvas.height = canvasHeight;
    canvas.style.width = `${cssWidth}px`;
    canvas.style.height = `${cssHeight}px`;

    const ctx = canvas.getContext('2d', { alpha: false });
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvasWidth, canvasHeight);

    const renderVp = page.getViewport({ scale: renderScale });
    const renderTask = page.render({
      canvasContext: ctx,
      viewport: renderVp
    });

    activeRenderTasks.set(pageNum, renderTask);
    await renderTask.promise;

    if (renderId !== currentRenderId || !renderedPagesSet.has(pageNum)) {
      canvas.width = 0;
      canvas.height = 0;
      return;
    }

    activeRenderTasks.delete(pageNum);

    // Hide placeholder and append canvas
    const placeholder = slot.querySelector('.pdf-page-placeholder');
    if (placeholder) placeholder.classList.add('hidden');
    slot.querySelectorAll('canvas').forEach((c) => c.remove());
    slot.appendChild(canvas);
  } catch (err) {
    activeRenderTasks.delete(pageNum);
    if (err?.name === 'RenderingCancelledException') {
      renderedPagesSet.delete(pageNum);
      return;
    }
    console.warn(`Error rendering page ${pageNum}:`, err);
    renderedPagesSet.delete(pageNum);
  } finally {
    if (page) {
      try {
        page.cleanup();
      } catch {}
    }
  }
}

// ----------------------------------------------------------------------------
// 6. PUBLIC IN-BROWSER READER CONTROLS
// ----------------------------------------------------------------------------

/**
 * Opens document in the reader modal (PDF.js viewer or Text Q&A viewer).
 * Defers view counting until the document successfully loads.
 * @param {object} doc
 */
export async function openProtectedReader(doc) {
  if (!doc) return;

  activeDoc = doc;
  const myRenderId = ++currentRenderId;

  // Clean previous viewer state
  if (pdfRenderObserver) {
    pdfRenderObserver.disconnect();
    pdfRenderObserver = null;
  }
  if (pdfPageTrackObserver) {
    pdfPageTrackObserver.disconnect();
    pdfPageTrackObserver = null;
  }

  if (activePdfDoc) {
    try {
      await activePdfDoc.destroy();
    } catch {}
    activePdfDoc = null;
    if (myRenderId !== currentRenderId) return;
  }
  activeRenderTasks.forEach((t) => {
    try { t.cancel(); } catch {}
  });
  activeRenderTasks.clear();
  renderedPagesSet.clear();
  visibleHeightsMap.clear();

  // Populate modal header
  const titleEl = document.getElementById('reader-doc-title');
  const metaEl = document.getElementById('reader-doc-meta');
  const paperTitleEl = document.getElementById('paper-title');
  const paperBadgeEl = document.getElementById('paper-badge');

  if (titleEl) titleEl.textContent = doc.title;
  if (metaEl) metaEl.textContent = `${doc.year} • ${doc.dept} • ${doc.sem} • ${doc.subject}`;
  if (paperTitleEl) paperTitleEl.textContent = `${doc.subject}: ${doc.title}`;
  if (paperBadgeEl) paperBadgeEl.textContent = doc.type;

  const bodyContainer = document.getElementById('reader-body-content');
  const viewportEl = document.getElementById('reader-viewport');
  const modal = document.getElementById('reader-modal');

  if (viewportEl) viewportEl.scrollTop = 0;
  if (modal) {
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    deps.createIconsIn(modal);
  }

  if (doc.pdf_url) {
    bodyContainer.innerHTML = `
      <div id="pdf-loading-msg" class="text-center py-12 text-xs font-semibold text-indigo-600 flex flex-col items-center justify-center gap-3">
        <div class="w-8 h-8 border-[3px] border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
        <span>Loading PDF document...</span>
      </div>
      <div id="pdf-scroll-container">
        <div id="pdf-canvas-wrapper"></div>
      </div>
    `;

    try {
      if (!window.pdfjsLib) {
        throw new Error('PDF viewer library failed to load. Please refresh the page and try again.');
      }
      const buffer = await fetchOrCachePdfBuffer(doc);
      if (myRenderId !== currentRenderId) return;
      if (!buffer) {
        throw new Error('Unable to download PDF stream from storage.');
      }

      const loadedPdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;
      if (myRenderId !== currentRenderId) {
        await loadedPdf.destroy().catch(() => {});
        return;
      }

      activePdfDoc = loadedPdf;

      const loadingMsg = document.getElementById('pdf-loading-msg');
      if (loadingMsg) loadingMsg.remove();

      await setupOrderedPdfSlotsAndLazyRender(myRenderId);

      // Deferred view counting: count ONLY after successful PDF load
      deps.onDocumentOpened(doc);
    } catch (err) {
      if (myRenderId !== currentRenderId) return;
      bodyContainer.innerHTML = `
        <div class="p-6 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex flex-col sm:flex-row items-center justify-between gap-4">
          <div>
            <p class="font-bold text-sm text-rose-900 mb-1">Could not display PDF document</p>
            <p class="text-rose-700">${deps.escapeHTML(err.message || 'Unable to open file.')}</p>
          </div>
          <button type="button" data-reader-action="retry" class="px-4 py-2 rounded-xl text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white shadow-sm shrink-0 cursor-pointer">
            Retry
          </button>
        </div>
      `;
    }
  } else {
    // Immediate view counting for text-only notes
    deps.onDocumentOpened(doc);

    // Formatted Q&A or plain text study notes
    let parsedBlocks = null;
    if (doc.raw_text) {
      try {
        const candidate = JSON.parse(doc.raw_text);
        if (Array.isArray(candidate)) parsedBlocks = candidate;
      } catch {
        // Plain text fallback
      }
    }

    if (parsedBlocks) {
      bodyContainer.innerHTML = parsedBlocks
        .map(
          (block) => `
          <div class="p-5 rounded-2xl bg-slate-50 border border-slate-200/80">
            <h4 class="font-bold text-slate-900 text-base mb-2.5">${deps.escapeHTML(block.q || block.question || '')}</h4>
            <div class="text-sm text-slate-700 whitespace-pre-line leading-relaxed">${deps.escapeHTML(block.a || block.answer || '')}</div>
          </div>
        `
        )
        .join('');
    } else {
      bodyContainer.innerHTML = `
        <div class="p-5 rounded-2xl bg-slate-50 border border-slate-200/80 whitespace-pre-line text-sm text-slate-800 leading-relaxed">
          ${deps.escapeHTML(doc.raw_text || 'No text content provided.')}
        </div>
      `;
    }
  }
}

/**
 * Closes reader modal and tears down memory resources cleanly.
 */
export async function closeReaderModal() {
  currentRenderId++;

  if (activePdfDoc) {
    try {
      await activePdfDoc.destroy();
    } catch {}
    activePdfDoc = null;
  }

  activeRenderTasks.forEach((t) => {
    try { t.cancel(); } catch {}
  });
  activeRenderTasks.clear();
  renderedPagesSet.clear();
  visibleHeightsMap.clear();

  if (pdfRenderObserver) {
    pdfRenderObserver.disconnect();
    pdfRenderObserver = null;
  }
  if (pdfPageTrackObserver) {
    pdfPageTrackObserver.disconnect();
    pdfPageTrackObserver = null;
  }

  const modal = document.getElementById('reader-modal');
  if (modal) {
    modal.classList.add('hidden');
    modal.classList.remove('flex');
  }

  const bodyContainer = document.getElementById('reader-body-content');
  if (bodyContainer) {
    bodyContainer.querySelectorAll('canvas').forEach((c) => {
      c.width = 0;
      c.height = 0;
    });
    bodyContainer.innerHTML = '';
  }

  activeDoc = null;
}

export function isReaderOpen() {
  const modal = document.getElementById('reader-modal');
  return Boolean(modal && !modal.classList.contains('hidden'));
}

// ----------------------------------------------------------------------------
// 7. MODULE INITIALIZER & EVENT BINDINGS
// ----------------------------------------------------------------------------

export function initReader(config) {
  deps = { ...deps, ...config };

  const readerModal = document.getElementById('reader-modal');

  // Delegated click handler for reader actions (close & 1-click retry)
  if (readerModal) {
    readerModal.addEventListener('click', (event) => {
      const btn = event.target.closest('[data-reader-action]');
      if (!btn) return;

      const action = btn.dataset.readerAction;
      if (action === 'close') {
        closeReaderModal();
      } else if (action === 'retry') {
        if (activeDoc) {
          openProtectedReader(activeDoc);
        }
      }
    });
  }

  // Keyboard shortcut: Escape closes reader modal
  document.addEventListener('keydown', (event) => {
    if (!isReaderOpen()) return;
    if (event.key === 'Escape') {
      closeReaderModal();
    }
  });

  // Responsive resize handler with width check
  window.addEventListener('resize', () => {
    if (!activePdfDoc || !isReaderOpen()) return;
    const currentWidth = window.innerWidth;
    if (Math.abs(currentWidth - lastViewportWidth) < 16) return;
    lastViewportWidth = currentWidth;

    if (resizeRescaleTimer) clearTimeout(resizeRescaleTimer);
    resizeRescaleTimer = setTimeout(() => {
      resizeRescaleTimer = null;
      if (activePdfDoc && isReaderOpen()) {
        setupOrderedPdfSlotsAndLazyRender(currentRenderId);
      }
    }, 250);
  });
}
