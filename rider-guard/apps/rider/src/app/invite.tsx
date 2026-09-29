// 디자인: spec-v2 04 '연락처 수락 웹' — 연락처가 받는 수락 페이지를 앱 안에서 미리 보는 시뮬레이션 모달. ?id=<연락처 id>
// 서버에는 아무것도 보내지 않는다. 답은 features/contactSim 에만 남는다.
// 문구는 실제 동작 그대로: 문자는 수락 여부와 상관없이 사고 때 1순위부터 가고, 위치는 연락처의 공개 범위(shareLevel)를 따른다.
import type { ShareLevel } from '@rider-guard/contract';
import { useLocalSearchParams } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useMe } from '@/api/hooks';
import { Header, Notice, TextButton } from '@/components/forms';
import { ClockIcon, EyeOffIcon, MailIcon, ShieldIcon, type IconComponent } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, Screen, ScreenFooter, SimBadge, Skeleton, Txt } from '@/components/ui';
import { useContactAcceptance } from '@/features/contactSim';
import { backOr } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

const SIDE = 24;

/** 받게 되는 것 — 사고 문자는 모두 받고, 그 밖의 위치는 공개 범위에 따라 */
const RECEIVE: Record<ShareLevel, string> = {
  realtime: '사고 문자·위치 링크, 보호 중 실시간 위치',
  on_anomaly: '사고 문자·위치 링크, 사고 감지 뒤의 위치',
  on_incident: '사고 소식, 마지막 위치, 확인 버튼이 있는 링크',
};
/** 볼 수 없는 것 */
const HIDDEN: Record<ShareLevel, string> = {
  realtime: '보호가 꺼진 동안의 위치와 운행 기록은 안 보여요',
  on_anomaly: '평소 위치와 운행 기록은 보이지 않아요',
  on_incident: '평소 위치와 운행 기록은 보이지 않아요',
};

const close = () => backOr('/setup');

export default function InviteScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const me = useMe();
  const acceptance = useContactAcceptance(me.data?.contacts);
  const toast = useToast();
  const contact = id ? me.data?.contacts.find((c) => c.id === id) : undefined;
  const rider = me.data?.rider.name?.trim() || '라이더';

  const header = <Header left={<SimBadge label="미리보기 · 시뮬레이션" />} onClose={close} closeLabel="미리보기 닫기" />;

  if (id && !me.data) {
    return (
      <Screen tone="white" top={52} side={SIDE} gap={20}>
        {header}
        {me.error ? <Notice error={me.error} onRetry={() => void me.refetch()} /> : <InviteSkeleton />}
      </Screen>
    );
  }

  if (!contact) {
    return (
      <Screen
        tone="white"
        top={52}
        side={SIDE}
        gap={8}
        footer={
          <ScreenFooter tone="white" style={styles.footer}>
            <Button label="닫기" onPress={close} />
          </ScreenFooter>
        }
      >
        {header}
        <Txt accessibilityRole="header" style={[typography.title, styles.titleGap]}>
          미리 볼 연락처가 없어요
        </Txt>
        <Txt style={styles.lead}>이미 삭제됐거나 주소가 잘못됐어요. 비상연락처 목록에서 다시 열어 주세요.</Txt>
      </Screen>
    );
  }

  const answer = (status: 'accepted' | 'declined') => {
    acceptance.set(contact.id, status);
    if (status === 'accepted') toast.success(`${contact.name}님을 수락함으로 표시했어요`);
    else toast.info(`${contact.name}님을 거절함으로 표시했어요`);
    close();
  };

  const items: { Icon: IconComponent; title: string; body: string }[] = [
    { Icon: MailIcon, title: '받게 되는 것', body: RECEIVE[contact.shareLevel] },
    { Icon: EyeOffIcon, title: '볼 수 없는 것', body: HIDDEN[contact.shareLevel] },
    { Icon: ClockIcon, title: '언제든 그만두기', body: `${rider}님에게 말하면 언제든 빠질 수 있어요` },
  ];

  return (
    <Screen
      tone="white"
      top={52}
      side={SIDE}
      gap={20}
      enter="none"
      footer={
        <ScreenFooter tone="white" style={[styles.footer, styles.footerGap]}>
          <Button label="수락할게요" onPress={() => answer('accepted')} />
          <TextButton label="거절하기" fontSize={15} onPress={() => answer('declined')} />
        </ScreenFooter>
      }
    >
      {header}

      <FadeIn style={styles.intro}>
        <View style={styles.brand} accessibilityLabel="Rider Guard">
          <ShieldIcon size={20} color={colors.primary} />
          <Txt style={styles.brandText}>Rider Guard</Txt>
        </View>
        <View style={styles.titleBlock}>
          <Txt accessibilityRole="header" style={typography.title}>
            {`${rider}님이\n당신을 비상연락처로\n등록했어요`}
          </Txt>
          <Txt style={styles.lead}>배달 중 사고가 감지됐는데 {rider}님이 응답하지 않거나 도움을 요청하면 문자를 받아요.</Txt>
        </View>
      </FadeIn>

      <FadeIn delay={motion.stagger * 2}>
        <Card tone="muted" style={styles.card}>
          {items.map(({ Icon, title, body }, i) => (
            <View key={title}>
              {i > 0 && <Divider inset={18} />}
              <View style={styles.item} accessible accessibilityLabel={`${title}, ${body}`}>
                <View style={styles.itemIcon}>
                  <Icon size={20} color={colors.primary} />
                </View>
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

function InviteSkeleton() {
  return (
    <View style={styles.intro}>
      <Skeleton width={120} height={20} />
      <View style={styles.titleBlock}>
        <Skeleton width="70%" height={30} />
        <Skeleton width="85%" height={30} />
        <Skeleton width="50%" height={30} />
      </View>
      <Skeleton width="100%" height={220} radius={radius.card} />
    </View>
  );
}

const styles = StyleSheet.create({
  titleGap: { marginTop: 4 },
  intro: { gap: 24, marginTop: 4 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandText: { ...font.sans(700), fontSize: 16, lineHeight: 22, color: colors.text },
  titleBlock: { gap: 8 },
  lead: { ...typography.lead, fontSize: 15 },
  card: { paddingVertical: 4 },
  item: { flexDirection: 'row', alignItems: 'flex-start', gap: 14, paddingVertical: 16, paddingHorizontal: 18 },
  itemIcon: { paddingTop: 1 },
  itemMain: { flex: 1, gap: 2 },
  itemTitle: { ...font.sans(700), fontSize: 15, lineHeight: 22, color: colors.text },
  itemBody: { ...typography.caption },
  footer: { paddingHorizontal: SIDE },
  footerGap: { gap: 4 },
});
