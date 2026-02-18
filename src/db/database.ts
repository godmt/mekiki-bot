import Database from "better-sqlite3";
import type BetterSqlite3 from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DATA_DIR = resolve(ROOT, "data");
const DB_PATH = resolve(DATA_DIR, "mekiki.db");

// -- Row types --

export type Origin = "USER_SEEDED" | "BOT_RECOMMENDED";

export interface ActionRow {
  id: number;
  evidence_id: string;
  action: string;
  actor: string;
  created_at: string;
  metadata: string | null;
}

export interface EvidenceRow {
  evidence_id: string;
  title: string;
  url: string | null;
  source_type: string;
  source_id: string | null;
  origin: Origin;
  state: string;
  feed_message_id: string | null;
  library_thread_id: string | null;
  raw_json: string | null;
  created_at: string;
  updated_at: string;
}

export interface TasteProfileVersion {
  id: number;
  profile_md: string;
  source: string; // "seed" | "approved" | "edited"
  proposal_id: string | null;
  created_at: string;
}

export interface TasteProfileProposal {
  id: string;
  status: string; // "pending" | "approved" | "rejected" | "expired"
  new_profile_md: string;
  diff_summary: string; // JSON array
  risks: string; // JSON array
  confidence: number;
  notes: string | null;
  stats_used: string | null; // JSON
  ops_message_id: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface LearningRun {
  id: number;
  started_at: string;
  finished_at: string | null;
  status: string; // "running" | "completed" | "failed"
  events_processed: number;
  proposal_id: string | null;
}

// -- Interface --

export interface MekikiDb {
  raw: BetterSqlite3.Database;
  // cursors
  upsertCursor(sourceId: string, lastFetchAt: string): void;
  getCursor(sourceId: string): { last_fetch_at: string } | undefined;
  // dedupe
  insertSeen(evidenceId: string, urlHash: string): void;
  isSeen(urlHash: string): boolean;
  // actions
  insertAction(evidenceId: string, action: string, actor: string, metadata?: string): void;
  getActions(evidenceId: string): ActionRow[];
  // evidence
  upsertEvidence(evidenceId: string, title: string, url: string | null, sourceType: string, sourceId: string | null, origin: Origin, rawJson?: string): void;
  updateEvidenceState(evidenceId: string, state: string): void;
  updateEvidenceFeedMsg(evidenceId: string, msgId: string): void;
  updateEvidenceLibraryThread(evidenceId: string, threadId: string): void;
  getEvidence(evidenceId: string): EvidenceRow | undefined;
  // taste profile
  getActiveProfile(): TasteProfileVersion | undefined;
  insertProfileVersion(profileMd: string, source: string, proposalId?: string): number;
  insertProposal(proposal: Omit<TasteProfileProposal, "created_at" | "resolved_at">): void;
  getProposal(id: string): TasteProfileProposal | undefined;
  updateProposalStatus(id: string, status: string, opsMessageId?: string): void;
  getPendingProposals(): TasteProfileProposal[];
  // learning runs
  tryAcquireLearningLock(ttlMinutes: number): boolean;
  insertLearningRun(): number;
  finishLearningRun(id: number, status: string, eventsProcessed: number, proposalId?: string): void;
  countNewEventsSince(since: string): number;
  // utility
  close(): void;
}

export function initDb(): MekikiDb {
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS rss_cursors (
      source_id     TEXT PRIMARY KEY,
      last_fetch_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS seen_items (
      evidence_id TEXT PRIMARY KEY,
      url_hash    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_seen_url_hash ON seen_items(url_hash);

    CREATE TABLE IF NOT EXISTS actions_log (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      evidence_id TEXT NOT NULL,
      action      TEXT NOT NULL,
      actor       TEXT NOT NULL DEFAULT 'user',
      created_at  TEXT NOT NULL DEFAULT (datetime('now')),
      metadata    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_actions_evidence ON actions_log(evidence_id);
    CREATE INDEX IF NOT EXISTS idx_actions_created  ON actions_log(created_at);

    CREATE TABLE IF NOT EXISTS evidence (
      evidence_id       TEXT PRIMARY KEY,
      title             TEXT NOT NULL,
      url               TEXT,
      source_type       TEXT NOT NULL DEFAULT 'url',
      source_id         TEXT,
      origin            TEXT NOT NULL DEFAULT 'BOT_RECOMMENDED',
      state             TEXT NOT NULL DEFAULT 'NEW',
      feed_message_id   TEXT,
      library_thread_id TEXT,
      raw_json          TEXT,
      created_at        TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS taste_profile_versions (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_md  TEXT    NOT NULL,
      source      TEXT    NOT NULL DEFAULT 'seed',
      proposal_id TEXT,
      created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS taste_profile_proposals (
      id              TEXT PRIMARY KEY,
      status          TEXT NOT NULL DEFAULT 'pending',
      new_profile_md  TEXT NOT NULL,
      diff_summary    TEXT NOT NULL,
      risks           TEXT NOT NULL,
      confidence      REAL NOT NULL,
      notes           TEXT,
      stats_used      TEXT,
      ops_message_id  TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now')),
      resolved_at     TEXT
    );

    CREATE TABLE IF NOT EXISTS learning_runs (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at       TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at      TEXT,
      status           TEXT NOT NULL DEFAULT 'running',
      events_processed INTEGER NOT NULL DEFAULT 0,
      proposal_id      TEXT
    );
  `);

  const stmts = {
    upsertCursor: db.prepare(`INSERT INTO rss_cursors (source_id, last_fetch_at) VALUES (?, ?) ON CONFLICT(source_id) DO UPDATE SET last_fetch_at = excluded.last_fetch_at`),
    getCursor: db.prepare(`SELECT last_fetch_at FROM rss_cursors WHERE source_id = ?`),
    insertSeen: db.prepare(`INSERT OR IGNORE INTO seen_items (evidence_id, url_hash) VALUES (?, ?)`),
    isSeen: db.prepare(`SELECT 1 FROM seen_items WHERE url_hash = ?`),
    insertAction: db.prepare(`INSERT INTO actions_log (evidence_id, action, actor, metadata) VALUES (?, ?, ?, ?)`),
    getActions: db.prepare(`SELECT * FROM actions_log WHERE evidence_id = ? ORDER BY created_at ASC`),
    upsertEvidence: db.prepare(`
      INSERT INTO evidence (evidence_id, title, url, source_type, source_id, origin, state, raw_json)
      VALUES (?, ?, ?, ?, ?, ?, 'NEW', ?)
      ON CONFLICT(evidence_id) DO UPDATE SET
        title = excluded.title, url = excluded.url,
        source_type = excluded.source_type, raw_json = excluded.raw_json,
        updated_at = datetime('now')
    `),
    updateState: db.prepare(`UPDATE evidence SET state = ?, updated_at = datetime('now') WHERE evidence_id = ?`),
    updateFeedMsg: db.prepare(`UPDATE evidence SET feed_message_id = ?, updated_at = datetime('now') WHERE evidence_id = ?`),
    updateLibThread: db.prepare(`UPDATE evidence SET library_thread_id = ?, updated_at = datetime('now') WHERE evidence_id = ?`),
    getEvidence: db.prepare(`SELECT * FROM evidence WHERE evidence_id = ?`),
    // taste profile
    getActiveProfile: db.prepare(`SELECT * FROM taste_profile_versions ORDER BY id DESC LIMIT 1`),
    insertProfileVersion: db.prepare(`INSERT INTO taste_profile_versions (profile_md, source, proposal_id) VALUES (?, ?, ?)`),
    insertProposal: db.prepare(`INSERT INTO taste_profile_proposals (id, status, new_profile_md, diff_summary, risks, confidence, notes, stats_used, ops_message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    getProposal: db.prepare(`SELECT * FROM taste_profile_proposals WHERE id = ?`),
    updateProposalStatus: db.prepare(`UPDATE taste_profile_proposals SET status = ?, resolved_at = datetime('now') WHERE id = ?`),
    updateProposalOpsMsg: db.prepare(`UPDATE taste_profile_proposals SET ops_message_id = ? WHERE id = ?`),
    getPendingProposals: db.prepare(`SELECT * FROM taste_profile_proposals WHERE status = 'pending' ORDER BY created_at DESC`),
    // learning runs
    getRunningLock: db.prepare(`SELECT * FROM learning_runs WHERE status = 'running' AND started_at > datetime('now', ? || ' minutes') LIMIT 1`),
    insertRun: db.prepare(`INSERT INTO learning_runs (status) VALUES ('running')`),
    finishRun: db.prepare(`UPDATE learning_runs SET finished_at = datetime('now'), status = ?, events_processed = ?, proposal_id = ? WHERE id = ?`),
    countNewEvents: db.prepare(`SELECT COUNT(*) as cnt FROM actions_log WHERE created_at > ? AND action IN ('label.keep', 'label.unsure', 'label.discard')`),
  };

  return {
    raw: db,
    upsertCursor: (sourceId, lastFetchAt) => { stmts.upsertCursor.run(sourceId, lastFetchAt); },
    getCursor: (sourceId) => stmts.getCursor.get(sourceId) as { last_fetch_at: string } | undefined,
    insertSeen: (evidenceId, urlHash) => { stmts.insertSeen.run(evidenceId, urlHash); },
    isSeen: (urlHash) => !!stmts.isSeen.get(urlHash),
    insertAction: (evidenceId, action, actor, metadata) => {
      stmts.insertAction.run(evidenceId, action, actor, metadata ?? null);
    },
    getActions: (evidenceId) => stmts.getActions.all(evidenceId) as ActionRow[],
    upsertEvidence: (evidenceId, title, url, sourceType, sourceId, origin, rawJson) => {
      stmts.upsertEvidence.run(evidenceId, title, url, sourceType, sourceId, origin, rawJson ?? null);
    },
    updateEvidenceState: (evidenceId, state) => { stmts.updateState.run(state, evidenceId); },
    updateEvidenceFeedMsg: (evidenceId, msgId) => { stmts.updateFeedMsg.run(msgId, evidenceId); },
    updateEvidenceLibraryThread: (evidenceId, threadId) => { stmts.updateLibThread.run(threadId, evidenceId); },
    getEvidence: (evidenceId) => stmts.getEvidence.get(evidenceId) as EvidenceRow | undefined,
    // taste profile
    getActiveProfile: () => stmts.getActiveProfile.get() as TasteProfileVersion | undefined,
    insertProfileVersion: (profileMd, source, proposalId) => {
      const r = stmts.insertProfileVersion.run(profileMd, source, proposalId ?? null);
      return Number(r.lastInsertRowid);
    },
    insertProposal: (p) => {
      stmts.insertProposal.run(p.id, p.status, p.new_profile_md, p.diff_summary, p.risks, p.confidence, p.notes ?? null, p.stats_used ?? null, p.ops_message_id ?? null);
    },
    getProposal: (id) => stmts.getProposal.get(id) as TasteProfileProposal | undefined,
    updateProposalStatus: (id, status, opsMessageId) => {
      stmts.updateProposalStatus.run(status, id);
      if (opsMessageId) stmts.updateProposalOpsMsg.run(opsMessageId, id);
    },
    getPendingProposals: () => stmts.getPendingProposals.all() as TasteProfileProposal[],
    // learning runs
    tryAcquireLearningLock: (ttlMinutes) => {
      const existing = stmts.getRunningLock.get(`-${ttlMinutes}`) as LearningRun | undefined;
      return !existing;
    },
    insertLearningRun: () => {
      const r = stmts.insertRun.run();
      return Number(r.lastInsertRowid);
    },
    finishLearningRun: (id, status, eventsProcessed, proposalId) => {
      stmts.finishRun.run(status, eventsProcessed, proposalId ?? null, id);
    },
    countNewEventsSince: (since) => {
      const row = stmts.countNewEvents.get(since) as { cnt: number };
      return row.cnt;
    },
    close: () => db.close(),
  };
}
