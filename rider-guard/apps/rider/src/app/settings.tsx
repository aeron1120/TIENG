// 설정 — v3 디자인에 없는 화면이라 v3·5 홈 톤(콘크리트 바탕 · 흰 카드 · 회색 보조 글자 · 아스팔트 강조)으로 외삽했다.
// 헬멧 카드는 v3·2, 비상연락처 줄은 v3·5, 동의 줄은 v3·1 과 같은 모양·문구. 평소 화면이라 빨강을 쓰지 않는다.
// 내 정보 · 헬멧(시뮬레이션) · 비상연락처 · 알림 · 동의 · (개발) 미리보기 · 로그아웃 · 계정 삭제.
// 계정 삭제는 앱 안에서 할 수 있어야 한다(Google Play 정책).
import type { ContactDto, MeDto, SocialProvider } from '@rider-guard/contract';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Linking, Platform, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useDeleteAccount, useIncidents, useMe } from '@/api/hooks';
import { useAuth } from '@/auth/AuthProvider';
import { BottomNav } from '@/components/BottomNav';
import { Notice, TextButton, Toggle } from '@/components/forms';
import { BellIcon, CheckIcon, ChevronRightIcon, LockIcon, LogOutIcon, MailIcon, PhoneIcon, UsersIcon, WarningTriangleIcon } from '@/components/Icons';
import { useToast } from '@/components/Toast';
import { Badge, Button, FadeIn, IconCircle, ListGroup, PressableScale, Screen, Sheet, SimBadge, Skeleton, Txt, type BadgeTone } from '@/components/ui';
import { acceptanceSummaryText, useContactAcceptance } from '@/features/contactSim';
import { helmetInfo, helmetTitle, useHelmet, useProtection, type HelmetInfo } from '@/features/helmet';
import { PUSH_STATUS_TEXT, usePushStatus, type PushStatus } from '@/features/push';
import { toggleVoice, voiceSub, voiceSupported } from '@/features/voice';
import { platformsText } from '@/lib/platforms';
import { contactDisplayName, useConsentSim } from '@/features/sim';
import { batteryText, formatMobile, hm } from '@/lib/format';
import { colors, font, typography } from '@/theme';

// 화면 미리보기(수락 웹 · 긴급 알림 웹 · 잠금화면) — 개발 빌드, 또는 시연용 preview 빌드(EXPO_PUBLIC_SHOW_DEV_TOOLS)에서만
const showDevTools = __DEV__ || process.env.EXPO_PUBLIC_SHOW_DEV_TOOLS === 'true';

const PROVIDER_LABEL: Record<SocialProvider, string> = { kakao: '카카오', naver: '네이버', google: 'Google' };

function loginMethod(account: MeDto['account']) {
  const methods = account.social.map((p) => `${PROVIDER_LABEL[p]} 로그인`);
  if (account.hasPassword && account.email) methods.unshift(account.email);
  return methods.join(', ') || '-';
}

/** 알림 상태 배지 — 평소 화면이라 꺼짐·오류도 빨강이 아닌 회색 */
const PUSH_BADGE: Record<PushStatus, { label: string; tone: BadgeTone }> = {
  registered: { label: '켜짐', tone: 'green' },
  unknown: { label: '확인 중', tone: 'neutral' },
  denied: { label: '꺼짐', tone: 'neutral' },
  error: { label: '오류', tone: 'neutral' },
  unsupported: { label: '사용 불가', tone: 'neutral' },
  expo_go: { label: '사용 불가', tone: 'neutral' },
  simulator: { label: '사용 불가', tone: 'neutral' },
  no_project: { label: '사용 불가', tone: 'neutral' },
};

const appVersion = Constants.expoConfig?.version;

const editProfile = () => router.push({ pathname: '/onboarding', params: { mode: 'edit' } });

export default function SettingsScreen() {
  const { data: me, error, refetch } = useMe();
  const { signOut } = useAuth();
  const toast = useToast();
  const helmet = useHelmet();
  const protection = useProtection();
  const [deleting, setDeleting] = useState(false);
  const [leaving, setLeaving] = useState(false);

  const loaded = !!me;
  // 보호 중(서버 운행 세션이 있음)이거나 켜는 중이면 바로 로그아웃하지 않는다 — 헬멧을 벗겨 보호를 끈 뒤에(시트)
  const protecting = protection.active || protection.pending === 'start';
  // 불러오는 중에는 보호 중인지 모르니 막는다. 불러오기에 실패했으면 로그아웃만은 할 수 있게 둔다
  const canSignOut = loaded || !!error;
  const onSignOut = () => (loaded && protecting ? setLeaving(true) : signOut());

  const info = me ? helmetInfo(me.device, helmet.worn) : null;

  return (
    <Screen top={56} side={16} bottom={28} gap={0} enter="none" footer={<BottomNav active="settings" />}>
      {/* 홈 머리글과 같은 자리·크기 — 탭을 바꿔도 제목이 튀지 않게 */}
      <FadeIn style={styles.header}>
        <Txt style={styles.kicker}>보호와 계정을 관리해요</Txt>
        <Txt accessibilityRole="header" style={styles.title}>
          설정
        </Txt>
      </FadeIn>

      {error && !me ? <Notice error={error} onRetry={() => void refetch()} style={styles.notice} /> : null}

      <Section title="내 정보" delay={40}>
        <ListGroup>
          <ProfileRow me={me} />
          <Row
            leading={
              <IconCircle>
                <MailIcon size={20} color={colors.text} />
              </IconCircle>
            }
            title="로그인 방식"
            sub={
              me ? (
                <Txt style={styles.rowSub} numberOfLines={1} ellipsizeMode="middle">
                  {loginMethod(me.account)}
                </Txt>
              ) : (
                <Skeleton width={150} height={13} style={styles.subSkel} />
              )
            }
          />
        </ListGroup>
      </Section>

      <Section title="헬멧" delay={80}>
        <ListGroup>
          {info ? <HelmetRow info={info} /> : <HelmetRowSkeleton />}
          <Row
            title="헬멧 착용"
            sub={<WornSub />}
            right={<Toggle value={helmet.worn} onValueChange={helmet.setWorn} disabled={!helmet.ready} accessibilityLabel="헬멧 착용" style={styles.toggle} />}
          />
          {/* 브라우저 음성 인식이 있을 때만 켤 수 있다 — 없으면 켤 수 있는 것처럼 보이지 않게 */}
          {voiceSupported() ? (
            <Row
              title="말로 응답하기"
              sub={voiceSub(helmet.voice)}
              right={<Toggle value={helmet.voice} onValueChange={(v) => void toggleVoice(v, helmet.setVoice, toast)} accessibilityLabel="말로 응답하기" style={styles.toggle} />}
            />
          ) : (
            <Row
              title="말로 응답하기"
              sub={voiceSub(false)}
              right={
                <Badge tone="neutral" size="sm">
                  미지원
                </Badge>
              }
              accessibilityLabel={`말로 응답하기, 미지원. ${voiceSub(false)}`}
            />
          )}
        </ListGroup>
      </Section>

      <Section title="사고 때 알림" delay={120}>
        <ListGroup>
          <AffiliationRow me={me} />
          <ContactsRow me={me} />
          <PushRow />
        </ListGroup>
      </Section>

      <Section title="동의 관리" delay={160}>
        <ConsentGroup me={me} />
      </Section>

      {showDevTools ? <DevPreview me={me} delay={200} /> : null}

      <Section title="계정" delay={showDevTools ? 240 : 200}>
        <ListGroup>
          {me?.role === 'admin' ? (
            <Row
              leading={
                <IconCircle>
                  <UsersIcon size={20} color={colors.text} />
                </IconCircle>
              }
              title={<Txt style={styles.rowTitle}>관리자 화면</Txt>}
              sub="관제 · 실험 데이터 · 운영 현황"
              chevron
              onPress={() => router.push('/admin')}
              accessibilityLabel="관리자 화면"
            />
          ) : null}
          <Row
            leading={
              <IconCircle>
                <LogOutIcon size={20} color={canSignOut ? colors.text : colors.disabledText} />
              </IconCircle>
            }
            title={<Txt style={[styles.rowTitle, !canSignOut && styles.disabledText]}>로그아웃</Txt>}
            sub={loaded && protecting ? '보호를 끈 뒤 로그아웃해요' : undefined}
            chevron
            disabled={!canSignOut}
            onPress={onSignOut}
            accessibilityLabel="로그아웃"
            accessibilityHint={loaded && protecting ? '보호 중이라 헬멧을 벗은 것으로 바꾸고 보호를 끈 뒤 로그아웃해요' : undefined}
          />
        </ListGroup>
        <TextButton
          label="계정 삭제"
          fontSize={13}
          color={colors.textMuted}
          disabled={!loaded}
          onPress={() => setDeleting(true)}
          accessibilityLabel="계정 삭제"
          style={styles.delete}
        />
        {appVersion ? <Txt style={styles.version}>Rider Guard {appVersion}</Txt> : null}
      </Section>

      <SignOutSheet visible={leaving} onClose={() => setLeaving(false)} />
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

// ── 묶음 · 줄 ─────────────────────────────────────────────────

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

type RowProps = {
  /** 왼쪽 원·점 */
  leading?: React.ReactNode;
  /** 문자열이면 15 굵게 */
  title: React.ReactNode;
  /** 문자열이면 13 회색 */
  sub?: React.ReactNode;
  /** 오른쪽 스위치·배지·글자 */
  right?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
};

/** 설정 한 줄 — v3·2 헬멧 카드 줄과 같은 크기(제목 15 굵게 · 보조 13 · 위아래 17). onPress 가 있으면 줄 전체가 눌린다 */
function Row({ leading, title, sub, right, chevron, onPress, disabled, accessibilityLabel, accessibilityHint }: RowProps) {
  const body = (
    <>
      {leading}
      <View style={styles.rowMain}>
        {typeof title === 'string' ? <Txt style={styles.rowTitle}>{title}</Txt> : title}
        {sub == null ? null : typeof sub === 'string' ? <Txt style={styles.rowSub}>{sub}</Txt> : sub}
      </View>
      {right}
      {chevron ? <ChevronRightIcon size={18} color={disabled ? colors.disabledText : colors.textFaint} /> : null}
    </>
  );
  if (!onPress) return <View style={[styles.row, leading ? styles.rowWithCircle : null]}>{body}</View>;
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled }}
      disabled={disabled}
      onPress={onPress}
      style={[styles.row, leading ? styles.rowWithCircle : null]}
      pressedStyle={styles.pressed}
    >
      {body}
    </PressableScale>
  );
}

/** 오른쪽 글자 동작 ('수정' — v3·5 비상연락처 카드와 같은 모양) */
const EditText = ({ label = '수정' }: { label?: string }) => <Txt style={styles.editText}>{label}</Txt>;

// ── 내 정보 ──────────────────────────────────────────────────

/** 이름 · 휴대폰 — 누르면 가입 정보 수정 */
function ProfileRow({ me }: { me: MeDto | undefined }) {
  if (!me) {
    return (
      <View style={styles.profile}>
        <Skeleton width={48} height={48} radius={24} />
        <View style={[styles.rowMain, styles.skelGap]}>
          <Skeleton width={72} height={20} />
          <Skeleton width={120} height={14} />
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
      onPress={editProfile}
      style={styles.profile}
      pressedStyle={styles.pressed}
    >
      <View style={styles.avatar}>
        <Txt style={styles.avatarText}>{name ? name[0] : '?'}</Txt>
      </View>
      <View style={styles.rowMain}>
        <Txt style={styles.name} numberOfLines={1}>
          {name || '이름을 등록해 주세요'}
        </Txt>
        {phone ? <Txt style={styles.phone}>{phone}</Txt> : null}
      </View>
      <EditText />
    </PressableScale>
  );
}

// ── 헬멧 ────────────────────────────────────────────────────

/** v3·2 와 같은 줄 — 초록 점 · '헬멧 모듈 연결됨' · '개발용 웹캠 detector, 배터리 78%' · 밑줄 '변경'(헬멧 화면으로) */
function HelmetRow({ info }: { info: HelmetInfo }) {
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
      <TextButton
        label="변경"
        underline
        color={colors.text}
        accessibilityLabel="헬멧 모듈 변경"
        onPress={() => router.push('/helmet')}
        style={styles.change}
      />
    </View>
  );
}

function HelmetRowSkeleton() {
  return (
    <View style={styles.row}>
      <Skeleton width={8} height={8} radius={4} />
      <View style={[styles.rowMain, styles.skelGap]}>
        <Skeleton width={120} height={16} />
        <Skeleton width={190} height={13} />
      </View>
    </View>
  );
}

/** 헬멧 착용 줄 아래 — 보호가 켜졌는지, 켜고 끄는 중인지 */
function WornSub() {
  const p = useProtection();
  if (p.error) {
    return (
      <View style={styles.subError}>
        <WarningTriangleIcon size={13} color={colors.error} strokeWidth={2.2} />
        <Txt style={[styles.rowSub, styles.subErrorText]}>보호를 {p.worn ? '켜지' : '끄지'} 못했어요 · 잠시 뒤 다시 시도해요</Txt>
      </View>
    );
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
  return <Txt style={styles.rowSub}>{text}</Txt>;
}

// ── 비상연락 · 알림 ───────────────────────────────────────────

/** v3·5 홈 비상연락처 카드와 같은 줄 — 전화 원 · '비상연락처 2명' · '1순위 김민지 수락, 2순위 박준호 대기' · '수정' */
function ContactsRow({ me }: { me: MeDto | undefined }) {
  const acc = useContactAcceptance(me?.contacts);
  const circle = (
    <IconCircle>
      <PhoneIcon size={20} color={colors.text} />
    </IconCircle>
  );
  if (!me) {
    return (
      <View style={[styles.row, styles.rowWithCircle]}>
        {circle}
        <View style={[styles.rowMain, styles.skelGap]}>
          <Skeleton width={96} height={16} />
          <Skeleton width={180} height={13} />
        </View>
      </View>
    );
  }
  const count = me.contacts.length;
  const summary = acceptanceSummaryText(me.contacts, acc.statusOf);
  return (
    <Row
      leading={circle}
      title={count ? `가족 비상연락처 ${count}명` : '가족 비상연락처 (선택)'}
      sub={count ? summary : '대행사 관제와 함께 가족에게도 알려요'}
      right={<EditText label={count ? '수정' : '등록'} />}
      onPress={() => router.push('/setup')}
      accessibilityLabel={count ? `가족 비상연락처 ${count}명, ${summary}` : '가족 비상연락처, 선택'}
      accessibilityHint="비상연락처를 보고 고칠 수 있어요"
    />
  );
}

/** 소속 배달대행사 · 일하는 플랫폼 — 사고 때 먼저 알리는 곳 */
function AffiliationRow({ me }: { me: MeDto | undefined }) {
  if (!me) return null;
  const aff = me.affiliation;
  const title = aff?.agency ? aff.agency.name : aff ? '대행사 없이 직접 계약' : '소속 배달대행사를 연결해 주세요';
  const sub = aff ? platformsText(aff.platforms) : '사고 때 대행사 관제에 바로 알리고 주문을 넘겨요';
  return (
    <Row
      leading={
        <IconCircle>
          <UsersIcon size={20} color={colors.text} />
        </IconCircle>
      }
      title={title}
      sub={sub}
      right={<EditText label={aff ? '수정' : '연결'} />}
      onPress={() => router.push('/affiliation')}
      accessibilityLabel={`${title}, ${sub}`}
      accessibilityHint="소속 배달대행사와 플랫폼을 보고 고칠 수 있어요"
    />
  );
}

function PushRow() {
  const push = usePushStatus();
  const badge = PUSH_BADGE[push];
  const sub = push === 'registered' ? '사고가 감지되면 잠금화면에서 바로 응답할 수 있어요' : PUSH_STATUS_TEXT[push];
  const openSettings = push === 'denied' && Platform.OS !== 'web' ? () => void Linking.openSettings() : undefined;
  return (
    <Row
      leading={
        <IconCircle>
          <BellIcon size={20} color={colors.text} />
        </IconCircle>
      }
      title="사고 확인 알림"
      sub={sub}
      right={
        <Badge tone={badge.tone} size="sm">
          {badge.label}
        </Badge>
      }
      chevron={!!openSettings}
      onPress={openSettings}
      accessibilityLabel={`사고 확인 알림, ${badge.label}, ${sub}`}
      accessibilityHint={openSettings ? '기기 설정에서 알림을 켤 수 있어요' : undefined}
    />
  );
}

// ── 동의 관리 ────────────────────────────────────────────────

/**
 * v3·1 동의 — 필수 둘 + 선택 '감지 구간 개선 제공'(서버 계약에 없어 기기에만 남는다) + 가입 때 받은 선택 둘.
 * 로그인(Google 등) 동의는 이 항목들을 대신하지 않는다. insuranceRecords 는 서버의 기록 파일 내보내기를 여닫는다.
 * 줄을 누르면 가입 정보 수정 화면에서 바꾼다 (서버 동의는 이름·번호와 함께 저장된다).
 */
function ConsentGroup({ me }: { me: MeDto | undefined }) {
  const [falsePositive] = useConsentSim();
  const c = me?.consents;
  const items: { key: string; required: boolean; label: string; agreed: boolean | undefined }[] = [
    { key: 'locationSensor', required: true, label: '헬멧 착용 중에만 위치·센서 수집', agreed: c?.locationSensor },
    { key: 'shareOnIncident', required: true, label: '사고 때 비상연락처에 위치 전달', agreed: c?.shareOnIncident },
    { key: 'falsePositive', required: false, label: '감지 구간을 정확도 개선에 제공 (기기에만 저장)', agreed: falsePositive },
    { key: 'insuranceRecords', required: false, label: '사고기록 파일 제공 (기록 파일 받기)', agreed: c?.insuranceRecords },
    { key: 'medicalInfo', required: false, label: '119 신고 때 의료정보 함께 전달', agreed: c?.medicalInfo },
  ];
  return (
    <ListGroup>
      {items.map(({ key, ...item }) => (
        <ConsentRow key={key} {...item} loading={!me} />
      ))}
    </ListGroup>
  );
}

function ConsentRow({ required, label, agreed, loading }: { required: boolean; label: string; agreed: boolean | undefined; loading: boolean }) {
  const tag = required ? '필수' : '선택';
  return (
    <PressableScale
      accessibilityRole="button"
      accessibilityLabel={`${tag}, ${label}, ${loading ? '불러오는 중' : agreed ? '동의함' : '동의 안 함'}`}
      accessibilityHint="가입 정보 수정 화면에서 동의를 바꿀 수 있어요"
      accessibilityState={{ disabled: loading }}
      disabled={loading}
      onPress={editProfile}
      style={styles.consentRow}
      pressedStyle={styles.pressed}
    >
      <Txt style={[styles.consentTag, !required && styles.consentTagOptional]}>{tag}</Txt>
      <Txt style={styles.consentLabel}>{label}</Txt>
      {loading ? (
        <Skeleton width={16} height={16} radius={8} />
      ) : agreed ? (
        <CheckIcon size={17} color={colors.asphalt} strokeWidth={2.6} />
      ) : (
        <Txt style={styles.consentOff}>미동의</Txt>
      )}
      <ChevronRightIcon size={16} color={colors.textFaint} />
    </PressableScale>
  );
}

// ── 개발 · 미리보기 ───────────────────────────────────────────

/** 비상연락처가 받는 화면과 잠금화면 알림을 앱 안에서 미리 본다 (모두 모의 화면 — 서버에 보내지 않고 실제 연락도 하지 않는다) */
function DevPreview({ me, delay }: { me: MeDto | undefined; delay: number }) {
  const { data } = useIncidents();
  const first: ContactDto | undefined = [...(me?.contacts ?? [])].sort((a, b) => a.priority - b.priority)[0];
  const latestId = data?.items[0]?.id;
  const openEmergency = () => (latestId ? router.push({ pathname: '/emergency', params: { id: latestId } }) : router.push('/emergency'));
  return (
    <Section title="미리보기" right={<SimBadge label="모의 화면 · 실제 전송 없음" />} delay={delay}>
      <ListGroup>
        <Row
          leading={
            <IconCircle>
              <MailIcon size={20} color={first ? colors.text : colors.disabledText} />
            </IconCircle>
          }
          title="연락처 수락 웹"
          sub={first ? `${contactDisplayName(first.name, first.priority)}님이 받는 수락 페이지` : '비상연락처를 먼저 등록해 주세요'}
          chevron
          disabled={!first}
          onPress={() => first && router.push({ pathname: '/invite', params: { id: first.id } })}
          accessibilityLabel="연락처 수락 웹 미리보기"
        />
        <Row
          leading={
            <IconCircle>
              <WarningTriangleIcon size={20} color={colors.text} />
            </IconCircle>
          }
          title="긴급 알림 웹"
          sub="사고 때 비상연락처가 받는 페이지"
          chevron
          onPress={openEmergency}
          accessibilityLabel="긴급 알림 웹 미리보기"
        />
        <Row
          leading={
            <IconCircle>
              <LockIcon size={20} color={colors.text} />
            </IconCircle>
          }
          title="잠금화면 알림"
          sub="보호 중 잠금화면에 늘 떠 있는 알림"
          chevron
          onPress={() => router.push('/lockscreen')}
          accessibilityLabel="잠금화면 알림 미리보기"
        />
      </ListGroup>
    </Section>
  );
}

// ── 로그아웃 · 계정 삭제 ──────────────────────────────────────

/**
 * 보호 중 로그아웃 — 헬멧을 벗은 것으로 바꾸고(자동 보호가 세션을 끈다) 보호가 꺼지면 그때 로그아웃한다.
 * 세션을 끄고 바로 로그아웃하면 자동 보호가 로그아웃 전에 세션을 다시 켤 수 있어서 이 순서를 지킨다.
 * 로그아웃한 뒤에는 착용 상태를 되돌린다 — 다시 로그인했을 때 보호가 꺼진 채 남지 않게(착용은 기기 저장값이다).
 */
function SignOutSheet({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const { signOut } = useAuth();
  const p = useProtection();
  const { setWorn } = useHelmet();
  const [started, setStarted] = useState(false);
  const fired = useRef(false);
  const wasWorn = useRef(false);
  const off = p.ready && !p.active && p.pending == null;

  useEffect(() => {
    if (!started || !off || fired.current) return;
    fired.current = true;
    signOut();
    // 로그아웃으로 세션 정보(me)가 비워진 뒤라 자동 보호가 다시 켜지지 않는다
    if (wasWorn.current) setWorn(true);
  }, [started, off, signOut, setWorn]);

  const failed = started && !!p.error && p.pending == null;
  const close = () => {
    setStarted(false);
    onClose();
  };
  const go = () => {
    wasWorn.current = p.worn;
    setWorn(false);
    setStarted(true);
  };
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="보호를 끄고 로그아웃할까요?"
      description="지금 보호 중이에요. 헬멧을 벗은 것으로 바꿔 보호를 끈 다음 로그아웃해요."
    >
      {started && p.heldByIncident ? <Notice tone="info" message="사고 대응이 끝나면 보호가 꺼지고, 그때 로그아웃돼요." /> : null}
      {failed ? <Notice message={`보호를 끄지 못했어요. ${errorMessage(p.error)}`} /> : null}
      <Button label="보호 끄고 로그아웃" loading={started && !failed} onPress={go} />
      <Button label="취소" variant="ghost" size="md" onPress={close} />
    </Sheet>
  );
}

/** 되돌릴 수 없어서 한 번 더 묻는다 — 무엇이 지워지는지 보여 주고 '삭제하기'를 눌러야 지워진다. 보호 중에는 먼저 헬멧을 벗게 한다 */
function DeleteAccountSheet({ visible, onClose, onDeleted }: { visible: boolean; onClose: () => void; onDeleted: () => void }) {
  const remove = useDeleteAccount();
  const p = useProtection();
  const { setWorn } = useHelmet();
  // 보호 중에는 삭제하지 않는다 — 위치 수집·사고 대응이 계정과 함께 끊기지 않게
  const protecting = p.active || p.pending === 'start';
  const close = () => {
    if (remove.isPending) return;
    remove.reset();
    onClose();
  };
  const blocked = !protecting
    ? null
    : p.worn
      ? '보호 중에는 계정을 삭제할 수 없어요. 헬멧을 벗으면 보호가 꺼져요.'
      : p.heldByIncident
        ? '사고 대응이 끝나면 보호가 꺼지고, 그 뒤에 삭제할 수 있어요.'
        : '보호를 끄는 중이에요. 꺼지면 삭제할 수 있어요.';
  return (
    <Sheet
      visible={visible}
      onClose={close}
      title="계정을 삭제할까요?"
      description="계정과 비상연락처, 기기 연결, 사고 기록이 모두 지워지고 되돌릴 수 없어요. 위치정보 이용·제공 기록은 위치정보법에 따라 6개월 동안 보관한 뒤 지워요."
    >
      {blocked ? <Notice tone="info" message={blocked} onRetry={p.worn ? () => setWorn(false) : undefined} retryLabel="헬멧 벗기" /> : null}
      <Notice error={remove.error} />
      <Button label="삭제하기" disabled={!!blocked} loading={remove.isPending} onPress={() => remove.mutate(undefined, { onSuccess: onDeleted })} />
      <Button label="취소" variant="ghost" size="md" disabled={remove.isPending} onPress={close} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  // 홈 머리글('안녕하세요' + '[이름]님')과 같은 글자·위치
  header: { paddingHorizontal: 8, minHeight: 50, justifyContent: 'center' },
  kicker: { ...font.sans(500), fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textMuted },
  title: { ...font.sans(800), fontSize: 24, lineHeight: 30, letterSpacing: -0.8, color: colors.text },
  notice: { marginTop: 16 },
  section: { marginTop: 22, gap: 8 },
  sectionHead: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, minHeight: 18 },

  // v3·2 헬멧 카드 줄: 두 줄(21 + 1 + 18) + 위아래 17 = 74
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingVertical: 17, paddingHorizontal: 18 },
  // 원(40)이 있는 줄은 v3·5 비상연락처 카드처럼 왼쪽 14 · 위아래 14
  rowWithCircle: { paddingVertical: 14, paddingLeft: 14 },
  pressed: { backgroundColor: colors.surfacePressed },
  rowMain: { flex: 1, minWidth: 0, gap: 1 },
  rowTitle: { ...font.sans(700), fontSize: 15, lineHeight: 21, letterSpacing: -0.3, color: colors.text },
  rowSub: { ...typography.caption, lineHeight: 18, letterSpacing: -0.4 },
  subSkel: { marginTop: 4 },
  disabledText: { color: colors.disabledText },
  subError: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  subErrorText: { ...font.sans(500), flexShrink: 1, color: colors.error },
  editText: { ...font.sans(600), fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.textMuted, paddingLeft: 4 },
  toggle: { minHeight: 40 },
  skelGap: { gap: 8 },

  profile: { flexDirection: 'row', alignItems: 'center', gap: 14, paddingVertical: 18, paddingLeft: 16, paddingRight: 18 },
  avatar: { width: 48, height: 48, borderRadius: 24, backgroundColor: colors.asphalt, alignItems: 'center', justifyContent: 'center' },
  avatarText: { ...font.sans(800), fontSize: 19, lineHeight: 24, color: colors.textOnDark },
  name: { ...font.sans(800), fontSize: 18, lineHeight: 24, letterSpacing: -0.5, color: colors.text },
  // 휴대폰 번호는 고정폭 숫자로
  phone: { ...font.mono(500), fontSize: 13, lineHeight: 18, color: colors.textMuted, marginTop: 1 },

  // 초록 점 8 + 연초록 헤일로 14 (헤일로는 자리를 차지하지 않는다)
  dotBox: { width: 8, height: 8, alignItems: 'center', justifyContent: 'center' },
  dotHalo: { position: 'absolute', left: -3, top: -3, width: 14, height: 14, borderRadius: 7 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  // 글자 끝이 카드 오른쪽 여백선에 맞게 · 줄 높이를 키우지 않게
  change: { marginRight: -8, minHeight: 40 },

  // v3·1 동의 줄: 꼬리표(필수 진하게 · 선택 흐리게) + 문구 14 + 오른쪽 >
  consentRow: { flexDirection: 'row', alignItems: 'center', gap: 10, minHeight: 50, paddingVertical: 13, paddingLeft: 18, paddingRight: 14 },
  consentTag: { ...font.sans(700), fontSize: 13, lineHeight: 20, width: 26, color: colors.text },
  consentTagOptional: { color: colors.textFaint },
  consentLabel: { flex: 1, minWidth: 0, fontSize: 14, lineHeight: 20, letterSpacing: -0.3, color: colors.text },
  consentOff: { ...font.sans(500), fontSize: 13, lineHeight: 18, color: colors.textFaint },

  delete: { alignSelf: 'center', marginTop: 6 },
  version: { ...typography.small, color: colors.textFaint, textAlign: 'center' },
});
