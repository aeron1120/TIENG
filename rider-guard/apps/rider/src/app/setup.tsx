// 디자인: spec-v3 03 '비상연락처 (수락 상태)' — 가입 흐름 2/2, 설정·홈에서도 연다(?flow 없음).
// 수락 상태·안내 문자는 화면만 시뮬레이션(features/contactSim). 실제 사고 대응은 수락 여부와 상관없이 1순위부터 차례로 알린다.
import type { ContactDto } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Animated, Pressable, StyleSheet, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { Header, Notice, StepHeader } from '@/components/forms';
import { ClockIcon, PlusIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, Card, Divider, FadeIn, IconCircle, Screen, ScreenFooter, Skeleton, Txt, usePressScale } from '@/components/ui';
import { ACCEPTANCE_LABEL, ACCEPTANCE_TONE, useContactAcceptance, type Acceptance } from '@/features/contactSim';
import { contactDisplayName } from '@/features/sim';
import { formatMobile, RELATION_LABEL } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

/** 서버(riders.ts MAX_CONTACTS)와 같은 한도 */
const MAX_CONTACTS = 5;
/** 카드 안 좌우 여백 · 구분선 여백 */
const INSET = 16;

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
      top={46}
      gap={0}
      enter="none"
      footer={
        <ScreenFooter>
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
        <Txt style={typography.lead}>{'등록하면 상대에게 안내 문자가 가요.\n수락한 사람만 실제 상황에서 알림을 받아요.'}</Txt>
      </FadeIn>

      {me.error && !me.data ? (
        <View style={styles.listGap}>
          <Notice error={me.error} onRetry={() => void me.refetch()} />
        </View>
      ) : loading ? (
        <ListSkeleton />
      ) : contacts.length > 0 ? (
        <FadeIn delay={motion.stagger} style={styles.listGap}>
          <Card style={styles.card}>
            {contacts.map((c, i) => (
              <View key={c.id}>
                {i > 0 && <Divider inset={INSET} />}
                <ContactRow contact={c} status={acceptance.statusOf(c.id)} onResend={() => resend(c)} />
              </View>
            ))}
          </Card>
        </FadeIn>
      ) : null}

      {!loading && (
        <FadeIn delay={motion.stagger * 2} style={contacts.length > 0 ? styles.addGap : styles.listGap}>
          {contacts.length < MAX_CONTACTS ? (
            <Button
              label="연락처 추가"
              variant="dashed"
              height={50}
              fontSize={15}
              weight={700}
              icon={<PlusIcon size={16} color={colors.text} strokeWidth={2} />}
              accessibilityHint="새 비상연락처를 등록해요"
              onPress={() => router.push('/contact')}
            />
          ) : (
            <Txt style={styles.limit}>비상연락처는 {MAX_CONTACTS}명까지 등록할 수 있어요.</Txt>
          )}
        </FadeIn>
      )}

      <FadeIn delay={motion.stagger * 3} style={[styles.notice, styles.noticeGap]}>
        <View style={styles.noticeIcon}>
          <ClockIcon size={18} color={colors.noticeText} />
        </View>
        <Txt style={styles.noticeText}>1순위부터 알려요. 3분 안에 확인이 없으면 2순위에게도 가고, 누구든 먼저 확인하면 거기서 멈춰요.</Txt>
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
  const name = contactDisplayName(contact.name, contact.priority);
  const relation = RELATION_LABEL[contact.relation];
  const press = usePressScale(0.98);
  const [pressed, setPressed] = useState(false);
  return (
    <Animated.View style={[styles.row, pressed && styles.rowPressed, { transform: [{ scale: press.scale }] }]}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${contact.priority}순위 ${name}, ${relation}, ${ACCEPTANCE_LABEL[status]}`}
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
      <View aria-hidden style={styles.passThrough}>
        <IconCircle size={30} color={first ? colors.asphalt : colors.curb}>
          <Txt style={[styles.rankText, first && styles.rankTextFirst]}>{contact.priority}</Txt>
        </IconCircle>
      </View>
      {/* 글자는 View 로 감싸 통과시킨다 — 네이티브에서 Text 는 pointerEvents 를 따르지 않을 수 있다 */}
      <View style={[styles.rowMain, styles.passThroughBox]}>
        <View aria-hidden style={[styles.nameLine, styles.passThrough]}>
          <Txt style={styles.name} numberOfLines={1}>
            {name}
          </Txt>
          <Txt style={styles.relation} numberOfLines={1}>
            {relation}
          </Txt>
        </View>
        {status === 'accepted' ? (
          <View aria-hidden style={styles.passThrough}>
            <Txt style={styles.sub}>{formatMobile(contact.phone)}</Txt>
          </View>
        ) : (
          <View style={[styles.subLine, styles.passThroughBox]}>
            <View aria-hidden style={styles.passThrough}>
              <Txt style={styles.sub}>{status === 'pending' ? '수락 대기 중' : '거절했어요'}</Txt>
            </View>
            <ResendLink name={name} onPress={onResend} />
          </View>
        )}
      </View>
      <View aria-hidden style={styles.passThrough}>
        <Badge tone={ACCEPTANCE_TONE[status]} check={status === 'accepted'} style={styles.badge} textStyle={styles.badgeText}>
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
    <View style={styles.listGap}>
      <Card style={styles.card}>
        {[0, 1].map((i) => (
          <View key={i}>
            {i > 0 && <Divider inset={INSET} />}
            <View style={styles.row}>
              <Skeleton width={30} height={30} radius={15} />
              <View style={styles.rowMain}>
                <Skeleton width="45%" height={16} />
                <Skeleton width="60%" height={14} />
              </View>
              <Skeleton width={56} height={28} radius={14} />
            </View>
          </View>
        ))}
      </Card>
    </View>
  );
}

const styles = StyleSheet.create({
  intro: { gap: 10, marginTop: 16 },
  listGap: { marginTop: 24 },
  addGap: { marginTop: 12 },
  noticeGap: { marginTop: 16 },
  card: { paddingVertical: 2, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 74, paddingVertical: 12, paddingHorizontal: INSET },
  rowPressed: { backgroundColor: colors.surfacePressed },
  rankText: { ...font.sans(700), fontSize: 15, lineHeight: 20, color: colors.textMuted },
  rankTextFirst: { color: colors.textOnDark },
  rowMain: { flex: 1, gap: 1 },
  nameLine: { flexDirection: 'row', alignItems: 'baseline', gap: 7 },
  name: { ...font.sans(700), flexShrink: 1, fontSize: 16, lineHeight: 22, color: colors.text },
  relation: { ...font.sans(400), flexShrink: 0, fontSize: 13, lineHeight: 18, color: colors.textMuted },
  sub: { ...font.sans(400), fontSize: 13, lineHeight: 18, color: colors.textMuted },
  subLine: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 7 },
  link: { ...font.sans(700), fontSize: 13, lineHeight: 18, color: colors.text, textDecorationLine: 'underline' },
  badge: { minHeight: 28, paddingHorizontal: 11 },
  badgeText: { fontSize: 12, lineHeight: 16 },
  /** 행 누름을 뒤의 판으로 통과시킨다 */
  passThrough: { pointerEvents: 'none' },
  passThroughBox: { pointerEvents: 'box-none' },
  /** 안내 박스 — 공통 Notice 보다 글자가 작고 자간이 좁다(디자인 측정) */
  notice: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, paddingVertical: 13, paddingLeft: 14, paddingRight: 16, borderRadius: radius.xl, backgroundColor: colors.notice },
  noticeIcon: { paddingTop: 2 },
  noticeText: { ...font.sans(400), flex: 1, fontSize: 13, lineHeight: 22, letterSpacing: -0.5, color: colors.noticeText },
  limit: { ...typography.caption, textAlign: 'center', paddingVertical: 8 },
  reason: { ...typography.caption, textAlign: 'center' },
});
