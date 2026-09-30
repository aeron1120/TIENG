"""Create the labelled data PDF from generated data, not fabricated measurements."""
from pathlib import Path
import json, re, hashlib
import numpy as np
import pandas as pd
from PIL import Image
from reportlab.pdfgen import canvas
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import Paragraph, Table, TableStyle

ROOT=Path(__file__).resolve().parent/'generated';D=ROOT/'data';F=ROOT/'figures'
OUT=ROOT/'output/pdf/ESP32_MPU6050_MODEL_분석보고서.pdf'
OUT.parent.mkdir(parents=True,exist_ok=True)
pdfmetrics.registerFont(TTFont('KR','C:/Windows/Fonts/malgun.ttf'))
pdfmetrics.registerFont(TTFont('KRB','C:/Windows/Fonts/malgunbd.ttf'))
pdfmetrics.registerFont(TTFont('DV','C:/Windows/Fonts/arial.ttf'))
pdfmetrics.registerFontFamily('KR',normal='KR',bold='KRB')
NAVY=colors.HexColor('#18334d');TEAL=colors.HexColor('#008795');GRAY=colors.HexColor('#627587')
RED=colors.HexColor('#ae473f');PALE=colors.HexColor('#eef4f7');LINE=colors.HexColor('#d0dde5')
W,H=A4;LEFT=44;WIDTH=W-88
c=canvas.Canvas(str(OUT),pagesize=A4,pageCompression=1)
c.setTitle('ESP32 MPU6050 헬멧 IMU 가상 실험 결과 분석 data')
c.setAuthor('TIENG - model analysis')
c.setSubject('SYNTHETIC data ONLY. No physical experiment. PDF summary anchored independent signals.')
s=pd.read_csv(D/'MODEL_summary_29.csv').set_index('scenario',drop=False)
tr=pd.read_csv(D/'MODEL_trials_145.csv');ass=json.loads((D/'assumptions.json').read_text())
ab=pd.read_csv(D/'MODEL_sensor_order_ablation.csv');rates=pd.read_csv(D/'MODEL_sampling_phase.csv')
y=0;page=0;minimum_y={}

def m(sid,col):return float(s.loc[sid,col])
def mean(sid,col):return float(tr.loc[tr.scenario==sid,col].mean())
def fmt(v,d=2):return '없음' if pd.isna(v) else f'{v:,.{d}f}'
def pm(sid,key,d=2):return f'{m(sid,key+"_mean"):.{d}f} ± {m(sid,key+"_std"):.{d}f}'
def prep(text):
    missing={ch for ch in text if ord(ch)>127 and ord(ch) not in pdfmetrics.getFont('KR').face.charToGlyph}
    for ch in missing:
        if ord(ch) not in pdfmetrics.getFont('DV').face.charToGlyph:
            raise ValueError('Missing glyph: '+repr(ch))
        text=text.replace(ch,f'<font name="DV">{ch}</font>')
    return text
def p(text,size=9.5,leading=15,color=NAVY,space=9,bold=False,width=WIDTH,x=LEFT):
    global y
    style=ParagraphStyle('p',fontName='KRB' if bold else 'KR',fontSize=size,leading=leading,
                         textColor=color,wordWrap='CJK',allowWidows=0,allowOrphans=0)
    obj=Paragraph(prep(text),style);_,h=obj.wrap(width,1000)
    obj.drawOn(c,x,y-h);y-=h+space
    if y<50:raise RuntimeError(f'Page {page} overflow y={y}: {text[:60]}')
def gap(h=6):
    global y;y-=h
def sub(text):p(text,11.1,17,TEAL,6,True)
def note(text):p(text,8.15,12,GRAY,8)
def start(title,large=False):
    global y,page
    page+=1;c.setFillColor(TEAL);c.setFont('KRB',8.8)
    c.drawString(LEFT,H-38,f'TIENG / model data / 2026.09.29 / {page:02d}')
    y=H-59
    p(title,22 if large else 17.5,31 if large else 26,NAVY,13,True)
def finish():
    minimum_y[page]=round(y,1)
    c.setStrokeColor(LINE);c.setLineWidth(.6);c.line(LEFT,38,W-LEFT,38)
    c.setFillColor(RED);c.setFont('KR',7.5);c.drawString(LEFT,25,'data · 실제 측정 아님 · 합성 데이터로 작성한 비교 연습용 보고서')
    c.setFillColor(GRAY);c.drawRightString(W-LEFT,25,f'{page} / 13');c.showPage()
def table(headers,rows,widths,size=8.4,leading=12.1):
    global y
    def cell(x,head=False):
        return Paragraph(prep(str(x)),ParagraphStyle('cell',fontName='KRB' if head else 'KR',fontSize=size,
            leading=leading,wordWrap='CJK',textColor=colors.white if head else NAVY))
    tb=Table([[cell(x,True) for x in headers]]+[[cell(x) for x in r] for r in rows],colWidths=widths)
    commands=[('BACKGROUND',(0,0),(-1,0),NAVY),('VALIGN',(0,0),(-1,-1),'TOP'),
     ('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),
     ('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7),
     ('LINEBELOW',(0,0),(-1,0),.8,TEAL),('LINEBELOW',(0,-1),(-1,-1),.5,LINE)]
    for i in range(1,len(rows)+1):
        if i%2==0:commands.append(('BACKGROUND',(0,i),(-1,i),PALE))
    tb.setStyle(TableStyle(commands));_,h=tb.wrap(WIDTH,1000);tb.drawOn(c,LEFT,y-h);y-=h+10
    if y<50:raise RuntimeError(f'Table overflow page {page}: {y}')
def fig(name,width=WIDTH):
    global y
    file=F/(name+'.png');iw,ih=Image.open(file).size;h=width*ih/iw
    c.drawImage(str(file),LEFT+(WIDTH-width)/2,y-h,width,h,mask='auto');y-=h+7
def cap(n,text):note(f'<b>Fig. {n}.</b> {text}')

# 1: The document is immediately self-identifying, not a purported real test report.
start('헬멧 IMU<br/>가상 실험 결과 분석',True)
p('ESP32 · MPU6050 | 시뮬레이션과 유사한 사건이 측정되었다는 가정',10.3,16,NAVY,13)
sub('1. 핵심 결과')
p('<b>아래 실험값은 전부 합성한 data 데이터입니다.</b> 실제 ESP32·MPU6050을 가동하거나 MuJoCo를 재실행하지 않았습니다. 제공 PDF의 29개 조건과 요약 수치를 참고해 새 파형을 만들고, 센서 범위·필터·잡음·기록 누락을 가정하여 계산했습니다.')
p('이 가정에서는 정상 조건의 신호 크기는 대체로 유지되지만, 큰 충격의 피크와 속도변화 추정은 작아집니다. 실제 실험에서는 <b>원래 충격이 달랐는지, 계측 과정이 달랐는지</b>부터 분리해 비교해야 합니다.')
note('Table 1. PDF의 시뮬레이션 요약 [SIM]과 이번 가상 결과 [data]. data은 5회 평균입니다.')
table(['비교 항목','PDF [SIM]','가상 센서 [data]'],[
 ['A1 합성 가속도 피크','203.7g',f'{m("A1","data_peak_g_mean"):.2f}g'],
 ['A4 합성 가속도 / 각속도','240.8g / 2,755°/s',f'{m("A4","data_peak_g_mean"):.2f}g / {m("A4","data_peak_dps_mean"):,.0f}°/s'],
 ['D6 정상 연석 응답','3.5g / 314°/s',f'{m("D6","data_peak_g_mean"):.2f}g / {m("D6","data_peak_dps_mean"):.0f}°/s'],
 ['D5 최대 추정 ΔV','0.206m/s',f'{m("D5","data_dv_est_peak_mps_mean"):.3f}m/s'],
 ['분석 분량','29개 기본 실행','29조건 × 가상 5회 = 145실행'],
], [161,153,WIDTH-314])
sub('이번 보고서에서 구분하는 세 종류의 수치')
p('<b>[SIM]</b> 제공 PDF에서 옮긴 결과입니다. 원본 CSV의 재분석값이 아닙니다.<br/><b>[data]</b> 독립 합성 신호와 가상 계측 처리에서 계산한 값입니다.<br/><b>[가정]</b> 잡음·잔류 바이어스·반복 변동·통신 지연 등 임의로 정한 입력입니다.')
note('정상 45회에서 후보가 없고 사고 라벨 85회에서 후보가 발생한 것은 합성 신호와 규칙의 관계입니다. 실제 검출률, 오경보율, 신뢰구간 또는 소자 성능의 근거로 사용하지 않습니다.')
finish()

# 2: Proposed device setup is distinct from empirical results.
start('2. 장치와 기록 조건')
p('비교 위치는 원본 PDF와 같은 <b>헬멧 뒤쪽 중앙</b>으로 가정했습니다. 기판 좌표를 모델의 헬멧 좌표로 변환한 뒤 비교합니다. 앞서 제안한 측면 장착 외형을 실제로 사용하면 측정 위치가 바뀌므로 별도 조건으로 기록해야 합니다. [1, p.2]')
note('Table 2. 실험에 적용할 초기 설정안. 실제 기기의 설정 완료를 뜻하지 않습니다. [2, 3]')
table(['항목','설정안','의미'],[
 ['가속도','AFS_SEL=3 / ACCEL_CONFIG 0x18','축별 ±16g, 2,048 LSB/g'],
 ['자이로','FS_SEL=3 / GYRO_CONFIG 0x18','축별 ±2,000°/s, 16.4 LSB/(°/s)'],
 ['기록률','SMPLRT_DIV=0 / DLPF_CFG=2','가속도·자이로 출력 1kHz 기준'],
 ['내부 필터','CONFIG=0x02','제조사 표: 가속도 94Hz / 3.0ms, 자이로 98Hz / 2.8ms'],
 ['전원 상태','PWR_MGMT_1=0x01','슬립 해제, X축 자이로 PLL 기준 선택'],
 ['통신','ESP32 I²C 400kHz 제안','SDA GPIO21 / SCL GPIO22; 실제 보드에서 확인'],
 ['저장','FIFO 또는 DATA_RDY 활용','가속도·자이로 12바이트/샘플; 온도·시각·순번은 추가 관리'],
 ['부착·보정','고정 지그, 정지 기록 및 축 확인','실물 질량·축·온도·고정법은 실측 메타데이터로 남김'],
],[70,193,WIDTH-263],8.5)
sub('기록률과 전송률은 같은 개념이 아닙니다')
p('MPU6050의 가속도 출력은 1kHz이므로 더 자주 읽어도 새로운 가속도 샘플이 늘어나는 것은 아닙니다. 내부 1,024바이트 FIFO에 가속도·자이로만 넣으면 85개 완전한 프레임, 1kHz에서 약 85ms 분량입니다. 온도를 포함하면 73개로 줄어듭니다. 여유를 두고 비워야 합니다. [2, 3]')
p('예를 들어 24바이트 패킷을 초당 1,000개 전송하면 24kB/s입니다. UART 8N1의 최소 전송률은 240kbps이므로 115,200bps로는 부족합니다. 초기안은 바이너리 기록과 921,600bps이며, 이는 실효 기록률을 보장하는 설정이 아닙니다.')
note('MPU6050 자체의 샘플별 고유 타임스탬프를 읽는 구조로 가정하지 않았습니다. ESP32의 DATA_RDY 시각 또는 FIFO 순번과 검증한 주기로 시각을 구성하고, 호스트 수신 시각을 별도로 남기는 방식입니다.')
finish()

# 3: Full provenance and real model assumptions.
start('3. 가상 데이터 생성 방법')
p('입력은 제공 PDF의 반올림된 피크·150ms ΔV·후보 시각 요약입니다. 3축 원본 파형, 원본 자세 추정기 코드, 세부 충돌 입력은 제공되지 않았으므로 <b>원본 MuJoCo 파형에 MPU6050 필터를 적용한 결과라고 볼 수 없습니다.</b>')
note('Table 3. 이번 계산에만 사용한 가정. 소자의 제조사 보증값이나 실측 잡음값이 아닙니다.')
table(['구분','가정 또는 처리'],[
 ['파형','충격은 좁은 Gaussian + 넓은 Gaussian, 회전은 완만한 각속도 펄스. D5는 별도 선회 궤적'],
 ['반복 변동','조건별 5회. 가속도 진폭 SD 2.5%, ΔV 추가 배율 SD 3%, 각속도 진폭 SD 2%'],
 ['편향·잡음','잔류 편향 SD: 0.004g / 0.15°/s. 필터 전 백색잡음 SD: 0.018g / 0.75°/s. 축 이득 SD 0.8%'],
 ['센서 근사','4kHz로 합성 → 축 제한 → 1차 저역통과 94/98Hz → 추가 지연 1.3/1.2ms → 1kHz → int16 양자화'],
 ['시간·누락','ESP 시각 지터 SD 25μs, 샘플 무작위 누락 확률 0.1%. 수신 지연 평균 12ms, SD 4ms, 최소 2ms'],
 ['재현 조건','난수 seed 20260930. 1회 6초, D5만 9초. 145개 합계 885초'],
],[87,WIDTH-87],8.8)
sub('필터의 대역폭만 맞춘 근사 모델')
p('1차 필터와 추가 지연은 문서의 대역폭·지연을 참고한 단순 근사입니다. 실제 MPU6050의 정확한 주파수 응답, 과입력 회복, 아날로그 포화, 온도 특성은 재현하지 않았습니다. <b>클리핑과 필터의 순서</b>도 가정이므로 8쪽에서 반대 순서와 비교합니다.')
sub('합성 입력의 참조값')
p('입력 위치의 선형가속도와 자세를 함께 만들었습니다. specific force는 f = Rᵀ(a − g)로 구성하므로 정지 시 약 1g입니다. 합성 입력 참조 ΔV는 세계좌표 가속도를 적분한 속도벡터 차이입니다. 이것은 가상 세계에서만 알 수 있는 값이며, 실험에서는 독립 기준기가 필요합니다.')
note('D5는 정상 선회의 구조적 모호성을 보여주는 별도 궤적입니다. 다른 조건도 원본 사건 전체를 재현하지 않으며, 피크와 짧은 창 속도변화가 비슷한 대표 이벤트입니다. 시각 비교의 출발점은 11쪽에서 따로 정의합니다.')
finish()

def result_table(ids,number):
 note(f'Table {number}. SIM은 PDF 요약, data은 5회 평균 ± 표본 SD입니다. ΔV의 두 열은 참조값과 추정값으로 성격이 다릅니다.')
 rows=[]
 for sid in ids:
  row=s.loc[sid]
  rows.append([f'<b>{sid}</b> {row["name"]}',f'{row.sim_peak_g:.1f}',pm(sid,'data_peak_g',2),
       f'{row.sim_dv_true_mps:.2f}',f'{row.data_dv_est_peak_mps_mean:.2f}',
       f'{row.data_peak_dps_mean:.0f}',f'{int(row.candidate_count)}/5'])
 table(['조건','SIM<br/>피크 g','data<br/>피크 g','SIM<br/>참조 ΔV','data<br/>추정 ΔV','data<br/>°/s','후보'],rows,
      [142,43,90,57,66,59,WIDTH-457],8.0,11.6)

# 4: 12 rows.
start('4. 가상 결과표 차대차와 도심 접촉')
result_table(list(s.index[:12]),4)
sub('피크가 작아져도 사건이 약해졌다는 뜻은 아닙니다')
p(f'A1의 data 합성 피크는 {pm("A1","data_peak_g",2)}g입니다. PDF의 203.7g보다 표시값이 약 {100*(1-m("A1","data_peak_g_mean")/203.7):.1f}% 낮지만, 이를 센서 정확도 오차율로 해석하지 않습니다. 입력도 별도로 합성했고, 측정 범위 밖 성분을 잃는 모델이기 때문입니다.')
p(f'A4의 합성 각속도는 평균 {m("A4","data_peak_dps_mean"):,.0f}°/s입니다. 축별 범위가 ±2,000°/s여도 3축 합성값은 2,000°/s를 넘을 수 있습니다. 한 축의 포화 여부와 합성 피크를 구분해야 합니다.')
note('ΔV 단위는 m/s, 후보는 가상 5회 중 발생 횟수입니다. 각 열은 서로 다른 시각의 최대값일 수 있습니다. B5는 경계 조건이며 사고 누락이나 정상 성공으로 묶지 않았습니다. [1, pp.4, 9]')
finish()

# 5: 17 rows. Compact enough without tiny text.
start('5. 가상 결과표 차량단독과 정상 조건')
result_table(list(s.index[12:]),5)
p('C5는 원본에서 사고가 미재현된 조건이므로 검출 성능 평가에서 제외합니다. C9는 저속 전도 경계 조건이며 이번 가상 입력에서는 5회 모두 후보가 발생했습니다. C8은 원본 결과가 없어 만들지 않았습니다.',9.1,14,space=7)
p(f'D6의 각속도는 평균 {m("D6","data_peak_dps_mean"):.0f}°/s로 300°/s를 넘지만 가속도는 {m("D6","data_peak_g_mean"):.2f}g여서 복합 후보 규칙은 켜지지 않았습니다. 정상 머리 동작·헬멧 탈착·책상 위 놓기는 이 표에 포함되지 않습니다.',9.1,14,space=7)
note('원본 시나리오명은 비교 식별자입니다. 실제 과속방지턱·연석·충돌 주행을 수행했다는 기록 또는 이를 재현하라는 지시가 아닙니다. [1, pp.5, 12]')
finish()

# 6.
start('6. 조건별 분포와 해석')
fig('distribution')
cap(1,'회색은 원본 PDF의 시뮬레이션 요약, 청록색은 가상 5회 평균과 표본 SD입니다. 세로축은 로그 축이며 D1의 작은 각속도에서는 잡음 바닥의 상대 영향이 큽니다.')
groups=[]
for cls,label in [('accident','사고 라벨 C5 제외'),('normal','정상 D1~D9'),('boundary','경계 B5 / C9')]:
 q=s[s['class']==cls];groups.append([label,f'{q.data_peak_g_mean.min():.2f}~{q.data_peak_g_mean.max():.2f}',
   f'{q.data_peak_dps_mean.min():.0f}~{q.data_peak_dps_mean.max():.0f}',f'{int(q.candidate_count.sum())}/{len(q)*5}'])
note('Table 6. 가상 조건별 평균 피크의 범위. 실제 운행 모집단의 분포가 아닙니다.')
table(['집단','가속도 g','각속도 °/s','가상 후보'],groups,[169,115,121,WIDTH-405])
p('큰 충격 조건의 가속도는 센서 범위와 필터에 의해 비슷한 구간으로 모입니다. 따라서 <b>포화된 가속도 피크의 순서로 사고 심각도를 매기면 안 됩니다.</b> 정상과 사건 후보의 구분 가능성, 피크의 정확한 재현, 상해 위험 추정은 서로 다른 검증 문제입니다.')
note('반복 SD에는 임의로 준 입력 진폭·ΔV 변동까지 섞여 있습니다. 이 SD는 MPU6050 반복정밀도, 실험실 오차 또는 현실의 예상 신뢰구간을 뜻하지 않습니다.')
finish()

# 7.
start('7. 대표 시계열 충격과 정상 입력')
fig('waveforms')
cap(2,'A1·A4·D6의 가상 1회차. 회색도 새로 합성한 입력이며 원본 MuJoCo 시계열이 아닙니다. 적색 점선은 가상 후보 최초 시각, A1·A4 가속도는 로그 축입니다.')
p('A1에서는 좁은 고가속도 성분이 제한되고 완만해집니다. A4는 가속도뿐 아니라 자이로의 한 축도 범위를 넘어 자세 적분에 영향을 줍니다. D6는 각속도가 300°/s를 넘더라도 충격 기준 6g를 만족하지 않습니다.')
note('필터는 파형을 낮추는 동시에 시간 위치도 바꿉니다. 실제 비교에서는 같은 좌표·대역폭·창 길이를 맞춘 다음, 독립 사건 기준에 대한 지연과 파형 정렬 후 오차를 분리해 계산해야 합니다.')
finish()

# 8.
start('8. 포화와 필터의 영향을 분리하기')
p('축별 ±16g는 합성값을 16g에서 잘라야 한다는 뜻이 아닙니다. 3축을 각각 제한하면 합성 상한은 16√3 ≈ <b>27.71g</b>입니다. 먼저 합성한 뒤 16g에서 자르는 방법은 다른 계측 모델입니다.')
fig('ablation')
cap(3,'A1 가상 1회차의 동일 입력에서 처리 순서만 비교했습니다. 실제 칩 내부의 과입력 전달함수를 확인한 결과가 아닙니다.')
note('Table 7. 동일 1kHz 격자에서 계산한 합성 피크(g). 무제한 필터 열은 비현실적인 중간 계산값입니다.')
table(['조건','입력','축 제한만','무제한 필터','제한→필터','필터→제한'],
 [[r.scenario]+[f'{r[k]:.2f}' for k in ['latent','clip_only','filter_only','clip_filter','filter_clip']] for _,r in ab.iterrows()],
 [49,81,90,99,96,WIDTH-415],8.5)
sub('레일 검출과 내부 과입력은 다릅니다')
p(f'145개 가상 실행 중 입력 가속도가 ±16g를 넘은 실행은 {ass["summary"]["input_acc_overrange_runs"]}개지만, 필터 후 출력의 근접 레일(|raw| ≥ 32760)이 검출된 실행은 0개입니다. 이 차이는 <b>클리핑 후 필터</b>라는 가정의 결과입니다.')
p('따라서 실험에서 “최대 코드값이 없다”는 사실만으로 선형 범위 내 측정이라고 확정하지 않습니다. 반대로 가상 데이터의 내부 과입력 정답 열은 실제 MPU6050에서 직접 읽을 수 있는 플래그가 아닙니다.',9.2,14)
finish()

# 9.
start('9. 기록 간격 누락과 낮은 기록률')
fig('timing')
cap(4,'왼쪽은 가상 1회차 29개 실행의 ESP 시각 간격입니다. 오른쪽은 이미 필터된 1kHz data 출력을 간격 추출한 최악 위상 결과이며 실제 낮은 ODR 설정을 모사한 값은 아닙니다.')
q=ass['summary'];loss=100*q['dropped_samples']/q['expected_samples']
p(f'145회에서 기대 샘플 {q["expected_samples"]:,}개 중 {q["received_samples"]:,}개를 남기고 {q["dropped_samples"]:,}개({loss:.3f}%)를 가상으로 누락시켰습니다. 시각은 단조 증가하며, 누락은 packet_seq의 불연속으로 구분했습니다. 1kHz 설정값과 초당 정상 저장 개수는 다를 수 있습니다.')
note('Table 8. 각 조건에서 모든 시작 위상을 검사한 최저 보존율. 일반적인 평균 손실률이 아닙니다.')
table(['기록률','조건별 최저의 중앙값','전체 최저','최저 조건'],
 [[f'{r.rate_hz}Hz',f'{r.median_worst_phase_percent:.1f}%',f'{r.minimum_worst_phase_percent:.1f}%',r.worst_scenario] for _,r in rates.iterrows()],
 [86,185,128,WIDTH-399])
p('원본 PDF의 무필터 파형과 여기의 필터된 파형은 보존율이 다릅니다. 500Hz에서 보존율이 높아졌다고 해서 500Hz가 항상 충분하다는 뜻은 아닙니다. 실제 다운샘플링에는 안티앨리어싱 처리가 필요하며, 위 표는 기록 시점 선택의 영향만 본 진단 계산입니다.')
note('ΔV는 실제 가상 타임스탬프에 따라 사다리꼴 적분했습니다. 최초 150ms와 누락 순번을 가로지르는 창은 NaN으로 유지했으며 0으로 채우지 않았습니다. 수신 지연은 별도 값이며 샘플 간격에 섞지 않았습니다.')
finish()

# 10.
start('10. 자세 오차가 속도변화 추정에 미치는 영향')
fig('attitude')
cap(5,'D5 가상 1회차. 황색은 가상 참조 자세를 알고 있다고 두었을 때의 적분값으로, 실제 6축 센서만으로 얻을 수 있는 결과가 아닙니다. 빈 구간은 ΔV 무효 창입니다.')
note('Table 9. D5 가상 5회의 지표 평균. 각 최대값은 서로 다른 시각일 수 있습니다.')
table(['지표','PDF [SIM]','이번 [data]'],[
 ['참조 / 추정 ΔV 최대','0.566 / 0.206m/s',f'{mean("D5","data_dv_true_peak_mps"):.3f} / {mean("D5","data_dv_est_peak_mps"):.3f}m/s'],
 ['추정 ΔV RMSE','0.323m/s',f'{mean("D5","data_dv_rmse_mps"):.3f}m/s'],
 ['헬멧 뱅크각 평균 절대오차','14.25°',f'{mean("D5","data_bank_mae_deg"):.2f}°'],
 ['헬멧 뱅크각 최대 절대오차','19.66°',f'{mean("D5","data_bank_max_error_deg"):.2f}°'],
],[195,151,WIDTH-346],8.5)
p('정상 선회에서도 원심·구심 운동에 따른 가속도와 중력을 6축 IMU만으로 완전히 구분하기 어렵습니다. 가속도 보정이 기울기를 잘못 당기면 중력 제거와 적분값이 함께 틀어집니다. 원본과 이번 추정기는 동일 코드가 아니므로 표의 유사성은 원본 재현 검증이 아닙니다.')
note('data RMSE는 t≥0.15s 중 누락 없는 유효 창에서 계산했고 필터 지연을 보상하지 않았습니다. A4의 최대 3차원 자세 오차는 가상 5회 평균 '+f'{mean("A4","data_pose_error_max_deg"):.1f}°'+ '이며, Euler 뱅크각 오차와 다른 지표입니다.')
finish()

# 11.
start('11. 후보 판정과 시각을 해석하는 방법')
p('<b>원본의 초기 후보 규칙</b><br/>t ≥ 0.15s, 최근 0.5s 안에서<br/>가속도 ≥ 6g AND (각속도 ≥ 300°/s OR 추정 ΔV ≥ 3m/s OR |추정 뱅크각| ≥ 45°).<br/>같은 샘플에서 동시에 넘을 필요는 없으며, 후보 발생 후에는 실행 끝까지 유지합니다. [1, p.9]')
note('Table 10. 규칙을 합성 데이터에 적용한 결과. 분류 정확도 표가 아닙니다.')
table(['구분','PDF 결과','가상 반복 결과','해석'],[
 ['사고 라벨 C5 제외','17/17','85/85','17조건 × 5회 모두 후보'],
 ['정상 D1~D9','0/9','0/45','정상 가상 기록 총 285초'],
 ['B5 경미 접촉','없음','0/5','경계 조건으로 유지'],
 ['C9 저속 전도','있음','5/5','경계 조건으로 유지'],
 ['C5 미재현','없음','0/5','성능 평가 제외'],
],[142,97,113,WIDTH-352])
sub('두 시각의 차이를 무조건 검출 지연이라고 부르지 않습니다')
p('이번 data에서는 “합성 펄스 중심 150ms 전”을 외부 트리거로 가정했습니다. 이는 원본의 실제 첫 접촉 시각이나 라이더 지면 접촉 시각이 아닙니다. C1 등에서도 이 가상 정의를 썼으므로 원본 23~208ms와 직접 비교할 수 없습니다.')
found=tr[tr.candidate]
p(f'이 트리거 기준 후보 지연은 {found.data_sensor_latency_ms.min():.1f}~{found.data_sensor_latency_ms.max():.1f}ms이고, 가상 수신 지연까지 포함하면 {found.data_receiver_latency_ms.min():.1f}~{found.data_receiver_latency_ms.max():.1f}ms입니다. 두 값 모두 입력 시각·통신 지연 가정을 바꾸면 달라집니다.')
sub('5회 전부 검출되어도 검증이 끝난 것은 아닙니다')
p('입력 피크와 펄스 형태를 기존 사건에 가깝게 만든 자료이므로 후보가 잘 분리되는 것은 놀라운 결과가 아닙니다. 실측에서는 일상 동작과 다른 부착 상태를 추가하고, 임계값 조정 자료와 평가 자료를 분리해야 합니다. 이번 data을 목표 정답으로 삼아 실측 파형을 억지로 맞추지 않습니다.')
note('무동작 확정, 상담원 판단, 주문 처리, 실제 긴급 통신은 모델링하지 않았습니다. 후보 판정은 최종 사고 판정이나 자동 구조 요청의 성공률을 뜻하지 않습니다.')
finish()

# 12.
start('12. 실측을 얻은 뒤 차이를 분해하는 순서')
note('Table 11. 이번 보고서를 실제 분석에 사용하는 비교 기준.')
table(['차이의 원인','관찰되는 양상','실제 확인 방법'],[
 ['측정 범위','큰 충격 피크가 비슷한 값으로 모임; ΔV 과소 가능','축별 raw·근접 레일 확인, 독립 고범위 기준 센서로 과입력 검토'],
 ['필터·기록률','피크 감소·지연·폭 증가 또는 샘플 위치별 피크 변동','설정 레지스터 읽기, 같은 대역 처리, DATA_RDY·순번·FIFO overflow 기록'],
 ['장착 위치·축','특정 축 부호와 피크 비율 변화; 머리 회전 시 차이 확대','회전행렬·위치 오프셋·체결 강성·장치 질량 기록'],
 ['자세·중력 제거','선회에서 기울기 편향, 정지 전후 적분 드리프트','영상·엔코더 등 독립 자세/속도 기준과 비교'],
 ['물리 입력·모델','범위 내에서도 파형·접촉 시간이 다름','실제 속도·노면·완충재·목 운동·충격 입력과 모델 조건 비교'],
],[85,174,WIDTH-259],8.7)
sub('정의부터 맞춰서 계산합니다')
p('특이력 f를 세계좌표로 돌리고 중력을 더해 a = Rf + g로 복원합니다. 150ms 동안 a를 벡터 적분한 뒤 크기를 구하며, ||f||−1g를 적분하지 않습니다. 피크 오차율은 같은 입력·같은 대역·비포화 조건에서만 정확도 비교로 해석합니다.')
p('작은 자세 오차 θ가 만드는 중력 누설의 크기는 대략 g·θ입니다. 10° 오차가 일정하게 150ms 지속되면 약 0.26m/s의 가짜 속도변화를 만들 수 있습니다. 이는 단순 규모 추정이며 오차 방향 변화와 신호 상쇄를 생략한 값입니다.')
p('측정 위치 차이는 aP = aO + α×r + ω×(ω×r)로 연결됩니다. 수직한 위치 차이를 5cm로 가정하면 314°/s에서 구심 항은 약 0.15g, 1,437°/s에서는 약 3.2g입니다. 실제 전체 차이에는 각가속도·회전축·고정 부위 변형도 포함됩니다.')
sub('실측으로 교체할 칸')
p('동봉한 actual_comparison_template.csv에 실측 피크, 누락 수, 기록 시간, 후보 시각과 독립 기준 ΔV를 입력합니다. 독립 기준이 없으면 참조 ΔV와 그 오차는 비워 두고 IMU 추정값만 보고합니다. 충격·전도 검증은 사람에게 재현하지 않고 적합한 지그·더미·시험 장비 범위에서 설계합니다.',9.2,14)
finish()

# 13.
start('13. 한계 출처와 재현 자료')
sub('이 보고서가 검증하지 않은 것')
p('실물 소자 품질, 복제품 여부, ESP32 펌웨어 처리율, 실제 배터리·케이스·부착 질량, 온도 드리프트, 헬멧 쉘·완충재·목의 운동, 실제 사고 검출률을 검증하지 않았습니다. 모델의 정규 잡음과 고정 필터는 이 요인을 대신하지 못합니다.')
p('클리핑→필터 순서와 1차 필터는 명시적 가정입니다. 다른 전달함수라면 8쪽의 비선형 왜곡과 출력 레일 결과가 달라집니다. 원본 3축 CSV를 받으면 같은 축 변환과 센서 처리를 직접 적용해 현재의 독립 합성 입력을 대체해야 합니다.')
sub('참고한 자료')
note('[1] 사용자 제공 「헬멧_IMU_시뮬레이션_분석_실험참고.pdf」, 2026-09-30, 13쪽. 조건·단위 p.2, 29개 요약 pp.4-5, 포화 p.7, 규칙 p.9, D5 비교 p.10. 원본 CSV와 해당 PDF의 내부 파일은 이번 작업에서 열람하지 않았습니다.')
note('[2] InvenSense, MPU-6000 and MPU-6050 Register Map and Descriptions, Rev.4.0, 2012-03-09, pp.11-15, 30-32. 제조사 원문을 SparkFun 보관본으로 열람.<br/><link href="https://cdn.sparkfun.com/datasheets/Sensors/Accelerometers/RM-MPU-6000A.pdf" color="#008795">cdn.sparkfun.com · RM-MPU-6000A.pdf</link>')
note('[3] InvenSense, MPU-6000 and MPU-6050 Product Specification, Rev.3.4, 2013-08-19, pp.7, 11-14, 29-31. 제조사 원문을 CDI 보관본으로 열람.<br/><link href="https://www.cdiweb.com/datasheets/invensense/mpu-6050_datasheet_v3%204.pdf" color="#008795">cdiweb.com · MPU6050 Product Specification</link>')
note('[4] Espressif, ESP32 I²C 및 Arduino-ESP32 I²C 공식 문서, 2026-09-29 확인.<br/><link href="https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/peripherals/i2c.html" color="#008795">ESP-IDF I²C</link> / <link href="https://docs.espressif.com/projects/arduino-esp32/en/latest/api/i2c.html" color="#008795">Arduino-ESP32 I²C</link>')
sub('동봉 파일')
table(['파일','내용'],[
 ['MODEL_trials_145.csv / MODEL_summary_29.csv','145회 개별 지표 / 29조건 평균과 표본 SD'],
 ['MODEL_*_repeat1.npz','29조건 1회차의 합성 참조·센서 출력·추정값'],
 ['대표 5조건 data CSV','A1·A4·C9·D5·D6의 raw 및 단위 환산값'],
 ['assumptions.json / verification.json','가정·설정·난수 seed / 데이터 일관성 확인'],
 ['generate_synthetic.py / make_synthetic_figures.py','합성 데이터와 그래프 재생성 원본'],
],[219,WIDTH-219],8.2,11.9)
note('실제 수행한 확인: 145실행·29조건 수, int16 및 합성 상한, 기대/수신/누락 샘플 합계, 시각 단조 증가, 최초 150ms 무효 처리. 보고서의 수치는 저장한 합성 파일에서 계산했습니다. 모든 반복의 파형은 코드로 다시 생성할 수 있습니다.')
finish()
assert page==13
c.save()
print(str(OUT));print('PAGE_BOTTOMS',minimum_y)
