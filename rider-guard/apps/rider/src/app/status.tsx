// 디자인: spec-v3 08 (v3·8 자동 대응 진행) — 사고 대응 진행 상황
import type { ContactDto, IncidentDetailDto, IncidentStep, OrderDto, StepState } from '@rider-guard/contract';
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Animated, Clipboard, Platform, Share, StyleSheet, View } from 'react-native';

import { isOpenStatus, useIncident, useMe, useRespond } from '@/api/hooks';
import { ErrorText, Header, Notice } from '@/components/forms';
import { CheckIcon, CopyIcon, PhoneIcon } from '@/components/Icons';
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
import { contactDisplayName, ESCALATION_STEP_S, escalationCountdown, useNow, type EscalationCountdown } from '@/features/sim';
import { clock, elapsed, mss, stepText, timeHMS } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

type StepOf<K extends IncidentStep['key']> = Extract<IncidentStep, { key: K }>;
type ContactsDetail = StepOf<'contacts'>['detail'];
const findStep = <K extends IncidentStep['key']>(incident: IncidentDetailDto, key: K) =>
  incident.steps.find((s): s is StepOf<K> => s.key === key);

// ── 문구 ───────────────────────────────────────────────────────

/** dot = 멈춘 점(디자인 '● 자동 대응 중'), live = 깜빡이는 점(응답을 기다리는 동안) */
type Head = { badge: string; tone: BadgeTone; dot?: boolean; live: boolean; title: string; lead: string | null };

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
        lead: '사고 기록은 보험·산재 접수에 쓸 수 있도록 보관돼요.',
      };
    case 'countdown':
      // '응답이 없으면 비상연락처와 119에 알려요'는 아래 '지금 단계' 카드가 이름까지 넣어 말한다
      return { badge: '응답 기다리는 중', tone: 'red', live: true, title: '괜찮은지\n확인하고 있어요', lead: null };
    case 'escalated': {
      const base = { badge: '자동 대응 중', tone: 'red', dot: true, live: false } as const;
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

// ── 비상연락 순서 (시뮬레이션) ─────────────────────────────────

type Who = { priority: number; name: string };

/**
 * 알리는 순서. 이름·순위는 내 연락처 목록에서 — 목록을 아직 못 받았으면 서버가 알린 사람만.
 * 인원은 서버가 사고 때 잡아 둔 비상연락 문자 수(알림 + 대기 + 실패)를 따른다.
 */
function contactQueue(d: ContactsDetail, contacts: ContactDto[] | undefined): Who[] {
  const mine = contacts
    ? [...contacts].sort((a, b) => a.priority - b.priority).map((c) => ({ priority: c.priority, name: contactDisplayName(c.name, c.priority) }))
    : [];
  const base = mine.length ? mine : [...d.notified].sort((a, b) => a.priority - b.priority);
  const total = d.notified.length + d.pending + d.failed;
  return total ? base.slice(0, total) : base;
}

/**
 * '지금 단계' 카드와 타임라인이 함께 쓰는 3분 단위 에스컬레이션(시뮬레이션 — 서버는 다음 순위까지 남은 시간을 주지 않는다).
 * 1순위에게 문자를 보낸 뒤 3분마다 다음 순위로 넘어간다. 누가 확인했거나 사고가 끝나면 멈춘다.
 */
type Relay = { queue: Who[]; startMs: number; cd: EscalationCountdown };

function relayOf(incident: IncidentDetailDto, contacts: ContactDto[] | undefined, now: number): Relay | null {
  if (incident.status !== 'escalated') return null;
  const step = findStep(incident, 'contacts');
  if (!step) return null;
  const d = step.detail;
  if (d.reason === 'no_contacts' || d.acknowledgedBy || !d.notified.length) return null;
  const queue = contactQueue(d, contacts);
  if (!queue.length) return null;
  const startMs = Date.parse(step.at ?? incident.escalatedAt ?? incident.detectedAt);
  return { queue, startMs, cd: escalationCountdown(startMs, now, { steps: queue.length }) };
}

// ── 지금 단계 카드 ─────────────────────────────────────────────

type Stage = {
  title: string;
  desc: string;
  /** 카드 아래 한 줄 */
  next: string | null;
  /** 빨강으로 강조 (119 실패·지연, 문자 지연) */
  warn: boolean;
  /** 오른쪽 큰 숫자 '2:41' */
  timer: string;
  /** 숫자 위 작은 머리말 — 줄어드는 시간(디자인)에는 없고, 지난 시간일 때만 '감지 후' */
  timerLabel: string | null;
  /** 스크린리더용 */
  timerSpoken: string;
  /** 빨간 진행바 0~1 */
  value: number;
  barLabel: string;
};

/** '2분 41초' — 스크린리더용 */
function spoken(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const m = Math.floor(s / 60);
  return m ? `${m}분 ${s % 60}초` : `${s}초`;
}

const STEP_MIN = Math.round(ESCALATION_STEP_S / 60);

/**
 * v3·8 '지금 단계'. 연락처 차례에는 디자인처럼 '1순위 [이름] 확인 대기' + 다음 순위까지 남은 시간(3분 시뮬레이션).
 * 119 실패·연락처 확인·연락처 없음처럼 디자인에 없는 상황은 같은 모양으로 사실을 말하고, 숫자는 감지 후 지난 시간이다.
 */
function currentStage(incident: IncidentDetailDto, contacts: ContactDto[] | undefined, relay: Relay | null, now: number): Stage {
  const sinceMs = now - Date.parse(incident.detectedAt);
  const since = { timer: elapsed(sinceMs), timerLabel: '감지 후', timerSpoken: `감지 후 ${spoken(sinceMs / 1000)}` };

  if (incident.status === 'countdown') {
    const leftS = Math.max(0, Math.ceil((Date.parse(incident.deadlineAt) - now) / 1000));
    const first = contacts ? [...contacts].sort((a, b) => a.priority - b.priority)[0] : undefined;
    const next = !contacts
      ? '응답이 없으면 비상연락처와 119에 자동으로 알려요.'
      : first
        ? `응답이 없으면 ${first.priority}순위 ${contactDisplayName(first.name, first.priority)}에게 문자를 보내고 119에 신고해요.`
        : '응답이 없으면 119에 자동으로 신고해요.';
    return {
      title: '괜찮은지 확인하는 중',
      desc: '확인 화면에서 괜찮은지 알려 주세요',
      next,
      warn: false,
      timer: mss(leftS),
      timerLabel: null,
      timerSpoken: `응답 남은 시간 ${spoken(leftS)}`,
      value: leftS / incident.countdownSeconds,
      barLabel: '응답 남은 시간',
    };
  }

  const delivery = findStep(incident, 'emergency')?.detail.delivery;
  const d = findStep(incident, 'contacts')?.detail;

  if (delivery === 'failed') {
    return { ...since, title: '119 자동 신고 실패', desc: '아래 119 전화 버튼으로 직접 신고해 주세요', next: null, warn: true, value: 1, barLabel: '119 자동 신고 실패' };
  }
  if (!d || d.reason === 'no_contacts') {
    const sent = delivery === 'sent';
    const late = delivery === 'retrying';
    return {
      ...since,
      title: sent ? '119 자동 신고 완료' : '119 자동 신고 중',
      desc: sent ? '위치와 라이더 정보를 담아 문자로 신고했어요' : late ? '신고가 늦어지고 있어요. 위급하면 직접 전화해 주세요' : '신고 문자를 보내고 있어요',
      next: null,
      warn: late,
      value: sent ? 1 : 0.5,
      barLabel: sent ? '119 자동 신고 완료' : '119 자동 신고 중',
    };
  }
  if (d.acknowledgedBy) {
    return {
      ...since,
      title: '비상연락처 확인 완료',
      desc: `${d.acknowledgedBy}님이 확인해서 다음 순위에게는 더 알리지 않아요`,
      next: null,
      warn: false,
      value: 1,
      barLabel: '비상연락처가 확인했어요',
    };
  }
  if (!relay) {
    return {
      ...since,
      title: '비상연락 문자 보내는 중',
      desc: d.failed ? '문자 발송이 늦어지고 있어요. 119 신고는 따로 진행돼요' : '1순위부터 위치 링크와 함께 알려요',
      next: null,
      warn: d.failed > 0,
      value: 0,
      barLabel: '비상연락 문자 보내는 중',
    };
  }

  const { queue, cd } = relay;
  if (cd.done) {
    const one = queue.length === 1 ? queue[0]! : null;
    return {
      ...since,
      title: one ? `${one.priority}순위 ${one.name} 확인 대기` : '비상연락처 확인 대기',
      desc: one ? '문자와 위치 링크를 보냈어요' : `${queue.length}명에게 문자와 위치 링크를 보냈어요`,
      next: null,
      warn: false,
      value: 1,
      barLabel: '모든 비상연락처에게 알렸어요',
    };
  }
  const cur = queue[cd.step]!;
  const nx = queue[cd.step + 1];
  const last =
    delivery === 'sent' ? '마지막 비상연락처예요. 119에는 자동으로 신고했어요.' : delivery === 'sending' || delivery === 'retrying' ? '마지막 비상연락처예요. 119에도 자동으로 신고하고 있어요.' : '마지막 비상연락처예요.';
  return {
    title: `${cur.priority}순위 ${cur.name} 확인 대기`,
    desc: '문자와 위치 링크를 보냈어요',
    next: nx ? `${STEP_MIN}분 안에 확인이 없으면 ${nx.priority}순위 ${nx.name}에게도 알려요.` : last,
    warn: false,
    timer: cd.text,
    timerLabel: null,
    timerSpoken: nx ? `${nx.priority}순위에게 알리기까지 ${spoken(cd.remainingS)}` : `남은 시간 ${spoken(cd.remainingS)}`,
    value: cd.progress,
    barLabel: '다음 순위까지 남은 시간',
  };
}

// ── 타임라인 ───────────────────────────────────────────────────

/** warn = 빨강으로 강조(119 실패·지연, 문자 지연) · note = 보조 줄을 보인다 */
type Row = { key: string; state: StepState; label: string; sub: string; time: string; warn: boolean; note: boolean };

/** v3·8 형식의 응답 줄 — '본인 확인 응답 없음 (30초)' · 'SOS로 도움 요청' */
function responseLabel(response: StepOf<'response'>['detail']['response'], seconds: number): string {
  if (response === 'none') return `본인 확인 응답 없음 (${seconds}초)`;
  if (response === 'help') return 'SOS로 도움 요청';
  if (response === 'ok') return '괜찮아요 응답';
  return '본인 확인 기다리는 중';
}

/**
 * 대응 단계 타임라인. 실제 사고 단계를 디자인 문구 형식으로 — 보조 줄은 경고 행과 '비상연락처 없음'에서만 보인다(나머지는 스크린리더로).
 * 비상연락 줄은 에스컬레이션 시뮬레이션과 같은 순서로 '1순위 [이름]에게 문자 발송'을 한 줄씩 늘린다.
 * 진행 중에는 디자인처럼 감지·응답·비상연락·기록만 — 119 는 문제가 생겼을 때만, 주문은 아래 안내 카드가 맡는다.
 * 끝난 사고(기록에서 열기)는 119·대체배차까지 전부 보인다.
 */
function timelineRows(incident: IncidentDetailDto, relay: Relay | null): Row[] {
  const open = isOpenStatus(incident.status);
  const rows: Row[] = [];
  for (const s of incident.steps) {
    if (s.state === 'skipped' && s.key !== 'contacts') continue;
    const text = stepText(s, incident);
    const warn =
      (s.key === 'emergency' && (s.detail.delivery === 'failed' || s.detail.delivery === 'retrying')) ||
      (s.key === 'contacts' && s.state === 'now' && s.detail.failed > 0);
    if (open && ((s.key === 'emergency' && !warn) || s.key === 'order')) continue;
    // 연락처가 없다는 건 경고보다 할 일 안내라 빨강 없이 보조 줄만 보인다
    const note = warn || (s.key === 'contacts' && s.detail.reason === 'no_contacts');
    const row: Row = { key: s.key, state: s.state, warn, note, ...text };

    if (s.key === 'response') row.label = responseLabel(s.detail.response, incident.countdownSeconds);
    if (s.key === 'record') row.label = s.state === 'done' ? '사고 기록 저장' : '사고 기록 저장 중';
    if (s.key === 'contacts' && relay) {
      const reached = relay.cd.done ? relay.queue.length : relay.cd.step + 1;
      relay.queue.slice(0, reached).forEach((who, k) => {
        rows.push({
          key: `contacts-${who.priority}`,
          state: 'done',
          label: `${who.priority}순위 ${who.name}에게 문자 발송`,
          sub: '현재 위치 링크를 함께 보냈어요',
          time: timeHMS(relay.startMs + k * ESCALATION_STEP_S * 1000),
          warn: false,
          note: false,
        });
      });
      continue;
    }
    // 끝났거나 누가 확인한 뒤에는 실제로 알린 사람을 한 줄씩 — 서버는 첫 문자 시각만 주므로 시각은 첫 줄에만
    if (s.key === 'contacts' && s.detail.notified.length > 1) {
      [...s.detail.notified]
        .sort((a, b) => a.priority - b.priority)
        .forEach((who, k) => {
          rows.push({
            ...row,
            key: `contacts-${who.priority}`,
            label: `${who.priority}순위 ${contactDisplayName(who.name, who.priority)}에게 문자 발송`,
            time: k === 0 ? row.time : '',
          });
        });
      continue;
    }
    rows.push(row);
  }
  return rows;
}

// ── 매장 안내 문구 ─────────────────────────────────────────────

/** 매장에 보낼 안내 문구 — 라이더가 직접 알리고 싶을 때 쓴다(대체배차 요청은 서버가 따로 한다) */
function storeNotice(o: OrderDto | null): string {
  if (!o) return '[Rider Guard] 배달하던 중 사고가 나서 이어서 배달하기 어려워요. 배달이 늦어져서 죄송해요.';
  const handled = o.status === 'reassigned' ? '다른 라이더에게 주문을 넘겼어요' : '대체배차를 요청해 뒀어요';
  return `[Rider Guard] ${o.storeName} 주문(${o.destination})을 배달하던 중 사고가 나서 이어서 배달하기 어려워요. ${handled}. 배달이 늦어져서 죄송해요.`;
}

/** 클립보드에 복사 — 웹은 navigator.clipboard(안 되면 react-native-web 방식), 앱은 RN 기본 Clipboard. 실패하면 false */
async function copyText(text: string): Promise<boolean> {
  try {
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // 권한·포커스 문제면 아래 방식으로 한 번 더
  }
  try {
    const ok: unknown = Clipboard.setString(text);
    return ok !== false;
  } catch {
    return false;
  }
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
        <Button label={closeLabel} onPress={close} />
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
        <Button label={closeLabel} variant="white" onPress={close} />
      </Screen>
    );
  }

  return <IncidentView incident={incident} dataUpdatedAt={dataUpdatedAt} stale={!!error} onClose={close} closeLabel={closeLabel} />;
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
  const now = useNow(1000, open) + offset;

  const head = headline(incident);
  const relay = relayOf(incident, me?.contacts, now);
  const rows = timelineRows(incident, relay);
  const stage = open ? currentStage(incident, me?.contacts, relay, now) : null;
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
    <Screen top={56} gap={12} enter="none">
      <FadeIn style={styles.head}>
        <Header
          left={
            <Badge tone={head.tone} dot={head.dot} live={head.live}>
              {head.badge}
            </Badge>
          }
          onClose={onClose}
          closeLabel={closeLabel}
          subtleClose
        />
        <FadeSwap swapKey={head.title}>
          <Txt accessibilityRole="header" accessibilityLiveRegion="polite" style={typography.title}>
            {head.title}
          </Txt>
          {head.lead ? <Txt style={[typography.lead, styles.lead]}>{head.lead}</Txt> : null}
        </FadeSwap>
      </FadeIn>

      {stale && <Notice tone="info" message={`연결이 불안정해요 · ${clock(new Date(dataUpdatedAt).toISOString())} 기준`} />}

      {stage && (
        <FadeIn delay={motion.stagger}>
          <StageCard stage={stage} />
        </FadeIn>
      )}

      {open && (
        <FadeIn delay={motion.stagger * 2} style={styles.actions}>
          {countdown ? (
            <Button
              label="확인 화면 열기"
              size="md"
              height={ACTION_H}
              rounded={radius.button}
              style={styles.flex}
              onPress={() => router.replace({ pathname: '/alert', params: { id: incident.id } })}
            />
          ) : null}
          <Button
            label="119 전화"
            variant="red"
            size="md"
            height={ACTION_H}
            rounded={radius.button}
            accessibilityLabel="119에 전화 걸기"
            icon={<PhoneIcon size={18} color={colors.textOnDark} strokeWidth={2} />}
            style={styles.flex}
            onPress={() => void Linking.openURL('tel:119')}
          />
          {countdown ? null : (
            <Button
              label="이제 괜찮아요"
              variant="white"
              size="md"
              height={ACTION_H}
              rounded={radius.button}
              accessibilityHint="사고 대응을 마칠지 한 번 더 물어봐요"
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
        <Card style={[styles.timeline, !open && styles.timelineClosed]}>
          {!open && (
            <View style={styles.timelineHead}>
              <Txt accessibilityRole="header" style={typography.heading}>
                대응 단계
              </Txt>
              {total != null && total >= 1000 ? (
                <Txt accessibilityLabel={`총 ${spoken(total / 1000)}`} style={styles.total}>
                  총 {elapsed(total)}
                </Txt>
              ) : null}
            </View>
          )}
          {rows.map((row, i) => (
            <View key={row.key}>
              {(i > 0 || !open) && <Divider inset={16} />}
              <FadeIn delay={motion.stagger * 3 + Math.min(i, 6) * motion.stagger} offset={6}>
                <TimelineRow row={row} />
              </FadeIn>
            </View>
          ))}
        </Card>
      </FadeIn>

      {open && (
        <FadeIn delay={motion.stagger * 4}>
          <OrderCard order={incident.order} />
        </FadeIn>
      )}

      {!open && (
        <>
          <Spacer />
          <Button label={closeLabel} onPress={onClose} style={styles.closeCta} />
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

function StageCard({ stage }: { stage: Stage }) {
  return (
    <Card tone="dark" style={styles.stage}>
      <Txt style={styles.stageEyebrow}>지금 단계</Txt>
      <View style={styles.stageRow}>
        <FadeSwap swapKey={stage.title} style={styles.stageText}>
          <Txt accessibilityLiveRegion="polite" style={[styles.stageTitle, stage.warn && { color: colors.dangerOnDark }]}>
            {stage.title}
          </Txt>
          <Txt style={styles.stageDesc}>{stage.desc}</Txt>
        </FadeSwap>
        <View style={styles.timer} accessible accessibilityLabel={stage.timerSpoken}>
          {stage.timerLabel ? <Txt style={styles.timerLabel}>{stage.timerLabel}</Txt> : null}
          <Txt style={styles.timerValue}>{stage.timer}</Txt>
        </View>
      </View>
      <ProgressBar onDark color={colors.red} value={stage.value} accessibilityLabel={stage.barLabel} style={styles.stageBar} />
      {stage.next ? <Txt style={styles.stageNext}>{stage.next}</Txt> : null}
    </Card>
  );
}

const STATE_TEXT: Record<StepState, string> = { done: '완료', now: '진행 중', todo: '대기', skipped: '건너뜀' };

function TimelineRow({ row }: { row: Row }) {
  const { state, label, sub, time, warn, note } = row;
  const faint = state === 'todo' || state === 'skipped';
  const showSub = note && !!sub;
  return (
    <View
      accessible
      accessibilityLabel={`${label}, ${STATE_TEXT[state]}${time && time !== '진행 중' ? `, ${time}` : ''}${sub ? `, ${sub}` : ''}`}
      style={styles.row}
    >
      <Marker state={state} warn={warn} />
      <View style={styles.rowMain}>
        <Txt style={[styles.rowLabel, faint && styles.rowFaint, warn && styles.rowWarn]}>{label}</Txt>
        {showSub ? <Txt style={[styles.rowSub, warn && styles.rowWarn]}>{sub}</Txt> : null}
      </View>
      {time ? <Txt style={[styles.rowTime, warn && styles.rowWarn]}>{time}</Txt> : null}
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

  const tint = warn ? colors.red : colors.asphalt;
  return (
    <View style={styles.markerBox} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
      {state === 'done' && (
        <Animated.View style={[styles.marker, { backgroundColor: tint, transform: [{ scale: pop }] }]}>
          <CheckIcon size={12} color={colors.textOnDark} strokeWidth={3.2} />
        </Animated.View>
      )}
      {state === 'now' && (
        <>
          <PulseHalo size={MARKER} color={warn ? colors.redTrack : colors.curb} duration={1400} scaleTo={2} />
          <View style={[styles.marker, styles.markerNow, { borderColor: tint }]}>
            <View style={[styles.markerDot, { backgroundColor: tint }]} />
          </View>
        </>
      )}
      {state === 'todo' && <View style={[styles.marker, styles.markerTodo]} />}
      {state === 'skipped' && (
        <View style={[styles.marker, styles.markerTodo]}>
          <View style={styles.skipBar} />
        </View>
      )}
    </View>
  );
}

function OrderCard({ order }: { order: OrderDto | null }) {
  const toast = useToast();
  const copy = async () => {
    const text = storeNotice(order);
    if (await copyText(text)) {
      toast.show('안내 문구를 복사했어요');
      return;
    }
    // 복사가 막힌 기기 — 공유 시트로 대신 보낸다(시트에 '복사'가 있다)
    if (Platform.OS !== 'web') {
      try {
        await Share.share({ message: text });
        return;
      } catch {
        // 아래 오류 토스트
      }
    }
    toast.error('복사하지 못했어요. 다시 시도해 주세요');
  };
  return (
    <Card tone="notice" style={styles.order}>
      <Txt style={styles.orderText}>{'진행 중이던 주문이 있다면 매장에 보낼\n안내 문구를 준비해뒀어요.'}</Txt>
      <Button
        label="문구 복사"
        variant="white"
        height={36}
        rounded={radius.md}
        fontSize={13}
        weight={700}
        icon={
          <View style={styles.copyIcon}>
            <CopyIcon size={14} color={colors.text} strokeWidth={2} />
          </View>
        }
        accessibilityHint="매장에 보낼 사고 안내 문구를 클립보드에 복사해요"
        style={styles.copy}
        onPress={() => void copy()}
      />
    </Card>
  );
}

/** 처음 불러오는 동안 — 실제 화면과 같은 자리에 막대를 둔다 */
function StatusSkeleton({ onClose, closeLabel }: { onClose: () => void; closeLabel: string }) {
  return (
    <Screen top={56} gap={12} enter="fade">
      <View style={styles.head} accessibilityLabel="대응 상황을 불러오는 중이에요">
        <Header left={<Skeleton width={94} height={26} radius={radius.pill} />} onClose={onClose} closeLabel={closeLabel} subtleClose />
        <View style={styles.skelTitle}>
          <Skeleton width="50%" height={28} />
          <Skeleton width="40%" height={28} />
        </View>
      </View>
      <Card tone="dark" style={[styles.stage, styles.skelStage]}>
        <Skeleton onDark width={48} height={12} />
        <Skeleton onDark width="56%" height={20} />
        <Skeleton onDark width="42%" height={13} />
        <Skeleton onDark width="100%" height={5} radius={radius.pill} />
        <Skeleton onDark width="72%" height={13} />
      </Card>
      <View style={styles.actions}>
        <Skeleton width="48%" height={ACTION_H} radius={radius.button} style={styles.flex} />
        <Skeleton width="48%" height={ACTION_H} radius={radius.button} style={styles.flex} />
      </View>
      <Card style={styles.timeline}>
        {[0, 1, 2, 3].map((i) => (
          <View key={i}>
            {i > 0 && <Divider inset={16} />}
            <View style={styles.row}>
              <Skeleton width={MARKER} height={MARKER} radius={radius.pill} />
              <View style={styles.rowMain}>
                <Skeleton width={i % 2 ? '62%' : '38%'} height={15} />
              </View>
              {i < 3 ? <Skeleton width={56} height={13} /> : null}
            </View>
          </View>
        ))}
      </Card>
    </Screen>
  );
}

const MARKER = 20;
/** v3·8 나란한 두 버튼 높이 */
const ACTION_H = 53;

const styles = StyleSheet.create({
  flex: { flex: 1 },
  head: { gap: 5.5, marginBottom: 8.5 },
  lead: { marginTop: 6 },

  stage: { paddingTop: 18, paddingHorizontal: 20, paddingBottom: 15 },
  stageEyebrow: { ...typography.meta, color: colors.textOnDarkFaint },
  stageRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 6 },
  stageText: { flex: 1 },
  stageTitle: { ...typography.heading, lineHeight: 25, color: colors.textOnDark },
  stageDesc: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.35, color: colors.textOnDarkMuted },
  timer: { alignItems: 'flex-end' },
  timerLabel: { ...typography.meta, color: colors.textOnDarkFaint },
  timerValue: { ...font.mono(800), fontSize: 34, lineHeight: 40, letterSpacing: -0.6, color: colors.textOnDark },
  stageBar: { marginTop: 13 },
  stageNext: { ...font.sans(400), fontSize: 13, lineHeight: 19, letterSpacing: -0.35, color: colors.textOnDarkMuted, marginTop: 11 },

  actions: { flexDirection: 'row', gap: 10 },

  timeline: { paddingTop: 4, paddingBottom: 5 },
  timelineClosed: { paddingTop: 0 },
  timelineHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 16, paddingBottom: 12 },
  total: { ...font.mono(500), fontSize: 13, lineHeight: 18, color: colors.textFaint },
  row: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 47, paddingVertical: 12, paddingHorizontal: 16 },
  rowMain: { flex: 1, gap: 2, justifyContent: 'center' },
  rowLabel: { ...typography.body, ...font.sans(500), letterSpacing: -0.15 },
  rowFaint: { color: colors.textFaint },
  rowWarn: { color: colors.redInk },
  rowSub: { ...typography.caption },
  // 시각은 멈춰 있는 값이라 고정폭 숫자 대신 디자인처럼 보통 숫자로
  rowTime: { ...font.sans(400), fontSize: 13.5, lineHeight: 18, color: colors.textFaint },
  markerBox: { width: MARKER, height: MARKER, alignItems: 'center', justifyContent: 'center' },
  marker: { width: MARKER, height: MARKER, borderRadius: MARKER / 2, alignItems: 'center', justifyContent: 'center' },
  markerNow: { backgroundColor: colors.surface, borderWidth: 2 },
  markerDot: { width: 8, height: 8, borderRadius: 4 },
  markerTodo: { borderWidth: 1.5, borderColor: colors.todo },
  skipBar: { width: 8, height: 1.5, borderRadius: 1, backgroundColor: colors.todo },

  order: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 14.4, paddingLeft: 18, paddingRight: 15 },
  orderText: { flex: 1, ...font.sans(400), fontSize: 13, lineHeight: 19.2, letterSpacing: -0.35, color: colors.noticeText },
  copy: { borderWidth: 0, paddingHorizontal: 11 },
  copyIcon: { marginRight: -3 },

  closeCta: { marginTop: 8 },

  skelTitle: { gap: 9, paddingVertical: 4 },
  skelStage: { gap: 10 },
});
