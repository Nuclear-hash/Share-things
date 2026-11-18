/**
 * Ferry
 * Send documents, photos or a whole movie, get a short link plus a QR code.
 * Anyone who opens the link or scans the QR can download the files.
 * No accounts: the share code is the only secret, and everything is deleted after 10 minutes
 * (or earlier, the moment the receiver says they have the files).
 *
 * Big files arrive in 16 MB chunks so a 5 GB movie can pass through, and uploads share a
 * 5 GB budget by taking turns in a queue: whoever asks first gets the space, the rest wait in line.
 *
 * Bindings:
 *   DB     D1 database   – share/file/upload metadata
 *   FILES  R2 bucket     – the uploaded file bytes, one object per chunk
 *   ASSETS static assets – public/
 */

import { zipSync } from 'fflate';

const MAX_FILES = 10;
// Any file under 5 GB can be sent. The handoff cap sits just under it so one huge movie
// still leaves the budget a little headroom instead of consuming every last byte.
const MAX_FILE_BYTES = 5000000000; // 5 GB per file
const MAX_TOTAL_BYTES = 5000000000; // 5 GB per handoff, single file or combined
const CHUNK_BYTES = 16 * 1024 * 1024; // 16 MB per upload request
// Compression is attempted only in the large band below. Small and mid-size files are
// delivered exactly as uploaded, and anything above the band is too big to deflate inside
// a Worker (and already-compressed media would not shrink anyway). A zip is kept only
// when it is genuinely smaller, and unzipping restores the original bytes exactly.
const ZIP_MIN_BYTES = 40000000; // 40 MB: below this, files travel untouched
// Zipping happens in memory inside the Worker, so the zip band has a hard ceiling:
// a multi-GB movie cannot be deflated here, so above 64 MB the file is stored as-is.
const ZIP_MAX_BYTES = 64000000; // 64 MB
// Formats that are already compressed: trying to deflate them just burns CPU and grows them.
const PRECOMPRESSED_RE =
  /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|ogv|mpg|mpeg|jpg|jpeg|png|webp|heic|heif|avif|gif|mp3|aac|m4a|ogg|opus|zip|gz|tgz|rar|7z|bz2|xz|pdf|docx|xlsx|pptx|apk|dmg)$/i;
const EXPIRY_MINUTES = 10; // every share link lives for exactly 10 minutes
// Cap our own footprint at 5 GB so other projects sharing these databases keep room.
const R2_BUDGET_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB
const UPLOAD_TTL_MS = 30 * 60 * 1000; // abandoned upload reservations expire after 30 minutes
const VIDEO_NAME_RE = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|3gp|ogv|mpg|mpeg)$/i;
const CODE_ALPHABET = 'abcdefghijkmnopqrstuvwxyz23456789'; // no l, o, 0, 1

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function fail(status, message) {
  return json({ error: message }, status);
}

function randomCode(length) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  let out = '';
  for (const byte of bytes) out += CODE_ALPHABET[byte % CODE_ALPHABET.length];
  return out;
}

// Sizes are shown in decimal units, the way Windows shows them, so a 5.2 GB file
// reads as 5.2 GB instead of 4.8 GB.
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

function cleanName(name, fallback) {
  const base = String(name || '').split(/[\\/]/).pop().trim();
  const safe = base.replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 180);
  return safe || fallback;
}

// Compress only files where it can pay off, and only within the memory ceiling.
function shouldAttemptZip(name, size) {
  if (size < ZIP_MIN_BYTES) return false;
  if (size > ZIP_MAX_BYTES) return false;
  return !PRECOMPRESSED_RE.test(name);
}

let schemaReady;

function ensureSchema(env) {
  if (!schemaReady) {
    schemaReady = (async () => {
      await env.DB.batch([
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS share_things_shares (
             id TEXT PRIMARY KEY,
             title TEXT,
             created_at INTEGER NOT NULL,
             expires_at INTEGER NOT NULL
           )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS share_things_files (
             id TEXT PRIMARY KEY,
             share_id TEXT NOT NULL,
             name TEXT NOT NULL,
             type TEXT,
             size INTEGER NOT NULL,
             zipped INTEGER NOT NULL DEFAULT 0,
             r2_key TEXT NOT NULL,
             chunk_count INTEGER NOT NULL DEFAULT 1,
             created_at INTEGER NOT NULL
           )`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS share_things_uploads (
             id TEXT PRIMARY KEY,
             name TEXT NOT NULL,
             type TEXT,
             size INTEGER NOT NULL,
             stored_size INTEGER NOT NULL DEFAULT 0,
             chunk_count INTEGER NOT NULL,
             received INTEGER NOT NULL DEFAULT 0,
             zipped INTEGER NOT NULL DEFAULT 0,
             state TEXT NOT NULL,
             r2_key TEXT NOT NULL,
             created_at INTEGER NOT NULL,
             updated_at INTEGER NOT NULL
           )`
        ),
        env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_share_things_files_share_id ON share_things_files (share_id)`
        ),
        env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_share_things_uploads_state ON share_things_uploads (state, created_at)`
        ),
        env.DB.prepare(
          `CREATE TABLE IF NOT EXISTS share_things_feedback (
             id TEXT PRIMARY KEY,
             reason TEXT NOT NULL,
             message TEXT NOT NULL,
             email TEXT,
             share_id TEXT,
             file_name TEXT,
             page TEXT,
             ip_hash TEXT,
             created_at INTEGER NOT NULL
           )`
        ),
        env.DB.prepare(
          `CREATE INDEX IF NOT EXISTS idx_share_things_feedback_created ON share_things_feedback (created_at)`
        ),
      ]);

      // Older deployments predate these columns: add whatever is missing.
      const upgrades = [
        'ALTER TABLE share_things_files ADD COLUMN zipped INTEGER NOT NULL DEFAULT 0',
        'ALTER TABLE share_things_files ADD COLUMN chunk_count INTEGER NOT NULL DEFAULT 1',
      ];
      for (const sql of upgrades) {
        try {
          await env.DB.prepare(sql).run();
        } catch (error) {
          const message = String((error && error.message) || error);
          if (!/duplicate column/i.test(message)) throw error;
        }
      }
    })().catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  }
  return schemaReady;
}

/* ---------------- storage accounting ---------------- */

async function bytesInShares(env) {
  const row = await env.DB.prepare(
    'SELECT COALESCE(SUM(size), 0) AS used FROM share_things_files'
  ).first();
  return Number(row && row.used) || 0;
}

// Reservation held by uploads that are not yet part of a share.
async function reservedBytes(env, excludeId) {
  const sql = `SELECT COALESCE(SUM(size), 0) AS used FROM share_things_uploads
               WHERE state IN ('waiting', 'active', 'uploading')${excludeId ? ' AND id != ?' : ''}`;
  const statement = excludeId ? env.DB.prepare(sql).bind(excludeId) : env.DB.prepare(sql);
  const row = await statement.first();
  return Number(row && row.used) || 0;
}

async function usageBytes(env, excludeId) {
  const [inShares, reserved] = await Promise.all([
    bytesInShares(env),
    reservedBytes(env, excludeId),
  ]);
  return inShares + reserved;
}

// Promote queued uploads, oldest first, while the budget allows it.
async function promoteQueue(env) {
  const waiting = await env.DB.prepare(
    `SELECT id, size FROM share_things_uploads WHERE state = 'waiting' ORDER BY created_at, id LIMIT 20`
  ).all();
  const rows = waiting.results || [];
  if (rows.length === 0) return;

  const inShares = await bytesInShares(env);
  const active = await env.DB.prepare(
    `SELECT COALESCE(SUM(size), 0) AS used FROM share_things_uploads WHERE state IN ('active', 'uploading')`
  ).first();
  let committed = inShares + (Number(active && active.used) || 0);

  for (const row of rows) {
    if (committed + row.size > R2_BUDGET_BYTES) break;
    const promoted = await env.DB.prepare(
      `UPDATE share_things_uploads SET state = 'active', updated_at = ? WHERE id = ? AND state = 'waiting'`
    )
      .bind(Date.now(), row.id)
      .run();
    if (promoted.meta && promoted.meta.changes) committed += row.size;
  }
}

async function queuePosition(env, uploadId) {
  const row = await env.DB.prepare(
    'SELECT created_at FROM share_things_uploads WHERE id = ?'
  )
    .bind(uploadId)
    .first();
  if (!row) return 0;
  const ahead = await env.DB.prepare(
    `SELECT COUNT(*) AS waiting FROM share_things_uploads
     WHERE state = 'waiting' AND (created_at < ? OR (created_at = ? AND id < ?))`
  )
    .bind(row.created_at, row.created_at, uploadId)
    .first();
  return (Number(ahead && ahead.waiting) || 0) + 1;
}

/* ---------------- cleanup ---------------- */

async function deleteObjects(env, key, chunkCount) {
  const jobs = [];
  for (let i = 0; i < chunkCount; i += 1) jobs.push(env.FILES.delete(`${key}/${i}`));
  const results = await Promise.allSettled(jobs);
  return results.every((result) => result.status === 'fulfilled');
}

async function purgeShare(env, shareId) {
  const { results } = await env.DB.prepare(
    'SELECT r2_key, chunk_count FROM share_things_files WHERE share_id = ?'
  )
    .bind(shareId)
    .all();
  const rows = results || [];

  for (const row of rows) {
    const clean = await deleteObjects(env, row.r2_key, Number(row.chunk_count) || 1);
    if (!clean) return false; // keep the rows so the sweep retries the delete
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM share_things_files WHERE share_id = ?').bind(shareId),
    env.DB.prepare('DELETE FROM share_things_shares WHERE id = ?').bind(shareId),
  ]);
  return true;
}

async function purgeUpload(env, upload) {
  const clean = await deleteObjects(env, upload.r2_key, Number(upload.chunk_count) || 1);
  if (!clean) return false;
  await env.DB.prepare('DELETE FROM share_things_uploads WHERE id = ?').bind(upload.id).run();
  return true;
}

let lastSweepAt = 0;
const SWEEP_INTERVAL_MS = 15 * 1000;
const SWEEP_BATCH = 10;

// Cleanup: expired shares and abandoned uploads, at most once every 15 seconds per isolate.
async function sweep(env) {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  await ensureSchema(env);

  const expired = await env.DB.prepare(
    'SELECT id FROM share_things_shares WHERE expires_at <= ? ORDER BY expires_at LIMIT ?'
  )
    .bind(now, SWEEP_BATCH)
    .all();
  for (const row of expired.results || []) await purgeShare(env, row.id);

  const stale = await env.DB.prepare(
    'SELECT id, r2_key, chunk_count FROM share_things_uploads WHERE created_at <= ? LIMIT ?'
  )
    .bind(now - UPLOAD_TTL_MS, SWEEP_BATCH)
    .all();
  for (const row of stale.results || []) await purgeUpload(env, row);

  await promoteQueue(env);
}

/* ---------------- upload sessions ---------------- */

async function handleStartUpload(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'Upload details could not be read.');
  }

  const size = Number(body.size);
  if (!Number.isFinite(size) || size <= 0) return fail(400, 'That file looks empty.');
  if (size > MAX_FILE_BYTES) {
    return fail(
      413,
              `${cleanName(body.name, 'That file')} is ${formatBytes(size)} — over the ${formatBytes(MAX_FILE_BYTES)} limit, so it can't be processed.`
    );
  }
  if (size > R2_BUDGET_BYTES) return fail(413, 'That file is bigger than the whole 5 GB budget.');

  const name = cleanName(body.name, 'file');
  const type = String(body.type || 'application/octet-stream').slice(0, 120);
  const id = randomCode(12);
  const chunkCount = Math.ceil(size / CHUNK_BYTES);
  const now = Date.now();

  const used = await usageBytes(env);
  const fits = used + size <= R2_BUDGET_BYTES;

  await env.DB.prepare(
    `INSERT INTO share_things_uploads
       (id, name, type, size, stored_size, chunk_count, received, zipped, state, r2_key, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, ?, 0, 0, ?, ?, ?, ?)`
  )
    .bind(id, name, type, size, chunkCount, fits ? 'active' : 'waiting', `up/${id}`, now, now)
    .run();

  if (!fits) {
    await promoteQueue(env);
    const row = await env.DB.prepare('SELECT state FROM share_things_uploads WHERE id = ?')
      .bind(id)
      .first();
    if (!row || row.state !== 'active') {
      const position = await queuePosition(env, id);
      return json(
        { status: 'waiting', uploadId: id, position, chunkSize: CHUNK_BYTES, chunkCount },
        202
      );
    }
  }

  return json({ status: 'active', uploadId: id, chunkSize: CHUNK_BYTES, chunkCount });
}

async function handleUploadStatus(env, id) {
  await promoteQueue(env);
  const row = await env.DB.prepare(
    'SELECT id, state, received, chunk_count, size FROM share_things_uploads WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!row) return fail(404, 'This upload is gone.');

  const payload = {
    status: row.state,
    uploadId: row.id,
    received: Number(row.received),
    chunkCount: Number(row.chunk_count),
    chunkSize: CHUNK_BYTES,
    size: Number(row.size),
  };
  if (row.state === 'waiting') payload.position = await queuePosition(env, id);
  return json(payload);
}

async function handlePutChunk(request, env, id, index) {
  const row = await env.DB.prepare(
    'SELECT id, state, size, chunk_count, r2_key FROM share_things_uploads WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!row) return fail(404, 'This upload session has expired. Start again.');
  if (row.state === 'waiting') return fail(409, 'Still in line — the upload has not started yet.');
  if (row.state !== 'active' && row.state !== 'uploading') {
    return fail(409, 'This upload is already finished.');
  }
  if (!Number.isInteger(index) || index < 0 || index >= Number(row.chunk_count)) {
    return fail(400, 'That chunk is not part of this file.');
  }

  const buffer = await request.arrayBuffer();
  if (buffer.byteLength === 0) return fail(400, 'That chunk arrived empty.');
  if (buffer.byteLength > CHUNK_BYTES) return fail(413, 'That chunk is too large.');

  const expected = Math.min(
    CHUNK_BYTES,
    Number(row.size) - index * CHUNK_BYTES
  );
  if (buffer.byteLength > expected) return fail(413, 'That chunk is larger than the file.');

  await env.FILES.put(`${row.r2_key}/${index}`, buffer, {
    httpMetadata: { contentType: 'application/octet-stream' },
  });
  await env.DB.prepare(
    `UPDATE share_things_uploads
       SET received = MAX(received, ?), state = 'uploading', updated_at = ?
     WHERE id = ?`
  )
    .bind(index + 1, Date.now(), id)
    .run();

  return json({ received: index + 1, chunkCount: Number(row.chunk_count) });
}

async function handleFinishUpload(env, id) {
  const row = await env.DB.prepare(
    `SELECT id, name, type, size, chunk_count, received, state, r2_key
       FROM share_things_uploads WHERE id = ?`
  )
    .bind(id)
    .first();
  if (!row) return fail(404, 'This upload session has expired. Start again.');
  if (row.state === 'ready') {
    return json({ uploadId: row.id, name: row.name, size: Number(row.size), zipped: false });
  }
  if (Number(row.received) < Number(row.chunk_count)) {
    return fail(400, 'Some parts of the file never arrived. Try again.');
  }

  const name = row.name;
  const type = row.type || 'application/octet-stream';
  let zipped = false;
  let storedSize = Number(row.size);

  if (shouldAttemptZip(name, Number(row.size))) {
    // Small enough to compress here: gather the parts and try a zip.
    const all = new Uint8Array(Number(row.size));
    let offset = 0;
    for (let i = 0; i < Number(row.chunk_count); i += 1) {
      const object = await env.FILES.get(`${row.r2_key}/${i}`);
      if (!object) return fail(400, 'A part of the file is missing. Try again.');
      const bytes = new Uint8Array(await object.arrayBuffer());
      all.set(bytes, offset);
      offset += bytes.byteLength;
    }
    const archive = zipSync({ [name]: [all, { level: 6 }] });
    // Only keep the archive when it genuinely saves space, otherwise leave the chunks alone.
    if (archive.byteLength + 1024 < Number(row.size)) {
      await env.FILES.put(`${row.r2_key}/0`, archive, {
        httpMetadata: { contentType: 'application/zip' },
      });
      for (let i = 1; i < Number(row.chunk_count); i += 1) {
        await env.FILES.delete(`${row.r2_key}/${i}`);
      }
      zipped = true;
      storedSize = archive.byteLength;
    }
  }

  await env.DB.prepare(
    `UPDATE share_things_uploads
       SET state = 'ready', zipped = ?, stored_size = ?, chunk_count = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(zipped ? 1 : 0, storedSize, zipped ? 1 : Number(row.chunk_count), Date.now(), id)
    .run();

  return json({
    uploadId: id,
    name,
    deliveredName: zipped ? `${name}.zip` : name,
    size: storedSize,
    zipped,
  });
}

async function handleCancelUpload(env, id) {
  const row = await env.DB.prepare(
    'SELECT id, r2_key, chunk_count FROM share_things_uploads WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!row) return json({ cancelled: true });
  await purgeUpload(env, row);
  await promoteQueue(env);
  return json({ cancelled: true });
}

/* ---------------- shares ---------------- */

function publicShare(share, files) {
  const expired = Date.now() > share.expires_at;
  return {
    id: share.id,
    title: share.title || '',
    createdAt: share.created_at,
    expiresAt: share.expires_at,
    expired,
    files: expired
      ? []
      : files.map((file) => ({
          id: file.id,
          name: file.name,
          type: file.type || '',
          size: file.size,
          zipped: Boolean(file.zipped),
        })),
  };
}

async function handleCreateShare(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'That handoff could not be read.');
  }

  const ids = Array.isArray(body.uploads)
    ? body.uploads.map((entry) => String(entry && entry.uploadId ? entry.uploadId : entry)).filter(Boolean)
    : [];
  if (ids.length === 0) return fail(400, 'Add at least one file.');
  if (ids.length > MAX_FILES) return fail(400, `You can send up to ${MAX_FILES} files at once.`);

  await ensureSchema(env);
  const placeholders = ids.map(() => '?').join(', ');
  const { results } = await env.DB.prepare(
    `SELECT id, name, type, size, stored_size, chunk_count, zipped, state, r2_key
       FROM share_things_uploads WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const rows = results || [];
  if (rows.length !== ids.length) return fail(400, 'One of those files never finished uploading.');
  if (rows.some((row) => row.state !== 'ready')) return fail(409, 'One of those files is still uploading.');

  const total = rows.reduce((sum, row) => sum + Number(row.stored_size || row.size), 0);
  if (total > MAX_TOTAL_BYTES) {
    return fail(
      413,
      `That handoff adds up to ${formatBytes(total)} — over the ${formatBytes(MAX_TOTAL_BYTES)} limit, so it can't be processed.`
    );
  }

  const now = Date.now();
  const shareId = randomCode(10);
  const expiresAt = now + EXPIRY_MINUTES * 60 * 1000;
  const title = String(body.title || '').trim().slice(0, 120);
  const prepared = rows.map((row) => ({
    id: randomCode(16),
    name: row.name,
    type: row.zipped ? 'application/zip' : row.type || 'application/octet-stream',
    size: Number(row.stored_size || row.size),
    zipped: Boolean(row.zipped),
    key: row.r2_key,
    chunks: Number(row.chunk_count),
  }));

  try {
    await env.DB.batch([
      env.DB.prepare(
        'INSERT INTO share_things_shares (id, title, created_at, expires_at) VALUES (?, ?, ?, ?)'
      ).bind(shareId, title, now, expiresAt),
      ...prepared.map((entry) =>
        env.DB.prepare(
          `INSERT INTO share_things_files
             (id, share_id, name, type, size, zipped, r2_key, chunk_count, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).bind(
          entry.id,
          shareId,
          entry.name,
          entry.type,
          entry.size,
          entry.zipped ? 1 : 0,
          entry.key,
          entry.chunks,
          now
        )
      ),
      ...rows.map((row) =>
        env.DB.prepare('DELETE FROM share_things_uploads WHERE id = ?').bind(row.id)
      ),
    ]);
  } catch (error) {
    await env.DB.batch([
      env.DB.prepare('DELETE FROM share_things_shares WHERE id = ?').bind(shareId),
      ...prepared.map((entry) =>
        env.DB.prepare('DELETE FROM share_things_files WHERE id = ?').bind(entry.id)
      ),
    ]).catch(() => {});
    throw error;
  }

  await promoteQueue(env).catch(() => {});

  return json({
    id: shareId,
    path: `/s/${shareId}`,
    title,
    expiresAt,
    files: prepared.map((entry) => ({
      id: entry.id,
      name: entry.name,
      size: entry.size,
      zipped: entry.zipped,
    })),
  });
}

async function handleGetShare(env, id) {
  await ensureSchema(env);
  const share = await env.DB.prepare(
    'SELECT id, title, created_at, expires_at FROM share_things_shares WHERE id = ?'
  )
    .bind(id)
    .first();
  if (!share) return fail(404, 'This share link does not exist.');

  const { results } = await env.DB.prepare(
    'SELECT id, name, type, size, zipped FROM share_things_files WHERE share_id = ? ORDER BY created_at, name'
  )
    .bind(id)
    .all();

  const payload = publicShare(share, results || []);
  if (payload.expired) await purgeShare(env, id).catch(() => {});
  return json(payload);
}

// The receiver decides when it is done: this deletes the files and frees the queue immediately.
async function handleDeleteShare(env, id) {
  await ensureSchema(env);
  const share = await env.DB.prepare('SELECT id FROM share_things_shares WHERE id = ?')
    .bind(id)
    .first();
  if (!share) return json({ deleted: true });
  const clean = await purgeShare(env, id);
  if (!clean) return fail(503, 'Could not delete everything yet. Try again in a moment.');
  await promoteQueue(env).catch(() => {});
  return json({ deleted: true });
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

function chunkStream(env, key, chunkCount) {
  let index = 0;
  return new ReadableStream({
    async pull(controller) {
      if (index >= chunkCount) {
        controller.close();
        return;
      }
      const object = await env.FILES.get(`${key}/${index}`);
      if (!object) {
        controller.error(new Error(`missing chunk ${index} for ${key}`));
        return;
      }
      controller.enqueue(new Uint8Array(await object.arrayBuffer()));
      index += 1;
    },
  });
}

async function handleDownload(env, shareId, fileId, method) {
  await ensureSchema(env);
  const share = await env.DB.prepare(
    'SELECT id, expires_at FROM share_things_shares WHERE id = ?'
  )
    .bind(shareId)
    .first();
  if (!share) return fail(404, 'This share link does not exist.');
  if (Date.now() > share.expires_at) {
    await purgeShare(env, shareId).catch(() => {});
    return fail(410, 'This share has expired.');
  }

  const file = await env.DB.prepare(
    'SELECT id, name, type, size, zipped, r2_key, chunk_count FROM share_things_files WHERE id = ? AND share_id = ?'
  )
    .bind(fileId, shareId)
    .first();
  if (!file) return fail(404, 'File not found.');

  const chunks = Number(file.chunk_count) || 1;
  const deliveryName = file.zipped ? `${file.name}.zip` : file.name;

  const headers = new Headers();
  headers.set('content-type', file.type || 'application/octet-stream');
  headers.set('content-length', String(file.size));
  headers.set('content-disposition', contentDisposition(deliveryName));
  headers.set('cache-control', 'private, max-age=0, no-store');
  headers.set('x-content-type-options', 'nosniff');

  if (method === 'HEAD') return new Response(null, { headers });

  if (chunks === 1) {
    const object = await env.FILES.get(`${file.r2_key}/0`);
    if (!object) return fail(404, 'File not found.');
    return new Response(object.body, { headers });
  }

  return new Response(chunkStream(env, file.r2_key, chunks), { headers });
}

/* ---------------- feedback ---------------- */

const SITE_NAME = 'Ferry';
const FEEDBACK_REASONS = new Set(['download-failed', 'link-expired', 'file-problem', 'other']);

async function hashIp(ip) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ip));
  return [...new Uint8Array(bytes).slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

// Optional: set FEEDBACK_TO (your address) and RESEND_API_KEY as Worker secrets and the
// note is also mailed out. Without them the feedback is still stored in D1.
async function mailFeedback(env, entry) {
  if (!env.RESEND_API_KEY || !env.FEEDBACK_TO) return false;
  const lines = [
    `Site: ${SITE_NAME}`,
    `Reason: ${entry.reason}`,
    `Message: ${entry.message}`,
    entry.email ? `Reply to: ${entry.email}` : '',
    entry.shareId ? `Share: /s/${entry.shareId}` : '',
    entry.fileName ? `File: ${entry.fileName}` : '',
    entry.page ? `Page: ${entry.page}` : '',
    `When: ${new Date(entry.createdAt).toISOString()}`,
  ].filter(Boolean);

  try {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${env.RESEND_API_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        from: env.FEEDBACK_FROM || `${SITE_NAME} <onboarding@resend.dev>`,
        to: [env.FEEDBACK_TO],
        reply_to: entry.email || undefined,
        subject: `${SITE_NAME} feedback — ${entry.reason}`,
        text: lines.join('\n'),
      }),
    });
    if (!response.ok) console.error('feedback mail rejected', response.status);
    return response.ok;
  } catch (error) {
    console.error('feedback mail failed', error);
    return false;
  }
}

async function handleFeedback(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return fail(400, 'That note could not be read.');
  }

  // A field nobody can see: anything in it came from a bot, so pretend it worked.
  if (String(body.website || '').trim()) return json({ ok: true, mailed: false });

  const reason = FEEDBACK_REASONS.has(String(body.reason)) ? String(body.reason) : 'other';
  const message = String(body.message || '').trim().slice(0, 2000);
  if (message.length < 4) return fail(400, 'Add a sentence about what went wrong.');

  const email = String(body.email || '').trim().slice(0, 160);
  if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return fail(400, 'That email address does not look right.');
  }

  const shareId = /^[a-z0-9]{4,32}$/.test(String(body.shareId || '')) ? String(body.shareId) : '';
  const fileName = cleanName(body.file, '');
  const page = String(body.page || '').slice(0, 300);

  await ensureSchema(env);

  const ip = request.headers.get('cf-connecting-ip') || '';
  const ipHash = ip ? await hashIp(ip) : '';
  if (ipHash) {
    const recent = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM share_things_feedback WHERE ip_hash = ? AND created_at > ?'
    )
      .bind(ipHash, Date.now() - 60 * 60 * 1000)
      .first();
    if (Number(recent && recent.n) >= 5) {
      return fail(429, 'That is a lot of notes in one hour. Try again a little later.');
    }
  }

  const createdAt = Date.now();
  const id = randomCode(12);
  await env.DB.prepare(
    `INSERT INTO share_things_feedback
       (id, reason, message, email, share_id, file_name, page, ip_hash, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, reason, message, email, shareId, fileName, page, ipHash, createdAt)
    .run();

  const mailed = await mailFeedback(env, {
    reason,
    message,
    email,
    shareId,
    fileName,
    page,
    createdAt,
  });

  return json({ ok: true, mailed });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;

    try {
      await sweep(env);
    } catch (error) {
      console.error('cleanup sweep failed', error);
    }

    try {
      if (pathname === '/api/uploads') {
        if (request.method !== 'POST') return fail(405, 'Method not allowed.');
        return await handleStartUpload(request, env);
      }

      const uploadMatch = pathname.match(/^\/api\/uploads\/([a-z0-9]{4,32})$/);
      if (uploadMatch) {
        if (request.method === 'DELETE') return await handleCancelUpload(env, uploadMatch[1]);
        if (request.method !== 'GET') return fail(405, 'Method not allowed.');
        return await handleUploadStatus(env, uploadMatch[1]);
      }

      const chunkMatch = pathname.match(/^\/api\/uploads\/([a-z0-9]{4,32})\/chunks\/(\d{1,6})$/);
      if (chunkMatch) {
        if (request.method !== 'PUT') return fail(405, 'Method not allowed.');
        return await handlePutChunk(request, env, chunkMatch[1], Number(chunkMatch[2]));
      }

      const finishMatch = pathname.match(/^\/api\/uploads\/([a-z0-9]{4,32})\/finish$/);
      if (finishMatch) {
        if (request.method !== 'POST') return fail(405, 'Method not allowed.');
        return await handleFinishUpload(env, finishMatch[1]);
      }

      if (pathname === '/api/shares') {
        if (request.method !== 'POST') return fail(405, 'Method not allowed.');
        return await handleCreateShare(request, env);
      }

      const shareMatch = pathname.match(/^\/api\/shares\/([a-z0-9]{4,32})$/);
      if (shareMatch) {
        if (request.method === 'DELETE') return await handleDeleteShare(env, shareMatch[1]);
        if (request.method !== 'GET') return fail(405, 'Method not allowed.');
        return await handleGetShare(env, shareMatch[1]);
      }

      const fileMatch = pathname.match(/^\/api\/shares\/([a-z0-9]{4,32})\/files\/([a-z0-9]{4,32})$/);
      if (fileMatch) {
        if (request.method !== 'GET' && request.method !== 'HEAD') {
          return fail(405, 'Method not allowed.');
        }
        return await handleDownload(env, fileMatch[1], fileMatch[2], request.method);
      }

      if (pathname === '/api/feedback') {
        if (request.method !== 'POST') return fail(405, 'Method not allowed.');
        return await handleFeedback(request, env);
      }

      if (pathname.startsWith('/api/')) return fail(404, 'Not found.');

      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error('request failed', pathname, error && error.stack ? error.stack : error);
      return fail(500, 'Something went wrong on our side. Please try again.');
    }
  },
};
