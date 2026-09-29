// 헬멧 (spec-v2 02 'v2·2 헬멧 자동 시작'). ?flow=onboarding 이면 가입 흐름 1/2(다음 → 비상연락처 2/2),
// 아니면 설정·홈에서 연 헬멧 화면 — 착용 상태도 여기서 바꿀 수 있다.
// 실제 헬멧 연동은 아직 없다. 착용·음성 응답은 시뮬레이션(features/helmet)이고, 페어링된 기기가 없으면 가상 헬멧을 보여 준다.
import type { DeviceDto } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMe, usePairDevice } from '@/api/hooks';
import { ErrorText, Header, Input, Notice, StepHeader, TextButton, Toggle } from '@/components/forms';
import { HelmetIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, IconHalo, Screen, ScreenFooter, Sheet, SimBadge, Skeleton, Txt } from '@/components/ui';
import { helmetInfo, useHelmet, useProtection, type HelmetInfo, type ProtectionState } from '@/features/helmet';
import { batteryText, hm } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, typography } from '@/theme';

export default function HelmetScreen() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const onboarding = flow === 'onboarding';
  const { data: me, error, refetch, isFetching } = useMe();
  const helmet = useHelmet();
  const protection = useProtection();
  const [changing, setChanging] = useState(false);
  // me 를 받기 전에는 가상 헬멧을 그리지 않는다 — 실제 기기가 있으면 이름이 바뀌며 깜빡이므로
  const info = me ? helmetInfo(me.device) : null;
  // '시뮬레이션' 칩은 화면에 하나만: 가상 헬멧이면 헬멧 행, 실제 기기면 착용(또는 음성) 행
  const simOn: 'helmet' | 'worn' | 'voice' = !info || info.simulated ? 'helmet' : onboarding ? 'voice' : 'worn';

  const back = () => backOr(onboarding ? '/onboarding' : '/home');
  const next = () => (onboarding ? router.push({ pathname: '/setup', params: { flow: 'onboarding' } }) : back());
  // 설정에서 열었으면 지금 상태를 보여 준다 — 벗으면 회색, 보호 중이면 숨쉬기
  const lit = onboarding || helmet.worn;

  return (
    <>
      <Screen
        top={52}
        side={24}
        gap={0}
        bottom={24}
        enter="none"
        footer={
          <ScreenFooter style={styles.footer}>
            <Button label={onboarding ? '다음' : '확인'} onPress={next} />
          </ScreenFooter>
        }
      >
        {onboarding ? (
          <StepHeader onBack={back} current={1} total={2} />
        ) : (
          <View>
            <Header onBack={back} />
            <Txt accessibilityRole="header" style={styles.navTitle}>
              헬멧
            </Txt>
          </View>
        )}

        <FadeIn style={styles.halo}>
          <IconHalo
            color={lit ? colors.primary : colors.textFaint}
            rings={lit ? undefined : [colors.divider]}
            breathing={onboarding || protection.active}
          >
            <HelmetIcon size={56} strokeWidth={1.25} color={colors.textOnDark} />
          </IconHalo>
        </FadeIn>

        <FadeIn delay={40} style={styles.intro}>
          <Txt accessibilityRole="header" style={[typography.title, styles.center]}>
            헬멧을 쓰면{'\n'}보호가 자동으로 켜져요
          </Txt>
          <Txt style={[typography.lead, styles.center]}>운행 시작 버튼은 없어요. 헬멧을 벗으면{'\n'}위치 수집도 함께 멈춰요.</Txt>
        </FadeIn>

        <FadeIn delay={80} style={styles.cardWrap}>
          <Card style={styles.card}>
            {!onboarding && (
              <>
                <View style={styles.row}>
                  <View style={styles.rowMain}>
                    <View style={styles.titleLine}>
                      <Txt style={styles.rowTitle}>헬멧 착용</Txt>
                      {simOn === 'worn' && <SimBadge />}
                    </View>
                    <Txt style={styles.rowSub}>{protectionText(protection, me?.onboarded ?? true)}</Txt>
                  </View>
                  <Toggle value={helmet.worn} onValueChange={helmet.setWorn} accessibilityLabel="헬멧 착용 (시뮬레이션)" />
                </View>
                <Divider inset={ROW_SIDE} />
              </>
            )}

            {info ? <HelmetRow info={info} sim={simOn === 'helmet'} onChange={() => setChanging(true)} /> : <HelmetRowSkeleton />}

            <Divider inset={ROW_SIDE} />

            <View style={styles.row}>
              <View style={styles.rowMain}>
                <View style={styles.titleLine}>
                  <Txt style={styles.rowTitle}>말로 응답하기</Txt>
                  {simOn === 'voice' && <SimBadge />}
                </View>
                <Txt style={styles.rowSub}>사고 시 헬멧 스피커로 묻고 음성으로 답해요</Txt>
              </View>
              <Toggle value={helmet.voice} onValueChange={helmet.setVoice} accessibilityLabel="말로 응답하기" />
            </View>
          </Card>
        </FadeIn>

        {error && !me ? <Notice error={error} onRetry={isFetching ? undefined : () => void refetch()} style={styles.notice} /> : null}
      </Screen>

      <ChangeSheet visible={changing} device={me?.device ?? null} onClose={() => setChanging(false)} />
    </>
  );
}

/** 착용 행 보조 줄 — 보호(운행 세션)가 지금 어떤지. 켜고 끄는 일은 useAutoProtection 이 한다. */
function protectionText(p: ProtectionState, onboarded: boolean): string {
  if (p.heldByIncident) return '사고 대응이 끝날 때까지 보호를 유지해요';
  if (p.pending === 'start') return '보호를 켜는 중이에요';
  if (p.pending === 'end') return '보호를 끄는 중이에요';
  // 실패하면 자동 보호가 잠시 뒤 다시 시도한다
  if (p.error) return p.worn ? '보호를 켜지 못했어요. 잠시 뒤 다시 시도해요' : '보호를 끄지 못했어요. 잠시 뒤 다시 시도해요';
  if (p.active) return `보호 중 · ${hm(p.startedAt)}부터`;
  if (p.worn) return onboarded ? '보호를 켜는 중이에요' : '가입 정보를 마치면 보호가 켜져요';
  return '보호 꺼짐 · 헬멧을 쓰면 켜져요';
}

function HelmetRow({ info, sim, onChange }: { info: HelmetInfo; sim: boolean; onChange: () => void }) {
  // 실제 태그는 이름과 종류가 같은 '헬멧 태그'일 수 있어 겹치면 한 번만
  const sub = [info.detail !== info.name ? info.detail : null, info.battery != null ? `배터리 ${batteryText(info.battery)}` : null]
    .filter(Boolean)
    .join(' · ');
  const state = info.connected ? '연결됨' : '신호 없음';
  return (
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: info.connected ? colors.primary : colors.textFaint }]} />
      <View style={styles.rowMain} accessible accessibilityLabel={`${info.name} ${state}${sub ? `, ${sub}` : ''}${sim ? ', 시뮬레이션' : ''}`}>
        <View style={styles.titleLine}>
          <Txt style={styles.rowTitle}>
            {info.name} {state}
          </Txt>
          {sim && <SimBadge />}
        </View>
        {sub ? <Txt style={styles.rowSub}>{sub}</Txt> : null}
      </View>
      <TextButton label="변경" accessibilityLabel="헬멧 모듈 변경" color={colors.primaryInk} fontSize={15} weight={700} onPress={onChange} />
    </View>
  );
}

function HelmetRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={8} height={8} radius={4} />
      <View style={[styles.rowMain, { gap: 8 }]}>
        <Skeleton width={128} height={16} />
        <Skeleton width={184} height={12} />
      </View>
    </View>
  );
}

/**
 * '변경' — 헬멧 모듈 연결은 아직 없어 안내만 한다. 개발용 detector·헬멧 태그의 페어링 코드가 있으면
 * 기존 기기 연결(POST /me/device)로 연결할 수 있다.
 */
function ChangeSheet({ visible, device, onClose }: { visible: boolean; device: DeviceDto | null; onClose: () => void }) {
  const toast = useToast();
  const pair = usePairDevice();
  const [code, setCode] = useState('');
  const close = () => {
    pair.reset();
    setCode('');
    onClose();
  };
  const submit = () => {
    if (code.length !== 6 || pair.isPending) return;
    pair.mutate(code, {
      onSuccess: () => {
        toast.show('기기를 연결했어요');
        close();
      },
    });
  };
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="헬멧 모듈 연결은 준비 중이에요"
      description={
        device
          ? `지금은 ${device.name} 신호로 보여 드려요. 다른 기기의 페어링 코드 6자리를 넣으면 그 기기로 바뀌어요.`
          : '지금은 시뮬레이션으로 보여 드려요. 개발용 detector나 헬멧 태그의 페어링 코드 6자리가 있으면 연결할 수 있어요.'
      }
    >
      <Input
        value={code}
        onChangeText={(t) => {
          setCode(t.replace(/\D/g, '').slice(0, 6));
          if (pair.error) pair.reset();
        }}
        placeholder="000000"
        accessibilityLabel="페어링 코드 6자리"
        keyboardType="number-pad"
        inputMode="numeric"
        maxLength={6}
        returnKeyType="done"
        onSubmitEditing={submit}
        error={!!pair.error}
        style={[font.mono(500), styles.code]}
      />
      <ErrorText error={pair.error} />
      <Button label="연결하기" disabled={code.length !== 6} loading={pair.isPending} onPress={submit} />
      <Button label="닫기" variant="ghost" size="md" onPress={close} />
    </Sheet>
  );
}

const ROW_SIDE = 18;

const styles = StyleSheet.create({
  navTitle: { ...font.sans(700), position: 'absolute', left: 56, right: 56, top: 0, fontSize: 17, lineHeight: 44, textAlign: 'center' },
  halo: { marginTop: 32 },
  intro: { marginTop: 30, gap: 10 },
  center: { textAlign: 'center' },
  cardWrap: { marginTop: 24 },
  card: { overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: 14, minHeight: 70, paddingVertical: 14, paddingHorizontal: ROW_SIDE },
  rowMain: { flex: 1, gap: 2 },
  titleLine: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 6 },
  rowTitle: { ...font.sans(700), fontSize: 15, lineHeight: 22 },
  rowSub: typography.caption,
  dot: { width: 8, height: 8, borderRadius: 4 },
  notice: { marginTop: 16 },
  footer: { paddingHorizontal: 24 },
  code: { letterSpacing: 4 },
});
