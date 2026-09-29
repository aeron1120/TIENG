// 디자인: spec-v2 03 '비상연락처 (수락 상태)' — 가입 흐름 2/2, 설정·홈에서도 연다(?flow 없음).
// 수락 상태는 화면만 시뮬레이션(features/contactSim). 실제 사고 대응은 수락 여부와 상관없이 1순위부터 차례로 알린다.
import type { ContactDto } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { Header, Notice, StepHeader } from '@/components/forms';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, Divider, FadeIn, Screen, ScreenFooter, SimBadge, Skeleton, Txt, usePressScale } from '@/components/ui';
import { ACCEPTANCE_LABEL, ACCEPTANCE_TONE, useContactAcceptance, type Acceptance } from '@/features/contactSim';
import { formatMobile, RELATION_LABEL } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font, motion, typography } from '@/theme';

/** 서버(riders.ts MAX_CONTACTS)와 같은 한도 */
const MAX_CONTACTS = 5;
const SIDE = 24;

export default function SetupScreen() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const onboarding = flow === 'onboarding';
  const me = useMe();
  const contacts = me.data?.contacts ?? [];
  const acceptance = useContactAcceptance(me.data?.contacts);
  const toast = useToast();
  const loading = !me.data && !me.error;
  const empty = !!me.data && contacts.length === 0;

  const finish = () => {
    if (onboarding) {
      toast.success('설정을 마쳤어요');
      resetTo('/home');
    } else backOr('/home');
  };

  // 시뮬레이션 — 실제로 문자를 보내지 않는다. 거절한 사람에게 다시 보내면 다시 대기로 돌린다.
  const resend = (c: ContactDto) => {
    if (acceptance.statusOf(c.id) === 'declined') acceptance.set(c.id, 'pending');
    toast.info('안내 문자를 다시 보냈어요');
  };

  return (
    <Screen
      top={52}
      side={SIDE}
      gap={20}
      enter="none"
      footer={
        <ScreenFooter style={styles.footer}>
          {empty && <Txt style={styles.reason}>연락처를 한 명 이상 등록하면 마칠 수 있어요</Txt>}
          <Button label="완료" disabled={loading || empty} onPress={finish} />
        </ScreenFooter>
      }
    >
      {onboarding ? (
        <StepHeader onBack={() => backOr({ pathname: '/helmet', params: { flow: 'onboarding' } })} current={2} total={2} />
      ) : (
        <Header onBack={() => backOr('/home')} />
      )}

      <FadeIn style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.title}>
          {'비상시 알릴 사람을\n정해주세요'}
        </Txt>
        <Txt style={styles.lead}>등록하면 상대에게 안내 문자가 가요. 사고 때는 1순위부터 차례로 알려요.</Txt>
      </FadeIn>

      {me.error && !me.data ? (
        <Notice error={me.error} onRetry={() => void me.refetch()} />
      ) : loading ? (
        <ListSkeleton />
      ) : contacts.length > 0 ? (
        <FadeIn delay={motion.stagger} style={styles.list}>
          <View style={styles.listHead}>
            <Txt style={typography.section}>
              연락처 {contacts.length}명 · 최대 {MAX_CONTACTS}명
            </Txt>
            <SimBadge label="수락 시뮬레이션" />
          </View>
          <Card style={styles.card}>
            {contacts.map((c, i) => (
              <View key={c.id}>
                {i > 0 && <Divider inset={18} />}
                <ContactRow contact={c} status={acceptance.statusOf(c.id)} onResend={() => resend(c)} />
              </View>
            ))}
          </Card>
        </FadeIn>
      ) : null}

      {!loading && (
        <FadeIn delay={motion.stagger * 2}>
          {contacts.length < MAX_CONTACTS ? (
            <Button
              label="+ 연락처 추가"
              variant="dashed"
              height={54}
              fontSize={15}
              weight={700}
              accessibilityHint="새 비상연락처를 등록해요"
              onPress={() => router.push('/contact')}
            />
          ) : (
            <Txt style={styles.limit}>비상연락처는 {MAX_CONTACTS}명까지 등록할 수 있어요.</Txt>
          )}
        </FadeIn>
      )}

      <FadeIn delay={motion.stagger * 3}>
        <Notice tone="info" message="1순위부터 차례로 알려요. 앞 사람이 확인하면 다음 사람에게는 가지 않아요." />
      </FadeIn>
    </Screen>
  );
}

/**
 * 행 전체를 누르면 편집, 안의 '문자 다시 보내기'는 따로 눌린다.
 * 버튼 안에 버튼을 넣으면 웹에서 <button> 이 겹쳐지므로, 행 누름은 뒤에 깔린 판(absoluteFill)이 받고
 * 글자들은 누름을 통과시킨다(pointerEvents none). 링크만 그 위에서 눌린다.
 */
function ContactRow({ contact, status, onResend }: { contact: ContactDto; status: Acceptance; onResend: () => void }) {
  const first = contact.priority === 1;
  const relation = RELATION_LABEL[contact.relation];
  const press = usePressScale(0.98);
  const [pressed, setPressed] = useState(false);
  return (
    <Animated.View style={[styles.row, pressed && styles.rowPressed, { transform: [{ scale: press.scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${contact.priority}순위 ${contact.name}, ${relation}, ${ACCEPTANCE_LABEL[status]}`}
        accessibilityHint="연락처를 고칠 수 있어요"
        onPress={() => router.push({ pathname: '/contact', params: { id: contact.id } })}
        onPressIn={() => {
          setPressed(true);
          press.onPressIn();
        }}
        onPressOut={() => {
          setPressed(false);
          press.onPressOut();
        }}
        style={StyleSheet.absoluteFill}
      />
      <View aria-hidden style={[styles.rank, first && styles.rankFirst, styles.passThrough]}>
        <Txt style={[styles.rankText, first && styles.rankTextFirst]}>{contact.priority}</Txt>
      </View>
      {/* 글자는 View 로 감싸 통과시킨다 — 네이티브에서 Text 는 pointerEvents 를 따르지 않을 수 있다 */}
      <View style={[styles.rowMain, styles.passThroughBox]}>
        <View aria-hidden style={styles.passThrough}>
          <Txt style={styles.name} numberOfLines={1}>
            {contact.name} · {relation}
          </Txt>
        </View>
        {status === 'accepted' ? (
          <View aria-hidden style={styles.passThrough}>
            <Txt style={styles.sub}>{formatMobile(contact.phone)}</Txt>
          </View>
        ) : (
          <View style={[styles.subLine, styles.passThroughBox]}>
            <View aria-hidden style={styles.passThrough}>
              <Txt style={styles.sub}>{status === 'pending' ? '수락 대기 중' : '거절했어요'} · </Txt>
            </View>
            <ResendLink name={contact.name} onPress={onResend} />
          </View>
        )}
      </View>
      <View aria-hidden style={styles.passThrough}>
        <Badge tone={ACCEPTANCE_TONE[status]} check={status === 'accepted'}>
          {ACCEPTANCE_LABEL[status]}
        </Badge>
      </View>
    </Animated.View>
  );
}

/** '문자 다시 보내기' 글자 버튼 — 줄 높이는 그대로 두고 hitSlop 으로 터치 영역 44 를 맞춘다 */
function ResendLink({ name, onPress }: { name: string; onPress: () => void }) {
  const press = usePressScale(0.96);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${name}님에게 안내 문자 다시 보내기`}
      onPress={onPress}
      onPressIn={press.onPressIn}
      onPressOut={press.onPressOut}
      hitSlop={{ top: 12, bottom: 12, left: 6, right: 8 }}
    >
      <Animated.View style={{ transform: [{ scale: press.scale }] }}>
        <Txt style={styles.link}>문자 다시 보내기</Txt>
      </Animated.View>
    </Pressable>
  );
}

/** 연락처를 불러오는 동안 카드 모양 그대로 자리를 잡아 둔다 */
function ListSkeleton() {
  return (
    <View style={styles.list}>
      <Skeleton width={120} height={16} style={styles.skeletonHead} />
      <Card style={styles.card}>
        {[0, 1].map((i) => (
          <View key={i}>
            {i > 0 && <Divider inset={18} />}
            <View style={styles.row}>
              <Skeleton width={44} height={44} radius={22} />
              <View style={styles.rowMain}>
                <Skeleton width="55%" height={16} />
                <Skeleton width="40%" height={14} />
              </View>
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 8, marginTop: 4 },
  lead: { ...typography.lead, fontSize: 15 },
  list: { gap: 10 },
  listHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8, paddingHorizontal: 2 },
  skeletonHead: { marginVertical: 1 },
  card: { paddingVertical: 4, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 72, paddingVertical: 14, paddingHorizontal: 18 },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rank: { width: 44, height: 44, borderRadius: 22, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.surfaceMuted },
  rankFirst: { backgroundColor: colors.primarySoft },
  rankText: { ...font.sans(700), fontSize: 16, lineHeight: 22, color: colors.textMuted },
  rankTextFirst: { color: colors.primary },
  rowMain: { flex: 1, gap: 2 },
  name: { ...typography.bodyStrong, ...font.sans(700) },
  sub: { ...typography.caption, fontSize: 14, lineHeight: 20 },
  subLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center' },
  link: { ...font.sans(700), fontSize: 14, lineHeight: 20, color: colors.primaryInk },
  /** 행 누름을 뒤의 판으로 통과시킨다 */
  passThrough: { pointerEvents: 'none' },
  passThroughBox: { pointerEvents: 'box-none' },
  limit: { ...typography.caption, textAlign: 'center', paddingVertical: 8 },
  footer: { paddingHorizontal: SIDE },
  reason: { ...typography.caption, textAlign: 'center' },
});
