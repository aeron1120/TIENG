// 첫 로그인 — 배달기사 / 관제사 고르기. 고른 역할에 따라 보는 화면이 나뉜다 (나중에 설정에서 바꿀 수 있다).
// 관리자는 고르지 않는다 — 서버의 ADMIN_EMAILS 에 있는 인증된 SNS 이메일로 정해진다.
import type { SetRoleRequest } from '@rider-guard/contract';
import { Redirect } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';

import { useMe, useSetRole } from '@/api/hooks';
import { AfterSignIn } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { Notice } from '@/components/forms';
import { HelmetIcon, LogoIcon, UsersIcon } from '@/components/Icons';
import { FadeIn, Screen, Txt } from '@/components/ui';
import { colors, font, radius, typography } from '@/theme';

const CHOICES: { role: SetRoleRequest['role']; title: string; lead: string; points: string[]; icon: React.ReactNode }[] = [
  {
    role: 'rider',
    title: '배달기사',
    lead: '헬멧·휴대폰 센서로 보호받아요',
    points: ['사고가 의심되면 확인 요청', '응답이 없으면 비상연락처·관제에 위치 공유', '사고 기록·보험 자료'],
    icon: <HelmetIcon size={26} color={colors.text} />,
  },
  {
    role: 'dispatcher',
    title: '관제사',
    lead: '배달대행사에서 라이더를 지켜봐요',
    points: ['라이더 상태·위치 지도', '사고 접수·담당 지정·연락', '주문 보류·대체 배차'],
    icon: <UsersIcon size={26} color={colors.text} />,
  },
];

export default function RoleScreen() {
  const { status } = useAuth();
  const { data: me } = useMe();
  const setRole = useSetRole();
  if (status !== 'signedIn') return <Redirect href="/" />;
  // 고르면(또는 관리자면) 첫 화면 고르기로 돌아간다
  if (me?.role) return <AfterSignIn />;

  return (
    <Screen top={63} side={24} gap={0}>
      <FadeIn style={styles.brand}>
        <LogoIcon size={28} />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </FadeIn>
      <FadeIn delay={40} style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.display}>
          {'어떤 일을\n하고 계세요?'}
        </Txt>
        <Txt style={typography.lead}>고른 역할에 맞는 화면을 보여 드려요. 나중에 설정에서 바꿀 수 있어요.</Txt>
      </FadeIn>
      <FadeIn delay={80} style={styles.choices}>
        {CHOICES.map((c) => (
          <Pressable
            key={c.role}
            accessibilityRole="button"
            accessibilityLabel={`${c.title}, ${c.lead}`}
            disabled={setRole.isPending}
            onPress={() => setRole.mutate(c.role)}
            style={({ pressed }) => [styles.card, pressed && styles.cardPressed, setRole.isPending && setRole.variables === c.role && styles.cardBusy]}
          >
            <View style={styles.icon}>{c.icon}</View>
            <View style={styles.flex}>
              <Txt style={styles.title}>{c.title}</Txt>
              <Txt style={styles.lead}>{c.lead}</Txt>
              {c.points.map((p) => (
                <Txt key={p} style={styles.point}>{`· ${p}`}</Txt>
              ))}
            </View>
          </Pressable>
        ))}
        <Notice error={setRole.error} />
      </FadeIn>
    </Screen>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  brandName: { ...font.sans(700), fontSize: 16, lineHeight: 22, letterSpacing: -0.2, color: colors.text },
  intro: { marginTop: 28, gap: 10 },
  choices: { marginTop: 28, gap: 12 },
  card: { flexDirection: 'row', gap: 14, padding: 18, borderRadius: radius.card, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border },
  cardPressed: { backgroundColor: colors.surfacePressed, borderColor: colors.asphalt },
  cardBusy: { borderColor: colors.asphalt },
  icon: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.surfaceMuted, alignItems: 'center', justifyContent: 'center' },
  flex: { flex: 1, gap: 2 },
  title: { ...font.sans(800), fontSize: 19, lineHeight: 26, letterSpacing: -0.4, color: colors.text },
  lead: { ...font.sans(600), fontSize: 14, lineHeight: 20, color: colors.textMuted, marginBottom: 4 },
  point: { ...typography.caption },
});
