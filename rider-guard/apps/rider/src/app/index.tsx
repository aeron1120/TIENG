// 디자인: design/Main.dc.html — 로그인과 동의
import { Redirect, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useRequestOtp, useVerify } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { CheckIcon, LogoIcon } from '@/components/Icons';
import { Button, Card, Screen, Spacer, Txt } from '@/components/ui';
import { colors, font, radius } from '@/theme';

const CONSENTS = [
  { key: 'locationSensor', required: true, label: '운행 중에만 위치·센서 데이터 수집' },
  { key: 'shareOnIncident', required: true, label: '사고 시 비상연락처·배달대행사에 위치와 상태 전달' },
  { key: 'insuranceRecords', required: false, label: '보험·산재 접수용 사고기록 제공' },
] as const;

type ConsentKey = (typeof CONSENTS)[number]['key'];

export default function LoginScreen() {
  const [phone, setPhone] = useState('010-');
  const [code, setCode] = useState('');
  const [agreed, setAgreed] = useState<Record<ConsentKey, boolean>>({ locationSensor: true, shareOnIncident: true, insuranceRecords: false });
  const [notice, setNotice] = useState<string | null>(null);
  const { status, signIn } = useAuth();
  const [justSignedIn, setJustSignedIn] = useState(false);
  const otp = useRequestOtp();
  const verify = useVerify();

  // 이미 로그인된 채로 앱을 열면 바로 홈으로. 방금 로그인한 경우에는 설정 화면으로 보낸다(아래 start).
  if (status === 'signedIn' && !justSignedIn) return <Redirect href="/home" />;

  const requiredOk = CONSENTS.every((c) => !c.required || agreed[c.key]);
  const error = otp.error ?? verify.error;

  const sendCode = () => {
    verify.reset();
    otp.mutate(phone, {
      onSuccess: (res) => {
        if (res.devCode) setCode(res.devCode);
        setNotice(res.devCode ? '개발 서버라 인증번호를 자동으로 넣었어요.' : '인증번호를 보냈어요.');
      },
    });
  };

  const start = () =>
    verify.mutate(
      { phone, code, consents: agreed },
      {
        onSuccess: ({ token }) => {
          setJustSignedIn(true);
          signIn(token);
          router.replace('/setup');
        },
      },
    );

  return (
    <Screen top={56} side={24} gap={28}>
      <View style={styles.brand}>
        <LogoIcon />
        <Txt style={styles.brandName}>Rider Guard</Txt>
      </View>

      <View style={{ gap: 10 }}>
        <Txt style={styles.h1}>{'휴대폰 번호로\n시작해요'}</Txt>
        <Txt style={styles.lead}>사고가 나면 이 번호로 확인 알림을 보내고, 비상연락처와 관제센터에도 이 번호로 신원을 알려요.</Txt>
      </View>

      <View style={{ gap: 14 }}>
        <View style={{ gap: 6 }}>
          <Txt style={styles.label}>휴대폰 번호</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              accessibilityLabel="휴대폰 번호"
              value={phone}
              onChangeText={setPhone}
              keyboardType="phone-pad"
              autoComplete="tel"
              style={[styles.input, { flex: 1, borderColor: colors.ink }]}
            />
            <Button
              label={otp.isSuccess ? '다시 받기' : '인증번호 받기'}
              variant="dark"
              height={52}
              rounded={radius.md}
              fontSize={14}
              weight={600}
              disabled={otp.isPending || phone.replace(/D/g, '').length < 10}
              onPress={sendCode}
            />
          </View>
        </View>
        <View style={{ gap: 6 }}>
          <Txt style={styles.label}>인증번호 6자리</Txt>
          <TextInput
            accessibilityLabel="인증번호 6자리"
            value={code}
            onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
            placeholder="000000"
            placeholderTextColor={colors.borderDashed}
            keyboardType="number-pad"
            autoComplete="sms-otp"
            textContentType="oneTimeCode"
            maxLength={6}
            style={[styles.input, { letterSpacing: 6 }]}
          />
        </View>
        {error ? (
          <Txt style={[styles.message, { color: colors.accent }]}>{errorMessage(error)}</Txt>
        ) : notice ? (
          <Txt style={styles.message}>{notice}</Txt>
        ) : null}
      </View>

      <Card style={{ padding: 16, gap: 4 }}>
        <Txt style={[font.sans(700), { fontSize: 13, paddingBottom: 6 }]}>사고 대응을 위해 동의가 필요해요</Txt>
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

      <Spacer />

      <Button label="동의하고 시작하기" disabled={!requiredOk || code.length !== 6 || verify.isPending} onPress={start} />
    </Screen>
  );
}

function Checkbox(props: { checked: boolean; onToggle: () => void; tag: string; tagColor: string; label: string }) {
  const { checked, onToggle, tag, tagColor, label } = props;
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked }} onPress={onToggle} style={styles.checkRow}>
      <View style={[styles.box, checked && styles.boxOn]}>{checked && <CheckIcon size={14} color={colors.textOnDark} strokeWidth={3.5} />}</View>
      <Txt style={styles.checkText}>
        <Txt style={[font.sans(700), { color: tagColor }]}>{tag}</Txt> {label}
      </Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { ...font.sans(700), fontSize: 18, letterSpacing: -0.2 },
  h1: { ...font.sans(700), fontSize: 28, lineHeight: 36, letterSpacing: -0.6 },
  lead: { fontSize: 15, lineHeight: 23, color: colors.textMuted },
  label: { ...font.sans(600), fontSize: 13 },
  input: {
    height: 52,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    fontSize: 17,
    color: colors.text,
    ...font.mono(500),
  },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10, minHeight: 44 },
  box: {
    width: 20,
    height: 20,
    marginTop: 1,
    borderRadius: 4,
    borderWidth: 1.5,
    borderColor: colors.borderDashed,
    backgroundColor: colors.surface,
    alignItems: 'center',
    justifyContent: 'center',
  },
  boxOn: { backgroundColor: colors.accent, borderColor: colors.accent },
  checkText: { flex: 1, fontSize: 14, lineHeight: 20 },
  message: { fontSize: 13, color: colors.textMuted },
});
