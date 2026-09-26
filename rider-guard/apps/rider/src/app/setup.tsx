// 디자인: design/Setup.dc.html — 기기 연결과 비상연락망
import type { ContactDto, DeviceDto } from '@rider-guard/contract';
import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useMe, usePairDevice } from '@/api/hooks';
import { BackIcon, CameraDeviceIcon, PencilIcon } from '@/components/Icons';
import { Badge, Button, Card, Screen, Spacer, Txt } from '@/components/ui';
import { RELATION_LABEL } from '@/lib/format';
import { backOr, resetTo } from '@/lib/nav';
import { colors, font, radius } from '@/theme';

const MAX_CONTACTS = 5;

export default function SetupScreen() {
  const { data: me, error } = useMe();
  const contacts = me?.contacts ?? [];

  return (
    <Screen top={48} gap={18}>
      <Pressable accessibilityRole="button" accessibilityLabel="뒤로" onPress={() => backOr('/')} hitSlop={8} style={styles.back}>
        <BackIcon color={colors.text} />
      </Pressable>

      <Txt style={styles.h1}>{'운행 전에\n두 가지만 설정해요'}</Txt>
      {error && <Txt style={styles.error}>{errorMessage(error)}</Txt>}

      <DeviceCard device={me?.device ?? null} />

      <Card style={{ padding: 18, gap: 12 }}>
        <View style={styles.stepHead}>
          <StepNo n={2} />
          <Txt style={styles.stepTitle}>비상연락망</Txt>
        </View>
        {contacts.map((c) => (
          <ContactRow key={c.id} contact={c} />
        ))}
        {contacts.length < MAX_CONTACTS && (
          <Button
            label="+ 연락처 추가"
            variant="dashed"
            height={46}
            rounded={radius.lg}
            fontSize={14}
            weight={600}
            onPress={() => router.push('/contact')}
          />
        )}
        <Txt style={[styles.muted13, { lineHeight: 20 }]}>사고 확인에 응답이 없으면 1순위부터 순서대로 문자로 위치를 알려요.</Txt>
      </Card>

      <Spacer />

      <Button label="설정 완료" onPress={() => resetTo('/home')} />
    </Screen>
  );
}

function DeviceCard({ device }: { device: DeviceDto | null }) {
  // 연결된 기기가 없으면 처음부터 코드 입력칸을 보여준다.
  const [pairing, setPairing] = useState(false);
  const [code, setCode] = useState('');
  const pair = usePairDevice();
  const showInput = pairing || !device;

  const submit = () =>
    pair.mutate(code, {
      onSuccess: () => {
        setPairing(false);
        setCode('');
      },
    });

  return (
    <Card style={{ padding: 18, gap: 14 }}>
      <View style={styles.stepHead}>
        <StepNo n={1} />
        <Txt style={styles.stepTitle}>감지 기기 연결</Txt>
        {device && (
          <Badge tone={device.connected ? 'info' : 'muted'} style={{ paddingHorizontal: 10 }}>
            {device.connected ? '연결됨' : '신호 없음'}
          </Badge>
        )}
      </View>

      {device && (
        <View style={styles.device}>
          <CameraDeviceIcon size={36} strokeWidth={1.6} />
          <View style={{ gap: 2 }}>
            <Txt style={[font.sans(600), { fontSize: 14 }]}>{device.name}</Txt>
            <Txt style={styles.muted13}>
              페어링 코드{' '}
              <Txt style={[font.mono(600), { color: colors.text }]}>{`${device.pairingCode.slice(0, 4)} ${device.pairingCode.slice(4)}`}</Txt>
            </Txt>
          </View>
        </View>
      )}

      {showInput ? (
        <View style={{ gap: 8 }}>
          {/* TODO: QR 스캔 — 지금은 기기에 표시된 페어링 코드 6자리를 입력한다 */}
          <Txt style={styles.muted13}>기기에 표시된 페어링 코드 6자리를 입력해요.</Txt>
          <View style={{ flexDirection: 'row', gap: 8 }}>
            <TextInput
              accessibilityLabel="페어링 코드"
              value={code}
              onChangeText={(t) => setCode(t.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              placeholderTextColor={colors.borderDashed}
              keyboardType="number-pad"
              maxLength={6}
              style={styles.codeInput}
            />
            <Button label="연결" variant="dark" height={46} rounded={radius.lg} fontSize={14} disabled={code.length !== 6 || pair.isPending} onPress={submit} />
          </View>
          {pair.error && <Txt style={styles.error}>{errorMessage(pair.error)}</Txt>}
        </View>
      ) : (
        <Button
          label="QR로 다른 기기 연결"
          variant="outline"
          height={46}
          rounded={radius.lg}
          fontSize={14}
          weight={600}
          onPress={() => setPairing(true)}
        />
      )}
    </Card>
  );
}

function StepNo({ n }: { n: number }) {
  return (
    <View style={styles.stepNo}>
      <Txt style={[font.sans(700), { fontSize: 13, color: colors.textOnDark }]}>{n}</Txt>
    </View>
  );
}

function ContactRow({ contact }: { contact: ContactDto }) {
  const first = contact.priority === 1;
  return (
    <View style={styles.contact}>
      <View style={[styles.rank, first ? { backgroundColor: colors.accent } : styles.rankOutline]}>
        <Txt style={[font.mono(600), { fontSize: 14, color: first ? colors.textOnDark : colors.accent }]}>{contact.priority}</Txt>
      </View>
      <View style={{ flex: 1, gap: 1 }}>
        <Txt style={[font.sans(600), { fontSize: 15 }]}>
          {contact.name} · {RELATION_LABEL[contact.relation]}
        </Txt>
        <Txt style={[styles.muted13, font.mono(500)]}>{contact.phone.replace(/^(\d{3})(\d{3,4})(\d{4})$/, '$1-$2-$3')}</Txt>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${contact.priority}순위 연락처 편집`}
        onPress={() => router.push({ pathname: '/contact', params: { id: contact.id } })}
        style={styles.edit}
      >
        <PencilIcon size={20} color={colors.textMuted} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  back: { width: 44, height: 44, marginLeft: -10, alignItems: 'center', justifyContent: 'center' },
  h1: { ...font.sans(700), fontSize: 24, lineHeight: 32, letterSpacing: -0.5 },
  stepHead: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  stepNo: { width: 26, height: 26, borderRadius: 13, backgroundColor: colors.ink, alignItems: 'center', justifyContent: 'center' },
  stepTitle: { ...font.sans(700), fontSize: 16, flex: 1 },
  device: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 14, borderRadius: radius.lg, backgroundColor: colors.bg },
  muted13: { fontSize: 13, color: colors.textMuted },
  error: { fontSize: 13, color: colors.accent },
  codeInput: {
    flex: 1,
    height: 46,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    fontSize: 16,
    letterSpacing: 4,
    color: colors.text,
    ...font.mono(500),
  },
  contact: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 52 },
  rank: { width: 32, height: 32, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  rankOutline: { backgroundColor: colors.surface, borderWidth: 1.5, borderColor: colors.accent },
  edit: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
