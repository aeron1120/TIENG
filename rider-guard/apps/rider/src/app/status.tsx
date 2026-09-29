// 디자인: design/Status.dc.html — 사고 대응 진행 상황
import type { IncidentDetailDto, IncidentStep } from '@rider-guard/contract';
import * as Linking from 'expo-linking';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { isOpenStatus, useIncident, useRespond } from '@/api/hooks';
import { ErrorText } from '@/components/forms';
import { CheckIcon, PhoneIcon } from '@/components/Icons';
import { Badge, Button, Card, Screen, Spacer, Txt } from '@/components/ui';
import { ORDER_LABEL, stepText } from '@/lib/format';
import { resetTo } from '@/lib/nav';
import { colors, font, radius } from '@/theme';

function headline(incident: IncidentDetailDto): { badge: string; title: string; lead: string } {
  const open = isOpenStatus(incident.status);
  if (incident.status === 'cancelled') return { badge: '오탐', title: '오탐으로 기록됐어요', lead: '괜찮다고 응답해서 아무에게도 연락하지 않았어요.' };
  if (!open) {
    return {
      badge: '사고 대응 종료',
      title:
        incident.resolution === 'false_alarm' ? '오탐으로 확인됐어요' : incident.resolution === 'rider_ok' ? '괜찮다고 알렸어요' : '사고 대응이 끝났어요',
      lead: '사고기록은 보험·산재 접수에 쓸 수 있도록 보관돼요.',
    };
  }
  return {
    badge: '사고 대응 진행 중',
    title: incident.escalationReason === 'no_response' ? '비상연락을 시작했어요' : '도움 요청이 접수됐어요',
    lead: '비상연락처와 119에 자동으로 알려요. 이 화면을 닫아도 대응은 계속돼요.',
  };
}

export default function StatusScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { data: incident, error } = useIncident(id);
  const [confirmingOk, setConfirmingOk] = useState(false);

  if (!incident) {
    return (
      <Screen top={52} bottom={28}>
        <Txt style={styles.lead}>{error ? errorMessage(error) : '불러오는 중…'}</Txt>
        <Spacer />
        <Button label="홈으로" variant="outline" onPress={() => resetTo('/home')} />
      </Screen>
    );
  }

  const { badge, title, lead } = headline(incident);
  const open = isOpenStatus(incident.status);
  const order = incident.order;

  return (
    <Screen top={52} bottom={28}>
      <View style={{ gap: 8 }}>
        <Badge tone={open ? 'accentSoft' : 'muted'} style={{ alignSelf: 'flex-start', paddingVertical: 5, paddingHorizontal: 10 }}>
          {badge}
        </Badge>
        <Txt style={styles.h1}>{title}</Txt>
        <Txt style={styles.lead}>{lead}</Txt>
      </View>

      {open && (
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            label="119 전화"
            height={56}
            fontSize={16}
            icon={<PhoneIcon size={18} color={colors.textOnDark} strokeWidth={2.2} />}
            style={{ flex: 1 }}
            onPress={() => Linking.openURL('tel:119')}
          />
          <Button label="괜찮아요" variant="outline" height={56} fontSize={16} style={{ flex: 1 }} onPress={() => setConfirmingOk(true)} />
        </View>
      )}
      {open && confirmingOk && <ConfirmOk id={incident.id} onCancel={() => setConfirmingOk(false)} />}

      <Card style={{ paddingTop: 18, paddingHorizontal: 18, paddingBottom: 6 }}>
        <Txt style={[font.sans(700), { fontSize: 14, paddingBottom: 12 }]}>대응 단계</Txt>
        {incident.steps
          .filter((s) => s.state !== 'skipped' || s.key === 'contacts')
          .map((s, i, all) => (
            <StepRow key={s.key} step={s} incident={incident} last={i === all.length - 1} />
          ))}
      </Card>

      {order && (
        <Card style={{ gap: 8, paddingVertical: 16, paddingHorizontal: 18 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
            <Txt style={[font.sans(700), { fontSize: 14 }]}>진행 중이던 주문</Txt>
            <Badge tone={order.status === 'held' ? 'info' : 'ink'}>{ORDER_LABEL[order.status]}</Badge>
          </View>
          <Txt style={{ fontSize: 14 }}>
            {order.storeName} → {order.destination}
          </Txt>
          <Txt style={styles.muted13}>
            {order.status === 'held'
              ? '대체배차를 요청했고, 매장과 고객에게 지연 안내가 나갔어요. 라이더님이 따로 연락할 필요는 없어요.'
              : '다른 라이더에게 인계됐어요. 라이더님이 따로 연락할 필요는 없어요.'}
          </Txt>
        </Card>
      )}

      <Spacer />
      <Button label={open ? '닫기' : '홈으로'} variant="light" height={52} onPress={() => resetTo('/home')} />
    </Screen>
  );
}

/**
 * 관제센터가 없으니 대응을 끝내는 건 라이더 본인이다. 사고를 닫고 이미 알린 연락처와 119 에도 알리므로 한 번 더 묻는다.
 */
function ConfirmOk({ id, onCancel }: { id: string; onCancel: () => void }) {
  const respond = useRespond(id);
  return (
    <Card style={{ padding: 18, gap: 12, borderColor: colors.accent }}>
      <Txt style={[font.sans(700), { fontSize: 16 }]}>괜찮으신가요?</Txt>
      <Txt style={styles.lead}>사고 대응을 마치고, 이미 알린 비상연락처와 119에 괜찮다고 알려요.</Txt>
      <ErrorText error={respond.error} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button label="취소" variant="outline" height={46} rounded={radius.lg} fontSize={14} weight={600} style={{ flex: 1 }} onPress={onCancel} />
        <Button
          label={respond.isPending ? '보내는 중…' : '대응 마치기'}
          height={46}
          rounded={radius.lg}
          fontSize={14}
          weight={600}
          style={{ flex: 1 }}
          disabled={respond.isPending}
          onPress={() => respond.mutate('ok')}
        />
      </View>
    </Card>
  );
}

function StepRow({ step, incident, last }: { step: IncidentStep; incident: IncidentDetailDto; last: boolean }) {
  const { label, sub, time } = stepText(step, incident);
  const done = step.state === 'done';
  return (
    <View style={{ flexDirection: 'row', gap: 14 }}>
      <View style={{ width: 20, alignItems: 'center' }}>
        {done && (
          <View style={[styles.marker, { backgroundColor: colors.ink }]}>
            <CheckIcon size={12} color={colors.textOnDark} strokeWidth={3.5} />
          </View>
        )}
        {step.state === 'now' && <View style={[styles.marker, { borderWidth: 5, borderColor: colors.accent }]} />}
        {(step.state === 'todo' || step.state === 'skipped') && <View style={[styles.marker, { borderWidth: 2, borderColor: colors.borderTodo }]} />}
        {!last && <View style={styles.line} />}
      </View>
      <View style={{ flex: 1, gap: 1, paddingBottom: 14 }}>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 8 }}>
          <Txt style={[font.sans(600), { fontSize: 14, flexShrink: 1 }]}>{label}</Txt>
          <Txt style={[font.mono(500), { fontSize: 12, color: colors.textMuted }]}>{time}</Txt>
        </View>
        <Txt style={styles.muted13}>{sub}</Txt>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 24, letterSpacing: -0.5 },
  lead: { fontSize: 14, lineHeight: 21, color: colors.textMuted },
  muted13: { fontSize: 13, color: colors.textMuted },
  marker: { width: 20, height: 20, borderRadius: 10, backgroundColor: colors.surface, alignItems: 'center', justifyContent: 'center' },
  line: { width: 2, flexGrow: 1, minHeight: 18, backgroundColor: colors.border },
});
