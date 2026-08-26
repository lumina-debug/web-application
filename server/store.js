import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DB_FILE, DATA_DIR, UPLOAD_DIR } from './config.js';

const EMPTY_DB = { documents: [] };

function readDb() {
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return { documents: Array.isArray(parsed.documents) ? parsed.documents : [] };
  } catch (err) {
    if (err.code === 'ENOENT') return structuredClone(EMPTY_DB);
    throw err;
  }
}

// 書き込みは一時ファイル経由。途中でプロセスが落ちてもdb.jsonが壊れない。
function writeDb(db) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}

export function newId() {
  return crypto.randomBytes(9).toString('base64url');
}

export function listDocuments() {
  return readDb().documents;
}

export function getDocument(id) {
  return readDb().documents.find((d) => d.id === id) || null;
}

export function insertDocument(doc) {
  const db = readDb();
  db.documents.unshift(doc);
  writeDb(db);
  return doc;
}

export function updateDocument(id, patch) {
  const db = readDb();
  const index = db.documents.findIndex((d) => d.id === id);
  if (index === -1) return null;
  const updated = { ...db.documents[index], ...patch, id, updatedAt: new Date().toISOString() };
  db.documents[index] = updated;
  writeDb(db);
  return updated;
}

export function deleteDocument(id) {
  const db = readDb();
  const index = db.documents.findIndex((d) => d.id === id);
  if (index === -1) return null;
  const [removed] = db.documents.splice(index, 1);
  writeDb(db);
  for (const file of removed.attachments || []) {
    // 添付の実体も消す。アップロード領域の外を指していたら触らない。
    const target = path.join(UPLOAD_DIR, path.basename(file.storedName || ''));
    if (file.storedName && target.startsWith(UPLOAD_DIR)) {
      fs.rmSync(target, { force: true });
    }
  }
  return removed;
}
