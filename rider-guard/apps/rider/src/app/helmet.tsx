// 헬멧 자동 시작 (spec-v3 02 'v3·2 헬멧 자동 시작'). ?flow=onboarding 이면 가입 흐름 1/2(다음 → 소속 배달대행사 2/2),
// 아니면 설정에서 연 같은 화면(단계 표시 없이 뒤로).
// 실제 헬멧 연동은 아직 없다. 페어링된 기기가 없으면 가상 헬멧(배터리 시뮬레이션), 음성 응답은 시뮬레이션이다(features/helmet).
import type { DeviceDto } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useMe, usePairDevice } from '@/api/hooks';
import { ErrorText, Header, Input, Notice, StepHeader, TextButton, Toggle } from '@/components/forms';
import { HelmetIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Button, Card, Divider, FadeIn, IconHalo, Screen, ScreenFooter, Sheet, Skeleton, Txt } from '@/components/ui';
import { helmetInfo, helmetTitle, useHelmet, useProtection, type HelmetInfo } from '@/features/helmet';
import { toggleVoice, voiceSub, voiceSupported } from '@/features/voice';
import { batteryText } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, typography } from '@/theme';

export default function HelmetScreen() {
  const { flow } = useLocalSearchParams<{ flow?: string }>();
  const onboarding = flow === 'onboarding';
  const { data: me, error, refetch, isFetching } = useMe();
  const helmet = useHelmet();
  const protection = useProtection();
  const [changing, setChanging] = useState(false);
  const toast = useToast();
  // me 를 받기 전에는 가상 헬멧을 그리지 않는다 — 실제 기기가 있으면 이름이 바뀌며 깜빡이므로
  const info = me ? helmetInfo(me.device, helmet.worn) : null;

  const back = () => backOr(onboarding ? '/onboarding' : '/settings');
  const next = () => (onboarding ? router.push({ pathname: '/affiliation', params: { flow: 'onboarding' } }) : back());

  return (
    <>
      <Screen
        gap={0}
        bottom={24}
        enter="none"
        footer={
          <ScreenFooter>
            <Button label={onboarding ? '다음' : '확인'} onPress={next} />
          </ScreenFooter>
        }
      >
        {onboarding ? <StepHeader onBack={back} current={1} total={2} /> : <Header onBack={back} />}

        <FadeIn style={styles.halo}>
          {/* 보호 중이면 링이 천천히 숨쉰다 (가입 흐름에서는 늘) */}
          <IconHalo breathing={onboarding || protection.active}>
            <HelmetIcon size={46} color={colors.textOnDark} />
          </IconHalo>
        </FadeIn>

        <FadeIn delay={40} style={styles.intro}>
          <Txt accessibilityRole="header" style={[typography.title, styles.center]}>
            {'헬멧을 쓰면\n보호가 자동으로 켜져요'}
          </Txt>
          <Txt style={[typography.lead, styles.center, styles.lead]}>{'운행 시작 버튼은 없어요.\n헬멧을 벗으면 위치 수집도 함께 멈춰요.'}</Txt>
        </FadeIn>

        <FadeIn delay={80} style={styles.cardWrap}>
          <Card style={styles.card}>
            {info ? <HelmetRow info={info} onChange={() => setChanging(true)} /> : <HelmetRowSkeleton />}
            <Divider inset={ROW_SIDE} />
            <View style={styles.row}>
              <View style={styles.rowMain}>
                <Txt style={styles.rowTitle}>말로 응답하기</Txt>
                <Txt style={styles.rowSub}>{voiceSub(helmet.voice)}</Txt>
              </View>
              <Toggle value={helmet.voice} onValueChange={(v) => void toggleVoice(v, helmet.setVoice, toast)} disabled={!voiceSupported()} accessibilityLabel="말로 응답하기" style={styles.toggle} />
            </View>
          </Card>
        </FadeIn>

        {error && !me ? <Notice error={error} onRetry={isFetching ? undefined : () => void refetch()} style={styles.notice} /> : null}
      </Screen>

      <ChangeSheet visible={changing} device={me?.device ?? null} onClose={() => setChanging(false)} />
    </>
  );
}

/** '헬멧 모듈 연결됨' / '개발용 웹캠 detector, 배터리 78%' / 밑줄 '변경' */
function HelmetRow({ info, onChange }: { info: HelmetInfo; onChange: () => void }) {
  const battery = `배터리 ${batteryText(info.battery)}`;
  const sub = info.detail !== info.name ? `${info.detail}, ${battery}` : battery;
  const title = helmetTitle(info);
  return (
    <View style={styles.row}>
      <View style={styles.dotBox}>
        <View style={[styles.dotHalo, { backgroundColor: info.connected ? colors.greenSoft : colors.curb }]} />
        <View style={[styles.dot, { backgroundColor: info.connected ? colors.green : colors.textFaint }]} />
      </View>
      <View style={styles.rowMain} accessible accessibilityLabel={`${title}, ${sub}`}>
        <Txt style={styles.rowTitle}>{title}</Txt>
        <Txt style={styles.rowSub}>{sub}</Txt>
      </View>
      <TextButton label="변경" accessibilityLabel="헬멧 모듈 변경" underline onPress={onChange} style={styles.change} />
    </View>
  );
}

function HelmetRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={8} height={8} radius={4} />
      <View style={[styles.rowMain, styles.skeletonMain]}>
        <Skeleton width={120} height={16} />
        <Skeleton width={190} height={13} />
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
          : '지금은 가상 헬멧으로 보여 드려요. 개발용 detector나 헬멧 태그의 페어링 코드 6자리가 있으면 연결할 수 있어요.'
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
  halo: { marginTop: 22 },
  intro: { marginTop: 28 },
  center: { textAlign: 'center' },
  lead: { marginTop: 10 },
  cardWrap: { marginTop: 28 },
  card: { overflow: 'hidden' },
  // 두 줄(21 + 1 + 18) + 위아래 17 = 74
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 17, paddingHorizontal: ROW_SIDE },
  rowMain: { flex: 1, gap: 1 },
  rowTitle: { ...font.sans(700), fontSize: 15, lineHeight: 21, color: colors.text },
  rowSub: { ...typography.caption, lineHeight: 18, letterSpacing: -0.4 },
  // 초록 점 8 + 연초록 헤일로 14 (헤일로는 자리를 차지하지 않는다)
  dotBox: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  dotHalo: { position: 'absolute', left: -3, top: -3, width: 14, height: 14, borderRadius: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  // 글자 끝이 카드 오른쪽 여백선에 맞게 · 행 높이를 키우지 않게
  change: { marginRight: -8, minHeight: 40 },
  toggle: { minHeight: 40 },
  skeletonMain: { gap: 8 },
  notice: { marginTop: 16 },
  code: { letterSpacing: 4 },
});
