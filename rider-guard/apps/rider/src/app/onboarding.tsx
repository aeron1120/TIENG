// 시작·동의 (spec-v3 01 'v3·1 시작·동의') — 휴대폰 인증 + 동의 → 가입 정보 저장 → 헬멧(1/2) → 비상연락처(2/2).
// 이름은 가입 화면에서 받아 둔 값(features/sim 의 pending name)을 쓴다. 그 값도 서버 이름도 없을 때만(SNS 가입·다른 기기 로그인) 이름 칸을 보인다.
// 인증번호는 앱 안 시뮬레이션이다(서버는 번호를 인증하지 않는다, MVP). 로고 줄 오른쪽 '다른 계정으로 로그인'이 이 화면의 출구다.
// 설정에서 열면(?mode=edit) 디자인 밖의 같은 톤 수정 폼 — 이름·번호·동의, 인증 칸은 없다.
import type { MeDto, OnboardingRequest } from '@rider-guard/contract';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Keyboard, StyleSheet, View, type TextInput } from 'react-native';

import { api } from '@/api/client';
import { keys, useMe } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { Checkbox, ErrorText, Field, Header, Input, Notice, TextButton } from '@/components/forms';
import { LogoIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, Screen, ScreenFooter, Sheet, Skeleton, Spacer, Txt } from '@/components/ui';
import { clearPendingName, getPendingName, setFalsePositiveConsent, useConsentSim, useOtpSim, usePendingName } from '@/features/sim';
import { formatMobile, isMobile } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, radius, typography } from '@/theme';

// ── 동의 항목 ────────────────────────────────────────────────

/** 서버 동의 넷 + 앱에만 남기는 '오탐 구간' 선택 동의(시뮬레이션) */
type ConsentId = 'locationSensor' | 'shareOnIncident' | 'falsePositive' | 'insuranceRecords' | 'medicalInfo';
type ConsentItem = { id: ConsentId; required: boolean; label: string; detail: string };
type Agreed = Record<ConsentId, boolean>;

// 문구는 디자인 그대로, 자세히 보기(>)는 서버가 실제로 하는 일에 맞춘다
const LOCATION: ConsentItem = {
  id: 'locationSensor',
  required: true,
  label: '헬멧 착용 중에만 위치·센서 수집',
  detail: '헬멧을 쓰고 보호가 켜져 있는 동안에만 위치와 움직임 센서 값을 모아요. 헬멧을 벗으면 수집도 함께 멈춰요. 모은 값은 사고 감지와 대응에만 써요.',
};
const SHARE: ConsentItem = {
  id: 'shareOnIncident',
  required: true,
  label: '사고 때 비상연락처에 위치 전달',
  detail: '사고가 감지되고 라이더님이 답하지 않거나 도움을 요청하면, 비상연락처에게 가는 알림과 119 신고에 마지막 위치를 함께 보내요. 평소에는 누구에게도 위치를 보여 주지 않아요.',
};
const FALSE_POSITIVE: ConsentItem = {
  id: 'falsePositive',
  required: false,
  label: '오탐 구간을 정확도 개선에 제공',
  detail: '사고로 감지됐지만 괜찮았던 구간의 센서 기록을 이름·연락처 없이 감지 정확도를 높이는 데 써요. 동의하지 않아도 모든 기능을 그대로 쓸 수 있어요.',
};
// 수정 화면에서만 — 디자인에는 없지만 설정의 '동의 관리'가 여기로 온다
const INSURANCE: ConsentItem = {
  id: 'insuranceRecords',
  required: false,
  label: '보험·산재 접수용 사고기록 제공',
  detail: '보험·산재를 접수할 때 쓸 수 있게 사고 기록(시각·위치·대응 과정)을 제공해요.',
};
const MEDICAL: ConsentItem = {
  id: 'medicalInfo',
  required: false,
  label: '119 신고 때 의료정보 함께 전달',
  detail: '119에 신고할 때 미리 등록한 의료정보를 함께 보내요.',
};

const START_ITEMS = [LOCATION, SHARE, FALSE_POSITIVE];
const EDIT_ITEMS = [LOCATION, SHARE, FALSE_POSITIVE, INSURANCE, MEDICAL];

const NONE: Agreed = { locationSensor: false, shareOnIncident: false, falsePositive: false, insuranceRecords: false, medicalInfo: false };

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');

// ── 화면 ────────────────────────────────────────────────────

export default function OnboardingScreen() {
  const { mode } = useLocalSearchParams<{ mode?: string }>();
  const editing = mode === 'edit';
  const { data: me, error } = useMe();
  // 스켈레톤을 거쳐 왔으면 로고·제목은 이미 보였으니 다시 떠오르게 하지 않는다
  const [waited] = useState(() => !me);
  // 번호를 미리 채우려고 me 를 받은 뒤에 폼을 그린다
  if (!me) return error ? <OnboardingError error={error} /> : <OnboardingSkeleton editing={editing} />;
  return editing ? <EditForm me={me} /> : <StartForm me={me} introShown={waited} />;
}

type SaveVars = OnboardingRequest & { medicalInfo: boolean | null };

/**
 * 가입 정보 저장 (POST /me/onboarding). 의료정보 동의는 가입 정보 요청에 없어 선택 동의 API 로 따로 — 바뀐 경우에만.
 * 둘 중 하나라도 실패하면 오류를 보여 주고, 다시 누르면 처음부터 다시 보낸다(둘 다 같은 값을 덮어쓴다).
 */
function useSaveOnboarding() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ medicalInfo, ...body }: SaveVars) => {
      await api<MeDto>('POST', '/me/onboarding', body);
      if (medicalInfo != null) await api('PUT', '/me/consents/medicalInfo', { granted: medicalInfo });
    },
    onSettled: () => qc.invalidateQueries({ queryKey: keys.me }),
  });
}

/** 동의 카드 + 자세히 보기 시트 (시작·수정 공통) */
function ConsentCard({ items, agreed, onChange }: { items: ConsentItem[]; agreed: Agreed; onChange: (next: Agreed) => void }) {
  const [open, setOpen] = useState(false);
  // 시트가 내려가는 동안에도 내용이 남아 있게 마지막 항목을 들고 있는다
  const [shown, setShown] = useState<ConsentItem>(items[0]!);
  const all = items.every((c) => agreed[c.id]);
  const toggleAll = () => onChange({ ...agreed, ...Object.fromEntries(items.map((c) => [c.id, !all])) });
  const set = (id: ConsentId, value: boolean) => onChange({ ...agreed, [id]: value });

  return (
    <>
      <Card style={styles.consents}>
        <Checkbox size="lg" checked={all} onToggle={toggleAll} label="모두 동의" />
        <Divider style={styles.rule} />
        {items.map((c) => (
          <Checkbox
            key={c.id}
            checked={agreed[c.id]}
            onToggle={() => set(c.id, !agreed[c.id])}
            tag={c.required ? '필수' : '선택'}
            label={c.label}
            onDetail={() => {
              setShown(c);
              setOpen(true);
            }}
          />
        ))}
      </Card>

      <Sheet visible={open} onClose={() => setOpen(false)} title={shown.label} description={shown.detail}>
        {agreed[shown.id] ? (
          <Button label="확인" onPress={() => setOpen(false)} />
        ) : (
          <>
            <Button
              label="동의할게요"
              onPress={() => {
                set(shown.id, true);
                setOpen(false);
              }}
            />
            <Button label="닫기" variant="ghost" size="md" onPress={() => setOpen(false)} />
          </>
        )}
      </Sheet>
    </>
  );
}

/**
 * '오탐 구간' 선택 동의 — 서버 계약에 없어 기기에만 남긴다(features/sim). 누르기 전에는 저장값을 따른다
 * (네이티브는 저장값을 늦게 읽으니 처음 값을 붙잡아 두지 않는다). fresh = 새 가입이면 저장값과 상관없이 꺼진 채로.
 */
function useFalsePositive(fresh: boolean) {
  const [stored] = useConsentSim();
  const [choice, setChoice] = useState<boolean | null>(null);
  const value = choice ?? (fresh ? false : stored);
  return {
    value,
    set: setChoice,
    changed: choice !== null && choice !== stored,
    /** 새 가입은 늘, 아니면 누른 경우에만 저장 — 읽기 전 기본값으로 덮어쓰지 않게 */
    persist: () => {
      if (fresh || choice !== null) setFalsePositiveConsent(value);
    },
  };
}

/** 로고 줄 · 제목 · 설명 (v3·1). 스켈레톤과 같은 자리 */
function Intro({ animate }: { animate: boolean }) {
  const { signOut } = useAuth();
  return (
    <>
      <FadeIn animate={animate} style={styles.brand}>
        <LogoIcon size={28} />
        <Txt style={styles.brandName}>Rider Guard</Txt>
        {/* 잘못 로그인했을 때의 출구 — 가입 정보를 마치기 전에는 홈·설정으로 갈 수 없다 (디자인에 없어 작고 옅게) */}
        <TextButton label="다른 계정으로 로그인" onPress={() => signOut()} color={colors.textFaint} fontSize={13} weight={500} style={styles.exit} />
      </FadeIn>
      <FadeIn animate={animate} delay={40} style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.display}>
          {'달리는 동안\n곁에서 지켜볼게요'}
        </Txt>
        <Txt style={[typography.lead, styles.lead]}>{'사고가 감지되면 먼저 라이더님께 묻고,\n답이 없을 때만 가까운 사람에게 알려요.'}</Txt>
      </FadeIn>
    </>
  );
}

// ── v3·1 시작·동의 ───────────────────────────────────────────

function StartForm({ me, introShown }: { me: MeDto; introShown: boolean }) {
  const toast = useToast();
  const save = useSaveOnboarding();
  const otp = useOtpSim();
  const fp = useFalsePositive(!me.onboarded);
  const codeRef = useRef<TextInput>(null);
  const phoneRef = useRef<TextInput>(null);
  // 가입 화면을 거치지 않아(SNS 가입·다른 기기 로그인·앱 데이터 삭제) 이름을 모를 때만 이름 칸 — 디자인 밖 예외 상태.
  // 처음 읽은 결과로 한 번만 정한다(저장 뒤 받아 둔 이름을 지워도 칸이 튀어나오지 않게)
  const pending = usePendingName();
  const [askName, setAskName] = useState<boolean | null>(null);
  if (askName === null && pending.ready) setAskName(!pending.name && !me.rider.name?.trim());
  const [name, setName] = useState('');
  // SNS 가입은 제공자가 준 번호가 미리 들어 있다. 없으면 '010-' 부터
  const [phone, setPhone] = useState(() => (me.rider.phone ? formatMobile(me.rider.phone) : '010-'));
  // 이미 가입 정보를 마친 계정이면 서버 값으로 (헬멧 단계에서 뒤로 온 경우는 입력값이 그대로 남아 있다)
  const [serverAgreed, setServerAgreed] = useState<Agreed>(() => (me.onboarded ? { ...me.consents, falsePositive: false } : NONE));
  const agreed: Agreed = { ...serverAgreed, falsePositive: fp.value };
  const changeConsents = (next: Agreed) => {
    setServerAgreed(next);
    if (next.falsePositive !== fp.value) fp.set(next.falsePositive);
  };
  // 인증번호를 요청한 번호(숫자만) — 번호를 바꾸면 인증을 처음부터
  const [otpFor, setOtpFor] = useState<string | null>(null);
  const [phoneError, setPhoneError] = useState<string | null>(null);
  const [codeError, setCodeError] = useState<Error | null>(null);
  const [resolving, setResolving] = useState(false);

  // 보냈으면 토스트 + 인증번호 칸으로. 문자 자동 채움처럼 잠시 뒤 6자리가 들어온다(useOtpSim)
  const prevStatus = useRef(otp.status);
  useEffect(() => {
    if (prevStatus.current === 'sending' && otp.status === 'sent') {
      toast.show('인증번호를 보냈어요');
      codeRef.current?.focus();
    }
    prevStatus.current = otp.status;
  }, [otp.status, toast]);

  // 자동으로 채워져 인증되면 키보드를 내려 아래 동의·버튼이 보이게
  useEffect(() => {
    if (otp.verified) Keyboard.dismiss();
  }, [otp.verified]);

  const requiredOk = START_ITEMS.every((c) => !c.required || agreed[c.id]);
  const formatError = digits(phone).length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const fieldsOk = (!askName || name.trim().length > 0) && isMobile(phone) && otp.code.length === 6;
  const valid = fieldsOk && requiredOk;
  const busy = save.isPending || resolving;

  const changePhone = (t: string) => {
    const next = formatMobile(t);
    setPhone(next);
    setPhoneError(null);
    if (otpFor && digits(next) !== otpFor) {
      otp.reset();
      setOtpFor(null);
      setCodeError(null);
    }
  };

  const requestCode = () => {
    if (!isMobile(phone)) {
      setPhoneError(digits(phone).length >= 10 ? '휴대폰 번호 형식을 확인해 주세요.' : '휴대폰 번호를 끝까지 입력해 주세요.');
      return;
    }
    setPhoneError(null);
    setCodeError(null);
    setOtpFor(digits(phone));
    otp.request(phone);
  };

  const submit = async () => {
    if (!valid || busy) return;
    if (!otp.verified || otpFor !== digits(phone)) {
      setCodeError(new Error(otp.status === 'idle' ? '먼저 인증 요청을 눌러 주세요.' : '인증번호가 맞지 않아요. 문자로 받은 6자리를 확인해 주세요.'));
      return;
    }
    // 이름: 이 화면에서 받은 이름 → 가입 화면에서 받아 둔 이름 → 서버에 있던 이름 → '라이더'
    setResolving(true);
    const stored = await getPendingName().catch(() => null);
    setResolving(false);
    const riderName = (askName ? name.trim() : '') || stored?.trim() || me.rider.name?.trim() || '라이더';
    save.mutate(
      {
        name: riderName,
        phone,
        consents: {
          locationSensor: agreed.locationSensor,
          shareOnIncident: agreed.shareOnIncident,
          // 이 화면에는 없는 선택 동의 — 처음이면 끔, 이미 있던 값은 그대로
          insuranceRecords: me.onboarded ? me.consents.insuranceRecords : false,
        },
        medicalInfo: null,
      },
      {
        onSuccess: () => {
          clearPendingName();
          fp.persist();
          // 가입 흐름: 헬멧(1/2) → 비상연락처(2/2). 뒤로 오면 입력한 값이 그대로 남아 있다
          router.push({ pathname: '/helmet', params: { flow: 'onboarding' } });
        },
      },
    );
  };

  const footer = (
    <ScreenFooter>
      {/* 버튼이 왜 회색인지 — 칸은 다 채웠는데 필수 동의만 빠졌을 때 */}
      {fieldsOk && !requiredOk ? <RequiredHint action="다음으로 넘어갈" /> : null}
      <Button label="동의하고 다음" loading={busy} disabled={!valid} onPress={() => void submit()} />
    </ScreenFooter>
  );

  return (
    <Screen top={63} gap={0} bottom={24} enter="none" footer={footer}>
      <Intro animate={!introShown} />

      {askName ? (
        <FadeIn delay={80} style={styles.phone}>
          <Field
            label="이름"
            value={name}
            onChangeText={setName}
            autoFocus
            placeholder="사고 때 비상연락처에게 보여요"
            autoComplete="name"
            textContentType="name"
            maxLength={20}
            returnKeyType="next"
            submitBehavior="submit"
            onSubmitEditing={() => phoneRef.current?.focus()}
          />
        </FadeIn>
      ) : null}

      <FadeIn delay={80} style={styles.phone}>
        <Field
          ref={phoneRef}
          label="휴대폰 번호"
          value={phone}
          onChangeText={changePhone}
          autoFocus={askName !== true}
          keyboardType="phone-pad"
          inputMode="tel"
          autoComplete="tel"
          textContentType="telephoneNumber"
          returnKeyType="done"
          error={phoneError ?? formatError}
          right={
            <Button
              label={otp.status === 'idle' ? '인증 요청' : '재요청'}
              accessibilityLabel={otp.status === 'idle' ? '인증 요청' : '인증번호 다시 요청'}
              variant="soft"
              size="md"
              fontSize={15}
              weight={600}
              loading={otp.status === 'sending'}
              onPress={requestCode}
              style={styles.request}
              textStyle={styles.requestText}
            />
          }
        />
        <Input
          ref={codeRef}
          value={otp.code}
          onChangeText={(t) => {
            otp.setCode(t);
            setCodeError(null);
          }}
          placeholder="인증번호 6자리"
          accessibilityLabel="인증번호 6자리"
          keyboardType="number-pad"
          inputMode="numeric"
          autoComplete="sms-otp"
          textContentType="oneTimeCode"
          maxLength={6}
          returnKeyType="done"
          onSubmitEditing={() => void submit()}
          error={!!codeError}
          style={styles.code}
        />
        <ErrorText error={codeError} />
      </FadeIn>

      <FadeIn delay={120} style={styles.card}>
        <ConsentCard items={START_ITEMS} agreed={agreed} onChange={changeConsents} />
      </FadeIn>

      <Notice error={save.error} style={styles.notice} />
    </Screen>
  );
}

// ── 설정 → 가입 정보 수정 (디자인 밖, 같은 톤) ─────────────────

function EditForm({ me }: { me: MeDto }) {
  const toast = useToast();
  const save = useSaveOnboarding();
  const fp = useFalsePositive(false);
  const phoneRef = useRef<TextInput>(null);
  // 바뀐 게 있는지 비교할 처음 값 (me 가 다시 와도 흔들리지 않게 한 번만)
  const [initial] = useState(() => ({
    name: me.rider.name ?? '',
    phone: me.rider.phone ? formatMobile(me.rider.phone) : '010-',
    agreed: { ...me.consents, falsePositive: false } as Agreed,
  }));
  const [name, setName] = useState(initial.name);
  const [phone, setPhone] = useState(initial.phone);
  const [serverAgreed, setServerAgreed] = useState<Agreed>(initial.agreed);
  const agreed: Agreed = { ...serverAgreed, falsePositive: fp.value };
  const changeConsents = (next: Agreed) => {
    setServerAgreed(next);
    if (next.falsePositive !== fp.value) fp.set(next.falsePositive);
  };

  const requiredOk = EDIT_ITEMS.every((c) => !c.required || agreed[c.id]);
  const phoneError = digits(phone).length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const fieldsOk = name.trim().length > 0 && isMobile(phone);
  const valid = fieldsOk && requiredOk;
  const dirty =
    name.trim() !== initial.name.trim() ||
    digits(phone) !== digits(initial.phone) ||
    fp.changed ||
    EDIT_ITEMS.some((c) => c.id !== 'falsePositive' && agreed[c.id] !== initial.agreed[c.id]);

  const submit = () => {
    if (!valid || !dirty || save.isPending) return;
    save.mutate(
      {
        name: name.trim(),
        phone,
        consents: { locationSensor: agreed.locationSensor, shareOnIncident: agreed.shareOnIncident, insuranceRecords: agreed.insuranceRecords },
        medicalInfo: agreed.medicalInfo !== me.consents.medicalInfo ? agreed.medicalInfo : null,
      },
      {
        onSuccess: () => {
          fp.persist();
          toast.show('가입 정보를 저장했어요');
          backOr('/settings');
        },
      },
    );
  };

  return (
    <Screen
      gap={0}
      bottom={24}
      enter="none"
      footer={
        <ScreenFooter>
          {fieldsOk && !requiredOk ? <RequiredHint action="저장할" /> : null}
          <Button label="저장" loading={save.isPending} disabled={!valid || !dirty} onPress={submit} />
        </ScreenFooter>
      }
    >
      <Header onBack={() => backOr('/settings')} />

      <FadeIn style={styles.editIntro}>
        <Txt accessibilityRole="header" style={typography.title}>
          가입 정보 수정
        </Txt>
        {/* 서버 문구: 비상연락처 알림에는 이름, 119 신고에는 이름과 번호가 들어간다 */}
        <Txt style={[typography.lead, styles.lead]}>사고가 나면 이 이름으로 비상연락처에게 알리고, 119{' '}신고에는 번호도 함께 보내요.</Txt>
      </FadeIn>

      <FadeIn delay={40} style={styles.editFields}>
        <Field
          label="이름"
          value={name}
          onChangeText={setName}
          placeholder="이름"
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

      <FadeIn delay={80} style={styles.card}>
        <ConsentCard items={EDIT_ITEMS} agreed={agreed} onChange={changeConsents} />
      </FadeIn>

      <Notice error={save.error} style={styles.notice} />
    </Screen>
  );
}

/** 필수 동의가 빠져 버튼이 회색일 때 한 줄 (디자인 밖 상태) */
function RequiredHint({ action }: { action: string }) {
  return (
    <FadeIn offset={4}>
      <Txt style={styles.need}>필수 항목에 동의해야 {action} 수 있어요.</Txt>
    </FadeIn>
  );
}

// ── 불러오는 중 · 실패 ─────────────────────────────────────────

/** me 를 받는 동안 — 폼과 같은 자리에 회색 막대 (받고 나서 자리가 튀지 않게) */
function OnboardingSkeleton({ editing }: { editing: boolean }) {
  const footer = (
    <ScreenFooter>
      <Skeleton width="100%" height={56} radius={radius.button} />
    </ScreenFooter>
  );
  if (editing) {
    return (
      <Screen gap={0} bottom={24} enter="none" footer={footer}>
        <View style={styles.editHead} />
        <View style={styles.editIntro}>
          <Skeleton width="52%" height={30} />
          <Skeleton width="96%" height={16} style={styles.skeletonLead} />
          <Skeleton width="58%" height={16} />
        </View>
        <View style={styles.editFields}>
          {[0, 1].map((i) => (
            <View key={i} style={styles.skeletonField}>
              <Skeleton width={64} height={13} />
              <Skeleton width="100%" height={52} radius={radius.input} />
            </View>
          ))}
        </View>
        <Skeleton width="100%" height={286} radius={radius.card} style={styles.card} />
      </Screen>
    );
  }
  return (
    <Screen top={63} gap={0} bottom={24} enter="none" footer={footer}>
      <Intro animate />
      <View style={[styles.phone, styles.skeletonField]}>
        <Skeleton width={64} height={13} />
        <View style={styles.skeletonRow}>
          <Skeleton width="72%" height={52} radius={radius.input} style={styles.skeletonGrow} />
          <Skeleton width={87} height={52} radius={radius.input} />
        </View>
        <Skeleton width="100%" height={52} radius={radius.input} />
      </View>
      <Skeleton width="100%" height={198} radius={radius.card} style={styles.card} />
    </Screen>
  );
}

function OnboardingError({ error }: { error: unknown }) {
  const { refetch, isFetching } = useMe();
  const { signOut } = useAuth();
  return (
    <Screen top={63} gap={12}>
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
  // 로고 28 + 'Rider Guard' 15 굵게 (+ 오른쪽 끝 '다른 계정으로 로그인')
  brand: { flexDirection: 'row', alignItems: 'center', gap: 8, height: 28 },
  exit: { marginLeft: 'auto', marginRight: -8, minHeight: 28 },
  brandName: { ...font.sans(700), fontSize: 15, lineHeight: 20, letterSpacing: 0.5, color: colors.text },
  intro: { marginTop: 28 },
  lead: { marginTop: 10 },
  // 라벨~입력칸 간격(Field 8)이 디자인(6)보다 넓어 1 당긴다
  phone: { marginTop: 27, gap: 8 },
  // '인증 요청' ↔ '재요청' 이 바뀌어도 폭이 흔들리지 않게
  request: { minWidth: 87 },
  requestText: { color: colors.noticeText },
  code: { fontVariant: ['tabular-nums'] },
  card: { marginTop: 20 },
  // 모두 동의 48 + 구분선 + 44 × n (디자인 카드 높이 196)
  consents: { paddingHorizontal: 16, paddingTop: 7, paddingBottom: 6 },
  rule: { marginTop: 2 },
  notice: { marginTop: 16 },
  need: { ...typography.caption, textAlign: 'center' },
  editHead: { height: 44 },
  editIntro: { marginTop: 16 },
  editFields: { marginTop: 28, gap: 16 },
  skeletonField: { gap: 8 },
  skeletonRow: { flexDirection: 'row', gap: 8 },
  skeletonGrow: { flex: 1 },
  skeletonLead: { marginTop: 14, marginBottom: 7 },
});
