// 디자인: design/Records.dc.html — 사고 기록
import type { IncidentSummaryDto } from '@rider-guard/contract';
import { router } from 'expo-router';
import { Pressable, Share, StyleSheet, View } from 'react-native';

import { errorMessage } from '@/api/client';
import { useIncidents } from '@/api/hooks';
import { BottomNav } from '@/components/BottomNav';
import { ChevronRightIcon } from '@/components/Icons';
import { Badge, Button, Card, Screen, Txt } from '@/components/ui';
import { contactText, dateTime, orderText, placeText, recordShareText, recordSummary, recordTag, responseText } from '@/lib/format';
import { colors, font, radius } from '@/theme';

const openStatus = (id: string) => router.push({ pathname: '/status', params: { id } });

export default function RecordsScreen() {
  const { data, error, isPending } = useIncidents();
  const [latest, ...past] = data?.items ?? [];

  return (
    <Screen top={52} bottom={20} footer={<BottomNav active="records" />}>
      <View style={{ gap: 6 }}>
        <Txt style={styles.h1}>사고 기록</Txt>
        <Txt style={styles.lead}>보험·산재 접수에 쓸 수 있도록 모든 감지 기록을 보관해요.</Txt>
      </View>

      {error && <Txt style={[styles.lead, { color: colors.accent }]}>{errorMessage(error)}</Txt>}
      {!isPending && !latest && !error && (
        <Card style={{ padding: 18 }}>
          <Txt style={styles.lead}>아직 감지 기록이 없어요.</Txt>
        </Card>
      )}

      {latest && <LatestCard record={latest} />}

      {past.length > 0 && (
        <>
          <Txt style={[font.sans(700), { fontSize: 13, color: colors.textMuted, paddingTop: 4, paddingHorizontal: 4 }]}>이전 기록</Txt>
          <Card style={{ overflow: 'hidden' }}>
            {past.map((r, i) => (
              <Pressable
                key={r.id}
                accessibilityRole="button"
                onPress={() => openStatus(r.id)}
                style={({ pressed }) => [
                  styles.item,
                  i < past.length - 1 && { borderBottomWidth: 1, borderBottomColor: colors.divider },
                  pressed && { backgroundColor: colors.bg },
                ]}
              >
                <View style={{ flex: 1, gap: 2 }}>
                  <Txt style={[font.mono(600), { fontSize: 14 }]}>{dateTime(r.detectedAt, false)}</Txt>
                  <Txt style={{ fontSize: 13, color: colors.textMuted }}>{recordSummary(r)}</Txt>
                </View>
                <Badge tone="muted" style={{ paddingVertical: 3, paddingHorizontal: 8 }}>
                  {recordTag(r)}
                </Badge>
                <ChevronRightIcon size={16} color={colors.textMuted} />
              </Pressable>
            ))}
          </Card>
        </>
      )}
    </Screen>
  );
}

function LatestCard({ record }: { record: IncidentSummaryDto }) {
  const facts = [
    { label: '감지 위치', value: placeText(record) },
    { label: '라이더 응답', value: responseText(record) },
    { label: '비상연락', value: contactText(record) },
    { label: '주문 처리', value: orderText(record) },
  ];
  const tag = recordTag(record);
  return (
    <Card style={{ padding: 18, gap: 14 }}>
      <Pressable accessibilityRole="button" onPress={() => openStatus(record.id)} style={styles.between}>
        <Txt style={[font.mono(600), { fontSize: 15 }]}>{dateTime(record.detectedAt)}</Txt>
        <Badge tone={tag === '대응 중' ? 'accentSoft' : 'ink'}>{tag}</Badge>
      </Pressable>
      <View style={styles.grid}>
        {facts.map((f) => (
          <View key={f.label} style={styles.fact}>
            <Txt style={{ fontSize: 12, color: colors.textMuted }}>{f.label}</Txt>
            <Txt style={[font.sans(600), { fontSize: 14 }]}>{f.value}</Txt>
          </View>
        ))}
      </View>
      {/* 디자인의 'PDF 받기'는 서버 PDF 생성이 없어 빼고, 기록을 글로 공유한다 */}
      <Button
        label="기록 공유"
        variant="dark"
        height={48}
        rounded={radius.lg}
        fontSize={14}
        onPress={() => Share.share({ message: recordShareText(record) }).catch(() => {})}
      />
    </Card>
  );
}

const styles = StyleSheet.create({
  h1: { ...font.sans(700), fontSize: 24, letterSpacing: -0.5 },
  lead: { fontSize: 14, lineHeight: 21, color: colors.textMuted },
  between: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 14, columnGap: 12 },
  fact: { width: '47%', flexGrow: 1, gap: 2 },
  item: { flexDirection: 'row', alignItems: 'center', gap: 12, minHeight: 64, paddingHorizontal: 16 },
});
