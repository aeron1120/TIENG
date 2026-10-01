// 넓은 화면(관제·관리자) 맨 위 — 화면 이름 · 로그인한 계정 · 역할 바꾸기 · 로그아웃
import type { UserRole } from '@rider-guard/contract';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { useMe, useSetRole } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { LogoIcon } from '@/components/Icons';
import { Badge, Button, Txt } from '@/components/ui';
import { colors, font, typography } from '@/theme';

export const ROLE_LABEL: Record<UserRole, string> = { rider: '배달기사', dispatcher: '관제사', admin: '관리자' };

export function AccountBar({ title, sub }: { title: string; sub?: string }) {
  const { data: me } = useMe();
  const { signOut } = useAuth();
  const setRole = useSetRole();
  const role = me?.role ?? null;
  const who = me?.rider.name?.trim() || me?.account.email || '';
  return (
    <View style={styles.bar}>
      <LogoIcon size={30} />
      <View style={styles.flex}>
        <Txt style={styles.title}>{title}</Txt>
        {sub ? <Txt style={styles.sub}>{sub}</Txt> : null}
      </View>
      {role ? <Badge tone={role === 'admin' ? 'dark' : 'neutral'}>{ROLE_LABEL[role]}</Badge> : null}
      {who ? <Txt style={styles.who} numberOfLines={1}>{who}</Txt> : null}
      {role === 'dispatcher' ? (
        <Button
          label="배달기사로 바꾸기"
          size="sm"
          variant="outline"
          loading={setRole.isPending}
          onPress={() => setRole.mutate('rider', { onSuccess: () => router.replace('/') })}
          style={styles.btn}
        />
      ) : null}
      <Button label="로그아웃" size="sm" variant="soft" onPress={() => signOut()} style={styles.btn} />
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
  flex: { flex: 1, minWidth: 220 },
  title: { ...font.sans(800), fontSize: 24, lineHeight: 32, letterSpacing: -0.6, color: colors.text },
  sub: { ...typography.caption },
  who: { ...font.sans(600), fontSize: 13, color: colors.textMuted, maxWidth: 240 },
  btn: { paddingHorizontal: 14 },
});
