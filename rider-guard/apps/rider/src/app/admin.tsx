// 관리자 화면 (넓은 화면) — 모든 화면으로 가는 입구 + 실제 서버의 운영 현황(읽기 전용).
// 관리자는 서버 ADMIN_EMAILS 에 있는 인증된 SNS 이메일로 정해진다. 운영 현황 API 도 서버에서 관리자만 열어 준다.
import type { AdminOverviewDto } from '@rider-guard/contract';
import { router, type Href } from 'expo-router';
import Head from 'expo-router/head';
import { Platform, Pressable, ScrollView, StyleSheet, View } from 'react-native';

import { API_URL } from '@/api/client';
import { useAdminOverview, useMe } from '@/api/hooks';
import { AccountBar } from '@/components/AccountBar';
import { Notice } from '@/components/forms';
import { Badge, Txt, type BadgeTone } from '@/components/ui';
import { colors, font, radius, typography } from '@/theme';

type Shortcut = { title: string; sub: string; href?: Href; url?: string; tab?: boolean };

const STATUS: Record<string, { label: string; tone: BadgeTone }> = {
  countdown: { label: '라이더 확인 중', tone: 'red' },
  escalated: { label: '대응 중', tone: 'redSolid' },
  cancelled: { label: '종료', tone: 'neutral' },
  resolved: { label: '종료', tone: 'neutral' },
};
const SOURCE: Record<string, string> = { tag: '헬멧 태그', phone: '휴대폰 센서', device: '기기 직접', test: '테스트' };
const RESOLUTION: Record<string, string> = { false_alarm: '오탐', rider_cancelled: '라이더 괜찮음', rider_ok: '라이더 괜찮음', handled: '대응 완료' };
const DECISION: Record<string, string> = { alarm: '경보', alarm_unverified: '경보(확인 불가)', reject: '기각', undetermined: '판정 불가' };
const time = (iso: string) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Seoul' });

const open = (s: Shortcut) => {
  if (s.url || s.tab) {
    if (Platform.OS === 'web' && typeof window !== 'undefined') window.open(s.url ?? String(s.href), '_blank');
    return;
  }
  if (s.href) router.push(s.href);
};

export default function AdminScreen() {
  const { data: me } = useMe();
  const isAdmin = me?.role === 'admin';
  const overview = useAdminOverview(isAdmin);
  const shortcuts: Shortcut[] = [
    { title: '배달기사 화면', sub: me?.onboarded ? '보호 · 기록 · 설정 (내 계정으로)' : '가입 정보를 먼저 입력해요', href: me?.onboarded ? '/home' : '/onboarding' },
    { title: '관제사 화면', sub: '라이더 목록 · 지도 · 사고 접수 · 대체 배차', href: '/control' },
    { title: '통합 시연', sub: '라이더 · 관제 · 센서 파형을 나란히', href: '/demo', tab: true },
    { title: '실험·시뮬레이션 결과', sub: '29조건 실측 vs 이론값 · 판정 근거', href: '/demo/results', tab: true },
    { title: '사건 보고서 (시연)', sub: '마지막 시연 사건', href: '/demo/report', tab: true },
    { title: '운영 모니터 (서버)', sub: '모니터 토큰이 필요해요', url: `${API_URL}/ops` },
  ];

  return (
    <ScrollView style={styles.page} contentContainerStyle={styles.content}>
      <Head>
        <title>Rider Guard 관리자</title>
      </Head>
      <AccountBar title="Rider Guard 관리자" sub="모든 화면 · 실제 운영 현황" />

      <View style={styles.grid}>
        {shortcuts.map((s) => (
          <Pressable key={s.title} onPress={() => open(s)} accessibilityRole="link" style={({ pressed }) => [styles.card, pressed && styles.cardPressed]}>
            <Txt style={styles.cardTitle}>{`${s.title}${s.url || s.tab ? ' ↗' : ''}`}</Txt>
            <Txt style={styles.cardSub}>{s.sub}</Txt>
          </Pressable>
        ))}
      </View>

      <Txt style={styles.h2}>운영 현황 — 실제 서버 데이터</Txt>
      {overview.error ? <Notice error={overview.error} onRetry={() => void overview.refetch()} /> : null}
      {overview.data ? <Overview o={overview.data} /> : !overview.error ? <Txt style={styles.meta}>불러오는 중</Txt> : null}
    </ScrollView>
  );
}

function Overview({ o }: { o: AdminOverviewDto }) {
  return (
    <>
      <View style={styles.stats}>
        <Stat n={String(o.riders.total)} label="가입 계정" />
        <Stat n={String(o.riders.onSession)} label="지금 운행 중" />
        <Stat n={String(o.riders.dispatchers)} label="관제사 계정" />
        <Stat n={`${o.ruleCheck.matched}/${o.ruleCheck.total}`} label={`실측 기록 규칙 대조 (${o.ruleCheck.ruleVersion})`} />
      </View>

      <View style={styles.panel}>
        <Txt style={styles.panelTitle}>{`최근 사고 ${o.incidents.length}건`}</Txt>
        <View style={[styles.tr, styles.th]}>
          {['감지', '라이더', '상태', '출처', '데이터', '결과'].map((h) => (
            <Txt key={h} style={[styles.thText, styles.cell]}>{h}</Txt>
          ))}
        </View>
        {o.incidents.length === 0 ? <Txt style={styles.meta}>아직 사고 기록이 없어요</Txt> : null}
        {o.incidents.map((i) => (
          <View key={i.id} style={styles.tr}>
            <Txt style={[styles.td, styles.cell]}>{time(i.detectedAt)}</Txt>
            <Txt style={[styles.td, styles.cell]}>{i.riderName ?? '이름 없음'}</Txt>
            <View style={styles.cell}>
              <Badge tone={STATUS[i.status]?.tone ?? 'neutral'} size="sm">{STATUS[i.status]?.label ?? i.status}</Badge>
            </View>
            <Txt style={[styles.td, styles.cell]}>{SOURCE[i.source] ?? i.source}</Txt>
            <Txt style={[styles.td, styles.cell]}>{i.dataSource === 'measured' ? '실측' : i.dataSource === 'mock' ? '모의' : i.dataSource === 'simulation' ? '시뮬레이션' : '—'}</Txt>
            <Txt style={[styles.td, styles.cell]}>{i.resolution ? RESOLUTION[i.resolution] ?? i.resolution : '진행 중'}</Txt>
          </View>
        ))}
      </View>

      <View style={styles.panel}>
        <Txt style={styles.panelTitle}>{`최근 센서 판정 ${o.judgments.length}건`}</Txt>
        <View style={[styles.tr, styles.th]}>
          {['받은 시각', '라이더', '보낸 곳', '모드', '판정', '처리'].map((h) => (
            <Txt key={h} style={[styles.thText, styles.cell]}>{h}</Txt>
          ))}
        </View>
        {o.judgments.length === 0 ? <Txt style={styles.meta}>아직 판정 기록이 없어요</Txt> : null}
        {o.judgments.map((j) => (
          <View key={j.id} style={styles.tr}>
            <Txt style={[styles.td, styles.cell]}>{time(j.receivedAt)}</Txt>
            <Txt style={[styles.td, styles.cell]}>{j.rider ?? '—'}</Txt>
            <Txt style={[styles.td, styles.cell]} numberOfLines={1}>{j.producer ?? '—'}</Txt>
            <Txt style={[styles.td, styles.cell]}>{j.mode}</Txt>
            <Txt style={[styles.td, styles.cell]}>{DECISION[j.decision] ?? j.decision}</Txt>
            <Txt style={[styles.td, styles.cell]} numberOfLines={1}>{`${j.action}${j.reason ? ` (${j.reason})` : ''}`}</Txt>
          </View>
        ))}
      </View>
    </>
  );
}

function Stat({ n, label }: { n: string; label: string }) {
  return (
    <View style={styles.stat}>
      <Txt style={styles.statN}>{n}</Txt>
      <Txt style={styles.meta}>{label}</Txt>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.bg },
  content: { padding: 24, gap: 16, maxWidth: 1400, width: '100%', alignSelf: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12 },
  card: { flexGrow: 1, flexBasis: 280, backgroundColor: colors.surface, borderRadius: radius.card, padding: 18, gap: 4, borderWidth: 1.5, borderColor: 'transparent' },
  cardPressed: { borderColor: colors.asphalt },
  cardTitle: { ...font.sans(800), fontSize: 17, color: colors.text },
  cardSub: { ...typography.caption },
  h2: { ...font.sans(800), fontSize: 18, color: colors.text, marginTop: 8 },
  stats: { flexDirection: 'row', gap: 12, flexWrap: 'wrap' },
  stat: { flex: 1, minWidth: 180, backgroundColor: colors.surface, borderRadius: radius.card, padding: 14 },
  statN: { ...font.mono(700), fontSize: 24, color: colors.text },
  panel: { backgroundColor: colors.surface, borderRadius: radius.card, padding: 14, gap: 2 },
  panelTitle: { ...font.sans(700), fontSize: 14, color: colors.text, marginBottom: 4 },
  tr: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingVertical: 7, borderTopWidth: 1, borderTopColor: colors.divider },
  th: { borderTopWidth: 0 },
  thText: { ...font.sans(600), fontSize: 12, color: colors.textFaint },
  td: { ...font.sans(500), fontSize: 13, color: colors.text },
  cell: { flex: 1, minWidth: 0 },
  meta: { ...typography.meta },
});
