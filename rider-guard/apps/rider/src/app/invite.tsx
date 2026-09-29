// 디자인: spec-v3 04 '연락처 수락 웹' — 연락처가 받는 수락 페이지를 앱 안에서 그대로 보여 주는 시뮬레이션 모달. ?id=<연락처 id>
// 서버에는 아무것도 보내지 않는다. 답은 features/contactSim 에만 남는다. 닫기는 뒤로가기 · 수락 · 거절로.
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useMe } from '@/api/hooks';
import { Notice, TextButton } from '@/components/forms';
import { EyeOffIcon, LogOutIcon, LogoIcon, MessageLinesIcon, type IconComponent } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, footerBottomPadding, IconCircle, Screen, ScreenFooter, Skeleton, Txt } from '@/components/ui';
import { useContactAcceptance } from '@/features/contactSim';
import { contactDisplayName, riderDisplayName } from '@/features/sim';
import { backOr } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

/** 디자인 문구 그대로 */
const ITEMS: { Icon: IconComponent; title: string; body: string }[] = [
  { Icon: MessageLinesIcon, title: '받게 되는 것', body: '사고 시각, 마지막 위치, 확인 버튼이 있는 링크' },
  { Icon: EyeOffIcon, title: '볼 수 없는 것', body: '평소 위치와 운행 기록은 보이지 않아요' },
  { Icon: LogOutIcon, title: '언제든 그만두기', body: '이 링크에서 수락을 취소할 수 있어요' },
];

const close = () => backOr('/setup');

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const me = useMe();
  const acceptance = useContactAcceptance(me.data?.contacts);
  const toast = useToast();
  const insets = useSafeAreaInsets();
  const contact = id ? me.data?.contacts.find((c) => c.id === id) : undefined;
  const rider = riderDisplayName(me.data?.rider.name);

  if (id && !me.data) {
    return (
      <Screen tone="white" top={64} gap={0}>
        <Brand />
        <View style={styles.titleGap}>{me.error ? <Notice error={me.error} onRetry={() => void me.refetch()} /> : <InviteSkeleton />}</View>
      </Screen>
    );
  }

  // 디자인에 없는 상태 — 연락처가 지워졌거나 주소가 잘못됐을 때만 닫기 버튼을 둔다
  if (!contact) {
    return (
      <Screen
        tone="white"
        top={64}
        gap={0}
        footer={
          <ScreenFooter tone="white">
            <Button label="닫기" onPress={close} />
          </ScreenFooter>
        }
      >
        <Brand />
        <View style={[styles.intro, styles.titleGap]}>
          <Txt accessibilityRole="header" style={typography.title}>
            미리 볼 연락처가 없어요
          </Txt>
          <Txt style={typography.lead}>이미 삭제됐거나 주소가 잘못됐어요. 비상연락처 목록에서 다시 열어 주세요.</Txt>
        </View>
      </Screen>
    );
  }

  const name = contactDisplayName(contact.name, contact.priority);
  const answer = (status: 'accepted' | 'declined') => {
    acceptance.set(contact.id, status);
    if (status === 'accepted') toast.success(`${name}님이 수락했어요`);
    else toast.info(`${name}님이 거절했어요`);
    close();
  };

  return (
    <Screen
      tone="white"
      top={64}
      gap={0}
      enter="none"
      footer={
        // '거절하기'(44 칸)가 홈 인디케이터 자리까지 내려간다 — 디자인 버튼 아래 = 바닥에서 58
        <ScreenFooter tone="white" style={[styles.footer, { paddingBottom: footerBottomPadding(insets.bottom) - DECLINE_DROP }]}>
          <Button label="수락할게요" onPress={() => answer('accepted')} />
          <TextButton label="거절하기" fontSize={15} color={colors.textMuted} onPress={() => answer('declined')} />
        </ScreenFooter>
      }
    >
      <FadeIn>
        <Brand />
      </FadeIn>

      <FadeIn delay={motion.stagger} style={[styles.intro, styles.titleGap]}>
        <Txt accessibilityRole="header" style={typography.title}>
          {`${rider}님이\n당신을 비상연락처로\n등록했어요`}
        </Txt>
        <Txt style={typography.lead}>배달 중 사고가 감지됐는데 본인이 응답하지 않을 때만 문자를 받아요.</Txt>
      </FadeIn>

      <FadeIn delay={motion.stagger * 2} style={styles.cardGap}>
        <Card tone="muted" style={styles.card}>
          {ITEMS.map(({ Icon, title, body }, i) => (
            <View key={title}>
              {i > 0 && <Divider inset={16} />}
              <View style={styles.item} accessible accessibilityLabel={`${title}, ${body}`}>
                <IconCircle size={36} color={colors.surface} style={styles.itemIcon}>
                  <Icon size={20} color={colors.text} />
                </IconCircle>
                <View style={styles.itemMain}>
                  <Txt style={styles.itemTitle}>{title}</Txt>
                  <Txt style={styles.itemBody}>{body}</Txt>
                </View>
              </View>
            </View>
          ))}
        </Card>
      </FadeIn>
    </Screen>
  );
}

/** 로고 타일 + 'Rider Guard' */
function Brand() {
  return (
    <View style={styles.brand} accessible accessibilityRole="header" accessibilityLabel="Rider Guard">
      <LogoIcon size={22} />
      <Txt style={styles.brandText}>Rider Guard</Txt>
    </View>
  );
}

function InviteSkeleton() {
  return (
    <View style={styles.intro}>
      <Skeleton width="62%" height={30} />
      <Skeleton width="78%" height={30} />
      <Skeleton width="46%" height={30} />
      <Skeleton width="100%" height={216} radius={radius.card} style={styles.cardGap} />
    </View>
  );
}

/** '거절하기'가 보통 하단 여백(36)보다 아래로 내려가는 만큼 */
const DECLINE_DROP = 22;

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 9 },
  brandText: { ...font.sans(700), fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: colors.text },
  titleGap: { marginTop: 25 },
  intro: { gap: 10 },
  cardGap: { marginTop: 24 },
  card: { paddingVertical: 4 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 12, paddingVertical: 14, paddingHorizontal: 16 },
  /** 원은 제목 줄에 맞춰 살짝 위로 (디자인 측정) */
  itemIcon: { marginTop: 1 },
  itemMain: { flex: 1, gap: 2 },
  itemTitle: { ...font.sans(700), fontSize: 15, lineHeight: 21, letterSpacing: -0.3, color: colors.text },
  itemBody: { ...font.sans(400), fontSize: 13, lineHeight: 18, letterSpacing: -0.5, color: colors.textMuted },
  footer: { gap: 0 },
});
