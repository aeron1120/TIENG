// 디자인에 없는 화면 — Setup 의 '+ 연락처 추가' / 편집에서 연다. 기존 컴포넌트로만 구성.
import type { Relation, ShareLevel } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useDeleteContact, useMe, useSaveContact } from '@/api/hooks';
import { Button, Card, Screen, Spacer, Txt } from '@/components/ui';
import { formatMobile, isMobile, RELATION_LABEL } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, radius } from '@/theme';

const RELATIONS: Relation[] = ['family', 'coworker', 'other'];
/** 설계문서 4.1.2 공유 대상 분리 권한 */
const LEVELS: { value: ShareLevel; label: string; hint: string }[] = [
  { value: 'realtime', label: '운행 중 항상', hint: '운행 중에는 실시간 위치를 볼 수 있어요.' },
  { value: 'on_anomaly', label: '사고 감지 시', hint: '사고가 감지된 순간부터 위치를 볼 수 있어요.' },
  { value: 'on_incident', label: '사고 확정 시', hint: '도움 요청이나 무응답으로 사고가 확정된 뒤에만 볼 수 있어요.' },
];
const DEFAULT_LEVEL: Record<Relation, ShareLevel> = { family: 'realtime', coworker: 'on_anomaly', other: 'on_incident' };

export default function ContactScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const existing = useMe().data?.contacts.find((c) => c.id === id);
  const [name, setName] = useState(existing?.name ?? '');
  const [phone, setPhone] = useState(existing?.phone ? formatMobile(existing.phone) : '010-');
  const [relation, setRelation] = useState<Relation>(existing?.relation ?? 'family');
  const [level, setLevel] = useState<ShareLevel | null>(existing?.shareLevel ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveContact();
  const remove = useDeleteContact();

  const shareLevel = level ?? DEFAULT_LEVEL[relation];
  // 가입 정보의 본인 번호와 같은 기준
  const phoneHint = phone.replace(/\D/g, '').length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const error = save.error ?? remove.error;
  const done = () => backOr('/setup');

  return (
    <Screen top={48} gap={18}>
      <Txt style={styles.h1}>{existing ? `${existing.priority}순위 연락처` : '비상연락처 추가'}</Txt>

      <Card style={{ padding: 18, gap: 14 }}>
        <Field label="이름">
          <TextInput accessibilityLabel="이름" value={name} onChangeText={setName} maxLength={20} style={styles.input} />
        </Field>
        <Field label="휴대폰 번호">
          <TextInput
            accessibilityLabel="휴대폰 번호"
            value={phone}
            onChangeText={(t) => setPhone(formatMobile(t))}
            keyboardType="phone-pad"
            style={[styles.input, font.mono(500)]}
          />
          {phoneHint && <Txt style={styles.error}>{phoneHint}</Txt>}
        </Field>
        <Field label="관계">
          <Segmented options={RELATIONS.map((r) => ({ value: r, label: RELATION_LABEL[r] }))} value={relation} onChange={setRelation} />
        </Field>
        <Field label="위치를 볼 수 있는 때">
          <Segmented options={LEVELS} value={shareLevel} onChange={setLevel} />
          <Txt style={styles.hint}>{LEVELS.find((l) => l.value === shareLevel)!.hint}</Txt>
        </Field>
      </Card>

      {error && <Txt style={styles.error}>{errorMessage(error)}</Txt>}
      <Spacer />

      <View style={{ gap: 10 }}>
        <Button
          label="저장"
          disabled={!name.trim() || !isMobile(phone) || save.isPending}
          onPress={() => save.mutate({ id: existing?.id, name: name.trim(), phone, relation, shareLevel }, { onSuccess: done })}
        />
        {existing && (
          // 확인 대화상자 대신 두 번 누르기 — 웹에서도 똑같이 동작한다.
          <Button
            label={confirmDelete ? '한 번 더 누르면 삭제돼요' : '연락처 삭제'}
            variant="outline"
            height={52}
            textStyle={confirmDelete ? { color: colors.accent } : undefined}
            disabled={remove.isPending}
            onPress={() => (confirmDelete ? remove.mutate(existing.id, { onSuccess: done }) : setConfirmDelete(true))}
          />
        )}
        <Button label="취소" variant="light" height={48} onPress={() => router.back()} />
      </View>
    </Screen>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <View style={{ gap: 6 }}>
      <Txt style={[font.sans(600), { fontSize: 13 }]}>{label}</Txt>
      {children}
    </View>
  );
}

function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <View style={{ flexDirection: 'row', gap: 6 }}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <Pressable
            key={o.value}
            accessibilityRole="radio"
            accessibilityState={{ selected }}
            onPress={() => onChange(o.value)}
            style={[styles.segment, selected && styles.segmentOn]}
          >
            <Txt style={[font.sans(600), { fontSize: 13, color: selected ? colors.textOnDark : colors.text }]}>{o.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 24, lineHeight: 32, letterSpacing: -0.5 },
  input: {
    height: 50,
    paddingHorizontal: 14,
    borderWidth: 1.5,
    borderColor: colors.border,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    fontSize: 16,
    color: colors.text,
    ...font.sans(400),
  },
  segment: {
    flex: 1,
    minHeight: 44,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.md,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmentOn: { backgroundColor: colors.ink, borderColor: colors.ink },
  hint: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  error: { fontSize: 13, color: colors.accent },
});
