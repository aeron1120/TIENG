import type { AppContext } from '../context.ts';
import { ApiError } from '../lib.ts';
import { openIncident } from './incidents.ts';

/**
 * 회원 탈퇴. 원격 DB 에서 외래 키 연쇄 삭제가 켜져 있다는 보장이 없어 자식 행을 직접 지운다.
 *
 * 남기는 것: 위치정보 이용·제공 사실 확인자료(locationAccessLogs) — 위치정보법 제16조가 6개월 이상 보존을 요구한다.
 *   보존 기간이 지나면 스케줄러가 지운다 (scheduler.ts).
 * 제공자 연결 끊기: 카카오는 탈퇴 과정에 연결 끊기를 요구한다 — socialUnlinks 에 넣고 스케줄러가 보낸다(실패하면 다시).
 *   네이버·구글은 사용자 토큰이 있어야 끊을 수 있는데 로그인 뒤 토큰을 보관하지 않으므로, 사용자가 각 계정 설정에서 끊는다.
 * 막는 경우: 진행 중인 사고가 있으면 탈퇴하지 않는다 — 비상연락·119 신고가 도중에 끊긴다.
 */
export async function deleteAccount(ctx: AppContext, riderId: string) {
  await ctx.db.tx(async () => {
    if (await openIncident(ctx, riderId)) {
      throw new ApiError(409, 'incident_open', '진행 중인 사고 대응이 끝난 뒤에 탈퇴할 수 있어요.');
    }
    const byIncident = 'IN (SELECT id FROM incidents WHERE riderId = :riderId)';
    const statements = [
      `DELETE FROM incidentEvents WHERE incidentId ${byIncident}`,
      `DELETE FROM notifications WHERE incidentId ${byIncident}`,
      'DELETE FROM pushes WHERE riderId = :riderId',
      'DELETE FROM shareLinks WHERE riderId = :riderId',
      'DELETE FROM judgments WHERE riderId = :riderId',
      'DELETE FROM detections WHERE riderId = :riderId',
      'DELETE FROM orders WHERE riderId = :riderId',
      'DELETE FROM incidents WHERE riderId = :riderId',
      'DELETE FROM locations WHERE riderId = :riderId',
      'DELETE FROM sessions WHERE riderId = :riderId',
      'DELETE FROM contacts WHERE riderId = :riderId',
      'DELETE FROM consents WHERE riderId = :riderId',
      'DELETE FROM pushTokens WHERE riderId = :riderId',
      'DELETE FROM loginCodes WHERE riderId = :riderId',
      "INSERT INTO socialUnlinks (provider, subject, dueAt) SELECT provider, subject, :now FROM riderIdentities WHERE riderId = :riderId AND provider = 'kakao'",
      'DELETE FROM riderIdentities WHERE riderId = :riderId',
      'DELETE FROM authTokens WHERE riderId = :riderId',
      // 기기는 남긴다(다른 라이더가 다시 페어링할 수 있다). 연결만 푼다.
      'UPDATE devices SET riderId = NULL, pairedAt = NULL WHERE riderId = :riderId',
      'DELETE FROM riders WHERE id = :riderId',
    ];
    const now = ctx.clock.now();
    for (const sql of statements) await ctx.db.run(sql, { riderId, now });
  });
}
