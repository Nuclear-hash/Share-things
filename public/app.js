(function () {
  'use strict';

  const MAX_FILES = 10;
  const MAX_FILE_BYTES = 5000000000;
  const MAX_TOTAL_BYTES = 5000000000;
  const ZIP_MIN_BYTES = 40000000;
  const ZIP_MAX_BYTES = 64000000;
  const PRECOMPRESSED_RE =
    /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|ogv|mpg|mpeg|jpg|jpeg|png|webp|heic|heif|avif|gif|mp3|aac|m4a|ogg|opus|zip|gz|tgz|rar|7z|bz2|xz|pdf|docx|xlsx|pptx|apk|dmg)$/i;
  const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|ogv|mpg|mpeg)$/i;

  const app = document.getElementById('app');
  const state = { files: [], busy: false, timers: [] };

  /* ---------------- helpers ---------------- */

  function esc(value) {
    return String(value).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
    }[c]));
  }

  // Decimal units, matching the limits and the way Windows reports file sizes.
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1000) return bytes + ' B';
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1000;
    let i = 0;
    while (value >= 1000 && i < units.length - 1) {
      value /= 1000;
      i += 1;
    }
    const shown = value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
    return shown + ' ' + units[i];
  }

  function isVideo(name, type) {
    return /^video\//i.test(type || '') || VIDEO_NAME_RE.test(name);
  }

  function deliveredName(file) {
    return file.zipped ? file.name + '.zip' : file.name;
  }

  function fileTag(name) {
    const match = /\.([a-z0-9]{1,5})$/i.exec(name || '');
    return match ? match[1].toUpperCase() : 'FILE';
  }

  function describeRemaining(ms) {
    if (ms <= 0) return 'expired';
    if (ms < 60000) return 'under a minute left';
    return Math.round(ms / 60000) + ' min left';
  }

  function zipPlan(file) {
    if (file.size < ZIP_MIN_BYTES) return '';
    if (file.size > ZIP_MAX_BYTES) return 'sent exactly as-is';
    if (PRECOMPRESSED_RE.test(file.name)) return 'sent exactly as-is';
    return 'zipped if that makes it smaller';
  }

  function totalSelectedBytes() {
    return state.files.reduce((sum, file) => sum + file.size, 0);
  }

  function clearTimers() {
    state.timers.forEach((timer) => clearInterval(timer));
    state.timers = [];
  }

  function startCountdown(el, expiresAt, onExpire) {
    if (!el) return;
    let timer = null;
    const tick = () => {
      const ms = expiresAt - Date.now();
      el.textContent = describeRemaining(ms);
      el.classList.toggle('is-urgent', ms > 0 && ms <= 120000);
      if (ms <= 0) {
        if (timer) clearInterval(timer);
        state.timers = state.timers.filter((item) => item !== timer);
        if (typeof onExpire === 'function') onExpire();
      }
    };
    timer = setInterval(tick, 1000);
    state.timers.push(timer);
    tick();
  }

  /* ---------------- network ---------------- */

  async function postJson(path, payload) {
    const response = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload || {}),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'That did not go through. Try again.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function putChunk(uploadId, index, blob, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', `/api/uploads/${uploadId}/chunks/${index}`);
      xhr.setRequestHeader('content-type', 'application/octet-stream');
      xhr.upload.addEventListener('progress', (event) => {
        if (event.lengthComputable && onProgress) onProgress(event.loaded);
      });
      xhr.addEventListener('load', () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          resolve();
          return;
        }
        let message = 'A part of the file did not arrive. Try again.';
        try {
          const data = JSON.parse(xhr.responseText);
          if (data && data.error) message = data.error;
        } catch {
          /* keep the generic message */
        }
        reject(new Error(message));
      });
      xhr.addEventListener('error', () => reject(new Error('The connection dropped. Try again.')));
      xhr.send(blob);
    });
  }

  /* ---------------- home ---------------- */

  function renderHome() {
    document.title = 'Ferry — send it across in ten minutes';
    clearTimers();
    state.busy = false;
    state.files = [];

    app.innerHTML = `
      <section class="hero rise">
        <p class="eyebrow">Ten minute file ferry</p>
        <h1>Anything under 5 GB,<br /><em>across in one trip.</em></h1>
        <p class="lede">
          Documents, photos, or a whole movie. Send it, share the link or the QR code,
          and it is deleted ten minutes later — or the moment the other side says they have it.
        </p>
        <ul class="facts">
          <li><strong>10</strong><span>files per handoff</span></li>
          <li><strong>5 GB</strong><span>per handoff</span></li>
          <li><strong>5 GB</strong><span>shared by everyone</span></li>
        </ul>
        <button class="btn btn-ghost hero-link" id="open-send-guide" type="button">
          See what you can send →
        </button>
      </section>

      <section class="card upload-card rise" style="animation-delay:80ms">
        <div class="dropzone" id="dropzone" role="button" tabindex="0" aria-label="Add files to send">
          <span class="dz-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M12 16V4" /><path d="m7 9 5-5 5 5" /><path d="M4 16v2.5A1.5 1.5 0 0 0 5.5 20h13a1.5 1.5 0 0 0 1.5-1.5V16" />
            </svg>
          </span>
          <p class="dz-title">Drop files here, or <u>browse</u></p>
          <p class="dz-hint">
            Up to ${MAX_FILES} files and 5 GB per handoff, so a full-length movie is fine.
            Nothing is re-encoded: whoever receives it gets exactly the bytes you sent, at the
            same size and quality. Only files between 40 and 64 MB are zipped on the way, and
            that zip unpacks to the identical file.
          </p>
          <input type="file" id="file-input" multiple hidden />
        </div>

        <ul class="file-list" id="file-list" hidden></ul>

        <div class="actions">
          <p class="note">
            The link works for ten minutes. One handoff can carry up to 5 GB, and the site keeps
            5 GB in total — if the space is taken you get a place in line instead of an error.
          </p>
          <button class="btn btn-primary" id="upload-btn" type="button" disabled>Send it</button>
        </div>

        <div class="progress" id="progress" hidden>
          <ul class="upload-list" id="upload-list"></ul>
          <p class="queue-note" id="queue-note" hidden></p>
        </div>

        <p class="alert" id="upload-error" hidden></p>
      </section>

      <section class="how">
        <div class="how-step">
          <span class="step-num">01</span>
          <h2>Send it</h2>
          <p>Anything from a PDF to a 5 GB movie, sent in 16 MB pieces so it survives a flaky connection.</p>
        </div>
        <div class="how-step">
          <span class="step-num">02</span>
          <h2>Share the code</h2>
          <p>A short link and a QR code. No account on either end, no app to install.</p>
        </div>
        <div class="how-step">
          <span class="step-num">03</span>
          <h2>Gone when acknowledged</h2>
          <p>The receiver taps “got it” and the files disappear right then. Otherwise they go in ten minutes.</p>
        </div>
      </section>

      <div class="modal-backdrop" id="send-guide" hidden>
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="send-guide-title">
          <div class="modal-head">
            <div>
              <p class="eyebrow">What you can send</p>
              <h2 id="send-guide-title">Almost any file you already have</h2>
            </div>
            <button class="icon-btn modal-close" id="send-guide-close" type="button" aria-label="Close">✕</button>
          </div>

          <ul class="send-grid">
            <li class="send-item">
              <span class="send-dot dot-music" aria-hidden="true"></span>
              <p class="send-name">Music</p>
              <p class="send-types">mp3 · wav · flac · m4a · aac · ogg · opus</p>
            </li>
            <li class="send-item">
              <span class="send-dot dot-video" aria-hidden="true"></span>
              <p class="send-name">Movies &amp; video</p>
              <p class="send-types">mp4 · mkv · mov · webm · avi · m4v · mp4 clips</p>
            </li>
            <li class="send-item">
              <span class="send-dot dot-photo" aria-hidden="true"></span>
              <p class="send-name">Pictures</p>
              <p class="send-types">jpg · png · heic · webp · gif · raw · psd</p>
            </li>
            <li class="send-item">
              <span class="send-dot dot-doc" aria-hidden="true"></span>
              <p class="send-name">Documents</p>
              <p class="send-types">pdf · docx · xlsx · pptx · txt · csv · epub</p>
            </li>
            <li class="send-item">
              <span class="send-dot dot-code" aria-hidden="true"></span>
              <p class="send-name">Code &amp; design</p>
              <p class="send-types">zip · 7z · rar · fig · ai · sketch · apk · dmg</p>
            </li>
            <li class="send-item">
              <span class="send-dot dot-any" aria-hidden="true"></span>
              <p class="send-name">Anything else</p>
              <p class="send-types">If your computer can open it, Ferry can carry it.</p>
            </li>
          </ul>

          <ul class="limits-inline">
            <li><strong>10</strong> files</li>
            <li><strong>5 GB</strong> per handoff</li>
            <li><strong>10 min</strong> then gone</li>
            <li><strong>Original</strong> quality</li>
          </ul>

          <p class="modal-note">
            One file or several together: anything over 5 GB in total can't be processed.
            Songs and photos keep their original quality, and files between 40 and 64 MB
            arrive as a .zip that unpacks to the identical file.
          </p>

          <div class="modal-actions">
            <button class="btn btn-primary" id="send-guide-start" type="button">Pick files</button>
            <button class="btn" id="send-guide-dismiss" type="button">Close</button>
          </div>
        </div>
      </div>
    `;

    wireHome();
    wireSendGuide();
  }

  function wireSendGuide() {
    const guide = document.getElementById('send-guide');
    const openers = [document.getElementById('open-send-guide')];
    const closers = [
      document.getElementById('send-guide-close'),
      document.getElementById('send-guide-dismiss'),
      document.getElementById('send-guide-start'),
    ];
    let lastFocused = null;

    function open() {
      lastFocused = document.activeElement;
      guide.hidden = false;
      document.body.classList.add('modal-open');
      const first = document.getElementById('send-guide-close');
      if (first) first.focus();
    }

    function close() {
      guide.hidden = true;
      document.body.classList.remove('modal-open');
      if (lastFocused && typeof lastFocused.focus === 'function') lastFocused.focus();
    }

    openers.forEach((button) => button && button.addEventListener('click', open));
    closers.forEach((button) => button && button.addEventListener('click', close));
    guide.addEventListener('click', (event) => {
      if (event.target === guide) close();
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !guide.hidden) close();
    });
  }

  function wireHome() {
    const dropzone = document.getElementById('dropzone');
    const input = document.getElementById('file-input');
    const list = document.getElementById('file-list');
    const button = document.getElementById('upload-btn');
    const errorBox = document.getElementById('upload-error');

    function showError(message) {
      errorBox.textContent = message || '';
      errorBox.hidden = !message;
    }

    function addFiles(incoming) {
      showError('');
      for (const file of incoming) {
        if (state.files.length >= MAX_FILES) {
          showError(`That is the lot — ${MAX_FILES} files per handoff.`);
          break;
        }
        if (file.size === 0) {
          showError(`"${file.name}" is empty.`);
          continue;
        }
        if (file.size > MAX_FILE_BYTES) {
          showError(
            `"${file.name}" is ${formatBytes(file.size)} — over the ${formatBytes(MAX_FILE_BYTES)} limit, so it can't be processed.`
          );
          continue;
        }
        if (totalSelectedBytes() + file.size > MAX_TOTAL_BYTES) {
          showError(
            `That handoff would be ${formatBytes(totalSelectedBytes() + file.size)} — over the ${formatBytes(MAX_TOTAL_BYTES)} limit, so it can't be processed.`
          );
          continue;
        }
        const duplicate = state.files.some(
          (existing) =>
            existing.name === file.name &&
            existing.size === file.size &&
            existing.lastModified === file.lastModified
        );
        if (duplicate) continue;
        state.files.push(file);
      }
      renderList();
    }

    function renderList() {
      list.hidden = state.files.length === 0;
      list.innerHTML = state.files
        .map((file, index) => {
          const plan = zipPlan(file);
          return `
          <li class="file-row">
            <span class="file-tag" aria-hidden="true">${esc(fileTag(file.name))}</span>
            <div class="file-meta">
              <p class="file-name" title="${esc(file.name)}">${esc(file.name)}</p>
              <p class="file-size">${formatBytes(file.size)}${plan ? ' · ' + plan : ''}</p>
            </div>
            <button class="icon-btn" type="button" data-remove="${index}" aria-label="Remove ${esc(file.name)}">✕</button>
          </li>`;
        })
        .join('');

      const count = state.files.length;
      button.disabled = state.busy || count === 0;
      button.textContent = count > 1 ? `Send ${count} files` : 'Send it';
    }

    list.addEventListener('click', (event) => {
      const target = event.target.closest('[data-remove]');
      if (!target) return;
      state.files.splice(Number(target.dataset.remove), 1);
      showError('');
      renderList();
    });

    dropzone.addEventListener('click', () => input.click());
    dropzone.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        input.click();
      }
    });

    input.addEventListener('change', () => {
      addFiles(Array.from(input.files || []));
      input.value = '';
    });

    ['dragenter', 'dragover'].forEach((type) => {
      dropzone.addEventListener(type, (event) => {
        event.preventDefault();
        dropzone.classList.add('dragging');
      });
    });
    ['dragleave', 'dragend'].forEach((type) => {
      dropzone.addEventListener(type, () => dropzone.classList.remove('dragging'));
    });
    dropzone.addEventListener('drop', (event) => {
      event.preventDefault();
      dropzone.classList.remove('dragging');
      addFiles(Array.from(event.dataTransfer.files || []));
    });

    button.addEventListener('click', () => {
      if (state.busy || state.files.length === 0) return;
      startHandoff();
    });

    renderList();
  }

  /* ---------------- uploading ---------------- */

  function uploadRow(index, file) {
    return `
      <li class="upload-row" data-upload-row="${index}">
        <div class="upload-top">
          <span class="upload-name">${esc(file.name)}</span>
          <span class="upload-state" data-upload-state="${index}">waiting</span>
        </div>
        <div class="upload-track"><div class="upload-bar" data-upload-bar="${index}"></div></div>
        <p class="upload-detail" data-upload-detail="${index}">${formatBytes(file.size)}</p>
      </li>`;
  }

  function setRow(index, { state: label, percent, detail }) {
    const stateEl = document.querySelector(`[data-upload-state="${index}"]`);
    const barEl = document.querySelector(`[data-upload-bar="${index}"]`);
    const detailEl = document.querySelector(`[data-upload-detail="${index}"]`);
    if (stateEl && label) stateEl.textContent = label;
    if (barEl && typeof percent === 'number') barEl.style.width = Math.max(0, Math.min(100, percent)) + '%';
    if (detailEl && typeof detail === 'string') detailEl.textContent = detail;
  }

  function setQueueNote(text) {
    const note = document.getElementById('queue-note');
    if (!note) return;
    note.textContent = text || '';
    note.hidden = !text;
  }

  async function waitForTurn(uploadId, index) {
    const started = Date.now();
    for (;;) {
      const response = await fetch(`/api/uploads/${uploadId}`);
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Your place in line was lost.');
      if (data.status !== 'waiting') return data;
      setRow(index, {
        state: `in line · #${data.position || 1}`,
        percent: 0,
        detail: 'Waiting for room in the 5 GB storage. This starts by itself.',
      });
      setQueueNote(
        data.position > 1
          ? `You are number ${data.position} in line. The upload ahead of you is still finishing.`
          : 'You are next in line. Starting as soon as the space frees up.'
      );
      if (Date.now() - started > 30 * 60 * 1000) throw new Error('Waiting too long in line. Try again later.');
      await new Promise((resolve) => setTimeout(resolve, 2500));
    }
  }

  async function uploadOne(index, file) {
    setRow(index, { state: 'preparing', percent: 0, detail: formatBytes(file.size) });
    const session = await postJson('/api/uploads', {
      name: file.name,
      size: file.size,
      type: file.type || 'application/octet-stream',
    });

    const uploadId = session.uploadId;
    try {
      if (session.status === 'waiting') {
        await waitForTurn(uploadId, index);
        setQueueNote('');
      }

      const chunkSize = session.chunkSize || 16 * 1024 * 1024;
      const chunkCount = Math.max(1, Math.ceil(file.size / chunkSize));

      for (let i = 0; i < chunkCount; i += 1) {
        const start = i * chunkSize;
        const end = Math.min(file.size, start + chunkSize);
        const blob = file.slice(start, end);
        await putChunk(uploadId, i, blob, (loaded) => {
          const sent = start + loaded;
          setRow(index, {
            state: Math.round((sent / file.size) * 100) + '%',
            percent: (sent / file.size) * 100,
            detail: `${formatBytes(sent)} of ${formatBytes(file.size)} · piece ${i + 1} of ${chunkCount}`,
          });
        });
      }

      setRow(index, {
        state: 'finishing',
        percent: 100,
        detail: 'Packing it up',
      });

      const finished = await postJson(`/api/uploads/${uploadId}/finish`, {});
      setRow(index, {
        state: 'ready',
        percent: 100,
        detail: finished.zipped ? 'Packed as a .zip' : 'Sent as-is',
      });
      return uploadId;
    } catch (error) {
      await fetch(`/api/uploads/${uploadId}`, { method: 'DELETE' }).catch(() => {});
      throw error;
    }
  }

  async function startHandoff() {
    state.busy = true;
    const button = document.getElementById('upload-btn');
    const errorBox = document.getElementById('upload-error');
    const progress = document.getElementById('progress');
    const uploadList = document.getElementById('upload-list');

    button.disabled = true;
    button.textContent = 'Sending…';
    errorBox.hidden = true;
    setQueueNote('');
    uploadList.innerHTML = state.files.map((file, index) => uploadRow(index, file)).join('');
    progress.hidden = false;

    try {
      const ids = [];
      for (let i = 0; i < state.files.length; i += 1) {
        ids.push(await uploadOne(i, state.files[i]));
      }
      setQueueNote('Making the link…');
      const share = await postJson('/api/shares', {
        uploads: ids.map((uploadId) => ({ uploadId })),
        title: '',
      });
      showResult(share);
    } catch (error) {
      state.busy = false;
      progress.hidden = true;
      setQueueNote('');
      button.disabled = false;
      button.textContent = state.files.length > 1 ? `Send ${state.files.length} files` : 'Send it';
      errorBox.textContent = error.message || 'That did not go through. Try again.';
      errorBox.hidden = false;
    }
  }

  /* ---------------- result ---------------- */

  function showResult(share) {
    state.busy = false;
    clearTimers();

    const url = location.origin + '/s/' + share.id;
    const count = share.files ? share.files.length : 0;

    // The page becomes just the result: the pitch and how-it-works step aside.
    ['.upload-card', '.hero', '.how'].forEach((selector) => {
      const node = document.querySelector(selector);
      if (node) node.hidden = true;
    });

    const container = document.createElement('div');
    container.innerHTML = `
      <section class="card result">
        <div class="result-head">
          <span class="pill">On the water</span>
          <span class="result-meta">${count} file${count === 1 ? '' : 's'} · deletes itself</span>
        </div>

        <div class="result-grid">
          <div>
            <label class="label" for="share-url">Share link</label>
            <div class="copy-row">
              <input id="share-url" type="text" readonly value="${esc(url)}" />
              <button class="btn" id="copy-btn" type="button">Copy</button>
            </div>
            <p class="result-hint">
              Works for anyone with the link or the QR code.
              <span class="count" id="result-count"></span>
            </p>
            <a class="btn btn-quiet" id="open-link" href="/s/${esc(share.id)}" style="margin-top:8px;padding-left:0">
              See what they will see →
            </a>
          </div>

          <figure class="qr">
            <canvas id="qr-canvas" width="312" height="312" aria-label="QR code for the share link"></canvas>
            <figcaption>Scan me</figcaption>
          </figure>
        </div>

        <ul class="file-list result-list">
          ${(share.files || [])
            .map(
              (file) => `
              <li class="file-row">
                <span class="file-tag" aria-hidden="true">${esc(fileTag(deliveredName(file)))}</span>
                <div class="file-meta">
                  <p class="file-name" title="${esc(deliveredName(file))}">${esc(deliveredName(file))}</p>
                  <p class="file-size">${formatBytes(file.size)}${file.zipped ? ' · compressed' : ' · original'}</p>
                </div>
              </li>`
            )
            .join('')}
        </ul>

        <div class="result-actions">
          <button class="btn btn-primary" id="qr-download" type="button">Save the QR code</button>
          <button class="btn btn-quiet" id="new-share" type="button">Send something else</button>
        </div>
        <p class="alert" id="result-error" hidden></p>
      </section>
    `;

    const result = container.firstElementChild;
    app.prepend(result);
    result.scrollIntoView({ behavior: 'smooth', block: 'start' });

    document.getElementById('share-url').addEventListener('focus', (event) => event.target.select());

    document.getElementById('copy-btn').addEventListener('click', async (event) => {
      const btn = event.currentTarget;
      const original = btn.textContent;
      try {
        await navigator.clipboard.writeText(url);
      } catch {
        const field = document.getElementById('share-url');
        field.select();
        try {
          document.execCommand('copy');
        } catch {
          /* the select-all fallback is fine */
        }
      }
      btn.textContent = 'Copied';
      setTimeout(() => {
        btn.textContent = original;
      }, 1500);
    });

    document.getElementById('new-share').addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
      renderHome();
    });

    document.getElementById('qr-download').addEventListener('click', async () => {
      const errorBox = document.getElementById('result-error');
      try {
        const lib = await loadQrLib();
        const dataUrl = await lib.toDataURL(url, {
          width: 1024,
          margin: 2,
          color: { dark: '#1b2733', light: '#ffffff' },
        });
        const blob = await (await fetch(dataUrl)).blob();
        const objectUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = objectUrl;
        link.download = `ferry-${share.id}-qr.png`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 10000);
      } catch {
        errorBox.textContent = 'Could not save the QR image.';
        errorBox.hidden = false;
      }
    });

    startCountdown(document.getElementById('result-count'), share.expiresAt, () => {
      const hint = document.querySelector('.result-hint');
      if (hint) hint.textContent = 'This link has expired. The files are gone.';
    });

    drawQr(document.getElementById('qr-canvas'), url);
  }

  // The QR library is only needed when a link has just been made, so receiver pages
  // never download it.
  let qrLibPromise = null;
  function loadQrLib() {
    if (window.QRCode) return Promise.resolve(window.QRCode);
    if (!qrLibPromise) {
      qrLibPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = '/vendor/qrcode.js';
        script.async = true;
        script.onload = () => (window.QRCode ? resolve(window.QRCode) : reject(new Error('missing')));
        script.onerror = () => reject(new Error('failed'));
        document.head.appendChild(script);
      });
    }
    return qrLibPromise;
  }

  async function drawQr(canvas, url) {
    if (!canvas) return;
    try {
      const lib = await loadQrLib();
      await lib.toCanvas(canvas, url, {
        width: 312,
        margin: 1,
        errorCorrectionLevel: 'M',
        color: { dark: '#1b2733', light: '#ffffff' },
      });
    } catch {
      const note = document.createElement('p');
      note.className = 'file-size';
      note.textContent = 'QR unavailable — use the link.';
      canvas.replaceWith(note);
    }
  }

  /* ---------------- receiver ---------------- */

  // Notes about the receiver end: files are pulled through fetch so Ferry knows a download
  // really finished, but that needs room in memory, so very large handoffs go to the
  // browser's own downloader and the receiver confirms by hand.
  const TRACKED_DOWNLOAD_LIMIT = 512 * 1024 * 1024;
  const FEEDBACK_REASONS = [
    ['download-failed', 'The download did not finish'],
    ['link-expired', 'The link expired before I could get it'],
    ['file-problem', 'A file arrived damaged or incomplete'],
    ['other', 'Something else went wrong'],
  ];

  function saveBlob(blob, name) {
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 20000);
  }

  function goToFeedback(reason, shareId, fileName) {
    const params = new URLSearchParams({ reason: reason || 'other' });
    if (shareId) params.set('share', shareId);
    if (fileName) params.set('file', fileName);
    location.href = '/feedback?' + params.toString();
  }

  async function trackedDownload(shareId, file, onProgress) {
    const response = await fetch(
      `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}`
    );
    if (!response.ok) {
      const error = new Error(response.status === 410 ? 'expired' : 'failed');
      error.status = response.status;
      throw error;
    }
    if (!response.body) throw new Error('failed');

    const total = Number(response.headers.get('content-length')) || file.size || 0;
    const reader = response.body.getReader();
    const parts = [];
    let received = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      received += value.length;
      onProgress(received, total);
    }
    if (total && received !== total) throw new Error('incomplete');
    return new Blob(parts, {
      type: response.headers.get('content-type') || 'application/octet-stream',
    });
  }

  function markProgress(statusEl, received, total) {
    statusEl.hidden = false;
    statusEl.classList.remove('is-failed');
    const percent = total ? Math.min(100, Math.round((received / total) * 100)) : 0;
    if (!statusEl.querySelector('.dl-track')) {
      statusEl.innerHTML = `
        <div class="dl-track"><div class="dl-bar"></div></div>
        <p class="dl-note"></p>`;
    }
    statusEl.querySelector('.dl-bar').style.width = percent + '%';
    statusEl.querySelector('.dl-note').textContent =
      `${formatBytes(received)} of ${formatBytes(total)} · ${percent}%`;
  }

  function markDelivered(statusEl, shareId, file) {
    statusEl.hidden = false;
    statusEl.classList.remove('is-failed');
    statusEl.innerHTML = `
      <p class="dl-done">Download complete — the whole file arrived.</p>
      <div class="dl-done-actions">
        <button class="dl dl-delete" type="button" data-delete-file="${esc(file.id)}">Downloaded — delete my file</button>
        <a class="dl-link" href="/feedback?reason=file-problem&share=${encodeURIComponent(shareId)}&file=${encodeURIComponent(file.name)}">Something wrong with the file?</a>
      </div>`;
  }

  async function deleteFile(shareId, fileId) {
    const response = await fetch(
      '/api/shares/' + encodeURIComponent(shareId) + '/files/' + encodeURIComponent(fileId),
      { method: 'DELETE' }
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not delete that file yet. Try again.');
    return data;
  }

  async function deleteShare(shareId) {
    const response = await fetch('/api/shares/' + encodeURIComponent(shareId), { method: 'DELETE' });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || 'Could not delete it yet. Try again.');
    return data;
  }

  function renderDeleted(shareId) {
    clearTimers();
    document.title = 'Deleted — Ferry';
    app.innerHTML = `
      <section class="card rise">
        <div class="empty">
          <span class="empty-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="m4 12.5 5 5L20 6.5" />
            </svg>
          </span>
          <strong>Deleted. Thank you.</strong>
          <p>The files are gone from storage and the space is free for the next person in line.</p>
        </div>
        <a class="btn block" href="/">Send something yourself</a>
      </section>`;
  }

  async function renderShare(shareId) {
    clearTimers();
    app.innerHTML = '<div class="loading">Looking for this handoff…</div>';

    let data;
    try {
      const response = await fetch('/api/shares/' + encodeURIComponent(shareId));
      data = await response.json().catch(() => ({}));
      if (response.status === 404) throw new Error('expired-or-missing');
      if (!response.ok) throw new Error(data.error || 'This link is not working.');
    } catch (error) {
      const gone = error.message === 'expired-or-missing';
      app.innerHTML = `
        <section class="card rise">
          <div class="empty">
            <strong>${gone ? 'Nothing here any more' : 'This link is not working'}</strong>
            <p>${
              gone
                ? 'Ferry links last ten minutes, and this one has already been cleared out.'
                : esc(error.message)
            }</p>
          </div>
          <a class="btn block" href="/">Send something yourself</a>
        </section>`;
      return;
    }

    if (data.expired) {
      document.title = 'Expired handoff — Ferry';
      app.innerHTML = `
        <section class="card rise">
          <div class="empty">
            <strong>This handoff has expired</strong>
            <p>The files were deleted. Ask whoever sent them for a fresh link.</p>
          </div>
          <a class="btn block" href="/">Send something yourself</a>
        </section>`;
      return;
    }

    const count = data.files.length;
    const heading = data.title || (count === 1 ? data.files[0].name : `${count} files`);
    document.title = heading + ' — Ferry';

    app.innerHTML = `
      <section class="share-page rise">
        <p class="eyebrow">Someone sent you files</p>
        <h1>${esc(heading)}</h1>
        <p class="share-meta">
          ${count} file${count === 1 ? '' : 's'} ·
          <span class="count" id="share-count"></span>
        </p>

        <section class="card">
          <ul class="file-list" style="margin-top:0">
            ${data.files
              .map(
                (file) => `
                <li class="file-row">
                  <span class="file-tag" aria-hidden="true">${esc(fileTag(deliveredName(file)))}</span>
                  <div class="file-meta">
                    <p class="file-name" title="${esc(deliveredName(file))}">${esc(deliveredName(file))}</p>
                    <p class="file-size">${formatBytes(file.size)}${file.zipped ? ' <span class="tag">ZIP</span>' : ''}</p>
                  </div>
                  <button class="dl" type="button" data-download="${esc(file.id)}">Download</button>
                  <div class="dl-status" data-status="${esc(file.id)}" hidden></div>
                </li>`
              )
              .join('')}
          </ul>
        </section>

        <section class="card ack" id="ack-card">
          <div class="ack-copy">
            <h2>Got everything?</h2>
            <p>Say yes and these files are deleted right now instead of waiting out the clock.</p>
          </div>
          <div class="ack-actions">
            <button class="btn btn-primary" id="ack-yes" type="button">Yes, delete now</button>
            <button class="btn btn-quiet" id="ack-no" type="button">Not yet</button>
          </div>
          <p class="alert" id="ack-error" hidden></p>
        </section>

        <p class="center">
          <a class="btn btn-quiet" href="/">Send something yourself</a>
        </p>
      </section>
    `;

    const yes = document.getElementById('ack-yes');
    const no = document.getElementById('ack-no');
    const ackError = document.getElementById('ack-error');
    const ackCard = document.getElementById('ack-card');

    async function startDownload(button) {
      const file = data.files.find((entry) => entry.id === button.dataset.download);
      if (!file) return;
      const statusEl = document.querySelector(`[data-status="${file.id}"]`);
      if (!statusEl) return;

      if (file.size > TRACKED_DOWNLOAD_LIMIT) {
        // Too big to hold in memory: hand it to the browser, then ask for a confirmation.
        const link = document.createElement('a');
        link.href = `/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(file.id)}`;
        link.download = deliveredName(file);
        document.body.appendChild(link);
        link.click();
        link.remove();
        statusEl.hidden = false;
        statusEl.innerHTML = `
          <p class="dl-done">Your browser is saving this one itself.</p>
          <div class="dl-done-actions">
            <button class="dl dl-delete" type="button" data-delete-file="${esc(file.id)}">It arrived — delete my file</button>
            <button class="dl dl-report" type="button" data-report="${esc(file.name)}">It didn't work</button>
          </div>`;
        return;
      }

      button.disabled = true;
      button.textContent = 'Downloading…';
      markProgress(statusEl, 0, file.size || 1);
      try {
        const blob = await trackedDownload(shareId, file, (received, total) => {
          markProgress(statusEl, received, total);
        });
        saveBlob(blob, deliveredName(file));
        markDelivered(statusEl, shareId, file);
        button.textContent = 'Downloaded';
      } catch (error) {
        const reason = error && error.status === 410 ? 'link-expired' : 'download-failed';
        goToFeedback(reason, shareId, file.name);
      }
    }

    document.querySelectorAll('[data-download]').forEach((button) => {
      button.addEventListener('click', () => startDownload(button));
    });

    no.addEventListener('click', () => {
      ackCard.classList.add('ack-dismissed');
      ackCard.innerHTML = `
        <div class="ack-copy">
          <h2>No problem</h2>
          <p>It will delete itself when the clock runs out. The download buttons still work.</p>
        </div>`;
    });

    yes.addEventListener('click', async () => {
      yes.disabled = true;
      yes.textContent = 'Deleting…';
      try {
        await deleteShare(shareId);
        renderDeleted(shareId);
      } catch (error) {
        yes.disabled = false;
        yes.textContent = 'Yes, delete now';
        ackError.textContent = error.message;
        ackError.hidden = false;
      }
    });

    startCountdown(document.getElementById('share-count'), data.expiresAt, () => {
      renderShare(shareId);
    });
  }

  /* ---------------- feedback ---------------- */

  function renderFeedback() {
    clearTimers();
    document.title = 'Feedback — Ferry';
    const params = new URLSearchParams(location.search);
    const asked = params.get('reason') || '';
    const reason = FEEDBACK_REASONS.some(([value]) => value === asked) ? asked : 'other';
    const shareId = (params.get('share') || '').slice(0, 32);
    const fileName = (params.get('file') || '').slice(0, 180);

    app.innerHTML = `
      <section class="share-page feedback-page rise">
        <p class="eyebrow">Tell Harsh what happened</p>
        <h1>Something went wrong?</h1>
        <p class="lede">
          Say what happened and it comes straight to Harsh. If a download failed, the details
          of that handoff travel with your note — nothing to copy down.
        </p>

        <section class="card">
          <form class="fb-form" id="fb-form" novalidate>
            <div class="fb-field">
              <label class="label" for="fb-reason">What happened</label>
              <select id="fb-reason" name="reason">
                ${FEEDBACK_REASONS.map(
                  ([value, label]) =>
                    `<option value="${value}"${value === reason ? ' selected' : ''}>${esc(label)}</option>`
                ).join('')}
              </select>
            </div>

            <div class="fb-field">
              <label class="label" for="fb-message">What went wrong</label>
              <textarea id="fb-message" name="message" rows="5" maxlength="2000" required
                placeholder="The download stopped at 80% and said the connection dropped…"></textarea>
            </div>

            <div class="fb-field">
              <label class="label" for="fb-email">
                Your email <span class="fb-optional">(optional, so Harsh can reply)</span>
              </label>
              <input id="fb-email" name="email" type="email" autocomplete="email" placeholder="you@example.com" />
            </div>

            <input class="fb-honeypot" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true" />

            <div class="result-actions">
              <button class="btn btn-primary" id="fb-submit" type="submit">Send feedback</button>
              <a class="btn btn-quiet" href="/">Back to Ferry</a>
            </div>
            <p class="alert" id="fb-error" hidden></p>
          </form>

          <div class="empty" id="fb-done" hidden>
            <span class="empty-icon" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="m4 12.5 5 5L20 6.5" />
              </svg>
            </span>
            <strong>Thank you — that went through.</strong>
            <p>Harsh has your note. If it was about a broken handoff, the share details went with it.</p>
            <a class="btn block" href="/">Back to Ferry</a>
          </div>
        </section>
      </section>`;

    const form = document.getElementById('fb-form');
    const errorBox = document.getElementById('fb-error');
    const submit = document.getElementById('fb-submit');

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      const message = form.message.value.trim();
      if (message.length < 4) {
        errorBox.textContent = 'Add a sentence about what went wrong.';
        errorBox.hidden = false;
        form.message.focus();
        return;
      }
      submit.disabled = true;
      submit.textContent = 'Sending…';
      try {
        await postJson('/api/feedback', {
          reason: form.reason.value,
          message,
          email: form.email.value.trim(),
          shareId,
          file: fileName,
          page: location.href,
          website: form.website.value,
        });
        form.hidden = true;
        document.getElementById('fb-done').hidden = false;
      } catch (error) {
        submit.disabled = false;
        submit.textContent = 'Send feedback';
        errorBox.textContent = error.message || 'That did not go through. Try again.';
        errorBox.hidden = false;
      }
    });
  }

  /* ---------------- back to top and shared clicks ---------------- */

  function wireToTop() {
    const button = document.getElementById('to-top');
    if (!button) return;
    const update = () => {
      button.hidden = window.scrollY < 320;
    };
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    button.addEventListener('click', () => window.scrollTo({ top: 0, behavior: 'smooth' }));
    update();
  }

  // One listener for the whole app: download confirmations and reports are added and
  // replaced as a receiver works through a handoff.
  function wireReceiverActions() {
    app.addEventListener('click', async (event) => {
      const report = event.target.closest('[data-report]');
      const remove = event.target.closest('[data-delete-share]');
      const removeFile = event.target.closest('[data-delete-file]');
      if (!report && !remove && !removeFile) return;
      const match = location.pathname.match(/^\/s\/([a-z0-9]+)\/?$/);
      if (!match) return;
      const shareId = match[1];

      if (report) {
        goToFeedback('download-failed', shareId, report.dataset.report);
        return;
      }

      if (removeFile) {
        const fileId = removeFile.dataset.deleteFile;
        const original = removeFile.textContent;
        removeFile.disabled = true;
        removeFile.textContent = 'Deleting…';
        try {
          const result = await deleteFile(shareId, fileId);
          if (result.shareGone) {
            renderDeleted(shareId);
            return;
          }
          const row = removeFile.closest('.file-row');
          const button = row && row.querySelector('[data-download]');
          if (button) {
            button.disabled = true;
            button.textContent = 'Deleted';
          }
          const statusEl = row && row.querySelector('.dl-status');
          if (statusEl) {
            statusEl.hidden = false;
            statusEl.classList.remove('is-failed');
            statusEl.innerHTML =
              '<p class="dl-done">Deleted — just that file. The rest of the handoff is still here.</p>';
          }
        } catch (error) {
          removeFile.disabled = false;
          removeFile.textContent = original;
          const alert = document.getElementById('ack-error');
          if (alert) {
            alert.textContent = error.message;
            alert.hidden = false;
          }
        }
        return;
      }

      const original = remove.textContent;
      remove.disabled = true;
      remove.textContent = 'Deleting…';
      try {
        await deleteShare(shareId);
        renderDeleted(shareId);
      } catch (error) {
        remove.disabled = false;
        remove.textContent = original;
        const alert = document.getElementById('ack-error');
        if (alert) {
          alert.textContent = error.message;
          alert.hidden = false;
        }
      }
    });
  }

  /* ---------------- route ---------------- */

  function route() {
    if (/^\/feedback\/?$/.test(location.pathname)) {
      renderFeedback();
      return;
    }
    const match = location.pathname.match(/^\/s\/([a-z0-9]+)\/?$/);
    if (match) {
      renderShare(match[1]);
    } else {
      renderHome();
    }
  }

  function start() {
    wireToTop();
    wireReceiverActions();
    route();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start);
  } else {
    start();
  }
})();
