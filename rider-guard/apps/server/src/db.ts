import { AsyncLocalStorage } from 'node:async_hooks';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { createClient, type Client, type InValue, type Transaction } from '@libsql/client';

/**
 * 저장소: libSQL (SQLite 방언). 같은 드라이버로
 *   로컬 개발  file:./data/rider-guard-v2.db
 *   테스트     :memory:
 *   클라우드   libsql://<db>.turso.io (+ 인증 토큰)
 * 를 다룬다.
 *
 * 컬럼 이름을 camelCase 로 두어 행을 그대로 객체로 쓴다. 시각은 모두 epoch ms 정수, JSON 은 *Json 텍스트 컬럼.
 *
 * 외래 키 연쇄 삭제(ON DELETE CASCADE)는 원격 DB 에서 연결마다 켜져 있다는 보장이 없어 기대지 않는다.
 * 지울 때는 코드에서 자식 행을 직접 지운다 (services/account.ts).
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE riders (
    id TEXT PRIMARY KEY,
    -- 로그인 수단. 이메일 가입이면 email+passwordHash, SNS 가입이면 riderIdentities 에 연결된다.
    email TEXT,
    passwordHash TEXT,
    loginFailures INTEGER NOT NULL DEFAULT 0,
    lockedUntil INTEGER,
    -- 가입 정보 (가입 직후에는 비어 있고, 가입 정보 화면에서 채운다)
    name TEXT,
    phone TEXT,
    onboardedAt INTEGER,
    vehicleJson TEXT,
    medicalJson TEXT,
    createdAt INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX riders_email ON riders(email) WHERE email IS NOT NULL;

  -- SNS 계정 연결. 제공자가 주는 고유 id(subject)로 찾는다 — 이메일은 바뀌거나 없을 수 있다.
  CREATE TABLE riderIdentities (
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    email TEXT,
    createdAt INTEGER NOT NULL,
    PRIMARY KEY (provider, subject)
  );
  CREATE INDEX riderIdentities_rider ON riderIdentities(riderId);

  -- SNS 로그인 진행 중 상태 (CSRF 방지용 state, 로그인 후 돌아갈 앱 주소)
  CREATE TABLE oauthStates (
    state TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    appRedirect TEXT NOT NULL,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  -- SNS 로그인 뒤 앱으로 넘기는 1회용 코드. 토큰을 주소창(딥링크)에 싣지 않으려고 쓴다.
  CREATE TABLE loginCodes (
    codeHash TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    isNew INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );

  CREATE TABLE consents (
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    granted INTEGER NOT NULL,
    version TEXT NOT NULL,
    updatedAt INTEGER NOT NULL,
    PRIMARY KEY (riderId, key)
  );

  CREATE TABLE authTokens (
    tokenHash TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    createdAt INTEGER NOT NULL,
    expiresAt INTEGER NOT NULL
  );
  CREATE INDEX authTokens_rider ON authTokens(riderId);

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
  CREATE INDEX devices_rider ON devices(riderId);

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
    sensorLogJson TEXT,
    -- 사고를 연 판정 근거(지표·규칙 추적)
    evidenceJson TEXT,
    -- 같은 보고로 사고가 두 번 열리지 않게 하는 키
    reportKey TEXT
  );
  CREATE INDEX incidents_rider ON incidents(riderId, detectedAt);
  CREATE INDEX incidents_status ON incidents(status, deadlineAt);
  -- 라이더당 진행 중 사고는 하나. 같은 충격이 여러 번 들어와도 중복 경보를 내지 않는다.
  CREATE UNIQUE INDEX incidents_one_open ON incidents(riderId) WHERE status IN ('countdown', 'escalated', 'reviewing');
  CREATE UNIQUE INDEX incidents_report ON incidents(riderId, reportKey) WHERE reportKey IS NOT NULL;

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
  -- 회원 탈퇴 뒤에도 6개월 이상 남아야 해서(위치정보법 제16조) riders 에 외래 키를 걸지 않는다 — 연쇄 삭제로 함께 지워지지 않게.
  CREATE TABLE locationAccessLogs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    riderId TEXT NOT NULL,
    incidentId TEXT,
    accessorKey TEXT NOT NULL,
    accessor TEXT NOT NULL,
    purpose TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX locationAccessLogs_rider ON locationAccessLogs(riderId, at);

  -- 지표 판정 기록. 경보가 아니어도 전부 남긴다 — 기각·판정 불가 기록이 임계값을 맞추는 재료다 (설계문서 8.3).
  CREATE TABLE judgments (
    id TEXT PRIMARY KEY,
    riderId TEXT REFERENCES riders(id) ON DELETE CASCADE,
    deviceId TEXT,
    producer TEXT,
    reportId TEXT,
    mode TEXT NOT NULL,
    decision TEXT NOT NULL,
    action TEXT NOT NULL,
    reason TEXT,
    incidentId TEXT,
    indicatorsJson TEXT NOT NULL,
    tracesJson TEXT NOT NULL,
    receivedAt INTEGER NOT NULL
  );
  CREATE INDEX judgments_rider ON judgments(riderId, receivedAt);

  -- 라이더 앱 푸시 토큰. 한 기기의 토큰은 마지막으로 로그인한 라이더 것이다.
  CREATE TABLE pushTokens (
    token TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
  CREATE INDEX pushTokens_rider ON pushTokens(riderId);

  -- 라이더에게 보낼 푸시 (outbox). 문자와 같은 이유로 스케줄러가 보낸다 — 실패하면 다시, 재시작해도 이어서.
  CREATE TABLE pushes (
    id TEXT PRIMARY KEY,
    riderId TEXT NOT NULL REFERENCES riders(id) ON DELETE CASCADE,
    incidentId TEXT NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    dueAt INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    sentAt INTEGER,
    error TEXT
  );
  CREATE INDEX pushes_due ON pushes(status, dueAt);
  `,
  // v2 — SNS 1회용 코드를 로그인을 시작한 앱에 묶는 열쇠, 탈퇴 시 카카오 연결 끊기, 위치 이용 기록 파기
  `
  ALTER TABLE oauthStates ADD COLUMN keyHash TEXT;
  ALTER TABLE loginCodes ADD COLUMN keyHash TEXT;

  -- 탈퇴한 SNS 계정의 제공자 연결 끊기 (outbox). 카카오는 탈퇴 과정에 연결 끊기를 요구한다. 끊으면 지운다.
  -- 라이더 행은 이미 지워졌으므로 외래 키가 없다.
  CREATE TABLE socialUnlinks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider TEXT NOT NULL,
    subject TEXT NOT NULL,
    dueAt INTEGER NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT
  );

  -- 보존 기간이 지난 위치 이용 기록을 스케줄러가 매초 지우므로 시각으로 찾는 인덱스
  CREATE INDEX locationAccessLogs_at ON locationAccessLogs(at);
  `,
  // v3 — 원격 DB(Turso)는 읽은 행 수로 한도를 센다. 매초·수 초마다 도는 조회와 외래 키 검사가 테이블을 통째로 읽지 않게
  `
  -- 스케줄러가 매초 찾는 대체배차 대기 주문, 사고 상세가 찾는 주문
  CREATE INDEX orders_held ON orders(status, reassignRequestedAt);
  CREATE INDEX orders_incident ON orders(incidentId);
  -- 사고 상세의 연락처 확인 여부
  CREATE INDEX shareLinks_incident ON shareLinks(incidentId);
  -- 관제 콘솔의 최근 판정 목록 (판정은 지표가 올 때마다 쌓인다)
  CREATE INDEX judgments_received ON judgments(receivedAt);
  -- 부모 행을 지울 때 외래 키 검사가 자식 테이블을 통째로 읽지 않게 (탈퇴·연락처 삭제)
  CREATE INDEX shareLinks_rider ON shareLinks(riderId);
  CREATE INDEX shareLinks_contact ON shareLinks(contactId);
  CREATE INDEX pushes_rider ON pushes(riderId);
  CREATE INDEX pushes_incident ON pushes(incidentId);
  CREATE INDEX incidents_session ON incidents(sessionId);
  CREATE INDEX locations_session ON locations(sessionId);
  `,
  // v4 — 관제 상담원 없이 서버가 끝까지 처리한다. 상담원 배정 단계(reviewing)와 상담원이 쓰던 칸을 없앤다.
  // 119 신고는 비상연락 문자와 같은 outbox(notifications, purpose = emergency_*)로 보낸다.
  `
  UPDATE incidents SET status = 'escalated' WHERE status = 'reviewing';
  DROP INDEX incidents_one_open;
  CREATE UNIQUE INDEX incidents_one_open ON incidents(riderId) WHERE status IN ('countdown', 'escalated');
  ALTER TABLE incidents DROP COLUMN urgent;
  ALTER TABLE incidents DROP COLUMN operatorName;
  ALTER TABLE incidents DROP COLUMN reviewingAt;
  ALTER TABLE incidents DROP COLUMN resolutionNote;
  `,
  // v5 — 지표 라우터 판정 수신 (/v1/detections). 판정은 라우터가 하고, 서버는 받은 본문과 첫 응답을 그대로 남긴다.
  `
  CREATE TABLE detections (
    -- 보내는 쪽이 정한 detection_id. 같은 id 로 다시 오면 중복(같은 본문) 또는 충돌(다른 본문)
    id TEXT PRIMARY KEY,
    -- 키를 정렬한 JSON 의 SHA-256
    bodyHash TEXT NOT NULL,
    bodyJson TEXT NOT NULL,
    -- 첫 응답. 같은 본문을 다시 보내면 이것을 그대로 돌려준다
    responseJson TEXT NOT NULL,
    riderId TEXT,
    incidentId TEXT,
    mode TEXT NOT NULL,
    candidate INTEGER NOT NULL,
    receivedAt INTEGER NOT NULL
  );
  CREATE INDEX detections_incident ON detections(incidentId);
  CREATE INDEX detections_received ON detections(receivedAt);
  CREATE INDEX detections_rider ON detections(riderId);
  -- 사고 당시 배달 중이던 주문 (보내는 쪽이 알려 준 경우). 없으면 에스컬레이션 때 라이더의 최근 배달 중 주문
  ALTER TABLE incidents ADD COLUMN orderId TEXT;
  `,
  // v6 — Google OIDC authorization code binding: PKCE verifier and ID-token nonce.
  `
  ALTER TABLE oauthStates ADD COLUMN verifier TEXT;
  ALTER TABLE oauthStates ADD COLUMN nonce TEXT;
  `,
  // v7 — heartbeat and actual measured sensor reception are independent.
  `ALTER TABLE devices ADD COLUMN lastSensorAt INTEGER;`,
  // v8 — 첫 로그인 때 고르는 역할 (rider·dispatcher). 관리자는 저장하지 않고 ADMIN_EMAILS 로 정한다.
  `ALTER TABLE riders ADD COLUMN role TEXT;`,
  // v9 — 배달대행사 소속. 관제사가 대행사를 만들면 가입 코드가 생기고, 라이더는 그 코드로 소속된다(소속 = 보호 중 위치·사고를 그 대행사 관제에 보이는 데 동의).
  // 주문은 대행사 관제사가 배정한다 — 어느 플랫폼(배민·쿠팡이츠…) 주문인지와 함께.
  `
  CREATE TABLE agencies (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    joinCode TEXT NOT NULL,
    createdBy TEXT NOT NULL,
    createdAt INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX agencies_code ON agencies(joinCode);
  ALTER TABLE riders ADD COLUMN agencyId TEXT;
  ALTER TABLE riders ADD COLUMN agencyJoinedAt INTEGER;
  ALTER TABLE riders ADD COLUMN platformsJson TEXT;
  CREATE INDEX riders_agency ON riders(agencyId);
  ALTER TABLE orders ADD COLUMN agencyId TEXT;
  ALTER TABLE orders ADD COLUMN platform TEXT;
  CREATE INDEX orders_agency ON orders(agencyId, status);
  `,
  // v10 — 관제사 초대 코드. 라이더 가입 코드는 라이더들이 알고 있으니, 그 코드로 관제사가 되어 다른 라이더 위치를 보지 못하게 따로 둔다.
  // 이미 있는 대행사는 관제 화면을 처음 열 때 만든다 (services/agency.ts).
  `
  ALTER TABLE agencies ADD COLUMN staffCode TEXT;
  CREATE UNIQUE INDEX agencies_staff_code ON agencies(staffCode) WHERE staffCode IS NOT NULL;
  `,
];

export type Params = Record<string, InValue | undefined>;

export class Db {
  private readonly client: Client;
  /** 지금 이 비동기 흐름이 어느 트랜잭션 안에 있는가 */
  private readonly current = new AsyncLocalStorage<Transaction>();
  /**
   * 문장·트랜잭션을 하나씩 차례로 돌린다. 예전 동기 DB 가 자연히 그랬던 것처럼 — pending → sending 같은
   * '조건부 UPDATE 로 선점' 이 여러 요청·스케줄러 사이에서도 그대로 원자적이게.
   */
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(client: Client) {
    this.client = client;
  }

  static async open(url: string, authToken?: string): Promise<Db> {
    if (url.startsWith('file:')) mkdirSync(dirname(url.slice('file:'.length)), { recursive: true });
    const db = new Db(createClient({ url, authToken }));
    await db.migrate();
    return db;
  }

  async get<T>(sql: string, params: Params = {}): Promise<T | undefined> {
    return (await this.exec(sql, params)).rows[0] as T | undefined;
  }

  async all<T>(sql: string, params: Params = {}): Promise<T[]> {
    return (await this.exec(sql, params)).rows as unknown as T[];
  }

  /**
   * 서로 기다릴 필요 없는 조회 여러 개를 한 번에 보낸다 — 원격 DB(Turso)에서는 왕복 한 번이다.
   * 쿼리마다 행 배열을 같은 순서로 돌려준다. 트랜잭션 안이면 그 트랜잭션에서 읽는다.
   */
  async readMany(queries: { sql: string; params?: Params }[]): Promise<unknown[][]> {
    const statements = queries.map(({ sql, params = {} }) => ({ sql, args: bind(sql, params) }));
    const tx = this.current.getStore();
    const results = tx ? await tx.batch(statements) : await this.serial(() => this.client.batch(statements, 'read'));
    return results.map((r) => r.rows as unknown[]);
  }

  /** 바뀐 행 수를 돌려준다. 조건부 UPDATE 로 상태 전이를 원자적으로 선점할 때 쓴다. */
  async run(sql: string, params: Params = {}): Promise<number> {
    return (await this.exec(sql, params)).rowsAffected;
  }

  /**
   * 안에서 부르는 get/all/run 은 모두 이 트랜잭션으로 간다. 중첩 호출은 바깥 트랜잭션에 합류하고,
   * 안쪽에서 던진 오류는 바깥 전체를 되돌린다. 안에서 외부 API(문자·푸시)를 부르지 않는다 — 그동안 다른 요청이 모두 멈춘다.
   */
  async tx<T>(fn: () => Promise<T>): Promise<T> {
    if (this.current.getStore()) return fn();
    return this.serial(async () => {
      const tx = await this.client.transaction('write');
      try {
        const result = await this.current.run(tx, fn);
        await tx.commit();
        return result;
      } catch (error) {
        await tx.rollback().catch(() => undefined);
        throw error;
      } finally {
        tx.close();
      }
    });
  }

  close() {
    this.client.close();
  }

  private exec(sql: string, params: Params) {
    const statement = { sql, args: bind(sql, params) };
    const tx = this.current.getStore();
    return tx ? tx.execute(statement) : this.serial(() => this.client.execute(statement));
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async migrate() {
    await this.client.execute('CREATE TABLE IF NOT EXISTS schemaMigrations (version INTEGER PRIMARY KEY, appliedAt INTEGER NOT NULL)');
    const row = (await this.client.execute('SELECT MAX(version) AS v FROM schemaMigrations')).rows[0];
    for (let v = Number(row?.v ?? 0); v < MIGRATIONS.length; v++) {
      // 한 버전은 통째로 적용되거나 전혀 적용되지 않는다.
      await this.client.batch(
        [...statements(MIGRATIONS[v]!), { sql: 'INSERT INTO schemaMigrations (version, appliedAt) VALUES (?, ?)', args: [v + 1, Date.now()] }],
        'write',
      );
    }
  }
}

/** 마이그레이션 SQL 을 문장 단위로. 문자열 안에 ; 를 쓰지 않는다는 전제 — 주석만 걷어 내고 나눈다. */
function statements(sql: string): string[] {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * undefined → NULL, boolean → 0/1. 문장에 없는 이름은 뺀다 — 여러 문장에 같은 params 를 넘겨도 되게.
 * (로컬 파일은 남는 이름을 무시하지만 원격 DB 프로토콜이 그러리라는 보장은 없다)
 */
function bind(sql: string, params: Params): Record<string, InValue> {
  const out: Record<string, InValue> = {};
  for (const [k, v] of Object.entries(params)) {
    if (!new RegExp(`:${k}\\b`).test(sql)) continue;
    out[k] = v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v;
  }
  return out;
}

export function parseJson<T>(text: string | null | undefined): T | null {
  return text ? (JSON.parse(text) as T) : null;
}
