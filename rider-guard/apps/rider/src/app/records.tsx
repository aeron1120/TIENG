// 사고 기록 — v3 디자인에 없는 화면이라 v3·5 홈 톤(콘크리트 바탕 · 흰 카드 · 회색 보조 글자 · 아스팔트 강조)으로 외삽했다.
// 평소 화면이라 빨강을 쓰지 않는다 — 대응 중은 아스팔트, 대응 완료는 보호 초록, 오탐은 회색.
// 보험·산재 접수에 쓸 수 있게 모든 감지 기록을 남기고, 기록을 글로 공유한다(서버 PDF 생성은 없다).
import type { IncidentSummaryDto } from '@rider-guard/contract';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';

import { isOpenStatus, useIncidents } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { Notice } from '@/components/forms';
import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  DocIcon,
  MapPinIcon,
  PhoneIcon,
  ShieldCheckIcon,
  WaveformIcon,
  type IconComponent,
} from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, Divider, FadeIn, IconCircle, IconHalo, ListGroup, LiveDot, PressableScale, Screen, Skeleton, Txt, type BadgeTone } from '@/components/ui';
import { contactText, dayLabel, hm, orderText, placeText, recordShareText, recordSummary, recordTag, responseText } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

// status 화면이 from=records 를 보고 '기록으로' 돌아온다
const openStatus = (id: string) => router.push({ pathname: '/status', params: { id, from: 'records' } });

/** 결과별 모양 — 대응 중은 아스팔트(깜빡이는 점), 대응 완료는 보호 초록 체크, 오탐은 회색 */
type Outcome = 'open' | 'done' | 'falseAlarm';
const outcomeOf = (r: IncidentSummaryDto): Outcome => (isOpenStatus(r.status) ? 'open' : r.resolution === 'false_alarm' ? 'falseAlarm' : 'done');

const OUTCOME: Record<Outcome, { tone: BadgeTone; icon: IconComponent; color: string; circle: string }> = {
  // 대응 중 카드는 배지·'대응 과정' 버튼이 아스팔트라 원은 연석으로 한 단계 낮춘다
  open: { tone: 'dark', icon: AlertIcon, color: colors.asphalt, circle: colors.curb },
  done: { tone: 'green', icon: ShieldCheckIcon, color: colors.green, circle: colors.greenSoft },
  falseAlarm: { tone: 'neutral', icon: CheckIcon, color: colors.textMuted, circle: colors.surfaceMuted },
};

function OutcomeBadge({ record, size }: { record: IncidentSummaryDto; size?: 'sm' | 'md' }) {
  const o = outcomeOf(record);
  return (
    <Badge
      tone={OUTCOME[o].tone}
      size={size}
      check={o === 'done'}
      // 대응 중 — 아스팔트 배지 위 흰 점이 깜빡인다 (평소 화면이라 빨강 대신)
      leading={o === 'open' ? <LiveDot color={colors.textOnDark} size={6} /> : undefined}
    >
      {recordTag(record)}
    </Badge>
  );
}

function OutcomeCircle({ record, size }: { record: IncidentSummaryDto; size: number }) {
  const o = OUTCOME[outcomeOf(record)];
  const Icon = o.icon;
  return (
    <IconCircle size={size} color={o.circle}>
      <Icon size={Math.round(size * 0.46)} color={o.color} />
    </IconCircle>
  );
}

const kindText = (r: IncidentSummaryDto) => (r.kind === 'fall' ? '전도 감지' : '충격 감지');

/** '9월 30일 수요일 · 02:51' — 올해가 아니면 연도를 앞에 붙인다 */
function when(iso: string, withWeekday = true): string {
  const d = new Date(iso);
  const year = d.getFullYear() !== new Date().getFullYear() ? `${d.getFullYear()}년 ` : '';
  const day = withWeekday ? dayLabel(d) : `${d.getMonth() + 1}월 ${d.getDate()}일`;
  return `${year}${day} · ${hm(iso)}`;
}

export default function RecordsScreen() {
  const { data, error, isPending, refetch } = useIncidents();
  const [latest, ...past] = data?.items ?? [];
  const retry = () => void refetch();

  return (
    <Screen top={56} side={16} bottom={28} gap={0} enter="none" footer={<BottomNav active="records" />}>
      {/* 홈 머리글과 같은 자리·크기 — 탭을 바꿔도 제목이 튀지 않게 */}
      <FadeIn style={styles.header}>
        <Txt style={styles.kicker}>보험·산재 접수에 쓸 수 있어요</Txt>
        <Txt accessibilityRole="header" style={styles.title}>
          사고 기록
        </Txt>
      </FadeIn>

      {/* 받아 둔 목록이 있으면 그대로 두고 위에 한 줄만 — 새로고침 실패로 기록을 가리지 않게 */}
      {error ? <Notice error={error} onRetry={retry} style={styles.notice} /> : null}

      {isPending && !error ? <RecordsSkeleton /> : null}
      {data && !latest ? <EmptyRecords /> : null}

      {latest ? (
        <FadeIn delay={40} style={styles.section}>
          <Txt accessibilityRole="header" style={styles.sectionTitle}>
            최근 감지
          </Txt>
          <LatestCard record={latest} />
        </FadeIn>
      ) : null}

      {past.length > 0 ? (
        <FadeIn delay={80} style={styles.section}>
          <View style={styles.sectionHead}>
            <Txt accessibilityRole="header" style={styles.sectionTitleText}>
              이전 기록
            </Txt>
            <Txt style={styles.count}>{past.length}건</Txt>
          </View>
          <ListGroup>
            {past.map((r) => (
              <RecordRow key={r.id} record={r} />
            ))}
          </ListGroup>
        </FadeIn>
      ) : null}
    </Screen>
  );
}

/** 이전 기록 한 줄 — 결과 원 · 날짜·시각 · 요약 · 배지 · > */
function RecordRow({ record }: { record: IncidentSummaryDto }) {
  const summary = recordSummary(record);
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${when(record.detectedAt)}, ${summary.replace(' → ', ', ')}, ${recordTag(record)}`}
      accessibilityHint="대응 과정을 봐요"
      onPress={() => openStatus(record.id)}
      style={styles.row}
      pressedStyle={styles.pressed}
    >
      <OutcomeCircle record={record} size={36} />
      <View style={styles.rowMain}>
        <Txt style={styles.rowTitle} numberOfLines={1}>
          {when(record.detectedAt, false)}
        </Txt>
        <Txt style={styles.rowSub} numberOfLines={1}>
          {summary}
        </Txt>
      </View>
      <OutcomeBadge record={record} size="sm" />
      <ChevronRightIcon size={18} color={colors.textFaint} />
    </PressableScale>
  );
}

type ShareResult = 'shared' | 'copied' | 'cancelled' | 'failed';

/**
 * 앱은 공유 시트, 웹은 브라우저 공유 기능을 쓴다. 웹에 공유 기능이 없거나(데스크톱 대부분) 막히면 클립보드에 복사한다.
 * (react-native-web 의 Share 는 navigator.share 가 없으면 그냥 실패한다)
 */
async function shareText(text: string): Promise<ShareResult> {
  if (Platform.OS !== 'web') {
    try {
      const r = await Share.share({ message: text });
      return r.action === Share.dismissedAction ? 'cancelled' : 'shared';
    } catch {
      return 'failed';
    }
  }
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ text });
      return 'shared';
    } catch (e) {
      // 사용자가 공유 창을 닫았으면 복사까지 하지 않는다
      if ((e as { name?: string } | null)?.name === 'AbortError') return 'cancelled';
    }
  }
  try {
    if (!navigator.clipboard) return 'failed';
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'failed';
  }
}

/** 웹에서 공유 기능이 없으면 버튼 이름부터 '복사'로 — 눌렀을 때 일어날 일과 맞게 */
const canShare = Platform.OS !== 'web' || (typeof navigator !== 'undefined' && typeof navigator.share === 'function');

type Fact = { key: string; icon: IconComponent; label: string; value: string; empty: boolean };

/** 가장 최근 감지 — 결과 · 네 칸(위치·응답·비상연락·주문) · 대응 과정/공유 */
function LatestCard({ record }: { record: IncidentSummaryDto }) {
  const toast = useToast();
  const busy = useRef(false);
  const open = outcomeOf(record) === 'open';
  // 비어 있는 값은 흐리게 — 기록이 없는 칸이 결과처럼 굵게 보이지 않게
  const facts: Fact[] = [
    { key: 'place', icon: MapPinIcon, label: '감지 위치', value: placeText(record), empty: !record.location },
    {
      key: 'response',
      icon: WaveformIcon,
      label: '라이더 응답',
      value: responseText(record),
      empty: record.riderResponse == null && record.escalationReason !== 'no_response',
    },
    { key: 'contact', icon: PhoneIcon, label: '비상연락', value: contactText(record), empty: record.notifiedPriorities.length === 0 },
    { key: 'order', icon: DocIcon, label: '주문 처리', value: orderText(record), empty: !record.orderStatus },
  ];

  const share = async () => {
    // 공유 창이 떠 있는 동안 다시 누르면 웹 공유 API 가 오류를 낸다
    if (busy.current) return;
    busy.current = true;
    const result = await shareText(recordShareText(record));
    busy.current = false;
    if (result === 'copied') toast.show('기록을 복사했어요');
    else if (result === 'failed') toast.error(Platform.OS === 'web' ? '이 브라우저에서는 공유할 수 없어요' : '공유하지 못했어요. 다시 시도해 주세요');
  };

  return (
    <Card style={styles.latest}>
      <View style={styles.latestHead} accessible accessibilityLabel={`${kindText(record)}, ${when(record.detectedAt)}, ${recordTag(record)}`}>
        <OutcomeCircle record={record} size={44} />
        <View style={styles.latestText}>
          <Txt style={styles.latestTitle}>{kindText(record)}</Txt>
          <Txt style={styles.latestWhen}>{when(record.detectedAt)}</Txt>
        </View>
        <OutcomeBadge record={record} />
      </View>

      <Divider style={styles.latestDivider} />

      {/* 홈 아래 칸(헬멧 · 음성 응답 · 위치 수집)과 같은 모양 — 두 칸씩 두 줄 */}
      <View style={styles.grid}>
        {[facts.slice(0, 2), facts.slice(2)].map((pair, row) => (
          <View key={row} style={styles.gridRow}>
            {pair.map((f, i) => (
              <View key={f.key} style={styles.gridCellWrap}>
                {i > 0 ? <View style={styles.vline} /> : null}
                <FactCell fact={f} />
              </View>
            ))}
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button
          label="대응 과정"
          variant={open ? 'primary' : 'white'}
          size="md"
          style={styles.action}
          onPress={() => openStatus(record.id)}
          accessibilityHint="시각별 대응 과정을 봐요"
        />
        <Button label={canShare ? '기록 공유' : '기록 복사'} variant="soft" size="md" style={styles.action} onPress={() => void share()} />
      </View>
    </Card>
  );
}

function FactCell({ fact }: { fact: Fact }) {
  const Icon = fact.icon;
  return (
    <View style={styles.cell} accessible accessibilityLabel={`${fact.label}, ${fact.value}`}>
      <View style={styles.cellHead}>
        <Icon size={14} color={colors.textFaint} strokeWidth={1.8} />
        <Txt style={styles.cellLabel}>{fact.label}</Txt>
      </View>
      <Txt style={[styles.cellValue, fact.empty && styles.cellEmpty]} numberOfLines={2}>
        {fact.value}
      </Txt>
    </View>
  );
}

/** 기록이 하나도 없을 때 — 비어 있는 게 정상이라는 느낌으로 차분하게 */
function EmptyRecords() {
  return (
    <FadeIn delay={40} style={styles.empty}>
      <IconHalo size={64} ringWidth={14}>
        <DocIcon size={26} color={colors.textOnDark} />
      </IconHalo>
      <View style={styles.emptyText}>
        <Txt accessibilityRole="header" style={styles.emptyTitle}>
          아직 감지 기록이 없어요
        </Txt>
        <Txt style={styles.emptyLead}>보호 중에 사고가 감지되면{'\n'}대응 과정이 여기에 자동으로 남아요.</Txt>
      </View>
    </FadeIn>
  );
}

/** 불러오는 동안 최근 감지 카드와 이전 기록 두 줄의 자리를 잡아 둔다 */
function RecordsSkeleton() {
  return (
    <View accessibilityLabel="사고 기록을 불러오는 중이에요">
      <View style={styles.section}>
        <Skeleton width={52} height={13} style={styles.sectionSkel} />
        <Card style={styles.latest}>
          <View style={styles.latestHead}>
            <Skeleton width={44} height={44} radius={22} />
            <View style={[styles.latestText, styles.skelText]}>
              <Skeleton width={84} height={18} />
              <Skeleton width={150} height={13} />
            </View>
            <Skeleton width={70} height={26} radius={radius.pill} />
          </View>
          <Divider style={styles.latestDivider} />
          <View style={styles.grid}>
            {[0, 1].map((row) => (
              <View key={row} style={styles.gridRow}>
                {[0, 1].map((i) => (
                  <View key={i} style={styles.gridCellWrap}>
                    {i > 0 ? <View style={styles.vline} /> : null}
                    <View style={[styles.cell, styles.skelText]}>
                      <Skeleton width={64} height={12} style={styles.skelLabel} />
                      <Skeleton width={i ? 88 : 112} height={16} />
                    </View>
                  </View>
                ))}
              </View>
            ))}
          </View>
          <View style={styles.actions}>
            <Skeleton width="48%" height={52} radius={radius.input} style={styles.action} />
            <Skeleton width="48%" height={52} radius={radius.input} style={styles.action} />
          </View>
        </Card>
      </View>
      <View style={styles.section}>
        <Skeleton width={52} height={13} style={styles.sectionSkel} />
        <ListGroup>
          {[0, 1].map((i) => (
            <View key={i} style={styles.row}>
              <Skeleton width={36} height={36} radius={18} />
              <View style={[styles.rowMain, styles.skelText]}>
                <Skeleton width={96} height={15} />
                <Skeleton width={150} height={13} />
              </View>
              <Skeleton width={48} height={20} radius={radius.pill} />
            </View>
          ))}
        </ListGroup>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  // 홈 머리글('안녕하세요' + '[이름]님')과 같은 글자·위치
  header: { paddingHorizontal: 8, minHeight: 50, justifyContent: 'center' },
  kicker: { ...font.sans(500), fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textMuted },
  title: { ...font.sans(800), fontSize: 24, lineHeight: 30, letterSpacing: -0.8, color: colors.text },
  notice: { marginTop: 16 },
  section: { marginTop: 22, gap: 8 },
  sectionTitle: { ...typography.section, paddingHorizontal: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 8 },
  sectionTitleText: typography.section,
  count: { ...typography.meta },
  sectionSkel: { marginHorizontal: 8, marginVertical: 2 },

  latest: { paddingTop: 18, paddingHorizontal: 18, paddingBottom: 18 },
  latestHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  latestText: { flex: 1, minWidth: 0, gap: 1 },
  latestTitle: { ...font.sans(700), fontSize: 17, lineHeight: 23, letterSpacing: -0.5, color: colors.text },
  latestWhen: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.3, color: colors.textMuted },
  latestDivider: { marginTop: 16 },
  grid: { paddingTop: 12, gap: 14 },
  gridRow: { flexDirection: 'row' },
  gridCellWrap: { flex: 1, minWidth: 0, flexDirection: 'row' },
  vline: { width: 1, marginVertical: 2, marginRight: 14, backgroundColor: colors.divider },
  cell: { flex: 1, minWidth: 0, paddingLeft: 2 },
  cellHead: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  cellLabel: { ...typography.meta, letterSpacing: -0.3 },
  cellValue: { ...font.sans(700), fontSize: 15, lineHeight: 20, letterSpacing: -0.3, color: colors.text, marginTop: 4 },
  cellEmpty: { ...font.sans(500), color: colors.textFaint },
  actions: { flexDirection: 'row', gap: 8, marginTop: 18 },
  action: { flex: 1 },

  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 68, paddingVertical: 14, paddingLeft: 14, paddingRight: 12 },
  pressed: { backgroundColor: colors.surfacePressed },
  rowMain: { flex: 1, minWidth: 0, gap: 2 },
  rowTitle: { ...font.sans(700), fontSize: 15, lineHeight: 20, letterSpacing: -0.3, color: colors.text },
  rowSub: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.3, color: colors.textMuted },

  empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingBottom: 56 },
  emptyText: { alignItems: 'center', gap: 6 },
  emptyTitle: { ...typography.heading, textAlign: 'center' },
  emptyLead: { ...typography.lead, fontSize: 14, lineHeight: 21, textAlign: 'center' },
  skelText: { gap: 8 },
  skelLabel: { marginTop: 2 },
});
