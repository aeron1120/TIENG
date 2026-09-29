// 디자인: spec-v2 08 (v2·8 자동 대응 진행) — 사고 대응 진행 상황
import type { ContactDto, IncidentDetailDto, IncidentStep, OrderDto, StepState } from '@rider-guard/contract';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Platform, Share, StyleSheet, View } from 'react-native';

import { isOpenStatus, useIncident, useMe, useRespond } from '@/api/hooks';
import { ErrorText, Header, Notice } from '@/components/forms';
import { CheckIcon, PhoneIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import {
  Badge,
  Button,
  Card,
  Divider,
  FadeIn,
  FadeSwap,
  ProgressBar,
  PulseHalo,
  Screen,
  Sheet,
  Skeleton,
  Spacer,
  Txt,
  useReducedMotion,
  type BadgeTone,
} from '@/components/ui';
import { clock, elapsed, stepText } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

type StepOf<K extends IncidentStep['key']> = Extract<IncidentStep, { key: K }>;
const findStep = <K extends IncidentStep['key']>(incident: IncidentDetailDto, key: K) =>
  incident.steps.find((s): s is StepOf<K> => s.key === key);

// ── 문구 ───────────────────────────────────────────────────────

type Head = { badge: string; tone: BadgeTone; live: boolean; title: string; lead: string | null };

/** 머리 배지·제목. 진행 중에는 지금 가장 중요한 사실(119 실패 > 연락처 확인 > 연락처 없음)을 제목으로 올린다. */
function headline(incident: IncidentDetailDto): Head {
  const contacts = findStep(incident, 'contacts')?.detail;
  const delivery = findStep(incident, 'emergency')?.detail.delivery;
  switch (incident.status) {
    case 'cancelled':
      return { badge: '오탐', tone: 'white', live: false, title: '오탐으로 기록됐어요', lead: '괜찮다고 응답해서 아무에게도 연락하지 않았어요.' };
    case 'resolved':
      return {
        badge: '대응 종료',
        tone: 'white',
        live: false,
        title:
          incident.resolution === 'false_alarm' ? '오탐으로 확인됐어요' : incident.resolution === 'rider_ok' ? '괜찮다고 알렸어요' : '사고 대응이 끝났어요',
        lead: '사고기록은 보험·산재 접수에 쓸 수 있도록 보관돼요.',
      };
    case 'countdown':
      // '응답이 없으면 비상연락처와 119에 알려요'는 아래 '지금 단계' 카드가 이름까지 넣어 말한다
      return { badge: '응답 기다리는 중', tone: 'primary', live: true, title: '괜찮은지\n확인하고 있어요', lead: null };
    case 'escalated': {
      const base = { badge: '자동 대응 중', tone: 'danger', live: true } as const;
      if (delivery === 'failed') {
        return {
          ...base,
          title: '119에 직접\n전화해 주세요',
          lead: contacts?.reason === 'no_contacts' ? '자동 신고 문자가 전달되지 않았어요.' : '자동 신고 문자가 전달되지 않았어요. 비상연락처 알림은 계속돼요.',
        };
      }
      if (contacts?.acknowledgedBy) return { ...base, title: `${contacts.acknowledgedBy}님이\n확인했어요`, lead: '비상연락처가 상황을 알고 있어요.' };
      if (contacts?.reason === 'no_contacts') {
        return {
          ...base,
          title: delivery === 'sent' ? '119에 자동으로\n신고했어요' : '119에 자동으로\n신고하고 있어요',
          lead: '등록된 비상연락처가 없어서 119에만 알려요.',
        };
      }
      return { ...base, title: '가까운 사람에게\n알리고 있어요', lead: null };
    }
  }
}

type Stage = { title: string; desc: string; next: string | null; warn: boolean };

/**
 * 남색 '지금 단계' 카드. 다음 순위 이름은 서버가 주지 않아 내 연락처 목록에서 찾는다 —
 * 목록을 아직 못 받았으면 이름 없이 말한다(없다고 단정하지 않게).
 */
function currentStage(incident: IncidentDetailDto, contacts: ContactDto[] | undefined): Stage {
  const sorted = contacts ? [...contacts].sort((a, b) => a.priority - b.priority) : undefined;
  const after = (p: number) => sorted?.find((c) => c.priority > p);

  if (incident.status === 'countdown') {
    const first = sorted?.[0];
    const next = !sorted
      ? '응답이 없으면 비상연락처와 119에 자동으로 알려요.'
      : first
        ? `응답이 없으면 ${first.priority}순위 ${first.name}에게 문자를 보내고 119에 신고해요.`
        : '응답이 없으면 119에 자동으로 신고해요.';
    return { title: '괜찮은지 확인하는 중', desc: '확인 화면에서 괜찮은지 알려 주세요', next, warn: false };
  }

  const delivery = findStep(incident, 'emergency')?.detail.delivery;
  if (delivery === 'failed') return { title: '119 자동 신고 실패', desc: '아래 119 전화 버튼으로 직접 신고해 주세요', next: null, warn: true };

  const d = findStep(incident, 'contacts')?.detail;
  if (!d || d.reason === 'no_contacts') {
    if (delivery === 'sent') return { title: '119 자동 신고 완료', desc: '위치와 라이더 정보를 담아 문자로 신고했어요', next: null, warn: false };
    const late = delivery === 'retrying';
    return { title: '119 자동 신고 중', desc: late ? '신고가 늦어지고 있어요. 위급하면 직접 전화해 주세요' : '신고 문자를 보내고 있어요', next: null, warn: late };
  }
  if (d.acknowledgedBy) return { title: '비상연락처 확인 완료', desc: `${d.acknowledgedBy}님이 확인해서 다음 순위에게는 더 알리지 않아요`, next: null, warn: false };
  if (!d.notified.length) {
    return {
      title: '비상연락 문자 보내는 중',
      desc: d.failed ? '문자 발송이 늦어지고 있어요. 119 신고는 따로 진행돼요' : '1순위부터 위치 링크와 함께 알려요',
      next: null,
      warn: d.failed > 0,
    };
  }
  const last = d.notified.reduce((a, b) => (b.priority > a.priority ? b : a));
  if (d.pending > 0) {
    const nx = after(last.priority);
    return {
      title: `${last.priority}순위 ${last.name} 확인 대기`,
      desc: '문자와 위치 링크를 보냈어요',
      next: nx ? `확인이 없으면 ${nx.priority}순위 ${nx.name}에게 자동으로 넘어가요.` : '확인이 없으면 다음 순위에게 자동으로 넘어가요.',
      warn: false,
    };
  }
  const many = d.notified.length > 1;
  return {
    title: many ? '비상연락처 확인 대기' : `${last.priority}순위 ${last.name} 확인 대기`,
    desc: many ? `${d.notified.length}명에게 문자와 위치 링크를 보냈어요` : '문자와 위치 링크를 보냈어요',
    next: null,
    warn: false,
  };
}

type Meter = { timer: { label: string; ms: number }; value: number; label: string };

/**
 * 카드 오른쪽 큰 숫자와 진행바. 기한은 카운트다운 마감(deadlineAt)만 서버가 준다 — 비상연락 중에는
 * 다음 순위까지 남은 시간을 모르니 지어내지 않고 감지 후 지난 시간을 보여 준다.
 * 진행바는 카운트다운이면 남은 시간, 비상연락 중이면 알린 연락처 비율(없으면 단계 비율).
 */
function stageMeter(incident: IncidentDetailDto, now: number, rows: Row[]): Meter {
  if (incident.status === 'countdown') {
    const left = Math.max(0, Date.parse(incident.deadlineAt) - now);
    return {
      timer: { label: '남은 시간', ms: Math.ceil(left / 1000) * 1000 },
      value: left / (incident.countdownSeconds * 1000),
      label: '응답 남은 시간',
    };
  }
  const timer = { label: '감지 후', ms: now - Date.parse(incident.detectedAt) };
  const d = findStep(incident, 'contacts')?.detail;
  if (d && d.reason !== 'no_contacts') {
    if (d.acknowledgedBy) return { timer, value: 1, label: '비상연락처가 확인했어요' };
    const all = d.notified.length + d.pending + d.failed;
    if (all > 0) return { timer, value: d.notified.length / all, label: `비상연락처 ${all}명 중 ${d.notified.length}명에게 알림` };
  }
  const done = rows.filter((r) => r.state === 'done').length;
  return { timer, value: done / rows.length, label: `대응 단계 ${rows.length}개 중 ${done}개 완료` };
}

/** warn = 빨강으로 강조(119 실패·지연, 문자 지연) · note = 보조 줄을 보인다 */
type Row = { key: string; state: StepState; label: string; sub: string; time: string; warn: boolean; note: boolean };

/** 대응 단계 타임라인. 문구는 stepText 그대로 — 보조 줄은 진행 중·경고 행에서만 보인다(나머지는 스크린리더로). */
function timelineRows(incident: IncidentDetailDto): Row[] {
  return incident.steps
    .filter((s) => s.state !== 'skipped' || s.key === 'contacts')
    .map((s) => {
      const warn =
        (s.key === 'emergency' && (s.detail.delivery === 'failed' || s.detail.delivery === 'retrying')) ||
        (s.key === 'contacts' && s.state === 'now' && s.detail.failed > 0);
      // 연락처가 없다는 건 경고보다 할 일 안내라 빨강 없이 보조 줄만 보인다
      const note = warn || s.state === 'now' || (s.key === 'contacts' && s.detail.reason === 'no_contacts');
      return { key: s.key, state: s.state, warn, note, ...stepText(s, incident) };
    });
}

/** 매장에 보낼 안내 문구 — 라이더가 직접 알리고 싶을 때 쓴다(대체배차 요청은 서버가 따로 한다) */
function storeNotice(o: OrderDto): string {
  const handled = o.status === 'reassigned' ? '다른 라이더에게 주문을 넘겼어요' : '대체배차를 요청해 뒀어요';
  return `[Rider Guard] ${o.storeName} 주문(${o.destination})을 배달하던 중 사고가 나서 이어서 배달하기 어려워요. ${handled}. 배달이 늦어져서 죄송해요.`;
}

/** '2분 41초' — 스크린리더용 */
function spoken(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
}

/** 1초마다 바뀌는 지금 시각. 멈춰 있으면 마지막 값을 유지한다. */
function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

// ── 화면 ───────────────────────────────────────────────────────

export default function StatusScreen() {
  const { id, from } = useLocalSearchParams<{ id?: string; from?: string }>();
  const { data: incident, error, dataUpdatedAt, refetch } = useIncident(id);
  const fromRecords = from === 'records';
  // 기록에서 열었으면 기록으로 돌아가고(뒤로 갈 곳이 없으면 기록 화면으로), 알림·확인 화면에서 왔으면 홈을 새 루트로
  const close = () => (fromRecords ? backOr('/records') : resetTo('/home'));
  const closeLabel = fromRecords ? '기록으로' : '홈으로';

  if (!id) {
    return (
      <Screen top={56}>
        <Header onClose={close} closeLabel={closeLabel} />
        <Txt accessibilityRole="header" style={typography.title}>
          사고 정보를 찾을 수 없어요
        </Txt>
        <Txt style={typography.lead}>주소에 사고 번호가 없어요. 기록에서 다시 열어 주세요.</Txt>
        <Spacer />
        <Button label={closeLabel} variant="dark" size="md" onPress={close} />
      </Screen>
    );
  }

  if (!incident) {
    if (!error) return <StatusSkeleton onClose={close} closeLabel={closeLabel} />;
    return (
      <Screen top={56}>
        <Header onClose={close} closeLabel={closeLabel} />
        <Txt accessibilityRole="header" style={typography.title}>
          대응 상황을 불러오지 못했어요
        </Txt>
        <Notice error={error} onRetry={() => void refetch()} />
        <Spacer />
        <Button label={closeLabel} variant="outline" size="md" onPress={close} />
      </Screen>
    );
  }

  return (
    <IncidentView
      incident={incident}
      dataUpdatedAt={dataUpdatedAt}
      stale={!!error}
      onClose={close}
      closeLabel={closeLabel}
    />
  );
}

type ViewProps = { incident: IncidentDetailDto; dataUpdatedAt: number; stale: boolean; onClose: () => void; closeLabel: string };

function IncidentView({ incident, dataUpdatedAt, stale, onClose, closeLabel }: ViewProps) {
  const { data: me } = useMe();
  const toast = useToast();
  const respond = useRespond(incident.id);
  const [confirmingOk, setConfirmingOk] = useState(false);
  const open = isOpenStatus(incident.status);
  const countdown = incident.status === 'countdown';
  // 기기 시계 오차 보정 — 첫 응답으로 한 번만 정한다(폴링마다 바꾸면 네트워크 지연만큼 초가 흔들린다)
  const [offset] = useState(() => Date.parse(incident.serverTime) - dataUpdatedAt);
  const now = useNow(open) + offset;

  const head = headline(incident);
  const rows = timelineRows(incident);
  const stage = open ? currentStage(incident, me?.contacts) : null;
  const detectedAt = Date.parse(incident.detectedAt);
  const total = incident.resolvedAt ? Date.parse(incident.resolvedAt) - detectedAt : null;

  const finishOk = () =>
    respond.mutate('ok', {
      onSuccess: () => {
        setConfirmingOk(false);
        toast.show('괜찮다고 알렸어요');
      },
    });

  return (
    <Screen top={56} enter="none">
      <FadeIn style={styles.head}>
        <Header
          left={
            <Badge tone={head.tone} live={head.live}>
              {head.badge}
            </Badge>
          }
          onClose={onClose}
          closeLabel={closeLabel}
        />
        <FadeSwap swapKey={head.title}>
          <Txt accessibilityRole="header" accessibilityLiveRegion="polite" style={typography.title}>
            {head.title}
          </Txt>
          {head.lead ? <Txt style={[typography.lead, styles.lead]}>{head.lead}</Txt> : null}
        </FadeSwap>
      </FadeIn>

      {stale && (
        <Notice tone="info" message={`연결이 불안정해요 · ${clock(new Date(dataUpdatedAt).toISOString())} 기준`} />
      )}

      {stage && (
        <FadeIn delay={motion.stagger}>
          <StageCard stage={stage} meter={stageMeter(incident, now, rows)} />
        </FadeIn>
      )}

      {open && (
        <FadeIn delay={motion.stagger * 2} style={styles.actions}>
          {countdown ? (
            <Button
              label="확인 화면 열기"
              size="md"
              style={styles.flex}
              onPress={() => router.replace({ pathname: '/alert', params: { id: incident.id } })}
            />
          ) : null}
          <Button
            label="119 전화"
            variant="danger"
            size="md"
            accessibilityLabel="119에 전화 걸기"
            icon={<PhoneIcon size={18} color={colors.textOnDark} strokeWidth={2.2} />}
            style={styles.flex}
            onPress={() => void Linking.openURL('tel:119')}
          />
          {countdown ? null : (
            <Button
              label="이제 괜찮아요"
              variant="white"
              size="md"
              style={styles.flex}
              onPress={() => {
                respond.reset();
                setConfirmingOk(true);
              }}
            />
          )}
        </FadeIn>
      )}

      <FadeIn delay={motion.stagger * 3}>
        <Card style={styles.timeline}>
          {!open && (
            <View style={styles.timelineHead}>
              <Txt accessibilityRole="header" style={typography.heading}>
                대응 단계
              </Txt>
              {total != null && total >= 1000 ? (
                // Plex Mono 에는 한글이 없어서 '총'은 sans, 숫자만 mono
                <Txt accessibilityLabel={`총 ${spoken(total)}`} style={styles.totalLabel}>
                  총 <Txt style={styles.total}>{elapsed(total)}</Txt>
                </Txt>
              ) : null}
            </View>
          )}
          {rows.map((row, i) => (
            <View key={row.key}>
              {(i > 0 || !open) && <Divider inset={18} />}
              <FadeIn delay={motion.stagger * 3 + Math.min(i, 6) * motion.stagger} offset={6}>
                <TimelineRow row={row} />
              </FadeIn>
            </View>
          ))}
        </Card>
      </FadeIn>

      {open && incident.order && (
        <FadeIn delay={motion.stagger * 4}>
          <OrderCard order={incident.order} />
        </FadeIn>
      )}

      {open ? (
        <Txt style={styles.footnote}>이 화면을 닫아도 대응은 계속돼요.</Txt>
      ) : (
        <>
          <Spacer />
          <Button label={closeLabel} variant="dark" size="md" onPress={onClose} />
        </>
      )}

      {/* 관제센터가 없으니 대응을 끝내는 건 라이더 본인이다. 이미 알린 연락처와 119 에도 알리므로 한 번 더 묻는다. */}
      <Sheet
        visible={confirmingOk && open}
        onClose={() => {
          if (!respond.isPending) setConfirmingOk(false);
        }}
        title="이제 괜찮으신가요?"
        description="사고 대응을 마치고, 이미 알린 비상연락처와 119에 괜찮다고 알려요."
      >
        <ErrorText error={respond.error} />
        <Button label="대응 마치기" loading={respond.isPending} onPress={finishOk} />
        <Button label="취소" variant="ghost" size="md" disabled={respond.isPending} onPress={() => setConfirmingOk(false)} />
      </Sheet>
    </Screen>
  );
}

// ── 조각 ───────────────────────────────────────────────────────

function StageCard({ stage, meter }: { stage: Stage; meter: Meter }) {
  const { timer } = meter;
  return (
    <Card tone="navy" style={styles.stage}>
      <Txt style={styles.stageEyebrow}>지금 단계</Txt>
      <View style={styles.stageRow}>
        <FadeSwap swapKey={stage.title} style={styles.stageText}>
          <Txt style={[styles.stageTitle, stage.warn && { color: colors.dangerOnDark }]}>{stage.title}</Txt>
          <Txt style={styles.stageDesc}>{stage.desc}</Txt>
        </FadeSwap>
        <View style={styles.timer} accessible accessibilityLabel={`${timer.label} ${spoken(timer.ms)}`}>
          <Txt style={styles.timerLabel}>{timer.label}</Txt>
          <Txt style={styles.timerValue}>{elapsed(timer.ms)}</Txt>
        </View>
      </View>
      <ProgressBar onDark value={meter.value} accessibilityLabel={meter.label} style={styles.stageBar} />
      {stage.next ? <Txt style={styles.stageNext}>{stage.next}</Txt> : null}
    </Card>
  );
}

const STATE_TEXT: Record<StepState, string> = { done: '완료', now: '진행 중', todo: '대기', skipped: '건너뜀' };

function TimelineRow({ row }: { row: Row }) {
  const { state, label, sub, time, warn, note } = row;
  const now = state === 'now';
  const showSub = note && !!sub;
  const labelStyle = [
    typography.body,
    now && [font.sans(600), { color: warn ? colors.dangerInk : colors.primaryInk }],
    !now && warn && { color: colors.dangerInk },
    state === 'todo' && { color: colors.textMuted },
    state === 'skipped' && { color: colors.textFaint },
  ];
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${STATE_TEXT[state]}${time && time !== '진행 중' ? `, ${time}` : ''}${sub ? `, ${sub}` : ''}`}
      style={styles.row}
    >
      <Marker state={state} warn={warn} />
      <View style={styles.rowMain}>
        <Txt style={labelStyle}>{label}</Txt>
        {showSub ? <Txt style={[styles.rowSub, warn && { color: colors.dangerInk }]}>{sub}</Txt> : null}
      </View>
      {time ? (
        // Plex Mono 에는 한글이 없어서 '진행 중'은 sans 로 그린다
        <Txt style={time === '진행 중' ? [styles.rowLive, warn && { color: colors.dangerInk }] : styles.rowTime}>{time}</Txt>
      ) : null}
    </View>
  );
}

/** 단계 원. 완료로 바뀌는 순간 체크 원이 톡 튄다 — 폴링으로 조용히 바뀌어도 눈에 띄게. */
function Marker({ state, warn }: { state: StepState; warn: boolean }) {
  const reduced = useReducedMotion();
  const prev = useRef(state);
  const [pop] = useState(() => new Animated.Value(1));
  useEffect(() => {
    const was = prev.current;
    prev.current = state;
    if (state !== 'done' || was === 'done' || reduced) return;
    pop.setValue(0.5);
    const a = Animated.spring(pop, { toValue: 1, friction: 5, tension: 140, useNativeDriver: motion.native });
    a.start();
    return () => a.stop();
  }, [state, pop, reduced]);

  return (
    <View style={styles.markerBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {state === 'done' && (
        <Animated.View style={[styles.marker, { backgroundColor: warn ? colors.danger : colors.primary, transform: [{ scale: pop }] }]}>
          <CheckIcon size={12} color={colors.textOnDark} strokeWidth={3.2} />
        </Animated.View>
      )}
      {state === 'now' && (
        <>
          <PulseHalo size={MARKER} color={warn ? colors.dangerBright : colors.violetLight} duration={1200} scaleTo={2.1} />
          <View style={[styles.marker, styles.markerNow, { borderColor: warn ? colors.danger : colors.primary }]}>
            <View style={[styles.markerDot, { backgroundColor: warn ? colors.danger : colors.primary }]} />
          </View>
        </>
      )}
      {state === 'todo' && <View style={[styles.marker, styles.markerTodo]} />}
      {state === 'skipped' && (
        <View style={[styles.marker, styles.markerSkipped]}>
          <View style={styles.skipBar} />
        </View>
      )}
    </View>
  );
}

function OrderCard({ order }: { order: OrderDto }) {
  const toast = useToast();
  const web = Platform.OS === 'web';
  // 웹은 클립보드, 앱은 공유 시트(클립보드 패키지를 새로 넣지 않으려고 — 시트에 '복사'가 있다)
  const send = async () => {
    const text = storeNotice(order);
    try {
      if (web) {
        if (!navigator.clipboard) throw new Error('clipboard');
        await navigator.clipboard.writeText(text);
        toast.show('안내 문구를 복사했어요');
      } else {
        await Share.share({ message: text });
      }
    } catch {
      toast.error(web ? '복사하지 못했어요. 다시 시도해 주세요' : '공유하지 못했어요. 다시 시도해 주세요');
    }
  };
  return (
    <Card tone="soft" style={styles.order}>
      <View style={styles.orderText}>
        <Txt style={styles.orderStore} numberOfLines={1}>
          진행 중이던 주문 · {order.storeName}
        </Txt>
        <Txt style={styles.orderBody}>매장에 보낼 안내 문구를 준비해뒀어요.</Txt>
      </View>
      <Button
        label={web ? '문구 복사' : '문구 공유'}
        variant="white"
        size="sm"
        height={44}
        textStyle={{ color: colors.primaryInk }}
        accessibilityHint="매장에 보낼 사고 안내 문구를 가져가요"
        onPress={() => void send()}
      />
    </Card>
  );
}

/** 처음 불러오는 동안 — 실제 화면과 같은 자리에 막대를 둔다 */
function StatusSkeleton({ onClose, closeLabel }: { onClose: () => void; closeLabel: string }) {
  return (
    <Screen top={56} enter="fade">
      <View style={styles.head} accessibilityLabel="대응 상황을 불러오는 중이에요">
        <Header left={<Skeleton width={104} height={26} radius={radius.pill} />} onClose={onClose} closeLabel={closeLabel} />
        <View style={styles.skelTitle}>
          <Skeleton width="62%" height={28} />
          <Skeleton width="48%" height={28} />
        </View>
      </View>
      <Card tone="navy" style={[styles.stage, styles.skelStage]}>
        <Skeleton onDark width={64} height={14} />
        <Skeleton onDark width="70%" height={22} />
        <Skeleton onDark width="50%" height={14} />
        <Skeleton onDark width="100%" height={6} radius={radius.pill} />
      </Card>
      <View style={styles.actions}>
        <Skeleton width="48%" height={52} radius={radius.input} style={styles.flex} />
        <Skeleton width="48%" height={52} radius={radius.input} style={styles.flex} />
      </View>
      <Card style={styles.timeline}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i}>
            {i > 0 && <Divider inset={18} />}
            <View style={[styles.row, styles.skelRow]}>
              <Skeleton width={MARKER} height={MARKER} radius={radius.pill} />
              <View style={styles.rowMain}>
                <Skeleton width={i % 2 ? '55%' : '70%'} height={16} />
              </View>
              <Skeleton width={64} height={14} />
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const MARKER = 20;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { gap: 6, marginBottom: 4 },
  lead: { marginTop: 6 },

  stage: { paddingTop: 20, paddingHorizontal: 20, paddingBottom: 20, borderRadius: radius.cardLg },
  stageEyebrow: { ...font.sans(500), fontSize: 13, lineHeight: 18, color: colors.textOnDarkMuted },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 12 },
  stageText: { flex: 1, gap: 2 },
  stageTitle: { ...typography.heading, color: colors.textOnDark },
  stageDesc: { ...font.sans(400), fontSize: 14, lineHeight: 20, color: colors.textOnDarkMuted },
  timer: { alignItems: 'flex-end' },
  timerLabel: { ...font.sans(500), fontSize: 11, lineHeight: 14, color: colors.textOnDarkFaint },
  timerValue: { ...font.mono(600), fontSize: 30, lineHeight: 36, letterSpacing: -0.5, color: colors.textOnDark },
  stageBar: { marginTop: 16 },
  stageNext: { ...font.sans(400), fontSize: 13, lineHeight: 19, color: colors.textOnDarkMuted, marginTop: 14 },

  actions: { flexDirection: 'row', gap: 10 },

  timeline: { paddingVertical: 4 },
  timelineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 18, paddingTop: 16, paddingBottom: 12 },
  totalLabel: { ...font.sans(500), fontSize: 12, lineHeight: 16, color: colors.textMuted },
  total: { ...font.mono(500), fontSize: 12, color: colors.textMuted },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 13, paddingHorizontal: 18 },
  rowMain: { flex: 1, gap: 2, justifyContent: 'center', minHeight: 22 },
  rowSub: { ...typography.caption },
  rowTime: { ...font.mono(500), fontSize: 13, lineHeight: 22, color: colors.textMuted },
  rowLive: { ...font.sans(600), fontSize: 12, lineHeight: 22, color: colors.primaryInk },
  markerBox: { width: MARKER, height: 22, alignItems: 'center', justifyContent: 'center' },
  marker: { width: MARKER, height: MARKER, borderRadius: MARKER / 2, alignItems: 'center', justifyContent: 'center' },
  markerNow: { backgroundColor: colors.surface, borderWidth: 2 },
  markerDot: { width: 8, height: 8, borderRadius: 4 },
  markerTodo: { borderWidth: 2, borderColor: colors.todo },
  markerSkipped: { backgroundColor: colors.surfaceMuted },
  skipBar: { width: 8, height: 2, borderRadius: 1, backgroundColor: colors.todo },

  order: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 16, paddingLeft: 18, paddingRight: 14 },
  orderText: { flex: 1, gap: 2 },
  orderStore: { ...font.sans(600), fontSize: 13, lineHeight: 18, color: colors.primaryInk },
  orderBody: { ...font.sans(400), fontSize: 14, lineHeight: 20, color: colors.primaryDeep },

  footnote: { ...typography.small, color: colors.textFaint, textAlign: 'center', marginTop: 4 },

  skelTitle: { gap: 10, paddingVertical: 4 },
  skelStage: { gap: 12 },
  skelRow: { alignItems: 'center' },
});
