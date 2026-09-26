import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync, type SQLInputValue, type StatementSync } from 'node:sqlite';

/**
 * 컬럼 이름을 camelCase 로 두어 행을 그대로 객체로 쓴다.
 * 시각은 모두 epoch ms 정수, JSON 은 *Json 텍스트 컬럼.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE riders (
    id TEXT PRIMARY KEY,
    phone TEXT NOT NULL UNIQUE,
    name TEXT,
    vehicleJson TEXT,
    medicalJson TEXT,
    createdAt INTEGER NOT NULL
  );

  CREATE TABLE consents (
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    granted INTEGER NOT NULL,
    version TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (riderId, key)
  );

  CREATE TABLE otpCodes (
    phone TEXT PRIMARY KEY,
    codeHash TEXT NOT NULL,
    expiresAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sentAt INTEGER NOT NULL
  );

  CREATE TABLE authTokens (
    tokenHash TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE contacts (
    id TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    priority INTEGER NOT NULL,
    name TEXT NOT NULL,
    relation TEXT NOT NULL,
    phone TEXT NOT NULL,
    shareLevel TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE INDEX contacts_rider ON contacts(riderId, priority);

  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    tokenHash TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    pairingCode TEXT NOT NULL UNIQUE,
    riderId TEXT REFERENCES riders(id) ON DELETE SET NULL,
    battery INTEGER,
    lastSeenAt INTEGER,
    createdAt INTEGER NOT NULL,
    pairedAt INTEGER
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    startedAt INTEGER NOT NULL,
    endedAt INTEGER,
    endReason TEXT,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX sessions_rider ON sessions(riderId, startedAt);
  -- 라이더당 진행 중 세션은 하나
  CREATE UNIQUE INDEX sessions_one_active ON sessions(riderId) WHERE endedAt IS NULL;

  CREATE TABLE locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    sessionId TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    recordedAt INTEGER NOT NULL,
    lat REAL NOT NULL,
    lng REAL NOT NULL,
    accuracy REAL,
    speed REAL,
    heading REAL
  );
  CREATE INDEX locations_rider_time ON locations(riderId, recordedAt);

  CREATE TABLE orders (
    id TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    storeName TEXT NOT NULL,
    destination TEXT NOT NULL,
    status TEXT NOT NULL,
    incidentId TEXT,
    -- 배달대행사에 대체배차 요청을 보낸 시각 (outbox — 재시작해도 한 번은 보낸다)
    reassignRequestedAt INTEGER,
    createdAt INTEGER NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX orders_rider ON orders(riderId, status);

  CREATE TABLE incidents (
    id TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    sessionId TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    deviceId TEXT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    detectedAt INTEGER NOT NULL,
    receivedAt INTEGER NOT NULL,
    countdownSeconds INTEGER NOT NULL,
    deadlineAt INTEGER NOT NULL,
    status TEXT NOT NULL,
    urgent INTEGER NOT NULL DEFAULT 0,
    riderResponse TEXT,
    respondedAt INTEGER,
    escalationReason TEXT,
    escalatedAt INTEGER,
    operatorName TEXT,
    reviewingAt INTEGER,
    resolution TEXT,
    resolutionNote TEXT,
    resolvedAt INTEGER,
    lat REAL,
    lng REAL,
    accuracy REAL,
    locationAt INTEGER,
    address TEXT,
    metricsJson TEXT,
    sensorLogJson TEXT
  );
  CREATE INDEX incidents_rider ON incidents(riderId, detectedAt);
  CREATE INDEX incidents_status ON incidents(status, deadlineAt);
  -- 라이더당 진행 중 사고는 하나. 같은 충격이 여러 번 들어와도 중복 경보를 내지 않는다.
  CREATE UNIQUE INDEX incidents_one_open ON incidents(riderId) WHERE status IN ('countdown', 'escalated', 'reviewing');

  CREATE TABLE incidentEvents (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    incidentId TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    at INTEGER NOT NULL,
    dataJson TEXT
  );
  CREATE INDEX incidentEvents_incident ON incidentEvents(incidentId, id);

  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    incidentId TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    contactId TEXT,
    purpose TEXT NOT NULL,
    recipient TEXT NOT NULL,
    -- {link} 자리표시자는 발송 시점에 새 공유 링크로 바뀐다. 토큰 원문은 DB 에 남기지 않는다.
    body TEXT NOT NULL,
    dueAt INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sentAt INTEGER,
    error TEXT
  );
  CREATE INDEX notifications_due ON notifications(status, dueAt);
  CREATE INDEX notifications_incident ON notifications(incidentId);

  CREATE TABLE shareLinks (
    tokenHash TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    contactId TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    incidentId TEXT REFERENCES incidents(id) ON DELETE CASCADE,
    scope TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL,
    acknowledgedAt INTEGER
  );

  -- 개인위치정보 이용·제공 사실 확인자료 (위치정보법 이용내역 통보, 설계문서 9.1)
  CREATE TABLE locationAccessLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    incidentId TEXT,
    accessorKey TEXT NOT NULL,
    accessor TEXT NOT NULL,
    purpose TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX locationAccessLogs_rider ON locationAccessLogs(riderId, at);
  `,
];

export type Params = Record<string, SQLInputValue | undefined | boolean>;

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.raw = new DatabaseSync(path);
    this.raw.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
  }

  get<T>(sql: string, params: Params = {}): T | undefined {
    return this.stmt(sql).get(bind(params)) as T | undefined;
  }

  all<T>(sql: string, params: Params = {}): T[] {
    return this.stmt(sql).all(bind(params)) as T[];
  }

  /** 바뀐 행 수를 돌려준다. 조건부 UPDATE 로 상태 전이를 원자적으로 선점할 때 쓴다. */
  run(sql: string, params: Params = {}): number {
    return Number(this.stmt(sql).run(bind(params)).changes);
  }

  /** 중첩 호출 시 바깥 트랜잭션에 합류한다. 안쪽에서 던진 오류는 바깥 전체를 되돌린다. */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) return this.nested(fn);
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = this.nested(fn);
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  private nested<T>(fn: () => T): T {
    this.depth++;
    try {
      return fn();
    } finally {
      this.depth--;
    }
  }

  close() {
    this.raw.close();
  }

  private stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  private migrate() {
    const { user_version: version } = this.raw.prepare('PRAGMA user_version').get() as { user_version: number };
    for (let v = version; v < MIGRATIONS.length; v++) {
      this.tx(() => {
        this.raw.exec(MIGRATIONS[v]!);
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }
}

/** undefined → NULL, boolean → 0/1. node:sqlite 는 둘 다 직접 받지 않는다. */
function bind(params: Params): Record<string, SQLInputValue> {
  const out: Record<string, SQLInputValue> = {};
  for (const [k, v] of Object.entries(params)) out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  return out;
}

export function parseJson<T>(text: string | null | undefined): T | null {
  return text ? (JSON.parse(text) as T) : null;
}
