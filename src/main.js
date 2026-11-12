import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

/* ================= Konfigurasi ================= */
const CORE_VERSION = '0.12.10'; // single-thread (@ffmpeg/core, bukan core-mt)
const CORE_SOURCES = [
  `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
  `https://unpkg.com/@ffmpeg/core@${CORE_VERSION}/dist/esm`,
];
const MAX_SIZE_MB = 100;
const MAX_DURATION_SEC = 120;
const ALLOWED_EXT = ['mp4', 'm4v', 'mov', 'webm', 'mkv', '3gp'];
const ALLOWED_TYPES = [
  'video/mp4', 'video/x-m4v', 'video/quicktime',
  'video/webm', 'video/x-matroska', 'video/3gpp',
];
const DEFAULTS = { sharpen: 0.8, denoise: 3, brightness: 0, contrast: 100 };

/* ================= Elemen & state ================= */
const els = Object.fromEntries(
  [...document.querySelectorAll('[id]')].map((n) => [n.id, n])
);

let ffmpeg = null;
let coreURLs = null;
let currentFile = null;
let currentExt = 'mp4';
let currentMeta = null;
let originalURL = null;
let resultURL = null;
let busy = false;
let cancelled = false;
let wakeLock = null;
let lastPct = 0;
let logLines = [];
const supported = typeof WebAssembly === 'object' && typeof Worker === 'function';

/* ================= Util ================= */
const formatBytes = (b) =>
  b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB';

const formatDuration = (s) => {
  const t = Math.round(s);
  return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}`;
};

function showError(msg) {
  els.errorBox.textContent = msg;
  els.errorBox.hidden = false;
}
function clearError() {
  els.errorBox.hidden = true;
  els.errorBox.textContent = '';
}

function setProgress(pct, text) {
  const v = Math.max(0, Math.min(100, Math.round(pct)));
  els.progressFill.style.width = v + '%';
  els.progressPct.textContent = v + '%';
  els.bar.setAttribute('aria-valuenow', v);
  if (text) els.statusText.textContent = text;
  lastPct = v;
}

function setBusy(state) {
  busy = state;
  els.startBtn.disabled = state || !currentFile;
  els.cancelBtn.hidden = !state;
  els.settings.disabled = state;
  els.fileInput.disabled = state;
  els.dropzone.classList.toggle('disabled', state);
  els.progressWrap.hidden = !state && els.progressWrap.dataset.keep !== '1';
}

function updateLabels() {
  els.sharpenVal.textContent = Number(els.sharpen.value).toFixed(1);
  els.denoiseVal.textContent = els.denoise.value;
  const b = Number(els.brightness.value);
  els.brightnessVal.textContent = (b > 0 ? '+' : '') + b;
  els.contrastVal.textContent = els.contrast.value + '%';
}

async function acquireWakeLock() {
  try {
    if ('wakeLock' in navigator) wakeLock = await navigator.wakeLock.request('screen');
  } catch { /* abaikan */ }
}
function releaseWakeLock() {
  try { wakeLock?.release(); } catch { /* abaikan */ }
  wakeLock = null;
}

/* ================= Upload & validasi ================= */
function readMetadata(url) {
  return new Promise((resolve) => {
    const v = document.createElement('video');
    let timer;
    const done = (r) => {
      clearTimeout(timer);
      v.removeAttribute('src');
      v.load();
      resolve(r);
    };
    timer = setTimeout(() => done(null), 8000);
    v.preload = 'metadata';
    v.muted = true;
    v.playsInline = true;
    v.onloadedmetadata = () =>
      done({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
    v.onerror = () => done(null);
    v.src = url;
  });
}

function rejectFile(msg) {
  currentFile = null;
  currentMeta = null;
  if (originalURL) URL.revokeObjectURL(originalURL);
  originalURL = null;
  els.originalVideo.removeAttribute('src');
  els.originalVideo.load();
  els.originalWrap.hidden = true;
  els.fileInput.value = '';
  els.startBtn.disabled = true;
  showError(msg);
}

function resetResult() {
  els.resultVideo.pause();
  els.resultVideo.removeAttribute('src');
  els.resultVideo.load();
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = null;
  els.downloadBtn.removeAttribute('href');
  els.resultCard.hidden = true;
  els.progressWrap.dataset.keep = '0';
  els.progressWrap.hidden = true;
}

async function handleFile(file) {
  if (busy || !file) return;
  clearError();
  resetResult();

  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const okExt = ALLOWED_EXT.includes(ext);

  if (!okExt && !ALLOWED_TYPES.includes(file.type)) {
    return rejectFile('Format video tidak didukung. Gunakan MP4, MOV, M4V, WebM, MKV, atau 3GP.');
  }
  if (file.size === 0) {
    return rejectFile('File video kosong atau rusak. Coba pilih video lain.');
  }
  if (file.size > MAX_SIZE_MB * 1048576) {
    return rejectFile(
      `Ukuran video ${formatBytes(file.size)} terlalu besar. Maksimal ${MAX_SIZE_MB} MB agar memori HP tidak habis.`
    );
  }

  const url = URL.createObjectURL(file);
  const meta = await readMetadata(url);

  if (meta && Number.isFinite(meta.duration) && meta.duration > MAX_DURATION_SEC) {
    URL.revokeObjectURL(url);
    return rejectFile(
      `Durasi video ${formatDuration(meta.duration)} terlalu panjang. Maksimal ${formatDuration(MAX_DURATION_SEC)} menit. Potong video terlebih dahulu.`
    );
  }

  if (originalURL) URL.revokeObjectURL(originalURL);
  originalURL = url;
  currentFile = file;
  currentExt = okExt ? ext : 'mp4';
  currentMeta = meta;

  els.originalVideo.src = url;
  els.originalWrap.hidden = false;
  els.fileInfo.textContent = meta
    ? `${file.name} • ${formatBytes(file.size)} • ${formatDuration(meta.duration)} • ${meta.width}×${meta.height}`
    : `${file.name} • ${formatBytes(file.size)} • Pratinjau tidak tersedia di browser ini, tetapi proses tetap bisa dicoba.`;
  els.startBtn.disabled = !supported;
}

/* ================= FFmpeg ================= */
async function fetchCoreURLs() {
  let lastErr;
  for (const base of CORE_SOURCES) {
    try {
      const [coreURL, wasmURL] = await Promise.all([
        toBlobURL(`${base}/ffmpeg-core.js`, 'text/javascript'),
        toBlobURL(`${base}/ffmpeg-core.wasm`, 'application/wasm'),
      ]);
      return { coreURL, wasmURL };
    } catch (e) {
      lastErr = e;
    }
  }
  console.error(lastErr);
  throw new Error('ENGINE_DOWNLOAD');
}

function buildFilters(targetH) {
  const f = [];

  const dn = Number(els.denoise.value);
  if (dn > 0) {
    const n = (x) => (dn * x).toFixed(1);
    f.push(`hqdn3d=${n(0.6)}:${n(0.45)}:${n(0.9)}:${n(0.7)}`);
  }

  const portrait = currentMeta && currentMeta.height > currentMeta.width;
  f.push(
    portrait
      ? `scale=${targetH}:-2:flags=lanczos`
      : `scale=-2:${targetH}:flags=lanczos`
  );

  const sh = Number(els.sharpen.value);
  if (sh > 0) f.push(`unsharp=5:5:${sh.toFixed(1)}:5:5:0`);

  const br = Number(els.brightness.value) / 100;
  const ct = Number(els.contrast.value) / 100;
  if (br !== 0 || ct !== 1) f.push(`eq=brightness=${br.toFixed(2)}:contrast=${ct.toFixed(2)}`);

  return f.join(',');
}

function friendlyError(err) {
  const msg = String(err?.message || err || '');
  if (cancelled) return null;
  if (msg === 'ENGINE_DOWNLOAD')
    return 'Gagal mengunduh mesin FFmpeg. Periksa koneksi internet lalu coba lagi.';
  if (/memory|out of bounds|abort|alloc|oom/i.test(msg))
    return 'Memori HP tidak cukup. Coba resolusi 480p atau 720p, gunakan video lebih pendek, dan tutup aplikasi lain.';
  if (msg === 'FFMPEG_FAILED')
    return 'Video tidak dapat diproses. File mungkin rusak atau kodeknya tidak didukung. Coba video lain (disarankan MP4/H.264).';
  if (msg === 'EMPTY_OUTPUT')
    return 'Proses selesai tetapi hasil kosong. Coba lagi dengan pengaturan berbeda atau video lain.';
  return 'Terjadi kesalahan saat memproses video. Coba lagi dengan resolusi lebih rendah atau video yang lebih pendek.';
}

function showResult(blob, targetH, baseName) {
  if (resultURL) URL.revokeObjectURL(resultURL);
  resultURL = URL.createObjectURL(blob);
  els.resultVideo.src = resultURL;
  els.downloadBtn.href = resultURL;
  els.downloadBtn.download = `${baseName}_enhanced_${targetH}p.mp4`;
  els.resultInfo.textContent =
    `Output ${targetH}p • ${formatBytes(blob.size)} (asli ${formatBytes(currentFile.size)})`;
  els.resultCard.hidden = false;
  els.resultCard.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function startEnhancement() {
  if (busy || !currentFile || !supported) return;

  clearError();
  resetResult();
  cancelled = false;
  logLines = [];
  els.progressWrap.dataset.keep = '1';
  setBusy(true);
  setProgress(1, 'Menyiapkan mesin FFmpeg (unduhan pertama ±31 MB)…');

  const inName = `input.${currentExt}`;
  const outName = 'output.mp4';
  const targetH = Number(document.querySelector('input[name="res"]:checked').value);
  const baseName =
    currentFile.name.replace(/\.[^.]+$/, '').replace(/[^\w-]+/g, '_').slice(0, 40) || 'video';

  const engine = new FFmpeg();
  ffmpeg = engine;
  engine.on('log', ({ message }) => {
    logLines.push(message);
    if (logLines.length > 40) logLines.shift();
  });
  engine.on('progress', ({ progress }) => {
    if (!Number.isFinite(progress)) return;
    const p = Math.min(Math.max(progress, 0), 1);
    const pct = 10 + p * 85;
    if (pct > lastPct) setProgress(pct, 'Meningkatkan kualitas video…');
  });

  try {
    await acquireWakeLock();

    if (!coreURLs) coreURLs = await fetchCoreURLs();
    if (cancelled) throw new Error('CANCELLED');
    await engine.load(coreURLs);

    setProgress(8, 'Membaca video…');
    await engine.writeFile(inName, await fetchFile(currentFile));

    setProgress(10, 'Meningkatkan kualitas video…');
    const code = await engine.exec([
      '-i', inName,
      '-vf', buildFilters(targetH),
      '-map', '0:v:0',
      '-map', '0:a:0?',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '23',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-movflags', '+faststart',
      '-y', outName,
    ]);
    if (code !== 0) throw new Error('FFMPEG_FAILED');

    setProgress(97, 'Menyimpan hasil…');
    const data = await engine.readFile(outName);
    if (!data || data.length === 0) throw new Error('EMPTY_OUTPUT');

    showResult(new Blob([data], { type: 'video/mp4' }), targetH, baseName);
    setProgress(100, 'Selesai! 🎉');
  } catch (err) {
    console.error(err, logLines.join('\n'));
    const msg = friendlyError(err);
    if (msg) showError(msg);
    else els.progressWrap.hidden = true;
    if (msg) els.progressWrap.hidden = true;
    els.progressWrap.dataset.keep = '0';
  } finally {
    // Bersihkan file sementara & bebaskan memori WASM
    if (!cancelled) {
      for (const name of [inName, outName]) {
        try { await engine.deleteFile(name); } catch { /* abaikan */ }
      }
      try { engine.terminate(); } catch { /* abaikan */ }
    }
    if (ffmpeg === engine) ffmpeg = null;
    releaseWakeLock();
    setBusy(false);
  }
}

function cancelEnhancement() {
  if (!busy) return;
  cancelled = true;
  if (ffmpeg) {
    try { ffmpeg.terminate(); } catch { /* abaikan */ }
    ffmpeg = null;
  }
  els.statusText.textContent = 'Dibatalkan.';
}

/* ================= Event ================= */
els.fileInput.addEventListener('change', (e) => handleFile(e.target.files[0]));

['dragenter', 'dragover'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('drag');
  })
);
['dragleave', 'drop'].forEach((ev) =>
  els.dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('drag');
  })
);
els.dropzone.addEventListener('drop', (e) => handleFile(e.dataTransfer.files[0]));

['sharpen', 'denoise', 'brightness', 'contrast'].forEach((k) =>
  els[k].addEventListener('input', updateLabels)
);

els.resetBtn.addEventListener('click', () => {
  Object.entries(DEFAULTS).forEach(([k, v]) => (els[k].value = v));
  document.querySelector('input[name="res"][value="720"]').checked = true;
  updateLabels();
});

els.startBtn.addEventListener('click', startEnhancement);
els.cancelBtn.addEventListener('click', cancelEnhancement);

window.addEventListener('beforeunload', (e) => {
  if (busy) {
    e.preventDefault();
    e.returnValue = '';
  }
});

/* ================= Init ================= */
els.limitHint.textContent =
  `MP4, MOV, WebM, MKV, 3GP • maks ${MAX_SIZE_MB} MB • maks ${formatDuration(MAX_DURATION_SEC)} menit`;
updateLabels();

if (!supported) {
  showError('Browser Anda tidak mendukung WebAssembly. Gunakan Chrome versi terbaru di Android.');
  els.fileInput.disabled = true;
}
