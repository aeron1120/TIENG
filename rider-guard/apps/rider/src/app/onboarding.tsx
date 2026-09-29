// 가입 정보 (spec-v2 01 'v2·1 시작·동의') — 이름·휴대폰·동의. 가입 직후 한 번(→ 헬멧 1/2 → 비상연락처 2/2),
// 설정에서 수정할 때도 쓴다(?mode=edit). 휴대폰 인증번호(OTP)는 없다 — 서버도 번호를 인증하지 않는다(MVP).
import type { ConsentKey, MeDto, OnboardingRequest } from '@rider-guard/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useRef, useState } from 'react';
import { StyleSheet, View, type TextInput } from 'react-native';

import { api } from '@/api/client';
import { keys, useMe } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { Checkbox, Field, Header, Notice, TextButton } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, Screen, ScreenFooter, Skeleton, Spacer, Txt } from '@/components/ui';
import { formatMobile, isMobile } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, radius, typography } from '@/theme';

/** 필수 둘 + 계약의 선택 동의 둘. 문구는 서버가 실제로 하는 일에 맞춘다. */
const CONSENTS: { key: ConsentKey; required: boolean; label: string }[] = [
  // 보호(운행 세션)는 헬멧을 쓰고 있을 때만 켜진다 — features/helmet
  { key: 'locationSensor', required: true, label: '헬멧 착용 중에만 위치·센서 수집' },
  // 비상연락 문자의 위치 링크와 119 신고문에 들어간다
  { key: 'shareOnIncident', required: true, label: '사고 시 비상연락처와 119에 위치 전달' },
  { key: 'insuranceRecords', required: false, label: '보험·산재 접수용 사고기록 제공' },
  // 동의가 있어야 119 신고문에 미리 등록한 의료정보가 들어간다
  { key: 'medicalInfo', required: false, label: '119 신고 때 의료정보 함께 전달' },
];

type Agreed = Record<ConsentKey, boolean>;

const digits = (s: string) => s.replace(/\D/g, '');

export default function OnboardingScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const editing = mode === 'edit';
  const { data: me, error } = useMe();
  // 가입 정보를 미리 채우려고 me 를 받은 뒤에 폼을 그린다
  if (!me) return error ? <OnboardingError error={error} /> : <OnboardingSkeleton editing={editing} />;
  return <OnboardingForm me={me} editing={editing} />;
}

/**
 * 가입 정보 저장. 의료정보 동의는 가입 정보 요청(OnboardingRequest)에 없어서 선택 동의 API 로 따로 보낸다 —
 * 바뀐 경우에만. 둘 중 하나라도 실패하면 오류를 보여 주고, 다시 누르면 처음부터 다시 보낸다(둘 다 같은 값을 덮어쓴다).
 */
function useSaveOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ medicalInfo, ...body }: OnboardingRequest & { medicalInfo: boolean | null }) => {
      await api<MeDto>('POST', '/me/onboarding', body);
      if (medicalInfo != null) await api('PUT', '/me/consents/medicalInfo', { granted: medicalInfo });
    },
    // 가입 정보만 저장되고 의료정보 동의에서 실패해도 화면이 서버 값을 보도록
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

function OnboardingForm({ me, editing }: { me: MeDto; editing: boolean }) {
  const { signOut } = useAuth();
  const toast = useToast();
  const save = useSaveOnboarding();
  const phoneRef = useRef<TextInput>(null);
  // 수정 화면에서 바뀐 게 있는지 비교할 처음 값 (me 가 다시 와도 흔들리지 않게 한 번만)
  const [initial] = useState(() => ({
    name: me.rider.name ?? '',
    phone: me.rider.phone ? formatMobile(me.rider.phone) : '010-',
    agreed: Object.fromEntries(CONSENTS.map((c) => [c.key, me.onboarded ? me.consents[c.key] : false])) as Agreed,
  }));
  // SNS 가입은 제공자가 준 이름·번호가 미리 들어 있다
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [agreed, setAgreed] = useState<Agreed>(initial.agreed);

  const allAgreed = CONSENTS.every((c) => agreed[c.key]);
  const requiredOk = CONSENTS.every((c) => !c.required || agreed[c.key]);
  const phoneError = digits(phone).length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const fieldsOk = name.trim().length > 0 && isMobile(phone);
  const valid = fieldsOk && requiredOk;
  const dirty =
    name.trim() !== initial.name.trim() || digits(phone) !== digits(initial.phone) || CONSENTS.some((c) => agreed[c.key] !== initial.agreed[c.key]);

  const toggleAll = () => setAgreed(Object.fromEntries(CONSENTS.map((c) => [c.key, !allAgreed])) as Agreed);

  const submit = () => {
    if (!valid || save.isPending) return;
    save.mutate(
      {
        name: name.trim(),
        phone,
        consents: { locationSensor: agreed.locationSensor, shareOnIncident: agreed.shareOnIncident, insuranceRecords: agreed.insuranceRecords },
        medicalInfo: agreed.medicalInfo !== me.consents.medicalInfo ? agreed.medicalInfo : null,
      },
      {
        onSuccess: () => {
          if (editing) {
            toast.show('가입 정보를 저장했어요');
            backOr('/settings');
          } else {
            // 가입 흐름: 헬멧(1/2) → 비상연락처(2/2). 뒤로 오면 입력한 값이 그대로 남아 있다
            router.push({ pathname: '/helmet', params: { flow: 'onboarding' } });
          }
        },
      },
    );
  };

  const footer = (
    <ScreenFooter style={styles.footer}>
      {/* 버튼이 왜 회색인지 — 칸은 다 채웠는데 필수 동의만 빠졌을 때 */}
      {fieldsOk && !requiredOk && (
        <FadeIn offset={4}>
          <Txt style={styles.need}>필수 항목에 동의해야 {editing ? '저장할' : '다음으로 넘어갈'} 수 있어요.</Txt>
        </FadeIn>
      )}
      <Button
        label={editing ? '저장' : '동의하고 다음'}
        loading={save.isPending}
        disabled={!valid || (editing && !dirty)}
        onPress={submit}
      />
    </ScreenFooter>
  );

  return (
    <Screen top={editing ? 52 : 60} side={24} gap={28} bottom={24} enter="none" footer={footer}>
      {editing ? (
        <Header onBack={() => backOr('/settings')} />
      ) : (
        <FadeIn style={styles.brandRow}>
          <View style={styles.brand}>
            <LogoIcon size={40} />
            <Txt style={styles.brandName}>Rider Guard</Txt>
          </View>
          {/* 다른 계정으로 로그인하려는 경우 — 가입 정보를 마치기 전에는 다른 화면으로 갈 수 없다 */}
          <TextButton label="다른 계정으로 로그인" fontSize={13} onPress={() => signOut()} style={styles.switchAccount} />
        </FadeIn>
      )}

      <FadeIn delay={editing ? 0 : 40} style={styles.intro}>
        <Txt accessibilityRole="header" style={editing ? typography.title : typography.display}>
          {editing ? '가입 정보 수정' : '시작하기 전에\n몇 가지만 확인할게요'}
        </Txt>
        {/* 서버 문구: 비상연락처 문자에는 이름, 119 신고문에는 이름과 번호가 들어간다. '119 신고'는 한 줄에 */}
        <Txt style={typography.lead}>사고가 나면 이 이름으로 비상연락처에게 알리고, 119{'\u00A0'}신고에는 번호도 함께 보내요.</Txt>
      </FadeIn>

      <FadeIn delay={editing ? 40 : 80} style={styles.fields}>
        <Field
          label="이름"
          value={name}
          onChangeText={setName}
          placeholder="홍길동"
          autoComplete="name"
          textContentType="name"
          maxLength={20}
          returnKeyType="next"
          submitBehavior="submit"
          onSubmitEditing={() => phoneRef.current?.focus()}
        />
        <Field
          ref={phoneRef}
          label="휴대폰 번호"
          value={phone}
          onChangeText={(t) => setPhone(formatMobile(t))}
          keyboardType="phone-pad"
          inputMode="tel"
          autoComplete="tel"
          textContentType="telephoneNumber"
          returnKeyType="done"
          error={phoneError}
        />
      </FadeIn>

      <FadeIn delay={editing ? 80 : 120}>
        <Card style={styles.consents}>
          <Checkbox size="lg" checked={allAgreed} onToggle={toggleAll} label="모두 동의" />
          <Divider style={styles.rule} />
          {CONSENTS.map((c) => (
            <Checkbox
              key={c.key}
              checked={agreed[c.key]}
              onToggle={() => setAgreed((a) => ({ ...a, [c.key]: !a[c.key] }))}
              tag={c.required ? '필수' : '선택'}
              tagColor={c.required ? colors.primary : colors.textMuted}
              label={c.label}
            />
          ))}
        </Card>
      </FadeIn>

      <Notice error={save.error} />
    </Screen>
  );
}

/** me 를 받는 동안 — 폼과 같은 자리에 회색 막대 (받고 나서 자리가 튀지 않게) */
function OnboardingSkeleton({ editing }: { editing: boolean }) {
  return (
    <Screen
      top={editing ? 52 : 60}
      side={24}
      gap={28}
      bottom={24}
      enter="none"
      footer={
        <ScreenFooter style={styles.footer}>
          <Skeleton width="100%" height={58} radius={radius.button} />
        </ScreenFooter>
      }
    >
      {editing ? (
        <View style={styles.editHead} />
      ) : (
        <View style={styles.brand}>
          <Skeleton width={40} height={40} radius={radius.lg} />
          <Skeleton width={112} height={18} />
        </View>
      )}
      <View style={styles.intro}>
        <Skeleton width="62%" height={30} />
        {!editing && <Skeleton width="82%" height={30} />}
        <Skeleton width="96%" height={16} style={styles.skeletonLead} />
        <Skeleton width="58%" height={16} />
      </View>
      <View style={styles.fields}>
        {[0, 1].map((i) => (
          <View key={i} style={styles.skeletonField}>
            <Skeleton width={72} height={14} />
            <Skeleton width="100%" height={56} radius={radius.input} />
          </View>
        ))}
      </View>
      <Skeleton width="100%" height={246} radius={radius.card} />
    </Screen>
  );
}

function OnboardingError({ error }: { error: unknown }) {
  const { refetch, isFetching } = useMe();
  const { signOut } = useAuth();
  return (
    <Screen top={60} side={24} gap={12}>
      <Txt accessibilityRole="header" style={typography.title}>
        가입 정보를 불러오지 못했어요
      </Txt>
      <Notice error={error} />
      <Txt style={typography.lead}>인터넷 연결을 확인하고 다시 시도해 주세요.</Txt>
      <Spacer />
      <Button label="다시 시도" loading={isFetching} onPress={() => void refetch()} />
      <TextButton label="다른 계정으로 로그인" onPress={() => signOut()} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  // 아주 좁은 폰에서는 '다른 계정으로 로그인'이 다음 줄로 내려간다
  brandRow: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', justifyContent: 'space-between', rowGap: 4 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandName: { ...font.sans(700), fontSize: 18, lineHeight: 24, letterSpacing: -0.3 },
  // 글자 버튼의 좌우 여백만큼 밖으로 — 글자 끝이 본문 오른쪽 선에 맞게
  switchAccount: { marginRight: -8 },
  editHead: { height: 44 },
  intro: { gap: 8, marginTop: -4 },
  fields: { gap: 16 },
  skeletonField: { gap: 12 },
  skeletonLead: { marginTop: 6 },
  consents: { paddingHorizontal: 16, paddingVertical: 6 },
  rule: { marginVertical: 2 },
  footer: { paddingHorizontal: 24 },
  need: { ...typography.caption, textAlign: 'center' },
});
