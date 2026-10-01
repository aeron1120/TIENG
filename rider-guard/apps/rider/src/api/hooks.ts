import type {
  AdminOverviewDto,
  AgencyBoardDto,
  CreateAgencyOrderRequest,
  SetAffiliationRequest,
  SetRoleRequest,
  ActiveIncidentResponse,
  AuthProvidersResponse,
  AuthResponse,
  ContactDto,
  CreateContactRequest,
  CreateIncidentRequest,
  CreateIncidentResponse,
  DeviceDto,
  IncidentDetailDto,
  IncidentListResponse,
  IncidentStatus,
  EmailLoginRequest,
  EmailSignupRequest,
  MeDto,
  OnboardingRequest,
  RespondRequest,
  SessionDto,
  UpdateContactRequest,
} from '@rider-guard/contract';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';

import { api } from './client';

export const keys = {
  me: ['me'] as const,
  active: ['incidents', 'active'] as const,
  list: ['incidents', 'list'] as const,
  incident: (id: string) => ['incidents', 'detail', id] as const,
  agency: ['agency', 'board'] as const,
};

export const isOpenStatus = (s: IncidentStatus | undefined) => s === 'countdown' || s === 'escalated';

// ── 조회 ───────────────────────────────────────────────────────

/** 로그아웃 직후 아직 내려가지 않은 화면이 토큰 없이 조회하지 않게 */
const useSignedIn = () => useAuth().status === 'signedIn';

export function useMe(options: { refetchInterval?: number } = {}) {
  const enabled = useSignedIn();
  return useQuery({ queryKey: keys.me, queryFn: () => api<MeDto>('GET', '/me'), enabled, refetchInterval: options.refetchInterval });
}

/** 운행 중에는 3초마다 진행 중 사고를 확인한다 — 태그/detector 가 서버로 바로 보낸 감지도 여기서 잡는다. */
export const useActiveIncident = (enabled: boolean) => {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: keys.active,
    queryFn: () => api<ActiveIncidentResponse>('GET', '/me/incidents/active'),
    enabled: signedIn && enabled,
    refetchInterval: signedIn && enabled ? 3000 : false,
  });
};

export function useIncident(id: string | undefined) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: keys.incident(id ?? ''),
    queryFn: () => api<IncidentDetailDto>('GET', `/me/incidents/${id}`),
    enabled: signedIn && !!id,
    refetchInterval: (q) => (isOpenStatus(q.state.data?.status) ? 3000 : false),
  });
}

/** 진행 중인 사고가 목록에 있으면 5초마다 다시 받는다 — 보고 있는 동안 '대응 중'이 '대응 완료'로 바뀌도록. */
export function useIncidents() {
  const enabled = useSignedIn();
  return useQuery({
    queryKey: keys.list,
    queryFn: () => api<IncidentListResponse>('GET', '/me/incidents'),
    enabled,
    refetchInterval: (q) => (q.state.data?.items.some((i) => isOpenStatus(i.status)) ? 5000 : false),
  });
}

// ── 변경 ───────────────────────────────────────────────────────

/** 서버에 키가 설정된 SNS 만 버튼으로 보인다. 서버에 못 붙으면 이메일만. */
export const useAuthProviders = () =>
  useQuery({ queryKey: ['auth', 'providers'], queryFn: () => api<AuthProvidersResponse>('GET', '/auth/providers', undefined, { timeoutMs: 45_000 }), staleTime: 60_000 });

export const useEmailSignup = () => useMutation({ mutationFn: (body: EmailSignupRequest) => api<AuthResponse>('POST', '/auth/signup', body) });

export const useEmailLogin = () => useMutation({ mutationFn: (body: EmailLoginRequest) => api<AuthResponse>('POST', '/auth/login', body) });

function useMeMutation<TVars, TResult>(fn: (vars: TVars) => Promise<TResult>) {
  const qc = useQueryClient();
  return useMutation({ mutationFn: fn, onSuccess: () => qc.invalidateQueries({ queryKey: keys.me }) });
}

export const useOnboarding = () => useMeMutation((body: OnboardingRequest) => api<MeDto>('POST', '/me/onboarding', body));

export const useDeleteAccount = () => useMutation({ mutationFn: () => api<void>('DELETE', '/me') });

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

// ── 역할 ───────────────────────────────────────────────────────

/** 배달기사·관제사 고르기 (나중에 바꿀 수 있다). 바뀐 /me 를 바로 반영한다 */
export function useSetRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (role: SetRoleRequest['role']) => api<MeDto>('PUT', '/me/role', { role } satisfies SetRoleRequest),
    onSuccess: (me) => qc.setQueryData(keys.me, me),
  });
}

/** 관리자 운영 현황 (실제 서버 데이터) */
export function useAdminOverview(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: () => api<AdminOverviewDto>('GET', '/me/admin/overview'),
    enabled: enabled && signedIn,
    refetchInterval: 15_000,
  });
}

// ── 배달대행사 ─────────────────────────────────────────────────

/** 소속 정하기 — 라이더는 가입 코드와 플랫폼, 관제사는 다른 관제사의 대행사에 가입 코드로 합류 */
export function useSetAffiliation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: SetAffiliationRequest) => api<MeDto>('PUT', '/me/affiliation', body),
    onSuccess: (me) => {
      qc.setQueryData(keys.me, me);
      void qc.invalidateQueries({ queryKey: keys.agency });
    },
  });
}

/** 관제 화면 — 소속 라이더·주문·사고. 5초마다 다시 읽는다 */
export function useAgencyBoard(enabled: boolean) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: keys.agency,
    queryFn: () => api<AgencyBoardDto>('GET', '/me/agency'),
    enabled: enabled && signedIn,
    refetchInterval: enabled && signedIn ? 5_000 : false,
  });
}

type AgencyAction =
  | { kind: 'create'; name: string }
  | { kind: 'assign'; body: CreateAgencyOrderRequest }
  | { kind: 'delivered'; orderId: string }
  | { kind: 'reassign'; orderId: string; riderId: string }
  | { kind: 'ack'; incidentId: string }
  | { kind: 'resolve'; incidentId: string };

const agencyRequest = (a: AgencyAction): Promise<AgencyBoardDto> => {
  switch (a.kind) {
    case 'create':
      return api('POST', '/me/agency', { name: a.name });
    case 'assign':
      return api('POST', '/me/agency/orders', a.body);
    case 'delivered':
      return api('POST', `/me/agency/orders/${a.orderId}/delivered`);
    case 'reassign':
      return api('POST', `/me/agency/orders/${a.orderId}/reassign`, { riderId: a.riderId });
    case 'ack':
      return api('POST', `/me/agency/incidents/${a.incidentId}/ack`);
    case 'resolve':
      return api('POST', `/me/agency/incidents/${a.incidentId}/resolve`);
  }
};

/** 관제 화면의 모든 버튼 — 서버가 돌려준 새 관제 화면을 바로 반영한다 */
export function useAgencyAction() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: agencyRequest, onSuccess: (board) => qc.setQueryData(keys.agency, board) });
}
