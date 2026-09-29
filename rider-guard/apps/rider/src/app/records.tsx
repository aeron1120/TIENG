// 사고 기록 — v2 화면설계에는 없는 화면이라 v2·5 홈 톤(흰 카드 · 목록 행 · 하단 탭)으로 외삽했다.
// 보험·산재 접수에 쓸 수 있게 모든 감지 기록을 남기고, 기록을 글로 공유한다(서버 PDF 생성은 없다).
import type { IncidentSummaryDto } from '@rider-guard/contract';
import { router } from 'expo-router';
import { useRef } from 'react';
import { Platform, Share, StyleSheet, View } from 'react-native';

import { isOpenStatus, useIncidents } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { Notice } from '@/components/forms';
import { AlertIcon, CheckIcon, DocIcon, ShieldCheckIcon, type IconComponent } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, Divider, FadeIn, IconHalo, ListGroup, ListRow, Screen, Skeleton, Txt, type BadgeTone } from '@/components/ui';
import { contactText, dayLabel, hm, orderText, placeText, recordShareText, recordSummary, recordTag, responseText } from '@/lib/format';
import { colors, font, radius, typography } from '@/theme';

// status 화면이 from=records 를 보고 '기록으로' 돌아온다
const openStatus = (id: string) => router.push({ pathname: '/status', params: { id, from: 'records' } });

/** 결과별 모양 — 진행 중은 빨강(실시간 점), 대응 완료는 보라 체크, 오탐은 회색 */
type Outcome = 'open' | 'done' | 'falseAlarm';
const outcomeOf = (r: IncidentSummaryDto): Outcome => (isOpenStatus(r.status) ? 'open' : r.resolution === 'false_alarm' ? 'falseAlarm' : 'done');

const OUTCOME: Record<Outcome, { tone: BadgeTone; icon: IconComponent; color: string; soft: string }> = {
  open: { tone: 'danger', icon: AlertIcon, color: colors.danger, soft: colors.dangerSoft },
  done: { tone: 'primary', icon: ShieldCheckIcon, color: colors.primary, soft: colors.primarySoft },
  falseAlarm: { tone: 'neutral', icon: CheckIcon, color: colors.textMuted, soft: colors.surfaceMuted },
};

function OutcomeBadge({ record, size }: { record: IncidentSummaryDto; size?: 'sm' | 'md' }) {
  const o = outcomeOf(record);
  return (
    <Badge tone={OUTCOME[o].tone} size={size} live={o === 'open'} check={o === 'done'}>
      {recordTag(record)}
    </Badge>
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
    <Screen top={52} bottom={24} gap={18} enter="none" footer={<BottomNav active="records" />}>
      <FadeIn style={styles.head}>
        <Txt accessibilityRole="header" style={typography.title}>
          사고 기록
        </Txt>
        <Txt style={styles.lead}>보험·산재 접수에 쓸 수 있도록 모든 감지 기록을 보관해요.</Txt>
      </FadeIn>

      {/* 받아 둔 목록이 있으면 그대로 두고 위에 한 줄만 — 새로고침 실패로 기록을 가리지 않게 */}
      {error ? <Notice error={error} onRetry={retry} /> : null}

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
          <Txt accessibilityRole="header" style={styles.sectionTitle}>
            이전 기록
          </Txt>
          <ListGroup>
            {past.map((r) => {
              const o = OUTCOME[outcomeOf(r)];
              const Icon = o.icon;
              return (
                <ListRow
                  key={r.id}
                  icon={<Icon size={20} color={o.color} />}
                  label={<Txt style={typography.bodyStrong}>{when(r.detectedAt, false)}</Txt>}
                  sub={recordSummary(r)}
                  right={<OutcomeBadge record={r} size="sm" />}
                  chevron
                  onPress={() => openStatus(r.id)}
                  accessibilityLabel={`${when(r.detectedAt)}, ${recordSummary(r).replace(' → ', ', ')}, ${recordTag(r)}`}
                  accessibilityHint="대응 과정을 봐요"
                />
              );
            })}
          </ListGroup>
        </FadeIn>
      ) : null}
    </Screen>
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

function LatestCard({ record }: { record: IncidentSummaryDto }) {
  const toast = useToast();
  const busy = useRef(false);
  const o = OUTCOME[outcomeOf(record)];
  const Icon = o.icon;
  // 비어 있는 값은 흐리게 — 기록이 없는 칸이 결과처럼 굵게 보이지 않게
  const facts = [
    { label: '감지 위치', value: placeText(record), empty: !record.location },
    { label: '라이더 응답', value: responseText(record), empty: record.riderResponse == null && record.escalationReason !== 'no_response' },
    { label: '비상연락', value: contactText(record), empty: record.notifiedPriorities.length === 0 },
    { label: '주문 처리', value: orderText(record), empty: !record.orderStatus },
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
      <View style={styles.latestHead}>
        <View style={[styles.kindCircle, { backgroundColor: o.soft }]}>
          <Icon size={22} color={o.color} />
        </View>
        <View style={styles.latestTitle}>
          <Txt style={typography.heading}>{kindText(record)}</Txt>
          <Txt style={typography.caption}>{when(record.detectedAt)}</Txt>
        </View>
        <OutcomeBadge record={record} />
      </View>

      <Divider />

      <View style={styles.facts}>
        {facts.map((f) => (
          <View key={f.label} style={styles.fact} accessible accessibilityLabel={`${f.label}, ${f.value}`}>
            <Txt style={styles.factLabel}>{f.label}</Txt>
            <Txt style={[styles.factValue, f.empty && styles.factEmpty]} numberOfLines={2}>
              {f.value}
            </Txt>
          </View>
        ))}
      </View>

      <View style={styles.actions}>
        <Button label="대응 과정" variant="outline" size="md" style={styles.action} onPress={() => openStatus(record.id)} />
        <Button label={canShare ? '기록 공유' : '기록 복사'} variant="soft" size="md" style={styles.action} onPress={() => void share()} />
      </View>
    </Card>
  );
}

/** 기록이 하나도 없을 때 — 비어 있는 게 정상이라는 느낌으로 차분하게 */
function EmptyRecords() {
  return (
    <FadeIn delay={40} style={styles.empty}>
      <IconHalo size={72} ringWidth={20}>
        <DocIcon size={30} color={colors.textOnDark} />
      </IconHalo>
      <View style={styles.emptyText}>
        <Txt accessibilityRole="header" style={[typography.heading, styles.center]}>
          아직 감지 기록이 없어요
        </Txt>
        <Txt style={[styles.lead, styles.center]}>보호 중에 사고가 감지되면{'\n'}대응 과정이 여기에 자동으로 남아요.</Txt>
      </View>
    </FadeIn>
  );
}

/** 불러오는 동안 최근 감지 카드와 이전 기록 두 줄의 자리를 잡아 둔다 */
function RecordsSkeleton() {
  return (
    <View style={styles.skeleton} accessibilityLabel="사고 기록을 불러오는 중이에요">
      <View style={styles.section}>
        <Skeleton width={56} height={13} style={styles.sectionSkel} />
        <Card style={styles.latest}>
          <View style={styles.latestHead}>
            <Skeleton width={44} height={44} radius={22} />
            <View style={styles.latestTitle}>
              <Skeleton width={96} height={20} />
              <Skeleton width={150} height={13} />
            </View>
            <Skeleton width={72} height={26} radius={radius.pill} />
          </View>
          <Divider />
          <View style={styles.facts}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.fact}>
                <Skeleton width={64} height={14} />
                <Skeleton width={i % 2 ? 96 : 120} height={15} />
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
        <Skeleton width={56} height={13} style={styles.sectionSkel} />
        <ListGroup>
          {[0, 1].map((i) => (
            <View key={i} style={styles.rowSkel}>
              <Skeleton width={20} height={20} radius={10} />
              <View style={styles.rowSkelText}>
                <Skeleton width={96} height={15} />
                <Skeleton width={150} height={13} />
              </View>
              <Skeleton width={56} height={20} radius={radius.pill} />
            </View>
          ))}
        </ListGroup>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  lead: { ...typography.body, color: colors.textMuted },
  center: { textAlign: 'center' },
  section: { gap: 8 },
  sectionTitle: { ...typography.section, paddingHorizontal: 4 },
  sectionSkel: { marginHorizontal: 4, marginVertical: 2 },
  latest: { padding: 20, gap: 16 },
  latestHead: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  kindCircle: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center' },
  latestTitle: { flex: 1, gap: 2 },
  facts: { gap: 12 },
  fact: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16 },
  factLabel: { ...typography.body, fontSize: 14, color: colors.textMuted },
  factValue: { ...typography.bodyStrong, flexShrink: 1, textAlign: 'right' },
  factEmpty: { ...font.sans(400), color: colors.textFaint },
  actions: { flexDirection: 'row', gap: 8, marginTop: 4 },
  action: { flex: 1 },
  empty: { flexGrow: 1, alignItems: 'center', justifyContent: 'center', gap: 20, paddingBottom: 48 },
  emptyText: { alignItems: 'center', gap: 6 },
  skeleton: { gap: 18 },
  rowSkel: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 72, paddingHorizontal: 18 },
  rowSkelText: { flex: 1, gap: 6 },
});
