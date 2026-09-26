import type {
  ActiveIncidentResponse,
  ContactDto,
  CreateContactRequest,
  CreateIncidentRequest,
  CreateIncidentResponse,
  DeviceDto,
  IncidentDetailDto,
  IncidentListResponse,
  IncidentStatus,
  MeDto,
  OtpResponse,
  RespondRequest,
  SessionDto,
  UpdateContactRequest,
  VerifyRequest,
  VerifyResponse,
} from '@rider-guard/contract';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from './client';

export const keys = {
  me: ['me'] as const,
  active: ['incidents', 'active'] as const,
  list: ['incidents', 'list'] as const,
  incident: (id: string) => ['incidents', 'detail', id] as const,
};

export const isOpenStatus = (s: IncidentStatus | undefined) => s === 'countdown' || s === 'escalated' || s === 'reviewing';

// ── 조회 ───────────────────────────────────────────────────────

export const useMe = (options: { refetchInterval?: number } = {}) =>
  useQuery({ queryKey: keys.me, queryFn: () => api<MeDto>('GET', '/me'), refetchInterval: options.refetchInterval });

/** 운행 중에는 3초마다 진행 중 사고를 확인한다 — 태그/detector 가 서버로 바로 보낸 감지도 여기서 잡는다. */
export const useActiveIncident = (enabled: boolean) =>
  useQuery({
    queryKey: keys.active,
    queryFn: () => api<ActiveIncidentResponse>('GET', '/me/incidents/active'),
    enabled,
    refetchInterval: enabled ? 3000 : false,
  });

export const useIncident = (id: string | undefined) =>
  useQuery({
    queryKey: keys.incident(id ?? ''),
    queryFn: () => api<IncidentDetailDto>('GET', `/me/incidents/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (isOpenStatus(q.state.data?.status) ? 3000 : false),
  });

export const useIncidents = () => useQuery({ queryKey: keys.list, queryFn: () => api<IncidentListResponse>('GET', '/me/incidents') });

// ── 변경 ───────────────────────────────────────────────────────

export const useRequestOtp = () => useMutation({ mutationFn: (phone: string) => api<OtpResponse>('POST', '/auth/otp', { phone }) });

export const useVerify = () => useMutation({ mutationFn: (body: VerifyRequest) => api<VerifyResponse>('POST', '/auth/verify', body) });

function useMeMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }) });
}

export const useStartSession = () => useMeMutation(() => api<SessionDto>('POST', '/me/session'));
export const useEndSession = () => useMeMutation(() => api<SessionDto>('POST', '/me/session/end'));
export const usePairDevice = () => useMeMutation((pairingCode: string) => api<DeviceDto>('POST', '/me/device', { pairingCode }));
export const useSaveContact = () =>
  useMeMutation(({ id, ...body }: CreateContactRequest & UpdateContactRequest & { id?: string }) =>
    id ? api<ContactDto>('PATCH', `/me/contacts/${id}`, body) : api<ContactDto>('POST', '/me/contacts', body),
  );
export const useDeleteContact = () => useMeMutation((id: string) => api<void>('DELETE', `/me/contacts/${id}`));

/** 사고 상태가 바뀐 응답을 받으면 캐시를 바로 맞춘다 — 감시자가 옛 'countdown' 을 보고 경보 화면을 다시 띄우지 않게. */
export function applyIncident(qc: QueryClient, incident: IncidentDetailDto) {
  qc.setQueryData(keys.incident(incident.id), incident);
  qc.setQueryData<ActiveIncidentResponse>(keys.active, { incident: isOpenStatus(incident.status) ? incident : null });
  void qc.invalidateQueries({ queryKey: keys.list });
}

export function useCreateIncident() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateIncidentRequest) => api<CreateIncidentResponse>('POST', '/me/incidents', body),
    onSuccess: (res) => applyIncident(qc, res.incident),
  });
}

export function useRespond(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (response: RespondRequest['response']) => api<IncidentDetailDto>('POST', `/me/incidents/${id}/respond`, { response }),
    onSuccess: (incident) => applyIncident(qc, incident),
  });
}
