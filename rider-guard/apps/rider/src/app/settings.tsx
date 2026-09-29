// 설정 — 디자인 없음. 계정·가입 정보·알림 상태·로그아웃·회원 탈퇴 (탈퇴는 앱 안에서 할 수 있어야 한다 — Google Play 정책)
import type { MeDto, SocialProvider } from '@rider-guard/contract';
import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useDeleteAccount, useMe } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { BottomNav } from '@/components/BottomNav';
import { ErrorText, TextButton } from '@/components/forms';
import { Button, Card, Screen, Txt } from '@/components/ui';
import { PUSH_STATUS_TEXT, usePushStatus } from '@/features/push';
import { formatMobile } from '@/lib/format';
import { colors, font, radius } from '@/theme';

const PROVIDER_LABEL: Record<SocialProvider, string> = { kakao: '카카오', naver: '네이버', google: 'Google' };

function loginMethod(account: MeDto['account']) {
  const methods = account.social.map((p) => `${PROVIDER_LABEL[p]} 로그인`);
  if (account.hasPassword && account.email) methods.unshift(account.email);
  return methods.join(', ') || '-';
}

export default function SettingsScreen() {
  const { data: me, error } = useMe();
  const { signOut } = useAuth();
  const push = usePushStatus();
  const driving = !!me?.session;

  return (
    <Screen top={48} bottom={24} gap={16} footer={<BottomNav active="settings" />}>
      <Txt style={styles.h1}>설정</Txt>
      <ErrorText error={error} />

      <Card style={styles.card}>
        <Txt style={styles.cardTitle}>계정</Txt>
        <Row label="로그인" value={me ? loginMethod(me.account) : ''} />
        <Row label="이름" value={me?.rider.name ?? '-'} />
        <Row label="휴대폰" value={me?.rider.phone ? formatMobile(me.rider.phone) : '-'} mono />
        <Button
          label="가입 정보 수정"
          variant="outline"
          height={46}
          rounded={radius.lg}
          fontSize={14}
          weight={600}
          onPress={() => router.push({ pathname: '/onboarding', params: { mode: 'edit' } })}
        />
      </Card>

      <Card style={styles.card}>
        <Txt style={styles.cardTitle}>알림</Txt>
        <Row label="사고 확인 푸시" value={PUSH_STATUS_TEXT[push]} />
      </Card>

      <View style={{ gap: 8, paddingTop: 8 }}>
        {driving && <Txt style={styles.muted}>운행 중에는 로그아웃·탈퇴할 수 없어요. 먼저 운행을 종료해 주세요.</Txt>}
        <Button label="로그아웃" variant="outline" disabled={driving} onPress={() => signOut()} />
        {!driving && <DeleteAccount onDeleted={() => signOut({ tokenInvalid: true })} />}
      </View>
    </Screen>
  );
}

function Row({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <View style={styles.row}>
      <Txt style={styles.rowLabel}>{label}</Txt>
      <Txt style={[styles.rowValue, mono && font.mono(500)]} numberOfLines={2}>
        {value}
      </Txt>
    </View>
  );
}

/** 두 번 눌러야 지워진다 — 되돌릴 수 없으므로 첫 번째는 무엇이 지워지는지 보여 주기만 한다 */
function DeleteAccount({ onDeleted }: { onDeleted: () => void }) {
  const [confirming, setConfirming] = useState(false);
  const remove = useDeleteAccount();

  if (!confirming) return <TextButton label="회원 탈퇴" onPress={() => setConfirming(true)} />;
  return (
    <Card style={[styles.card, { borderColor: colors.accent }]}>
      <Txt style={styles.cardTitle}>정말 탈퇴할까요?</Txt>
      <Txt style={styles.body}>
        계정과 비상연락망, 기기 연결, 사고 기록이 모두 지워지고 되돌릴 수 없어요. 위치정보 이용·제공 기록은 위치정보법에 따라 6개월 동안 보관한 뒤 지워요.
      </Txt>
      <ErrorText error={remove.error} />
      <View style={{ flexDirection: 'row', gap: 8 }}>
        <Button
          label="취소"
          variant="outline"
          height={46}
          rounded={radius.lg}
          fontSize={14}
          weight={600}
          style={{ flex: 1 }}
          onPress={() => {
            remove.reset();
            setConfirming(false);
          }}
        />
        <Button
          label={remove.isPending ? '탈퇴 중…' : '탈퇴하기'}
          height={46}
          rounded={radius.lg}
          fontSize={14}
          weight={600}
          style={{ flex: 1 }}
          disabled={remove.isPending}
          onPress={() => remove.mutate(undefined, { onSuccess: onDeleted })}
        />
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 22, letterSpacing: -0.4 },
  card: { padding: 18, gap: 12 },
  cardTitle: { ...font.sans(700), fontSize: 16 },
  row: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  rowLabel: { width: 96, fontSize: 14, color: colors.textMuted },
  rowValue: { flex: 1, fontSize: 14, textAlign: 'right' },
  body: { fontSize: 14, lineHeight: 21, color: colors.textSubtle },
  muted: { fontSize: 13, lineHeight: 19, color: colors.textMuted },
});
