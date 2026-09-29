// 디자인에 없는 화면 — 비상연락처(setup)의 '+ 연락처 추가' / 행 눌러 편집에서 여는 모달. v2 톤 폼.
import type { ContactDto, Relation, ShareLevel } from '@rider-guard/contract';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { useDeleteContact, useMe, useSaveContact } from '@/api/hooks';
import { Field, Header, Notice } from '@/components/forms';
import { MailIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, FadeIn, ListGroup, ListRow, PressableScale, Screen, ScreenFooter, SimBadge, Skeleton, Spacer, Txt } from '@/components/ui';
import { ACCEPTANCE_LABEL, ACCEPTANCE_TONE, useContactAcceptance } from '@/features/contactSim';
import { DEFAULT_SHARE_LEVEL, formatMobile, isMobile, RELATION_LABEL, SHARE_LEVELS } from '@/lib/format';
import { backOr } from '@/lib/nav';
import { colors, font, motion, radius, typography } from '@/theme';

const RELATIONS: Relation[] = ['family', 'coworker', 'other'];
const SIDE = 24;
/** 삭제 확인 상태를 풀기까지 — 한참 뒤 무심코 누른 탭이 삭제가 되지 않게 */
const CONFIRM_MS = 4000;

const close = () => backOr('/setup');

export default function ContactScreen() {
  const { id } = useLocalSearchParams<{ id?: string }>();
  const me = useMe();
  // 편집은 연락처를 불러온 뒤에 입력칸을 채운다 — 주소로 바로 열거나 새로고침하면 처음에는 데이터가 없어 빈칸으로 굳는다
  if (id && !me.data) {
    return (
      <Screen top={52} side={SIDE} gap={20}>
        <Header onClose={close} />
        {me.error ? <Notice error={me.error} onRetry={() => void me.refetch()} /> : <FormSkeleton />}
      </Screen>
    );
  }
  const existing = me.data?.contacts.find((c) => c.id === id);
  if (id && !existing) {
    return (
      <Screen
        top={52}
        side={SIDE}
        gap={8}
        footer={
          <ScreenFooter style={styles.footer}>
            <Button label="연락처 목록으로" onPress={close} />
          </ScreenFooter>
        }
      >
        <Header onClose={close} />
        <Txt accessibilityRole="header" style={[typography.title, styles.titleGap]}>
          연락처를 찾을 수 없어요
        </Txt>
        <Txt style={styles.lead}>이미 삭제된 연락처예요.</Txt>
      </Screen>
    );
  }
  return <ContactForm key={existing?.id ?? 'new'} existing={existing} count={me.data?.contacts.length ?? 0} />;
}

function ContactForm({ existing, count }: { existing: ContactDto | undefined; count: number }) {
  const [name, setName] = useState(existing?.name ?? '');
  const [phone, setPhone] = useState(existing?.phone ? formatMobile(existing.phone) : '010-');
  const [relation, setRelation] = useState<Relation>(existing?.relation ?? 'family');
  const [level, setLevel] = useState<ShareLevel | null>(existing?.shareLevel ?? null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const save = useSaveContact();
  const remove = useDeleteContact();
  const toast = useToast();

  useEffect(() => {
    if (!confirmDelete) return;
    const t = setTimeout(() => setConfirmDelete(false), CONFIRM_MS);
    return () => clearTimeout(t);
  }, [confirmDelete]);

  // 공개 범위를 직접 고르기 전까지는 관계에 맞춰 따라간다
  const shareLevel = level ?? DEFAULT_SHARE_LEVEL[relation];
  // 가입 정보의 본인 번호와 같은 기준
  const phoneHint = phone.replace(/\D/g, '').length >= 10 && !isMobile(phone) ? '휴대폰 번호 형식을 확인해 주세요.' : null;
  const error = save.error ?? remove.error;
  const busy = save.isPending || remove.isPending;

  const submit = () =>
    save.mutate(
      { id: existing?.id, name: name.trim(), phone, relation, shareLevel },
      {
        onSuccess: () => {
          toast.success(existing ? '연락처를 저장했어요' : '연락처를 추가했어요');
          close();
        },
      },
    );
  const onDelete = () => {
    if (!existing) return;
    if (!confirmDelete) return setConfirmDelete(true);
    remove.mutate(existing.id, {
      onSuccess: () => {
        toast.success('연락처를 삭제했어요');
        close();
      },
    });
  };

  return (
    <Screen
      top={52}
      side={SIDE}
      gap={24}
      enter="none"
      footer={
        <ScreenFooter style={styles.footer}>
          <Notice error={error} />
          <Button label={existing ? '저장' : '추가'} disabled={!name.trim() || !isMobile(phone) || busy} loading={save.isPending} onPress={submit} />
          {existing && (
            // 확인 대화상자 대신 두 번 누르기 — 웹에서도 똑같이 동작한다
            <Button
              label={confirmDelete ? '한 번 더 누르면 삭제돼요' : '연락처 삭제'}
              variant="ghost"
              size="md"
              textStyle={confirmDelete ? styles.deleteConfirm : undefined}
              disabled={save.isPending}
              loading={remove.isPending}
              onPress={onDelete}
            />
          )}
        </ScreenFooter>
      }
    >
      <Header onClose={close} />

      <FadeIn style={[styles.intro, styles.titleGap]}>
        <Txt accessibilityRole="header" style={typography.title}>
          {existing ? `${existing.priority}순위 연락처` : '비상연락처 추가'}
        </Txt>
        {!existing && <Txt style={styles.lead}>새 연락처는 {count + 1}순위가 돼요. 사고 때는 1순위부터 차례로 알려요.</Txt>}
      </FadeIn>

      {existing && (
        <FadeIn delay={motion.stagger}>
          <InvitePreviewRow contact={existing} />
        </FadeIn>
      )}

      <FadeIn delay={motion.stagger * 2} style={styles.fields}>
        <Field label="이름" value={name} onChangeText={setName} maxLength={20} placeholder="예: 김민지" returnKeyType="next" />
        <Field
          label="휴대폰 번호"
          value={phone}
          onChangeText={(t) => setPhone(formatMobile(t))}
          keyboardType="phone-pad"
          style={font.mono(500)}
          error={phoneHint}
        />
        <View style={styles.group}>
          <Txt style={typography.label}>관계</Txt>
          <Segmented label="관계" options={RELATIONS.map((r) => ({ value: r, label: RELATION_LABEL[r] }))} value={relation} onChange={setRelation} />
        </View>
        <View style={styles.group}>
          <Txt style={typography.label}>위치를 볼 수 있는 때</Txt>
          <Segmented label="위치를 볼 수 있는 때" options={SHARE_LEVELS} value={shareLevel} onChange={setLevel} />
          <Txt style={styles.hint}>{SHARE_LEVELS.find((l) => l.value === shareLevel)!.hint}</Txt>
        </View>
      </FadeIn>
      <Spacer />
    </Screen>
  );
}

/** 편집할 때만 — 이 연락처가 받는 수락 안내 화면(시뮬레이션)과 지금 수락 상태 */
function InvitePreviewRow({ contact }: { contact: ContactDto }) {
  const { data: me } = useMe();
  const acceptance = useContactAcceptance(me?.contacts);
  const status = acceptance.statusOf(contact.id);
  return (
    <ListGroup>
      <ListRow
        icon={<MailIcon size={20} color={colors.primary} />}
        label={<Txt style={typography.bodyStrong}>받는 화면 미리보기</Txt>}
        sub={
          <View style={styles.previewSub}>
            <Badge tone={ACCEPTANCE_TONE[status]} size="sm" check={status === 'accepted'}>
              {ACCEPTANCE_LABEL[status]}
            </Badge>
            <SimBadge />
          </View>
        }
        chevron
        accessibilityLabel={`받는 화면 미리보기, 지금 ${ACCEPTANCE_LABEL[status]}`}
        accessibilityHint={`${contact.name}님이 받는 수락 안내 화면을 미리 봐요`}
        onPress={() => router.push({ pathname: '/invite', params: { id: contact.id } })}
      />
    </ListGroup>
  );
}

function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <View accessibilityRole="radiogroup" accessibilityLabel={label} style={styles.segments}>
      {options.map((o) => {
        const selected = o.value === value;
        return (
          <PressableScale
            key={o.value}
            accessibilityRole="radio"
            accessibilityLabel={o.label}
            accessibilityState={{ checked: selected }}
            onPress={() => onChange(o.value)}
            scaleTo={motion.pressScale}
            style={[styles.segment, selected && styles.segmentOn]}
            pressedStyle={!selected && styles.segmentPressed}
          >
            <Txt style={[styles.segmentText, selected && styles.segmentTextOn]} numberOfLines={1}>
              {o.label}
            </Txt>
          </PressableScale>
        );
      })}
    </View>
  );
}

/** 편집 화면을 주소로 바로 열었을 때 — 폼 모양 그대로 자리를 잡아 둔다 */
function FormSkeleton() {
  return (
    <View style={[styles.fields, styles.titleGap]}>
      <Skeleton width={160} height={30} />
      {[0, 1].map((i) => (
        <View key={i} style={styles.group}>
          <Skeleton width={72} height={16} />
          <Skeleton width="100%" height={56} radius={radius.input} />
        </View>
      ))}
      <View style={styles.group}>
        <Skeleton width={56} height={16} />
        <Skeleton width="100%" height={48} radius={radius.input} />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  titleGap: { marginTop: 4 },
  intro: { gap: 8 },
  lead: { ...typography.lead, fontSize: 15 },
  fields: { gap: 22 },
  group: { gap: 8 },
  hint: { ...typography.caption },
  previewSub: { flexDirection: 'row', alignItems: 'center', gap: 6, marginTop: 4 },
  segments: { flexDirection: 'row', gap: 8 },
  segment: {
    flex: 1,
    minHeight: 48,
    paddingHorizontal: 6,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.input,
    borderWidth: 1.5,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  segmentOn: { backgroundColor: colors.primarySoft, borderColor: colors.primary },
  segmentPressed: { backgroundColor: colors.surfacePressed },
  segmentText: { ...font.sans(600), fontSize: 14, lineHeight: 20, color: colors.textMuted },
  segmentTextOn: { ...font.sans(700), color: colors.primaryInk },
  footer: { paddingHorizontal: SIDE },
  deleteConfirm: { color: colors.danger },
});
