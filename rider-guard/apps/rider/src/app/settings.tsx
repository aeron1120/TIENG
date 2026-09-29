// 설정 — v2 화면설계에는 없는 화면이라 v2·5 홈 톤(흰 카드 · 목록 행 · 하단 탭)으로 외삽했다.
// 내 정보 · 헬멧(시뮬레이션) · 비상연락처 · 알림 · 로그아웃 · 계정 삭제. 계정 삭제는 앱 안에서 할 수 있어야 한다(Google Play 정책).
import type { Consents, MeDto, SocialProvider } from '@rider-guard/contract';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useDeleteAccount, useMe } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { BottomNav } from '@/components/BottomNav';
import { Notice, TextButton, Toggle } from '@/components/forms';
import { AlertIcon, DocIcon, HelmetIcon, MailIcon, ShieldIcon, UsersIcon, WaveformIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, FadeIn, ListGroup, ListRow, PressableScale, Screen, Sheet, SimBadge, Skeleton, Txt, type BadgeTone } from '@/components/ui';
import { useContactAcceptance } from '@/features/contactSim';
import { helmetInfo, useHelmet, useProtection } from '@/features/helmet';
import { PUSH_STATUS_TEXT, usePushStatus, type PushStatus } from '@/features/push';
import { batteryText, formatMobile, hm } from '@/lib/format';
import { colors, font, typography } from '@/theme';

const PROVIDER_LABEL: Record<SocialProvider, string> = { kakao: '카카오', naver: '네이버', google: 'Google' };

function loginMethod(account: MeDto['account']) {
  const methods = account.social.map((p) => `${PROVIDER_LABEL[p]} 로그인`);
  if (account.hasPassword && account.email) methods.unshift(account.email);
  return methods.join(', ') || '-';
}

/** 필수 둘(위치·센서, 사고 시 위치 전달)은 가입 때 받는다. 선택 동의만 개수로 */
function consentText(c: Consents) {
  const required = c.locationSensor && c.shareOnIncident;
  const optional = [c.insuranceRecords, c.medicalInfo].filter(Boolean).length;
  return `${required ? '필수 동의 완료' : '필수 동의가 필요해요'} · 선택 ${optional}개 동의`;
}

/** 알림 상태 배지 — 쓸 수 없는 환경(웹·에뮬레이터 등)은 회색, 권한이 꺼졌거나 오류면 빨강 */
const PUSH_BADGE: Record<PushStatus, { label: string; tone: BadgeTone }> = {
  registered: { label: '켜짐', tone: 'primary' },
  unknown: { label: '확인 중', tone: 'neutral' },
  denied: { label: '꺼짐', tone: 'danger' },
  error: { label: '오류', tone: 'danger' },
  unsupported: { label: '사용 불가', tone: 'neutral' },
  expo_go: { label: '사용 불가', tone: 'neutral' },
  simulator: { label: '사용 불가', tone: 'neutral' },
  no_project: { label: '사용 불가', tone: 'neutral' },
};

const appVersion = Constants.expoConfig?.version;

export default function SettingsScreen() {
  const { data: me, error, refetch } = useMe();
  const { signOut } = useAuth();
  const toast = useToast();
  const push = usePushStatus();
  const helmet = useHelmet();
  const protection = useProtection();
  const acceptance = useContactAcceptance(me?.contacts);
  const [deleting, setDeleting] = useState(false);

  const loaded = !!me;
  // 보호 중(서버 운행 세션이 있음)에는 로그아웃·삭제를 막는다 — 위치 수집·사고 대응이 계정과 함께 끊기지 않게.
  // 보호를 켜는 요청이 오가는 중에도 막는다 — 로그아웃한 뒤에 세션이 켜지지 않게
  const protecting = protection.active || protection.pending === 'start';
  // 불러오는 중에는 보호 중인지 모르니 막는다. 불러오기에 실패했으면 로그아웃만은 할 수 있게 둔다
  const canSignOut = loaded ? !protecting : !!error;
  const canDelete = loaded && !protecting;

  const info = me ? helmetInfo(me.device) : null;
  // 기기 이름이 종류와 같으면('헬멧 태그 · 헬멧 태그') 두 번 쓰지 않는다
  const helmetKind = info && info.detail !== info.name ? info.detail : null;
  const contacts = me?.contacts ?? [];
  const { accepted, pending, declined } = acceptance.summary;
  const acceptText = [`${accepted}명 수락`, pending && `${pending}명 대기`, declined && `${declined}명 거절`].filter(Boolean).join(' · ');

  const pushBadge = PUSH_BADGE[push];
  const pushSub = push === 'registered' ? '사고가 감지되면 잠금화면에서 바로 응답할 수 있어요' : PUSH_STATUS_TEXT[push];
  const openPushSettings = push === 'denied' && Platform.OS !== 'web' ? () => void Linking.openSettings() : undefined;

  const editProfile = () => router.push({ pathname: '/onboarding', params: { mode: 'edit' } });

  return (
    <Screen top={52} bottom={24} gap={22} enter="none" footer={<BottomNav active="settings" />}>
      <FadeIn>
        <Txt accessibilityRole="header" style={typography.title}>
          설정
        </Txt>
      </FadeIn>

      {error && !me ? <Notice error={error} onRetry={() => void refetch()} /> : null}

      <Section title="내 정보" delay={40}>
        <ListGroup>
          <ProfileRow me={me} onPress={editProfile} />
          <ListRow
            icon={<MailIcon size={20} color={colors.primary} />}
            label="로그인 방식"
            value={
              me ? (
                <Txt style={styles.value} numberOfLines={1} ellipsizeMode="middle">
                  {loginMethod(me.account)}
                </Txt>
              ) : (
                <Skeleton width={140} height={15} />
              )
            }
          />
          <ListRow
            icon={<DocIcon size={20} color={colors.primary} />}
            label="동의 관리"
            sub={me ? consentText(me.consents) : <Skeleton width={170} height={13} style={styles.subSkel} />}
            chevron
            disabled={!me}
            onPress={editProfile}
            accessibilityLabel={me ? `동의 관리, ${consentText(me.consents)}` : '동의 관리'}
            accessibilityHint="가입 정보 수정 화면에서 동의를 바꿀 수 있어요"
          />
        </ListGroup>
      </Section>

      {/* 착용·음성은 늘 흉내 낸 값이라 칩을 묶음 제목에 한 번만 붙인다 (실제 헬멧이 붙어 있어도) */}
      <Section title="헬멧" right={<SimBadge />} delay={80}>
        <ListGroup>
          <ListRow
            icon={<HelmetIcon size={20} color={info && !info.connected ? colors.danger : colors.primary} />}
            label={info ? info.name : <Skeleton width={96} height={16} />}
            sub={
              info ? (
                info.connected ? (
                  `${helmetKind ?? '연결됨'} · 배터리 ${batteryText(info.battery)}`
                ) : (
                  <Txt style={[typography.caption, { color: colors.danger }]}>{helmetKind ? `신호 없음 · ${helmetKind}` : '신호 없음'}</Txt>
                )
              ) : (
                <Skeleton width={180} height={13} style={styles.subSkel} />
              )
            }
            chevron
            disabled={!info}
            onPress={() => router.push('/helmet')}
            accessibilityLabel={
              info
                ? `${info.name}, ${info.connected ? `연결됨, 배터리 ${batteryText(info.battery)}` : '신호 없음'}`
                : '헬멧 불러오는 중'
            }
            accessibilityHint="헬멧 연결과 착용 상태를 봐요"
          />
          <ListRow
            icon={<ShieldIcon size={20} color={colors.primary} />}
            label="헬멧 착용"
            sub={<WornSub />}
            right={
              <Toggle
                value={helmet.worn}
                onValueChange={helmet.setWorn}
                disabled={!helmet.ready}
                accessibilityLabel="헬멧 착용 (시뮬레이션)"
              />
            }
          />
          <ListRow
            icon={<WaveformIcon size={20} color={colors.primary} />}
            label="말로 응답하기"
            sub="사고 시 헬멧 스피커로 묻고 음성으로 답해요"
            right={
              <Toggle
                value={helmet.voice}
                onValueChange={helmet.setVoice}
                disabled={!helmet.ready}
                accessibilityLabel="말로 응답하기 (시뮬레이션)"
              />
            }
          />
        </ListGroup>
      </Section>

      <Section title="비상연락 · 알림" delay={120}>
        <ListGroup>
          <ListRow
            icon={<UsersIcon size={20} color={colors.primary} />}
            label={
              !me ? (
                <Skeleton width={104} height={16} />
              ) : contacts.length ? (
                `비상연락처 ${contacts.length}명`
              ) : (
                <Txt style={[typography.bodyStrong, { color: colors.primaryInk }]}>비상연락처를 등록해 주세요</Txt>
              )
            }
            sub={!me ? <Skeleton width={120} height={13} style={styles.subSkel} /> : contacts.length ? acceptText : '사고 때 1순위부터 차례로 알려요'}
            chevron
            disabled={!me}
            onPress={() => router.push('/setup')}
            accessibilityLabel={!me ? '비상연락처 불러오는 중' : contacts.length ? `비상연락처 ${contacts.length}명, ${acceptText}` : '비상연락처를 등록해 주세요'}
            accessibilityHint="비상연락처를 보고 고칠 수 있어요"
          />
          <ListRow
            icon={<AlertIcon size={20} color={colors.primary} />}
            label="사고 확인 알림"
            sub={pushSub}
            right={<Badge tone={pushBadge.tone} size="sm">{pushBadge.label}</Badge>}
            chevron={!!openPushSettings}
            onPress={openPushSettings}
            accessibilityLabel={`사고 확인 알림, ${pushBadge.label}, ${pushSub}`}
            accessibilityHint={openPushSettings ? '기기 설정에서 알림을 켤 수 있어요' : undefined}
          />
        </ListGroup>
      </Section>

      <Section title="계정" delay={160}>
        <ListGroup>
          <ListRow
            label={<Txt style={[typography.body, !canSignOut && { color: colors.disabledText }]}>로그아웃</Txt>}
            disabled={!canSignOut}
            onPress={() => signOut()}
            accessibilityLabel="로그아웃"
          />
        </ListGroup>
        <SignOutNote />
        <TextButton
          label="계정 삭제"
          fontSize={13}
          disabled={!canDelete}
          onPress={() => setDeleting(true)}
          accessibilityLabel="계정 삭제"
          style={styles.delete}
        />
        {appVersion ? <Txt style={styles.version}>Rider Guard {appVersion}</Txt> : null}
      </Section>

      <DeleteAccountSheet
        visible={deleting}
        onClose={() => setDeleting(false)}
        onDeleted={() => {
          toast.show('계정을 삭제했어요');
          signOut({ tokenInvalid: true });
        }}
      />
    </Screen>
  );
}

function Section({ title, right, delay, children }: { title: string; right?: React.ReactNode; delay: number; children: React.ReactNode }) {
  return (
    <FadeIn delay={delay} style={styles.section}>
      <View style={styles.sectionHead}>
        <Txt accessibilityRole="header" style={typography.section}>
          {title}
        </Txt>
        {right}
      </View>
      {children}
    </FadeIn>
  );
}

/** 이름 · 휴대폰 — 누르면 가입 정보 수정. '내 정보' 묶음의 첫 줄 */
function ProfileRow({ me, onPress }: { me: MeDto | undefined; onPress: () => void }) {
  if (!me) {
    return (
      <View style={styles.profile}>
        <Skeleton width={52} height={52} radius={26} />
        <View style={styles.profileText}>
          <Skeleton width={72} height={20} style={{ marginVertical: 3 }} />
          <Skeleton width={120} height={14} style={{ marginVertical: 2 }} />
        </View>
      </View>
    );
  }
  const name = me.rider.name?.trim() || '';
  const phone = me.rider.phone ? formatMobile(me.rider.phone) : '';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${name || '이름 없음'}${phone ? `, ${phone}` : ''}, 가입 정보 수정`}
      accessibilityHint="이름·휴대폰 번호와 동의를 고칠 수 있어요"
      onPress={onPress}
      style={styles.profile}
      pressedStyle={styles.pressed}
    >
      <View style={styles.avatar}>
        <Txt style={styles.avatarText}>{name ? name[0] : '?'}</Txt>
      </View>
      <View style={styles.profileText}>
        <Txt style={typography.heading} numberOfLines={1}>
          {name || '이름을 등록해 주세요'}
        </Txt>
        {phone ? <Txt style={styles.phone}>{phone}</Txt> : null}
      </View>
      <Txt style={styles.edit}>수정</Txt>
    </PressableScale>
  );
}

/** 헬멧 착용 행 아래 줄 — 보호가 켜졌는지, 켜고 끄는 중인지 */
function WornSub() {
  const p = useProtection();
  if (p.error) {
    return <Txt style={[typography.caption, { color: colors.danger }]}>보호를 {p.worn ? '켜지' : '끄지'} 못했어요 · 잠시 뒤 다시 시도해요</Txt>;
  }
  const text =
    p.pending === 'start'
      ? '보호를 켜는 중이에요'
      : p.pending === 'end'
        ? '보호를 끄는 중이에요'
        : p.heldByIncident
          ? '사고 대응이 끝나면 보호가 꺼져요'
          : p.active && p.startedAt
            ? `보호 중 · ${hm(p.startedAt)}부터`
            : '쓰면 보호가 자동으로 켜져요';
  return <Txt style={typography.caption}>{text}</Txt>;
}

/** 로그아웃·삭제가 막힌 까닭과 푸는 방법. 착용 중이면 여기서 바로 헬멧을 벗을 수 있다 */
function SignOutNote() {
  const p = useProtection();
  const { setWorn } = useHelmet();
  if (!p.ready || !(p.active || p.pending === 'start')) return null;
  if (p.worn) {
    return (
      <Notice
        tone="info"
        message="보호 중에는 로그아웃·계정 삭제를 할 수 없어요. 헬멧을 벗으면 보호가 꺼져요."
        onRetry={() => setWorn(false)}
        retryLabel="헬멧 벗기"
      />
    );
  }
  const message = p.heldByIncident
    ? '사고 대응이 끝나면 보호가 꺼지고, 그 뒤에 로그아웃할 수 있어요.'
    : p.error
      ? `보호를 끄지 못했어요. ${errorMessage(p.error)}`
      : '보호를 끄는 중이에요. 꺼지면 로그아웃할 수 있어요.';
  return <Notice tone="info" message={message} />;
}

/** 되돌릴 수 없어서 한 번 더 묻는다 — 무엇이 지워지는지 보여 주고 '삭제하기'를 눌러야 지워진다 */
function DeleteAccountSheet({ visible, onClose, onDeleted }: { visible: boolean; onClose: () => void; onDeleted: () => void }) {
  const remove = useDeleteAccount();
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="계정을 삭제할까요?"
      description="계정과 비상연락처, 기기 연결, 사고 기록이 모두 지워지고 되돌릴 수 없어요. 위치정보 이용·제공 기록은 위치정보법에 따라 6개월 동안 보관한 뒤 지워요."
    >
      <Notice error={remove.error} />
      <Button label="삭제하기" variant="danger" loading={remove.isPending} onPress={() => remove.mutate(undefined, { onSuccess: onDeleted })} />
      <Button label="취소" variant="ghost" disabled={remove.isPending} onPress={close} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  section: { gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 4, minHeight: 18 },
  value: { ...typography.body, color: colors.textMuted, flexShrink: 1, maxWidth: '62%' },
  subSkel: { marginTop: 3 },
  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, paddingHorizontal: 18 },
  pressed: { backgroundColor: colors.surfacePressed },
  avatar: { width: 52, height: 52, borderRadius: 26, backgroundColor: colors.primarySoft, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...font.sans(700), fontSize: 20, lineHeight: 26, color: colors.primaryInk },
  profileText: { flex: 1, gap: 2 },
  // 휴대폰 번호는 숫자와 하이픈뿐이라 mono 로
  phone: { ...font.mono(500), fontSize: 13, lineHeight: 19, color: colors.textMuted },
  edit: { ...font.sans(700), fontSize: 14, color: colors.primaryInk, paddingHorizontal: 4 },
  delete: { alignSelf: 'center', marginTop: 4 },
  version: { ...typography.small, color: colors.textFaint, textAlign: 'center' },
});
