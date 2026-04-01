'use strict';
const fs   = require('fs');
const path = require('path');

const CLIENTS_DIR = path.join(__dirname, '..', 'clients');

/**
 * Remove old bitmaps_test subdirectories for a single client,
 * keeping only the most recent `keepLast` folders.
 */
function cleanupClientDir(slug, keepLast = 3) {
  const testDir = path.join(CLIENTS_DIR, slug, 'backstop_data', 'bitmaps_test');
  if (!fs.existsSync(testDir)) return { removed: 0, kept: 0, freed_kb: 0 };

  const folders = fs.readdirSync(testDir)
    .filter(f => {
      try { return fs.statSync(path.join(testDir, f)).isDirectory(); } catch { return false; }
    })
    .sort(); // YYYYMMDD-HHMMSS — alphabetical = chronological

  const toRemove = folders.slice(0, Math.max(0, folders.length - keepLast));
  let freedBytes = 0;

  for (const f of toRemove) {
    const fullPath = path.join(testDir, f);
    try {
      freedBytes += dirSizeBytes(fullPath);
      fs.rmSync(fullPath, { recursive: true, force: true });
    } catch (e) {
      console.warn(`[cleanup] Could not remove ${fullPath}: ${e.message}`);
    }
  }

  return {
    removed:   toRemove.length,
    kept:      Math.min(folders.length, keepLast),
    freed_kb:  Math.round(freedBytes / 1024),
  };
}

/** Recursively sum file sizes in a directory */
function dirSizeBytes(dir) {
  let total = 0;
  try {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      total += stat.isDirectory() ? dirSizeBytes(full) : stat.size;
    }
  } catch (_) {}
  return total;
}

/**
 * Run cleanup for ALL clients.
 */
async function cleanupAllClients(keepLast = 3) {
  const db      = require('../db');
  const clients = await db.getAllClients();
  const results = [];
  let totalFreedKb = 0;

  for (const client of clients) {
    const result = cleanupClientDir(client.slug, keepLast);
    totalFreedKb += result.freed_kb;
    results.push({ name: client.name, slug: client.slug, ...result });
  }

  console.log(`[cleanup] Freed ~${Math.round(totalFreedKb / 1024)} MB across ${clients.length} clients`);
  return { results, totalFreedKb };
}

/**
 * Run cleanup for a single client after each successful test.
 */
function cleanupAfterTest(slug, keepLast = 3) {
  try {
    const result = cleanupClientDir(slug, keepLast);
    if (result.removed > 0) {
      console.log(`[cleanup] ${slug}: removed ${result.removed} old snapshot(s), freed ${result.freed_kb} KB`);
    }
  } catch (e) {
    console.warn(`[cleanup] Post-test cleanup failed for ${slug}: ${e.message}`);
  }
}

module.exports = { cleanupClientDir, cleanupAllClients, cleanupAfterTest };
