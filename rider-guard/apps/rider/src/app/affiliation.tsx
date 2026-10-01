// 소속 배달대행사 · 일하는 플랫폼 — 가입 흐름 2/2(?flow=onboarding), 설정·홈에서도 연다.
// 사고 때 먼저 알아야 하는 곳은 배달대행사 관제다: 라이더가 어디서 무슨 주문을 들고 있는지 알고, 주문을 보류·대체 배차한다.
// 가족 비상연락처는 선택으로 따로 둔다(/setup).
import type { DeliveryPlatform } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { useMe, useSetAffiliation } from '@/api/hooks';
import { ErrorText, Field, Header, StepHeader, TextButton } from '@/components/forms';
import { CheckIcon, InfoIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, FadeIn, Screen, ScreenFooter, Txt } from '@/components/ui';
import { backOr, resetTo } from '@/lib/nav';
import { PLATFORM_LABEL, PLATFORMS } from '@/lib/platforms';
import { colors, font, motion, radius, typography } from '@/theme';

type Mode = 'agency' | 'direct';

export default function AffiliationScreen() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const onboarding = flow === 'onboarding';
  const { data: me } = useMe();
  const save = useSetAffiliation();
  const toast = useToast();
  const current = me?.affiliation ?? null;

  const [mode, setMode] = useState<Mode>(current && !current.agency ? 'direct' : 'agency');
  const [code, setCode] = useState('');
  const [platforms, setPlatforms] = useState<DeliveryPlatform[]>(current?.platforms ?? []);

  const joined = current?.agency ?? null;
  // 이미 소속된 대행사가 있으면 코드를 다시 넣지 않아도 된다 (플랫폼만 바꾸기)
  const keepAgency = mode === 'agency' && !!joined && code.trim() === '';
  const codeOk = mode === 'direct' || keepAgency || code.replace(/[^0-9a-z]/gi, '').length >= 4;
  const canSave = platforms.length > 0 && codeOk && !save.isPending;

  const toggle = (p: DeliveryPlatform) => setPlatforms((ps) => (ps.includes(p) ? ps.filter((x) => x !== p) : [...ps, p]));

  const back = () => backOr(onboarding ? { pathname: '/helmet', params: { flow: 'onboarding' } } : '/settings');
  const submit = () => {
    if (!canSave) return;
    // 코드를 비워 두면 지금 소속을 그대로 두고 플랫폼만 바꾼다 (joinCode 를 보내지 않는다)
    const body = mode === 'direct' ? { joinCode: null, platforms } : keepAgency ? { platforms } : { joinCode: code.trim(), platforms };
    save.mutate(body, {
      onSuccess: (next) => {
        toast.success(next.affiliation?.agency ? `${next.affiliation.agency.name}에 연결했어요` : '플랫폼을 저장했어요');
        if (onboarding) resetTo('/home');
        else backOr('/settings');
      },
    });
  };

  return (
    <Screen
      top={46}
      gap={0}
      enter="none"
      footer={
        <ScreenFooter>
          {platforms.length === 0 ? <Txt style={styles.reason}>일하는 플랫폼을 하나 이상 골라 주세요</Txt> : null}
          <Button label={onboarding ? '완료' : '저장'} disabled={!canSave} loading={save.isPending} onPress={submit} />
        </ScreenFooter>
      }
    >
      {onboarding ? <StepHeader onBack={back} current={2} total={2} /> : <Header onBack={back} />}

      <FadeIn style={styles.intro}>
        <Txt accessibilityRole="header" style={typography.title}>
          {'어디서 배달하고\n계세요?'}
        </Txt>
        <Txt style={typography.lead}>{'사고가 나면 소속 배달대행사 관제에 바로 알려요.\n들고 있던 주문은 보류하고 다른 라이더에게 넘겨요.'}</Txt>
      </FadeIn>

      <FadeIn delay={motion.stagger} style={styles.block}>
        <Txt style={typography.label}>일하는 플랫폼 (여러 개 고를 수 있어요)</Txt>
        <View style={styles.chips}>
          {PLATFORMS.map((p) => {
            const on = platforms.includes(p);
            return (
              <Pressable
                key={p}
                accessibilityRole="checkbox"
                accessibilityState={{ checked: on }}
                onPress={() => toggle(p)}
                style={({ pressed }) => [styles.chip, on && styles.chipOn, pressed && styles.chipPressed]}
              >
                {on ? <CheckIcon size={14} color={colors.textOnDark} /> : null}
                <Txt style={[styles.chipText, on && styles.chipTextOn]}>{PLATFORM_LABEL[p]}</Txt>
              </Pressable>
            );
          })}
        </View>
      </FadeIn>

      <FadeIn delay={motion.stagger * 2} style={styles.block}>
        <Txt style={typography.label}>배달대행사</Txt>
        <View style={styles.segment}>
          {(
            [
              ['agency', '대행사 소속'],
              ['direct', '대행사 없이 직접 계약'],
            ] as const
          ).map(([m, label]) => (
            <Pressable
              key={m}
              accessibilityRole="radio"
              accessibilityState={{ selected: mode === m }}
              onPress={() => setMode(m)}
              style={[styles.segItem, mode === m && styles.segOn]}
            >
              <Txt style={[styles.segText, mode === m && styles.segTextOn]}>{label}</Txt>
            </Pressable>
          ))}
        </View>

        {mode === 'agency' ? (
          <View style={styles.codeBox}>
            {joined ? <Txt style={styles.joined}>{`지금 소속: ${joined.name}`}</Txt> : null}
            <Field
              label={joined ? '다른 대행사로 옮기려면 가입 코드' : '대행사 가입 코드'}
              hint="관제사에게 받은 6자리 코드예요 (관제 화면 맨 위에 있어요)"
              value={code}
              onChangeText={(t) => {
                setCode(t.toUpperCase().replace(/[^0-9A-Z]/g, '').slice(0, 8));
                if (save.error) save.reset();
              }}
              placeholder={joined ? '바꾸지 않으면 비워 두세요' : '예: K7M2QX'}
              autoCapitalize="characters"
              autoCorrect={false}
              returnKeyType="done"
              onSubmitEditing={submit}
              style={styles.code}
            />
            <View style={styles.consent}>
              <InfoIcon size={16} color={colors.noticeText} />
              <Txt style={styles.consentText}>
                소속하면 보호 중일 때만 위치·센서 상태와 사고가 이 대행사 관제에 보여요. 보호가 꺼지면 보이지 않고, 관제가 위치를 본 기록은 설정에서 확인할 수 있어요.
              </Txt>
            </View>
          </View>
        ) : (
          <Txt style={styles.directNote}>사고가 나면 등록한 비상연락처와 119에 알려요. 플랫폼에 직접 알리는 연동은 아직 없어요.</Txt>
        )}
        <ErrorText error={save.error} />
      </FadeIn>

      <FadeIn delay={motion.stagger * 3} style={styles.extra}>
        <TextButton label="가족 비상연락처도 등록하기 (선택)" underline onPress={() => router.push('/setup')} />
      </FadeIn>
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginTop: 20, gap: 10 },
  block: { marginTop: 26, gap: 10 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  chip: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 14, height: 40, borderRadius: radius.pill, backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.border },
  chipOn: { backgroundColor: colors.asphalt, borderColor: colors.asphalt },
  chipPressed: { opacity: 0.85 },
  chipText: { ...font.sans(600), fontSize: 14.5, color: colors.text },
  chipTextOn: { color: colors.textOnDark },
  segment: { flexDirection: 'row', backgroundColor: colors.surfaceMuted, borderRadius: radius.lg, padding: 4, gap: 4 },
  segItem: { flex: 1, height: 40, borderRadius: radius.md, alignItems: 'center', justifyContent: 'center' },
  segOn: { backgroundColor: colors.surface },
  segText: { ...font.sans(600), fontSize: 14, color: colors.textMuted },
  segTextOn: { color: colors.text },
  codeBox: { gap: 10, marginTop: 4 },
  joined: { ...font.sans(700), fontSize: 15, color: colors.text },
  code: { ...font.mono(600), letterSpacing: 3 },
  consent: { flexDirection: 'row', gap: 8, backgroundColor: colors.notice, borderRadius: radius.lg, padding: 12 },
  consentText: { flex: 1, ...font.sans(500), fontSize: 13, lineHeight: 19, color: colors.noticeText },
  directNote: { ...typography.caption, marginTop: 4 },
  extra: { marginTop: 22, alignItems: 'flex-start' },
  reason: { ...typography.caption, textAlign: 'center', marginBottom: 10 },
});
