// 가입 정보 — 이름·휴대폰·동의. 가입 직후 한 번(→ 기기·연락망 설정), 설정에서 수정할 때도 쓴다(?mode=edit)
// 동의 문구는 design/Main.dc.html 의 로그인 화면에서 가져왔다.
import type { MeDto } from '@rider-guard/contract';
import { useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMe, useOnboarding } from '@/api/hooks';
import { Loading } from '@/auth/AfterSignIn';
import { useAuth } from '@/auth/AuthProvider';
import { BackButton, Checkbox, ErrorText, Field, TextButton } from '@/components/forms';
import { Button, Card, Screen, Spacer, Txt } from '@/components/ui';
import { formatMobile, isMobile } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font } from '@/theme';

const CONSENTS = [
  { key: 'locationSensor', required: true, label: '운행 중에만 위치·센서 데이터 수집' },
  { key: 'shareOnIncident', required: true, label: '사고 시 비상연락처·배달대행사에 위치와 상태 전달' },
  { key: 'insuranceRecords', required: false, label: '보험·산재 접수용 사고기록 제공' },
] as const;

type ConsentKey = (typeof CONSENTS)[number]['key'];

export default function OnboardingScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const { data: me, error } = useMe();
  // 가입 정보를 미리 채우려고 me 를 받은 뒤에 폼을 그린다
  if (!me) return error ? <OnboardingError error={error} /> : <Loading />;
  return <OnboardingForm me={me} editing={mode === 'edit'} />;
}

function OnboardingForm({ me, editing }: { me: MeDto; editing: boolean }) {
  const { signOut } = useAuth();
  const save = useOnboarding();
  // SNS 가입은 제공자가 준 이름·번호가 미리 들어 있다
  const [name, setName] = useState(me.rider.name ?? '');
  const [phone, setPhone] = useState(me.rider.phone ? formatMobile(me.rider.phone) : '010-');
  const [agreed, setAgreed] = useState<Record<ConsentKey, boolean>>(() =>
    me.onboarded
      ? { locationSensor: me.consents.locationSensor, shareOnIncident: me.consents.shareOnIncident, insuranceRecords: me.consents.insuranceRecords }
      : { locationSensor: false, shareOnIncident: false, insuranceRecords: false },
  );

  const allAgreed = CONSENTS.every((c) => agreed[c.key]);
  const requiredOk = CONSENTS.every((c) => !c.required || agreed[c.key]);
  const phoneHint = phone.replace(/\D/g, '').length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const valid = name.trim().length > 0 && isMobile(phone) && requiredOk;

  const submit = () =>
    save.mutate(
      { name: name.trim(), phone, consents: agreed },
      // 처음이면 기기·연락망 설정으로, 수정이면 설정 화면으로
      { onSuccess: () => (editing ? backOr('/settings') : resetTo('/setup')) },
    );

  return (
    <Screen top={editing ? 48 : 56} side={24} gap={24}>
      {editing && <BackButton onPress={() => backOr('/settings')} />}

      <View style={{ gap: 10 }}>
        <Txt style={styles.h1}>{editing ? '가입 정보 수정' : '가입 정보를\n입력해 주세요'}</Txt>
        <Txt style={styles.lead}>사고가 나면 이 번호로 확인 알림을 보내고, 비상연락처와 관제센터에도 이 이름과 번호로 신원을 알려요.</Txt>
      </View>

      <View style={{ gap: 14 }}>
        <Field label="이름" value={name} onChangeText={setName} placeholder="홍길동" autoComplete="name" textContentType="name" maxLength={20} />
        <Field
          label="휴대폰 번호"
          value={phone}
          onChangeText={(t) => setPhone(formatMobile(t))}
          keyboardType="phone-pad"
          autoComplete="tel"
          textContentType="telephoneNumber"
          hint={phoneHint}
          style={font.mono(500)}
        />
      </View>

      <Card style={{ padding: 16, gap: 4 }}>
        <Checkbox
          checked={allAgreed}
          onToggle={() => setAgreed(Object.fromEntries(CONSENTS.map((c) => [c.key, !allAgreed])) as Record<ConsentKey, boolean>)}
          label="모두 동의"
        />
        <View style={styles.rule} />
        {CONSENTS.map((c) => (
          <Checkbox
            key={c.key}
            checked={agreed[c.key]}
            onToggle={() => setAgreed((a) => ({ ...a, [c.key]: !a[c.key] }))}
            tag={c.required ? '[필수]' : '[선택]'}
            tagColor={c.required ? colors.accent : colors.textMuted}
            label={c.label}
          />
        ))}
      </Card>

      <ErrorText error={save.error} />

      <Spacer />

      <View style={{ gap: 6 }}>
        <Button
          label={save.isPending ? '저장 중…' : editing ? '저장' : '동의하고 시작하기'}
          disabled={!valid || save.isPending}
          onPress={submit}
        />
        {/* 다른 계정으로 로그인하려는 경우 — 가입 정보를 마치기 전에는 다른 화면으로 갈 수 없다 */}
        {!editing && <TextButton label="다른 계정으로 로그인" onPress={() => signOut()} />}
      </View>
    </Screen>
  );
}

function OnboardingError({ error }: { error: unknown }) {
  const { refetch } = useMe();
  return (
    <Screen top={56} side={24} gap={16}>
      <ErrorText error={error} />
      <Button label="다시 시도" variant="outline" onPress={() => void refetch()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 26, lineHeight: 34, letterSpacing: -0.5 },
  lead: { fontSize: 15, lineHeight: 23, color: colors.textMuted },
  rule: { height: 1, backgroundColor: colors.divider, marginVertical: 4 },
});
