"""Report supplied experiment records; preserve reference-provenance distinctions."""
from pathlib import Path
import argparse, json
from xml.sax.saxutils import escape
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from reportlab.lib.pagesizes import A4
from reportlab.lib import colors
from reportlab.lib.styles import ParagraphStyle
from reportlab.platypus import SimpleDocTemplate, Paragraph, Table, TableStyle, Spacer, PageBreak, Image
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

ROOT=Path(__file__).resolve().parent;D=ROOT/'data';F=ROOT/'figures'
ap=argparse.ArgumentParser();ap.add_argument('--output',type=Path,default=ROOT/'output/pdf/ESP32_MPU6050_데이터_분석보고서.pdf');args=ap.parse_args()
font=next(p for p in [Path('C:/Windows/Fonts/malgun.ttf'),Path('/usr/local/share/fonts/nanum/NanumGothic-Regular.ttf')] if p.exists())
bold=next((p for p in [Path('C:/Windows/Fonts/malgunbd.ttf'),Path('/usr/local/share/fonts/nanum/NanumGothic-Bold.ttf')] if p.exists()),font)
pdfmetrics.registerFont(TTFont('KR',str(font)));pdfmetrics.registerFont(TTFont('KRB',str(bold)))
pdfmetrics.registerFontFamily('KR',normal='KR',bold='KRB')
font_manager.fontManager.addfont(str(font));plt.rcParams.update({'font.family':font_manager.FontProperties(fname=str(font)).get_name(),'axes.unicode_minus':False,'font.size':9,'axes.spines.top':False,'axes.spines.right':False})
tr=pd.read_csv(D/'REAL_trials_145.csv');s=pd.read_csv(D/'REAL_summary_29.csv').set_index('scenario')
ab=pd.read_csv(D/'ANALYSIS_sensor_order_ablation.csv');rates=pd.read_csv(D/'ANALYSIS_sampling_phase.csv')
ids=list(s.index);received=int(tr.samples_received.sum());missing=int(tr.missing_count.sum());expected=int(tr.samples_expected.sum())
invalid=int((tr.dv_invalid_fraction*tr.samples_received).round().sum())
NAVY='#18334D';TEAL='#087F8C';GRAY='#64798D';PALE='#EFF5F7'
W,H=A4;M=43;WIDTH=W-2*M;story=[]
styles={k:ParagraphStyle(k,fontName='KRB' if k in ['title','h1','h2','head','label'] else 'KR',fontSize=size,leading=leading,textColor=colors.HexColor(color),wordWrap='CJK',spaceAfter=space) for k,size,leading,color,space in [
 ('body',9.4,15,NAVY,8),('small',8,12,GRAY,7),('title',24,33,NAVY,16),('h1',17,24,NAVY,13),('h2',11,17,TEAL,8),('head',8,12,'#FFFFFF',0),('cell',8,12,NAVY,0),('label',8.2,12,TEAL,9)]}
def p(text,style='body'):return Paragraph(text,styles[style])
def add(text,style='body'):story.append(p(text,style))
def section(n,title):
 if story:story.append(PageBreak())
 add(f'ESP32 · MPU6050  /  실험 자료 분석  /  {n:02d}','label');add(title,'h1')
def table(head,rows,widths):
 def c(v,head=False):return p(escape(str(v)).replace('\n','<br/>'),'head' if head else 'cell')
 t=Table([[c(v,True) for v in head]]+[[c(v) for v in row] for row in rows],colWidths=widths,repeatRows=1)
 t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),colors.HexColor(NAVY)),('ROWBACKGROUNDS',(0,1),(-1,-1),[colors.white,colors.HexColor(PALE)]),('VALIGN',(0,0),(-1,-1),'TOP'),('LEFTPADDING',(0,0),(-1,-1),7),('RIGHTPADDING',(0,0),(-1,-1),7),('TOPPADDING',(0,0),(-1,-1),6),('BOTTOMPADDING',(0,0),(-1,-1),6),('LINEBELOW',(0,-1),(-1,-1),.4,colors.HexColor('#C8D5DF'))]))
 story.extend([t,Spacer(1,9)])
def box(text):
 t=Table([[p(text)]],colWidths=[WIDTH]);t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,-1),colors.HexColor('#EAF4F4')),('BOX',(0,0),(-1,-1),.5,colors.HexColor('#C5DFDF')),('LEFTPADDING',(0,0),(-1,-1),11),('RIGHTPADDING',(0,0),(-1,-1),11),('TOPPADDING',(0,0),(-1,-1),10),('BOTTOMPADDING',(0,0),(-1,-1),8)]));story.extend([t,Spacer(1,10)])
def pic(name):
 im=Image(str(F/name));iw,ih=im.imageWidth,im.imageHeight;im.drawWidth=WIDTH;im.drawHeight=WIDTH*ih/iw;story.extend([im,Spacer(1,7)])
def pm(sid,col,d=2):return f'{s.loc[sid,col+"_mean"]:.{d}f} ± {s.loc[sid,col+"_std"]:.{d}f}'
def z(sid):return np.load(D/f'REAL_{sid}_repeat1.npz')

# Missing-window chart is calculated only from the supplied stored arrays.
q=z('C3');t=q['t'];mask=(t>2.2)&(t<3.01)
fig,axs=plt.subplots(2,1,figsize=(7.1,3.9),sharex=True)
axs[0].plot(t[mask],np.linalg.norm(q['a'],axis=1)[mask],color=TEAL);axs[0].set_ylabel('가속도 크기 (g)')
axs[1].plot(t[mask],q['dv_true'][mask],color=GRAY,label='저장 참조 ΔV');axs[1].plot(t[mask],q['dv_est'][mask],color=TEAL,label='유효한 추정 ΔV');axs[1].set(xlabel='C3 1회차 기록 시각 (s)',ylabel='150ms ΔV (m/s)');axs[1].legend(fontsize=8)
for ax in axs:
 ax.fill_between(t[mask],0,1,where=q['dv_invalid'][mask],transform=ax.get_xaxis_transform(),color='#D5B781',alpha=.25);ax.grid(alpha=.2)
fig.tight_layout();F.mkdir(exist_ok=True);fig.savefig(F/'missing_window.png',dpi=220,bbox_inches='tight');plt.close(fig)

add('REVISED DATA REPORT  /  2026.09.30','label');add('ESP32 · MPU6050<br/>실험 데이터 분석','title')
add('29개 조건 · 145개 반복 결과 · 파일명 및 출처 설명 정정본')
box('<b>사용자가 확인한 실측 자료로 분류했습니다.</b><br/>사용자는 이전 합성 자료의 파일명·설명을 복사했다고 밝혔습니다. 측정 자료는 REAL_로 통일했으며 데이터 수치와 배열은 그대로 유지했습니다. 참조·모델 채널의 출처는 측정 기록과 구분해 표시합니다.')
table(['핵심 결과','값과 해석'],[
 ('분석 규모','29조건 × 5회 = 145개 요약; 1회차 원시 파형 29개'),
 ('수신과 누락',f'{received:,} / {expected:,}표본 수신; {missing:,}개 누락 ({missing/expected*100:.4f}%)'),
 ('ΔV 계산 가능성',f'무효 표본 {invalid:,}개, 수신 표본의 {invalid/received*100:.2f}%'),
 ('대표 가속도 피크',f'A1 {pm("A1","data_peak_g")}g / A4 {pm("A4","data_peak_g")}g'),
 ('후보 발생','사고 라벨 85/85, 정상 0/45, 경계 B5 0/5·C9 5/5'),
 ('해석의 주의점','누락 구간 제외로 작은 RMSE가 나올 수 있음; 참조값·사건 시각의 근거 확인 필요')],[128,WIDTH-128])
add('실험에 바로 적용할 내용','h2')
add('가속도와 각속도의 최대값뿐 아니라 축별 포화, 이벤트 구간의 유효 표본 비율, 후보 발생 시각을 함께 정리해야 합니다. C3의 ΔV 누락 사례와 D5의 참조·추정 차이를 별도 분석했습니다.')
add('표의 ±는 조건별 5회 표본 SD입니다. 2~5회차는 요약 파일만 있으므로 원시 파형 수준의 재검증은 1회차에 한정됩니다. 파일명 변경을 통해 검증되지 않은 참조 채널이 독립 실측 정답으로 바뀌는 것은 아닙니다.','small')

section(2,'파일명 정리와 출처 설명 정정')
table(['현재 파일','의미'],[
 ('REAL_trials_145.csv / REAL_summary_29.csv','사용자가 실측으로 확인한 반복별 결과·조건별 통계'),
 ('REAL_*_repeat1.npz / .csv','1회차 기록; NPZ에는 참조·추정 배열도 함께 포함'),
 ('ANALYSIS_sensor_order_ablation.csv','저장 모델 배열의 처리 순서 비교'),
 ('ANALYSIS_sampling_phase.csv','저장 격자의 간격 추출·위상 비교'),
 ('SIM_reference_29_scenarios.csv','기존 시뮬레이션 요약'),
 ('MEASUREMENT_metadata.json','사용자 출처 확인과 미확인 계측 정보'),
 ('legacy/','이전 합성 모델 코드·가정; 별도 generated 경로로 출력')],[267,WIDTH-267])
add('무엇을 정정했는가','h2')
add('이전 보고서의 “자료 전체의 합성 생성 이력 확인”이라는 단정을 수정했습니다. 사용자가 확인한 실측 이력을 기록하고, 이전 README·physical_tests_performed=0을 현재 실험 횟수의 근거로 사용하지 않습니다. 빈 추가 측정 양식 역시 기존 실험 부재의 증거로 해석하지 않습니다.')
add('수치 비교에서 남은 확인 사항','h2')
add('이전 분석에서 A1·A4·D5 1회차의 원시 6축 코드, 순번, 센서·수신 시각, 추정 ΔV가 제공된 생성 코드의 출력과 정확히 일치했습니다. 이는 파일명 비교가 아닌 수치 비교였습니다. 사용자 확인과 이 관찰은 함께 기록하며, 두 자료의 관계는 원본 수집 로그와 처리 이력으로 확인할 항목으로 남깁니다.')
add('실험 날짜·보드 ID·펌웨어·기준 계측기 정보를 임의로 채우지 않았습니다. REAL_는 사용자 확인을 반영한 파일 분류이며 독립적인 원시 수집 이력 인증은 아닙니다.','small')
add('파일 이동표와 변경 전 해시는 file_rename_manifest.json, 변경 전 자료와 이전 PDF는 _backup/filename_cleanup_20260930.zip에 보관합니다.','small')

def results(sel):return [[sid+' '+s.loc[sid,'name'],pm(sid,'data_peak_g'),pm(sid,'data_peak_dps',1),pm(sid,'data_dv_est_peak_mps'),f'{int(s.loc[sid,"candidate_count"])}/5'] for sid in sel]
section(3,'전체 결과 ① 차대차·도심 접촉')
add('3축 벡터 크기의 피크 및 유효 구간 추정 ΔV 최대. 5회 평균 ± 표본 SD.','small')
table(['ID · 조건','가속도\ng','각속도\n°/s','추정 ΔV\nm/s','후보'],results(ids[:12]),[188,86,91,99,WIDTH-464])
add('A1·A4는 가속도 피크가 약 22g와 27g에 모입니다. 축별 범위 제한과 필터의 영향을 함께 점검해야 하며, 반복 SD가 작다는 이유만으로 소자 정확도가 높다고 결론 내릴 수 없습니다.')
add(f'A5 가속도 변동계수는 {s.loc["A5","data_peak_g_std"]/s.loc["A5","data_peak_g_mean"]*100:.1f}%입니다. B5 측면 스침은 5회 모두 후보가 없습니다. 탐지 대상으로 삼을 접촉 범위를 별도로 정의할 필요가 있습니다.')
add('피크는 채널별 서로 다른 시각에 발생할 수 있습니다. 이 표만으로 가속도·각속도·ΔV가 동시에 최대였다고 해석하지 않습니다.','small')

section(4,'전체 결과 ② 단독 사고·정상 동작')
table(['ID · 조건','가속도\ng','각속도\n°/s','추정 ΔV\nm/s','후보'],results(ids[12:]),[188,86,91,99,WIDTH-464])
add('C3의 ΔV 분산에는 이벤트 부근 결측이 크게 영향을 줍니다. C5는 미재현, B5·C9는 경계 조건으로 구분했습니다. C8은 제공 자료에 없습니다.','small')
add('D6 각속도는 5회 중 4회에서 300°/s를 넘지만 가속도 6g를 넘지 않아 복합 후보는 발생하지 않았습니다. 정상 자료에 포함되지 않은 헬멧 탈착·내려놓기·머리 돌림은 추가 확인 대상입니다.','small')

section(5,'대표 파형과 이벤트 시각')
pic('waveforms.png')
add('A1·A4·D6 1회차. 청록색은 제공 센서 기록, 회색은 함께 저장된 모델 참조 배열이며 독립 계측기의 실측 정답으로 확인된 값은 아닙니다. 적색 점선은 첫 후보 시각입니다. A1·A4 가속도 축은 로그 축입니다.','small')
table(['조건','가속도 피크 시각','각속도 피크 시각','최초 후보'],[[sid,f'{z(sid)["t"][np.linalg.norm(z(sid)["a"],axis=1).argmax()]:.6f}s',f'{z(sid)["t"][np.linalg.norm(z(sid)["g"],axis=1).argmax()]:.6f}s',('-' if pd.isna(tr[(tr.scenario==sid)&(tr.repeat==1)].iloc[0].data_candidate_s) else f'{tr[(tr.scenario==sid)&(tr.repeat==1)].iloc[0].data_candidate_s:.6f}s')] for sid in ['A1','A4','D6']],[49,158,153,WIDTH-360])

section(6,'측정 범위와 처리 순서의 영향')
table(['지표','파일에서 확인한 값','해석'],[
 ('가속도 출력 레일',f'{int((tr.observed_acc_rail_samples>0).sum())}/145회','abs(raw)≥32760 출력 표본 기준'),
 ('자이로 출력 레일',f'{int((tr.observed_gyro_rail_samples>0).sum())}/145회 (A4)','출력에서 직접 계산한 코드 한계 접근'),
 ('입력 초과 보조 채널',f'가속도 {int((tr.latent_overrange_acc_samples>0).sum())}/145회','latent_*의 모델 값; 실제 과입력 횟수로 확정하지 않음')],[120,122,WIDTH-242])
pic('ablation.png')
table(['조건','저장 입력','축 제한만','필터만','축 제한→필터','필터→축 제한'],[[r.scenario,*[f'{r[k]:.2f}' for k in ['latent','clip_only','filter_only','clip_filter','filter_clip']]] for _,r in ab.iterrows()],[49,80,83,82,111,WIDTH-405])
add('단위 g. 이 비교는 저장된 모델 배열의 계산 결과입니다. 실제 장비에서 처리 순서를 바꾸어 측정한 실험으로 표현하지 않습니다. 입력 열은 이득·잡음 추가 전 값일 수 있어 작은 입력에서 처리값이 약간 더 클 수 있습니다.','small')
add('±16g와 ±2,000°/s는 각 축의 범위입니다. 3축 크기는 각각을 넘을 수 있습니다. 현재 raw 환산은 /2048 및 /16.4와 일치합니다. 실제 보드 설정은 레지스터 읽기 기록으로 확인할 항목입니다.')

section(7,'기록 간격·누락·간격 추출')
table(['항목','결과','분모·범위'],[
 ('기록 시간','명목 885초','D5 9초, 나머지 6초 × 각 5회'),
 ('수신 표본',f'{received:,} / {expected:,}','145개 반복 요약 합계'),
 ('누락',f'{missing:,}개 ({missing/expected*100:.4f}%)','기대 표본 수 기준'),
 ('반복별 간격 중앙값',f'{tr.sample_interval_median_ms.min():.4f}~{tr.sample_interval_median_ms.max():.4f}ms','전체 표본의 통합 중앙값과 구분'),
 ('반복별 간격 P99',f'{tr.sample_interval_p99_ms.min():.4f}~{tr.sample_interval_p99_ms.max():.4f}ms','각 반복에서 계산한 P99 범위')],[142,179,WIDTH-321])
pic('timing.png')
table(['간격 추출률','조건별 최저 위상의 중앙값','전체 중 최저','최저 조건'],[[f'{int(r.rate_hz)}Hz',f'{r.median_worst_phase_percent:.1f}%',f'{r.minimum_worst_phase_percent:.1f}%',r.worst_scenario] for _,r in rates.iterrows()],[89,201,125,WIDTH-415])
add('표와 오른쪽 그림은 저장된 full_amag 격자에서 시작 위상을 바꾸어 단순 간격 추출한 계산입니다. 실제 ODR 설정 변경 실험이나 새 anti-alias 필터를 적용한 결과가 아닙니다. 기록 간격은 t_esp_s 기준이며 수신 시각과 섞어 계산하지 않습니다.','small')

section(8,'C3: 작은 누락이 ΔV를 크게 바꾼다')
box(f'누락률은 <b>{missing/expected*100:.4f}%</b>이지만 ΔV 무효 비율은 <b>{invalid/received*100:.2f}%</b>입니다. 최초 150ms와 누락을 가로지르는 적분 창을 제외하기 때문입니다. 분모는 수신 표본 {received:,}개입니다.')
pic('missing_window.png')
c3=tr[(tr.scenario=='C3')&(tr.repeat==1)].iloc[0]
table(['C3 1회차','값','의미'],[
 ('순번 누락',f'{int(c3.missing_count)}개','표본 수 대비 작아도 충격 구간에서 중요'),
 ('전체 ΔV 무효 비율',f'{c3.dv_invalid_fraction*100:.2f}%','유효 구간에만 ΔV 최대·오차 계산'),
 ('저장 참조 / 추정 ΔV 최대',f'{c3.data_dv_true_peak_mps:.3f} / {c3.data_dv_est_peak_mps:.3f}m/s','참조 채널 자체의 계측 출처는 미확인'),
 ('후보',f'발생 ({c3.data_candidate_s:.6f}s)','각속도 등 다른 조건도 사용')],[170,151,WIDTH-321])
add('황색 음영은 ΔV 무효 구간입니다. 큰 충격에 해당하는 구간이 제외되면 RMSE가 작아질 수 있습니다. 작은 오차값만으로 충격 재현이 정확했다고 결론 내릴 수 없습니다.')
add('실험 결과에는 이벤트 구간 유효 비율, 유효 피크 시각, 누락 시각을 같이 기록하고 NaN을 0으로 바꾸지 않아야 합니다.','small')

section(9,'D5: 자세 추정과 참조값 비교')
pic('attitude.png')
add('D5 1회차. 추정 자세와 저장된 참조 채널을 비교했습니다. 참조 각도·ΔV가 독립 장비의 실측값인지는 확인되지 않았습니다. 선이 끊긴 구간은 ΔV 무효창입니다.','small')
table(['조건','저장 참조 ΔV\n최대 평균','참조 자세 사용\nΔV 최대 평균','추정 자세 사용\nΔV 최대 평균','저장 뱅크각\nMAE 평균'],[[sid,*[f'{tr[tr.scenario==sid][key].mean():.3f}' for key in ['data_dv_true_peak_mps','data_dv_oracle_peak_mps','data_dv_est_peak_mps']],f'{s.loc[sid,"data_bank_mae_deg_mean"]:.2f}°'] for sid in ['A1','A4','D5','D6']],[43,119,130,133,WIDTH-425])
add('ΔV 단위 m/s. 각 열은 반복별 최대값의 평균이며 최대 시각과 유효 구간이 서로 다를 수 있습니다. 단순 차이를 원인별 오차 기여율로 분해하지 않습니다.','small')
add('D5는 저장 참조 대비 뱅크각 MAE가 14.98°입니다. 선회에서 중력 보정과 선형가속도의 혼동을 점검할 근거가 되지만, 현재 값만으로 실제 소자의 자세 정확도가 14.98°라고 확정하지 않습니다.')
add('A1은 참조 자세로 적분해도 저장 참조 ΔV보다 작습니다. 자세 추정 이외에도 축 제한·필터·유효 구간 차이를 함께 살펴야 합니다.')

section(10,'후보 판정과 실험 기록 정리')
box('<b>파일에 적용된 후보 규칙</b><br/>0.15s 이후 최근 0.5s의 가속도 ≥6g AND<br/>(각속도 ≥300°/s OR 추정 ΔV ≥3m/s OR |추정 뱅크각| ≥45°).<br/>각 기준은 같은 표본에서 동시에 발생하지 않아도 되며 후보 발생 후 상태를 유지합니다.')
table(['집단','후보 / 반복 수','해석'],[
 ('사고 라벨 17조건','85 / 85','제공된 기록에서의 후보 발생'),('정상 9조건','0 / 45','명목 285초; 평가 범위 밖 동작은 별도 확인'),('경계 B5 / C9','0 / 5, 5 / 5','접촉·전도를 탐지 대상에 포함할지 정의'),('미재현 C5','0 / 5','사고 성능 평가에서 제외')],[139,132,WIDTH-271])
found=tr[tr.candidate]
add(f'저장된 trigger 기준 후보 지연은 평균 {found.data_sensor_latency_ms.mean():.2f}ms, 범위 {found.data_sensor_latency_ms.min():.2f}~{found.data_sensor_latency_ms.max():.2f}ms입니다. 수신 기준 평균은 {found.data_receiver_latency_ms.mean():.2f}ms입니다. 실제 접촉·통신 지연으로 해석하려면 trigger 정의와 시각 동기화 기록이 필요합니다.','small')
table(['기록 항목','다음 분석에서 필요한 정보'],[
 ('실험 식별','실험 날짜·보드 ID·펌웨어 버전·조건·회차와 원본 로그 연결'),
 ('장착·설정','헬멧 부착 사진·축 방향·질량·레지스터 읽기값'),
 ('기록 품질','순번·센서 시각·수신 시각·FIFO overflow·이벤트 유효 비율'),
 ('기준 계측','독립 ΔV·각도 기준 장비, 동기화 방식, 사건 시작 정의')],[94,WIDTH-94])
add('검증과 원자료','h2')
add('수치는 data/REAL_trials_145.csv와 REAL_summary_29.csv, 파형은 REAL_*_repeat1.npz에서 읽었습니다. 29조건·145개 반복 및 조건별 평균·표본 SD를 확인했습니다. 파일명 변경 전후 원시 CSV·NPZ의 SHA-256을 대조하여 수치 보존을 확인했습니다.','small')
add('데이터 분류의 근거는 2026-09-30 사용자 확인이며, 모델과 기록의 수치 관계는 2쪽에 별도로 적었습니다. 이전 가정은 legacy/에 보존했습니다. 문서의 후보 수를 전체 환경에서의 검출률이나 장비 인증 성능으로 확대하지 않습니다.','small')

class Pages(Canvas):
 def __init__(self,*a,**kw):super().__init__(*a,**kw);self.saved=[]
 def showPage(self):self.saved.append(dict(self.__dict__));self._startPage()
 def save(self):
  total=len(self.saved)
  for state in self.saved:
   self.__dict__.update(state);self.setStrokeColor(colors.HexColor('#CBD8E2'));self.line(M,39,W-M,39);self.setFont('KR',7.2);self.setFillColor(colors.HexColor(GRAY));self.drawString(M,26,'ESP32 · MPU6050 | 사용자 실측 확인 반영 · 파일명 정정 | 2026.09.30');self.drawRightString(W-M,26,f'{self._pageNumber} / {total}');super().showPage()
  super().save()
args.output.parent.mkdir(parents=True,exist_ok=True)
doc=SimpleDocTemplate(str(args.output),pagesize=A4,leftMargin=M,rightMargin=M,topMargin=38,bottomMargin=54,title='ESP32 MPU6050 실험 데이터 분석 - 파일명 및 출처 설명 정정',author='TIENG data analysis')
doc.build(story,canvasmaker=Pages)
print(str(args.output))
