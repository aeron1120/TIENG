// 사고 기록 파일 내보내기 — 서버 GET /me/incidents/:id/export 가 저장된 기록(판정 근거·원시 센서 로그·대응 과정)을 JSON 으로 준다.
// '사고기록 제공' 동의(insuranceRecords)가 없으면 서버가 403 으로 막는다. 파일을 준다는 것일 뿐, 외부 기관이 인정하는지는 별개다.
import { Platform, Share } from 'react-native';

import { api, ApiError } from '@/api/client';

export type ExportOutcome = 'downloaded' | 'shared' | 'cancelled' | 'consent_required' | 'failed';

export async function exportIncidentRecord(id: string): Promise<{ outcome: ExportOutcome; message?: string }> {
  let data: unknown;
  try {
    // 원시 로그가 커서 기본 10초보다 여유를 둔다
    data = await api<unknown>('GET', `/me/incidents/${encodeURIComponent(id)}/export`, undefined, { timeoutMs: 30_000 });
  } catch (e) {
    if (e instanceof ApiError && e.status === 403) return { outcome: 'consent_required', message: e.message };
    return { outcome: 'failed', message: e instanceof Error ? e.message : undefined };
  }
  const text = JSON.stringify(data, null, 2);
  const name = `rider-guard-incident-${id}.json`;

  if (Platform.OS === 'web') {
    try {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      return { outcome: 'downloaded' };
    } catch {
      return { outcome: 'failed', message: '이 브라우저에서 파일을 저장하지 못했어요.' };
    }
  }
  // 네이티브는 파일 시스템 모듈 없이 공유 시트로 JSON 본문을 넘긴다
  try {
    const r = await Share.share({ title: name, message: text });
    return { outcome: r.action === Share.dismissedAction ? 'cancelled' : 'shared' };
  } catch {
    return { outcome: 'failed', message: '공유하지 못했어요.' };
  }
}
