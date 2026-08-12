"""신규성·독창성 레드팀 평가 PDF 생성."""

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate, Frame, KeepTogether, PageBreak, Paragraph,
    PageTemplate, Spacer, Table, TableStyle,
)

DIR = "/tmp/claude-0/-home-user-TIENG/0e9f64d4-30dd-51b4-b44c-998dc683d9d0/scratchpad"
OUT = f"{DIR}/TIENG-신규성-레드팀-평가.pdf"

pdfmetrics.registerFont(TTFont("KR", f"{DIR}/Pretendard.ttf"))
pdfmetrics.registerFont(TTFont("Mono", f"{DIR}/JetBrainsMono.ttf"))

GOLD = colors.HexColor("#A8792F")
GOLD_L = colors.HexColor("#C5A059")
INK = colors.HexColor("#1A1A1A")
BODY = colors.HexColor("#2E2E2E")
MUTED = colors.HexColor("#5F5F5F")
FAINT = colors.HexColor("#8C8C8C")
RULE = colors.HexColor("#DEDEDE")
BAD = colors.HexColor("#A3261E")
GOOD = colors.HexColor("#2C6E3F")
WASH = colors.HexColor("#FAF7F1")
BAD_H, GOOD_H = "#A3261E", "#2C6E3F"
CODEBG = colors.HexColor("#F4F4F2")

FULL, OPEN = "●", "○"


def rating(n):
    return f'<font color="#A8792F">{FULL * n}</font><font color="#C9C9C9">{OPEN * (5 - n)}</font>'


S = {}
S["title"] = ParagraphStyle("t", fontName="KR", fontSize=23, leading=30, textColor=INK,
                            spaceAfter=3)
S["sub"] = ParagraphStyle("s", fontName="KR", fontSize=12.5, leading=18, textColor=GOLD,
                          spaceAfter=10)
S["meta"] = ParagraphStyle("m", fontName="KR", fontSize=8.6, leading=14, textColor=FAINT)
S["h1"] = ParagraphStyle("h1", fontName="KR", fontSize=15, leading=21, textColor=INK,
                         spaceBefore=13, spaceAfter=7)
S["h2"] = ParagraphStyle("h2", fontName="KR", fontSize=11.6, leading=17, textColor=INK,
                         spaceBefore=13, spaceAfter=5)
S["body"] = ParagraphStyle("b", fontName="KR", fontSize=9.6, leading=16.4, textColor=BODY,
                           alignment=TA_LEFT, spaceAfter=7)
S["lead"] = ParagraphStyle("l", fontName="KR", fontSize=10.4, leading=17.6, textColor=BODY,
                           spaceAfter=8)
S["li"] = ParagraphStyle("li", parent=S["body"], leftIndent=11, bulletIndent=1, spaceAfter=4.5)
S["note"] = ParagraphStyle("n", fontName="KR", fontSize=8.9, leading=15, textColor=MUTED,
                           spaceAfter=6)
S["quote"] = ParagraphStyle("q", fontName="KR", fontSize=9.1, leading=15.5, textColor=MUTED,
                            leftIndent=11, rightIndent=6, spaceBefore=2, spaceAfter=2)
S["code"] = ParagraphStyle("c", fontName="Mono", fontSize=8.3, leading=13.5, textColor=INK,
                           leftIndent=8, rightIndent=6, spaceBefore=3, spaceAfter=3)
S["codekr"] = ParagraphStyle("ck", fontName="KR", fontSize=9.2, leading=15, textColor=INK,
                             leftIndent=8, rightIndent=6, spaceBefore=3, spaceAfter=3)
S["th"] = ParagraphStyle("th", fontName="KR", fontSize=8.5, leading=12.5, textColor=INK)
S["td"] = ParagraphStyle("td", fontName="KR", fontSize=8.7, leading=13.5, textColor=BODY)
S["tdm"] = ParagraphStyle("tdm", fontName="Mono", fontSize=8.5, leading=13.5, textColor=BODY)
S["cap"] = ParagraphStyle("cap", fontName="KR", fontSize=8.2, leading=12.5, textColor=FAINT,
                          spaceBefore=3, spaceAfter=9)

F = []


def p(txt, st="body"):
    F.append(Paragraph(txt, S[st]))


def h1(num, txt):
    F.append(Paragraph(
        f'<font color="#A8792F" face="Mono" size="11">{num}</font>  {txt}', S["h1"]))
    F.append(hr(GOLD_L, 1.0))


def h2(txt):
    F.append(Paragraph(txt, S["h2"]))


def bullets(items, st="li"):
    for it in items:
        F.append(Paragraph(it, S[st], bulletText="•"))
    F.append(Spacer(1, 4))


def hr(color=RULE, w=0.6, space=5):
    t = Table([[""]], colWidths=[168 * mm], rowHeights=[0.1])
    t.setStyle(TableStyle([("LINEBELOW", (0, 0), (-1, -1), w, color),
                           ("TOPPADDING", (0, 0), (-1, -1), 0),
                           ("BOTTOMPADDING", (0, 0), (-1, -1), space)]))
    return t


def box(title, body_html, accent=GOLD, bg=WASH):
    accent_hex = "#%02X%02X%02X" % tuple(round(c*255) for c in (accent.red, accent.green, accent.blue))
    inner = []
    if title:
        inner.append(Paragraph(
            f'<font color="{accent_hex}"><b>{title}</b></font>', S["note"]))
    inner.append(Paragraph(body_html, S["note"]))
    t = Table([[inner]], colWidths=[168 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, accent),
        ("LEFTPADDING", (0, 0), (-1, -1), 9), ("RIGHTPADDING", (0, 0), (-1, -1), 9),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
    ]))
    F.append(t)
    F.append(Spacer(1, 5))


def quote(txt):
    t = Table([[Paragraph(txt, S["quote"])]], colWidths=[168 * mm])
    t.setStyle(TableStyle([
        ("LINEBEFORE", (0, 0), (0, -1), 2.2, colors.HexColor("#D8D2C6")),
        ("LEFTPADDING", (0, 0), (-1, -1), 4), ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    F.append(t)
    F.append(Spacer(1, 7))


def code(txt, st="code"):
    t = Table([[Paragraph(txt, S[st])]], colWidths=[168 * mm])
    t.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), CODEBG),
        ("LEFTPADDING", (0, 0), (-1, -1), 5), ("RIGHTPADDING", (0, 0), (-1, -1), 5),
        ("TOPPADDING", (0, 0), (-1, -1), 6), ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
    ]))
    F.append(t)
    F.append(Spacer(1, 8))


def table(head, rows, widths, aligns=None, caption=None, mono_cols=()):
    data = [[Paragraph(f"<b>{c}</b>", S["th"]) for c in head]]
    for r in rows:
        data.append([
            Paragraph(c, S["tdm"] if i in mono_cols else S["td"])
            for i, c in enumerate(r)
        ])
    t = Table(data, colWidths=[w * mm for w in widths], repeatRows=1, hAlign="LEFT")
    style = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#F2EDE3")),
        ("LINEBELOW", (0, 0), (-1, 0), 0.9, GOLD_L),
        ("LINEBELOW", (0, 1), (-1, -2), 0.35, RULE),
        ("LINEBELOW", (0, -1), (-1, -1), 0.7, colors.HexColor("#C8C8C8")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6), ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 4.4), ("BOTTOMPADDING", (0, 0), (-1, -1), 4.4),
    ]
    for col, al in (aligns or {}).items():
        style.append(("ALIGN", (col, 0), (col, -1), al))
    t.setStyle(TableStyle(style))
    F.append(t)
    if caption:
        F.append(Paragraph(caption, S["cap"]))
    else:
        F.append(Spacer(1, 10))


# ═══════════════════════════════════════════════════════════ 표지
F.append(Spacer(1, 4))
p("신규성 · 독창성 레드팀 평가", "title")
p("TouchFree Vitals — TIENG", "sub")
F.append(hr(GOLD_L, 1.4, 8))
F.append(Paragraph(
    "검토 대상  Thyun 브랜치 전체 (약 20,000줄) · legacy/tieng_rppg/ 및 validation 산출물<br/>"
    "작성일  2026-08-12", S["meta"]))
F.append(Spacer(1, 13))

p("이 문서의 목적은 칭찬이 아니다. 심사위원·리뷰어·경쟁자가 신규성 주장을 어디서 "
  "무너뜨릴지 먼저 찾고, 그러고도 남는 것이 무엇인지 말하는 것이다.", "lead")

# ═══════════════════════════════════════════════════════════ 0
h1("00", "요약")

p("README §1 이 내세우는 차별점은 측정이 아니라 <b>닫힌 루프</b>다.")
code("센싱 &#8594; 품질 게이팅 &#8594; 상태 추정 &#8594; 개입 &#8594; 효과 검증 "
     "&#8594; (기준 갱신) &#8594; 센싱", "codekr")
p("그리고 시그니처 기능은 <b>L1</b> 이다. 상용 rPPG SDK 는 “밝은 곳에서 측정하세요”라고 "
  "요구할 뿐이지만, 이 시스템은 그 조건을 스스로 만든다.")
p("주장을 둘로 나눠야 한다. 하나는 살아남고 하나는 살아남지 못한다.")

table(
    ["주장", "내용", "판정"],
    [["<b>주장 1</b> · 아키텍처",
      "닫힌 루프와 정직성 계약이 이 부류의 시스템을 만드는 새로운 방식이다.",
      f'<font color="{GOOD_H}"><b>대체로 살아남는다</b></font>'],
     ["<b>주장 2</b> · 근거",
      "품질 게이팅이 정확도를 벌어 주고, 루프가 측정을 실제로 복구한다.",
      f'<font color="{BAD_H}"><b>뒷받침되지 않는다</b></font>']],
    [30, 100, 38])

# ═══════════════════════════════════════════════════════════ A
h1("A", "진짜 독창적인 것")
p("적대적 리뷰어 앞에서 얼마나 버티는지 순으로 정렬했다.", "note")

h2(f"A1.  reversible 을 정책 타입의 안전 계약으로  {rating(4)}")
p("<font face='Mono' size='8.6'>core/policy/base.py</font> 는 <b>reversible</b> 을 클래스 "
  "속성으로 요구하고, 그 규칙은 권고가 아니라 구조다. "
  "<font face='Mono' size='8.6'>runner.py</font> 가 되돌릴 수 없는 경로를 구조적으로 강제한다 — "
  "<font face='Mono' size='8.6'>fire()</font> 는 보내지 않는다. 취소 창을 열 뿐이고, "
  "<font face='Mono' size='8.6'>evaluate()</font> 가 아무도 취소하지 않았을 때만 보낸다.")
quote("카운트다운을 두는 이유: 메일은 되돌릴 수 없다. 새벽에 오작동으로 보호자를 깨우면 "
      "그 시스템은 다음 날 꺼진다. 한 번 꺼진 시스템은 진짜 필요할 때도 꺼져 있다."
      "<br/><font face='Mono' size='7.6' color='#8C8C8C'>l4_guardian.py</font>")
p("저장소에서 가장 강한 아이디어다. 실행 취소 창(Gmail undo send)도, 임상 알람의 단계적 "
  "에스컬레이션도 오래된 개념이다. 드문 것은 <b>자동 개입을 되돌림 가능성으로 계층화하고, "
  "그 계층을 정책 타입에 선언하고, 확인 관문을 정책이 아니라 실행기가 강제한다</b>는 점이다. "
  "이 프로젝트 밖으로도 일반화되는 재사용 가능한 설계 패턴이고, 신규성 주장은 이런 모양이어야 한다.")

h2(f"A2.  progress 와 confidence 를 계약에서 분리  {rating(4)}")
quote("이 필드가 있어야 프론트가 “기다리면 나온다”와 “신호가 나빠서 못 낸다”를 구분한다."
      "<br/><font face='Mono' size='7.6' color='#8C8C8C'>README §2</font>")
p("둘 다 <font face='Mono' size='8.6'>state=low_quality</font> 다. 이것을 뭉개면 표준적인 "
  "실패가 나온다 — 켤 때마다 창 채우는 동안 품질 경고가 뜨고, 사용자는 <b>경고 자체를 무시하는 "
  "법을 배운다.</b> 해결은 계약에 float 하나다.")
p("작다. 그리고 그게 요점이다. 비용이 거의 없는데 이 분야 대부분의 시스템이 틀리는 지점을 "
  "바로잡는 진짜 설계 기여다. 범위도 정직하다 — progress 는 화면 개념이지 근거가 아니라서 "
  "CSV 에서 명시적으로 뺐다.")

h2(f"A3.  발화하지 않은 결정을 근거로 남기는 것  {rating(3)}")
p("정책은 <b>왜 발화하지 않았는지</b>를 남기고, “조건이 아예 안 맞았다”와 "
  "<font face='Mono' size='8.6'>near_miss</font>(“주 조건은 맞았는데 다른 것이 막았다”)를 "
  "나눈다. near_miss 만 CSV 로 가서 로그가 익사하지 않는다.")
p("이것이 <b>보류율에 진짜 분모를 만든다.</b> “모를 땐 보류한다”를 구호에서 감사 가능한 "
  "숫자로 바꾸는 장치다. VALIDATION_PROTOCOL.md §0 은 이미 정확도와 커버리지를 한 쌍으로 "
  "보고하겠다고 못박아 두었다. 그 짝짓기 규율은 생각보다 드물고, 방법론적 독창성으로 "
  "방어할 수 있다.")

h2(f"A4.  confidence &#8594; 기대오차 캘리브레이션  {rating(3)}")
quote("‘0.7’이라는 값에 물리적 의미를 준다. 임계값을 눈대중이 아니라 목표 오차로부터 "
      "역산할 수 있게 하는 것이 이 클래스의 존재 이유."
      "<br/><font face='Mono' size='7.6' color='#8C8C8C'>legacy/…/confidence.py</font>")
p("<font face='Mono' size='8.6'>Calibration.fit</font> 은 confidence 를 측정 오차에 대해 "
  "구간화하고, 표본이 부족한 구간을 보간한 뒤, <b>가중 등위회귀</b>로 단조 감소를 강제한다 — "
  "<font face='Mono' size='8.6'>np.minimum.accumulate</font> 가 왜 틀리는지까지 주석에 있다. "
  "<font face='Mono' size='8.6'>threshold_for_mae</font> 가 그것을 뒤집는다: 눈대중이 아니라 "
  "목표 오차에서 게이트를 고른다. 지적으로는 프로젝트에서 가장 잘 논증된 부분이고, "
  "“왜 0.5 인가”라는 <b>반드시 나올 질문</b>에 대한 옳은 답이다.")
box("다만 — 능력으로 제시하면 과대주장이다",
    "이 코드는 <font face='Mono'>legacy/</font> 에 있고, 현재 파이프라인에서 <b>호출되지 "
    "않으며</b>, <font face='Mono'>core/quality.py</font> 는 계수를 재측정 전까지 의도적으로 "
    "미뤘다고 적어 두었다. 옥시미터 데이터가 생기면 <i>적용할 캘리브레이션 방법</i>으로 제시할 것.")

h2(f"A5.  L1 — 센싱을 고치기 위해 환경을 조작하는 것  "
   f"<font size='9' color='#5F5F5F'>신규성</font> {rating(2)} "
   f"<font size='9' color='#5F5F5F'>데모</font> {rating(4)}")
p("가장 잘 팔리는 기능이자 <b>가장 공격받기 쉬운 기능</b>이다 (C3·C4 참고). 아이디어로서는 "
  "잘 정립된 분야 — 능동 인지(active perception), 머신비전의 조명 제어 — 바로 옆에 있고, "
  "지금은 실기기 근거가 0 이다.")

h2(f"A6.  받쳐 주는 엔지니어링  {rating(1)}")
p("정직하게: 이것들은 <b>장인정신이지 독창성이 아니다.</b> 앞세우지 말 것.", "note")
bullets([
    "<font face='Mono' size='8.6'>core/registry.py</font> — config 기반 동적 로드. 어댑터·"
    "액추에이터·정책이 한 규칙을 따르고, 모든 실패를 흡수해 state 로 강등하므로 센서 하나가 "
    "죽어도 파이프라인이 멈추지 않는다.",
    "<font face='Mono' size='8.6'>core/sim_room.py</font> — mock 액추에이터의 불이 실제로 "
    "mock 조도를 올리고 그것이 신뢰도를 올리는 공유 가상 방. 하드웨어 없이 L1 루프를 닫는다.",
    "<font face='Mono' size='8.6'>quality.combine()</font> — 가중 <b>기하</b>평균이라 0 에 "
    "가까운 성분 하나를 평균으로 덮을 수 없고, 없는 성분은 0.5 로 채우는 대신 가중치 합에서 뺀다.",
    "구조로 만든 프라이버시 — 프레임을 숫자 3개로 줄이고 버린다. 미리보기는 보는 사람이 있을 "
    "때만 인코딩한다. 카메라 고장 시 마지막 프레임을 버려서 죽은 화면이 실시간인 척하지 못한다.",
    "테스트 148개. guest/member/admin 과 HttpOnly 쿠키 — 브라우저 WebSocket 이 헤더를 못 붙이기 "
    "때문에 고른 것.",
])

# ═══════════════════════════════════════════════════════════ B
h1("B", "신규성이 아닌 것")
p("심사위원이 말하기 전에 <b>먼저 말할 것.</b> 알려진 영역을 양보하는 것이 남은 주장을 "
  "믿게 만든다.")

table(
    ["구성 요소", "선행연구"],
    [["<font face='Mono' size='8.3'>rppg.py</font> 의 _pos()",
      "<b>POS</b> — Wang et al., IEEE TBME 2017. 교과서적 rPPG. CHROM(de Haan 2013), "
      "ICA(Poh 2010) 계보."],
     ["<font face='Mono' size='8.3'>quality.score()</font> 의 SQI 공식",
      "<b>HANDOFF.md §7 이 단국대 2025 논문 식 2.1~2.5 의 구현이라고 스스로 밝히고 있다.</b> "
      "발명이 아니라 재구현이다. 이것부터 말할 것."],
     ["rPPG 품질지수 · 게이팅 일반",
      "활발히 출판된 하위 분야. “rPPG 를 신호 품질로 게이팅한다”는 새 아이디어가 아니다."],
     ["열화상 콧구멍 호흡", "오래 정립된 서모그래피 기법."],
     ["Bland-Altman 보고", "Bland &amp; Altman 1986. 방법 일치도의 표준."],
     ["비접촉 활력징후 돌봄",
      "붐빈다 — Oxehealth(CE 인증, 카메라, 돌봄 현장), Binah.ai, Nuralogix Anura. "
      "레이더 쪽은 Vayyar Care, Google Nest Hub/Soli, MIT Emerald."],
     ["센서 임계값 기반 환경 자동화", "평범한 홈 오토메이션."],
     ["영상 개선을 위한 조명 조작",
      "능동 인지(Bajcsy 1988). 산업 머신비전에서 조명 제어는 일상적이다."]],
    [46, 122])

box("결론",
    "<b>측정 계층은 전적으로 파생물이고, 그렇지 않은 척하면 안 된다.</b> 신규성은 한 층 위 — "
    "루프, 계약, 정직성 규율 — 에서 논증해야 한다. 다행히 A1~A3 이 바로 거기에 있다.")
box("검토의 한계",
    "특허 조사와 체계적 문헌조사는 <b>수행하지 않았다.</b> 위 내용 중 어떤 것도 그런 조사 "
    "없이 공식 독창성 주장으로 제출하면 안 된다.", accent=BAD, bg=colors.HexColor("#FCF5F4"))

# ═══════════════════════════════════════════════════════════ C
h1("C", "신규성 주장에 대한 공격")
p("실제로 아플 것들.", "note")

h2("C1.  자체 검증 데이터가 게이팅 주장을 뒷받침하지 않는다 — 뒤집는다")
box("이 검토에서 가장 심각한 발견",
    "VALIDATION_PROTOCOL.md §0 은 <b>H2</b> 를 제품의 핵심으로 세운다 — “SQI 게이팅을 켜면 "
    "나쁜 구간이 제거되어 오차가 크게 준다”. §6 의 head_motion 합격 기준은 논문의 "
    "<font face='Mono'>13.4</font> &#8594; <font face='Mono'>2.89</font> 방향을 재현하는 것이다.",
    accent=BAD, bg=colors.HexColor("#FCF5F4"))

bad = f'<font color="{BAD_H}"><b>역전</b></font>'
good = f'<font color="{GOOD_H}"><b>작동</b></font>'
table(
    ["세션", "전체 MAE", "SQI&gt;=0.50", "SQI&lt;0.50", "게이팅 방향"],
    [["static1", "3.65", "3.65", "(n=0)", '<font color="#8C8C8C">비교 불가</font>'],
     ["static2", "5.21", "<b>4.94</b>", "7.27", good],
     ["static3", "7.95", "7.95", "(n=0)", '<font color="#8C8C8C">비교 불가</font>'],
     ["lighting1", "4.54", "4.59", "<b>4.13</b>", bad],
     ["headmotion1", "7.78", "8.08", "<b>7.15</b>", bad],
     ["headmotion1_raw", "13.99", "14.35", "<b>13.14</b>", bad]],
    [37, 26, 28, 26, 51], aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT"}, mono_cols=(0, 1, 2, 3),
    caption="출처 · legacy/tieng_rppg/validation/report/*/summary.csv (수정 없음)")

p("<b>비교 가능한 4개 세션 중 1개에서만 게이팅이 도움이 되고, 그것을 증명하려고 만든 바로 그 "
  "시나리오에서 실패한다.</b> head_motion 에서는 품질 미달 구간이 통과 구간보다 <i>더</i> "
  "정확하다 — SQI 가 제 몫을 해야 할 바로 그 자리에서 정확도와 역상관이다.")
p(f'<font color="{BAD_H}">summary.csv 를 여는 심사위원은 이것을 30초 안에 찾는다.</font> '
  "슬라이드가 “게이팅이 나쁜 구간을 제거한다”고 말하는데 저장소가 반대를 말하면, 제품 논지 "
  "전체인 정직성 포지셔닝이 그 자리에서 무너진다.")

h2("C2.  추정기가 자명한 상수 예측기를 못 이긴다")
p("기준 PR 시계열이 거의 움직이지 않는다 — 세션별 SD 약 2.1~5.4 bpm, head_motion 은 전 구간이 "
  "54~61 bpm 뿐이다. <b>참값이 거의 상수일 때 MAE 는 추정값이 고정된 숫자에서 얼마나 벗어나는지를 "
  "재는 것에 가깝다.</b> 퇴화된 비교다.")
p("“이 피험자의 평균 안정시 심박을 늘 출력한다”는 귀무모형과 다시 비교했다. 지연 탐색 ±5초, "
  "옥시미터 워밍업 20초 제외 — 문서화된 파이프라인과 동일하다. 카메라 MAE 가 보고된 값의 "
  "약 0.5 bpm 이내로 재현되므로 근사가 유효하다.")

win = f'<font color="{GOOD_H}"><b>이김</b></font>'
lose = f'<font color="{BAD_H}"><b>짐</b></font>'
table(
    ["세션", "기준 SD", "카메라 MAE", "상수 예측기 MAE", "판정"],
    [["static_r1", "5.33", "<b>3.21</b>", "4.35", win],
     ["static_r2", "5.43", "5.14", "<b>4.47</b>", lose],
     ["static_r3", "4.15", "7.82", "<b>3.57</b>", lose],
     ["lighting_r1", "3.13", "4.59", "<b>2.37</b>", lose],
     ["head_motion_r1", "2.11", "7.30", "<b>1.90</b>", lose]],
    [37, 24, 30, 36, 41], aligns={1: "RIGHT", 2: "RIGHT", 3: "RIGHT"}, mono_cols=(0, 1, 2, 3),
    caption="단위 bpm · 상수 예측기 = 해당 피험자의 평균 안정시 심박을 항상 출력")

p("<b>카메라가 “안정시 심박을 찍는다”를 이기는 것은 5개 중 1개다.</b> 프로토콜의 어떤 "
  "시나리오도 심박 변화를 유도하지 않으므로, 이 저장소에는 시스템이 심박을 <i>추적한다</i>는 "
  "근거가 — 그럴듯한 상수 근처에 떨어지는 것과 구별되는 의미에서 — 현재 없다.")
box("오해하지 말 것",
    "rPPG 가 고장났다는 뜻이 <b>아니다.</b> 설계된 실험이 그것이 작동함을 보일 수 없다는 뜻이다.")

h2("C3.  L1 의 성공 지표가 부분적으로 순환적이다")
code("q_brightness = 1.0 if 45 &lt;= brightness &lt;= 220 else 0.5<br/>W_BRIGHTNESS = 0.10")
p("밝기가 그 경계를 넘는 것만으로 <b>맥파 신호가 전혀 바뀌지 않아도</b> confidence 가 정확히 "
  "0.05 × q_motion 움직인다. L1 은 confidence &lt; 0.4 에서 발화하고 20초 뒤 confidence 를 다시 "
  "읽어 스스로를 검증한다. demo 게이트가 0.4 이므로, <b>0.36~0.40 에 있는 측정은 계단항만으로 "
  "선을 넘는다.</b>")
p("즉 개입이 자기 성공을 제조할 수 있다. 효과는 유계이고 치명적이지는 않지만, “불을 켰더니 "
  "신뢰도가 회복됐다”는 지금 깨끗한 인과 주장이 아니다.")
box("해결 — 그리고 싸다",
    "<font face='Mono'>Quality</font> 는 이미 모든 성분을 들고 있다. <b>q_snr 의 변화</b> — "
    "또는 q_brightness 를 고정한 채 재계산한 confidence — 를 L1 의 주 결과로 보고할 것. SNR 이 "
    "진짜로 개선되면 진짜 결과이고 훨씬 강한 이야기가 된다. "
    "<font face='Mono'>l1_light.evaluate()</font> 가 after 에 성분을 적어 넣기만 하면 된다.",
    accent=GOOD, bg=colors.HexColor("#F5FAF6"))

h2("C4.  시그니처 기능이 실기기에서 돈 적이 없다")
p("<font face='Mono' size='8.6'>sim_room.py</font> 는 L1 루프를 정직하게 닫고, docstring 은 "
  "live 어댑터가 여기를 쓰지 않는다고 명시한다. 그런데 그 말은 <b>시그니처 기능의 근거 전체가 "
  "mock 조명 &#8594; mock 조도 &#8594; mock 신뢰도</b>라는 뜻이다.")
p("실제 사슬 — Tuya 전구 &#8594; 실제 방 조도 &#8594; 실제 피부 조명 &#8594; 실제 rPPG SNR — 은 "
  "측정된 적이 없다. README §6 Phase 3 이 올바른 완료 기준을 세워 두었지만(“불을 끄면 시스템이 "
  "스스로 켜고 confidence 가 복구된다”) 충족되지 않았다. 그때까지 <b>L1 은 결과가 아니라 "
  "아키텍처다.</b> “실제 방에서 됐나요?”라는 질문에 시뮬레이터가 답이 되면 안 된다.")

h2("C5.  N=1, 단일 피부톤 — 이 공백은 다른 곳보다 이 논지에 더 위험하다")
p("VALIDATION_PROTOCOL.md §5 는 이미 N=1 과 Fitzpatrick 다양성을 권고로 표시해 두었다. "
  "레드팀 관점에서 왜 여기서 더 중요한지:")
p("rPPG 는 피부톤에 민감한 것으로 알려져 있다. 이 제품의 논지는 <b>정직한 보류</b>다. 게이트가 "
  "어두운 피부에서 체계적으로 더 자주 보류한다면, 시스템은 요란하게 실패하지 않는다 — "
  "<b>조용해지고, 조용함은 “괜찮음”으로 읽힌다.</b> 한 집단에 대해 조용한 미커버리지로 "
  "퇴화하는 안전장치는 신중함의 옷을 입은 형평성 실패다.")
p("마감 전에 고칠 수 없다. 알려진 한계이자 필수 후속 과제로 명시할 수는 있고, 그것이 "
  "정직하면서 방어적이다.", "note")

h2("C6.  두 갈래 품질 경로, 그중 하나는 문서화된 실패한 이관")
p("<font face='Mono' size='8.6'>core/quality.py</font> 는 <font face='Mono' size='8.6'>score()</font>"
  "(가시광 rPPG, 가중 산술평균)와 <font face='Mono' size='8.6'>score_signal()</font>(센서 중립, "
  "가중 기하평균)을 함께 들고 있다. HR 은 옛것을, RR/열화상은 새것을 쓴다. docstring 이 시도했던 "
  "이관과 되돌린 과정을, 정상적인 얼굴이 0.38~0.47 로 보류되는 비교표까지 붙여 문서화해 두었다.")
p("엔지니어링 정직성으로는 <b>모범적이다.</b> 다만 “센서 중립 품질 계층”이라는 프레이밍을 "
  "약화시킨다 — 그 통합은 설계됐고, 절반 지어졌고, 옥시미터 재측정에 막혀 있다. "
  "<b>성취가 아니라 아키텍처로 주장할 것.</b>")

h2("C7.  그 밖")
bullets([
    "<b>열화상은 전부 잠정이다.</b> <font face='Mono' size='8.6'>MIN_ROI_PIXELS = 4</font>, "
    "<font face='Mono' size='8.6'>MIN_DELTA_T = 0.5</font>, 32×24 좌표계에 고정된 "
    "<font face='Mono' size='8.6'>DEFAULT_NOSTRIL_ROI</font> 에 “※ 실장비가 없어 잠정값이다”가 "
    "붙어 있다. ROI 가 얼굴을 따라가지 않으므로 피험자가 한 자리에 있어야 한다. "
    "RR 을 작동하는 모달리티로 시연하면 과대주장이다.",
    "<b>README.md 가 UTF-16LE + CRLF 다.</b> 나머지 파일은 전부 UTF-8 이다. 대부분의 뷰어에서 "
    "깨져 보이고 diff 에서 바이너리로 잡힌다 (main 에서 <font face='Mono' size='8.6'>Bin 0 -&gt; "
    "20 bytes</font>). 심사위원이 저장소를 훑으면 <b>가장 먼저 여는 파일이 깨져 있다.</b> "
    "iconv 한 번이면 된다.",
    "<b>main 에 20바이트 README 하나뿐이다.</b> 모든 작업이 Thyun/Justin 에 있다. 저장소 루트를 "
    "가리키면 프로젝트가 비어 보인다.",
])

# ═══════════════════════════════════════════════════════════ D
h1("D", "방어 가능하게 만드는 법")
p("노력 대비 가치 순.", "note")

steps = [
    ("헤드라인 주장을 <b>정확도에서 보류로</b> 바꿀 것",
     "게이팅이 MAE 를 개선한다고 지금 주장할 수 없다 — 자체 데이터가 4개 중 3개에서 반대를 "
     "말한다. <b>정당화할 수 없는 값을 표시하지 않고, 모든 보류를 사유와 함께 남긴다</b>고는 "
     "주장할 수 있다. 그 주장은 코드가 완전히 뒷받침하고, 실제 제품 논지(HANDOFF.md §1)이며, "
     "A1~A3 이 전달하는 것이다."),
    ("<b>C1 을 슬라이드에 스스로 올릴 것</b>",
     "“논문의 게이팅 효과를 재현하려 했고 되지 않았다 — 데이터는 이렇고, 원인 가설은 N=1 · "
     "거의 상수인 기준값 · 다른 피험자에서 조정된 게이트다.” 자기 핵심 가설의 재현 실패를 "
     "보고하는 팀이, 유리한 부분집합만 조용히 내보내는 팀보다 훨씬 믿을 만하다. 가장 큰 "
     "취약점을 <b>팔고 있는 바로 그 규율의 시연</b>으로 바꾸는 방법이기도 하다."),
    ("<b>심박이 변하는 세션을 한 번 돌릴 것</b>",
     "가벼운 운동 후 앉아서 회복, 옥시미터를 낀 채 60~100 bpm 램프. 오후 한 나절이면 되고 "
     "프로젝트에서 빠진 <b>가장 값진 데이터</b>다. C2 에 답하는 유일한 방법이고, 보이는 추적 "
     "곡선은 어떤 오차표보다 나은 슬라이드다."),
    ("L1 효과 지표를 <b>분해할 것</b> (C3)",
     "confidence <b>변화</b>가 아니라 <b>q_snr 변화</b>를 보고한다. "
     "<font face='Mono' size='8.6'>l1_light.evaluate()</font> 의 작은 변경이고, 순환성 반론을 "
     "완전히 없앤다."),
    ("<b>L1 을 실제로 한 번 하고 찍을 것</b>",
     "등을 끔 &#8594; 신뢰도 하락 &#8594; 시스템이 불을 켬 &#8594; 신뢰도 회복, 옆에 CSV. "
     "그 영상이 발표 전체다. 그전까지 C4 는 유효하다."),
    ("README 인코딩을 고치고 main 에 무언가를 올릴 것",
     "10분."),
    ("<b>Part B 를 덱에서 먼저 양보할 것</b>",
     "한 줄이면 된다 — “POS 는 Wang 2017, SQI 는 [논문]의 우리 구현이다. 우리 것은 개입 루프와 "
     "보류 계약이다.” 가장 강한 공격, <b>남의 알고리즘을 자기 것처럼 주장하다 걸리는 것</b>을 "
     "예방한다."),
]
rows = [[f'<font face="Mono" color="#A8792F"><b>{i}</b></font>',
         f"<b>{t}</b><br/><font size='8.8' color='#4A4A4A'>{d}</font>"]
        for i, (t, d) in enumerate(steps, 1)]
table(["", "우선순위"], rows, [10, 158], aligns={0: "CENTER"})

# ═══════════════════════════════════════════════════════════ 판정
F.append(Spacer(1, 4))
h1("", "최종 판정")

verdict = [
    (BAD, "측정은 신규하지 않다",
     "POS, SQI 공식, 열화상 호흡, 비접촉 돌봄 모니터링은 전부 정립돼 있고, 그중 하나는 인용된 "
     "논문의 재구현이라고 <b>스스로 밝히고 있다.</b> 그렇게 주장해서는 안 된다."),
    (GOOD, "방어 가능하게 독창적인 것은 제어 · 안전 계층이다",
     "되돌림 가능성을 타입 계약으로 두고 되돌릴 수 없는 행동의 확인을 실행기가 강제하는 것"
     "<b>(A1)</b>, “아직 아님”과 “믿을 수 없음”을 가르는 progress/confidence 분리<b>(A2)</b>, "
     "발화하지 않은 결정을 일급 근거로 기록해 보류를 측정 가능하게 만드는 것<b>(A3)</b>. "
     "실재하고, 구현돼 있고, 테스트돼 있고, 이 프로젝트 밖으로 일반화된다."),
    (BAD, "경험적 주장은 현재 뒷받침되지 않는다",
     "게이팅은 비교 가능한 4개 중 3개에서 역전하고, 추정기는 5개 중 1개에서만 상수 예측기를 "
     "이기며, 시그니처 L1 은 시뮬레이터 상대로만 돌았고, 그 성공 지표는 부분적으로 자기충족적이다."),
]
for color, title, text in verdict:
    box(title, text, accent=color,
        bg=colors.HexColor("#F5FAF6") if color is GOOD else colors.HexColor("#FCF5F4"))

p("좋은 소식은 프로젝트 자체 문서 — HANDOFF.md §1·§5, VALIDATION_PROTOCOL.md §6 — 가 이미 이 "
  "대부분을 예상하고 <b>목표 미달이 실패가 아니라고</b> 적어 두었다는 것이다. 그 본능을 끝까지 "
  "밀 것: 아키텍처를 앞세우고, 재현 실패를 발견으로 보고하고, 심박이 변하는 세션 하나와 실기기 "
  "L1 시연 하나를 기록에 남길 것. 그 조합이 <b>지금 할 수 없는 정확도 주장보다 정직하면서도 "
  "상당히 더 설득력 있다.</b>", "lead")


# ═══════════════════════════════════════════════════════════ 렌더
def decorate(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(FAINT)
    canvas.setFont("Mono", 7.2)
    canvas.drawString(21 * mm, 12 * mm, "TIENG  ·  TouchFree Vitals")
    w = canvas.stringWidth("TIENG  ·  TouchFree Vitals", "Mono", 7.2)
    canvas.setFont("KR", 7.6)
    canvas.drawString(21 * mm + w + 7, 12 * mm, "—  신규성 · 독창성 레드팀 평가")
    canvas.setFont("Mono", 7.2)
    canvas.drawRightString(189 * mm, 12 * mm, f"{doc.page:02d}")
    canvas.setStrokeColor(RULE)
    canvas.setLineWidth(0.4)
    canvas.line(21 * mm, 15.5 * mm, 189 * mm, 15.5 * mm)
    canvas.setFillColor(GOLD_L)
    canvas.rect(0, 0, 4.5 * mm, A4[1], stroke=0, fill=1)
    canvas.restoreState()


doc = BaseDocTemplate(OUT, pagesize=A4, title="TIENG 신규성·독창성 레드팀 평가",
                      author="Red-team review", subject="TouchFree Vitals",
                      leftMargin=21 * mm, rightMargin=21 * mm,
                      topMargin=18 * mm, bottomMargin=20 * mm)
doc.addPageTemplates([PageTemplate(
    id="main",
    frames=[Frame(21 * mm, 20 * mm, 168 * mm, A4[1] - 38 * mm, id="f",
                  leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0)],
    onPage=decorate)])
doc.build(F)
print("built:", OUT)
