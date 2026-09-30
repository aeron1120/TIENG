from pathlib import Path
import json
import numpy as np
import pandas as pd
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

ROOT=Path(__file__).resolve().parent/'generated';D=ROOT/'data';F=ROOT/'figures';F.mkdir(exist_ok=True)
FONT=next(p for p in [Path('C:/Windows/Fonts/malgun.ttf'),Path('/usr/local/share/fonts/nanum/NanumGothic-Regular.ttf')] if p.exists())
font_manager.fontManager.addfont(str(FONT))
plt.rcParams.update({'font.family':[font_manager.FontProperties(fname=str(FONT)).get_name(),'DejaVu Sans'],'axes.unicode_minus':False,'font.size':9,
 'axes.spines.top':False,'axes.spines.right':False,'axes.edgecolor':'#b8c4cc',
 'axes.labelcolor':'#263c51','xtick.color':'#536575','ytick.color':'#536575',
 'figure.facecolor':'white','axes.facecolor':'white','savefig.facecolor':'white',
 'grid.color':'#e1e8ed','grid.linewidth':.6,'legend.frameon':False})
TEAL='#008c99';NAVY='#17334c';RED='#c45647';GRAY='#8e9ba7';GOLD='#b8872a'
s=pd.read_csv(D/'MODEL_summary_29.csv');tr=pd.read_csv(D/'MODEL_trials_145.csv')
def z(sid):return np.load(D/f'MODEL_{sid}_repeat1.npz')
def save(fig,name):
 fig.savefig(F/(name+'.png'),dpi=230,bbox_inches='tight');plt.close(fig)

# Full distributions, reference PDF anchors are visually separate from new data means.
fig,axs=plt.subplots(2,1,figsize=(8.1,5.1),sharex=True)
x=np.arange(len(s))
for ax,(ref,mean,std,label,log) in zip(axs,[
 ('sim_peak_g','data_peak_g_mean','data_peak_g_std','합성 가속도 피크 (g)',True),
 ('sim_peak_dps','data_peak_dps_mean','data_peak_dps_std','합성 각속도 피크 (°/s)',True)]):
 ax.plot(x,s[ref],'o',ms=4,mfc='white',mec=GRAY,label='PDF 시뮬레이션 요약')
 ax.errorbar(x,s[mean],yerr=s[std],fmt='o',color=TEAL,ms=3.6,capsize=2,lw=.8,label='data 평균 ± 표본 SD (5회)')
 ax.set_ylabel(label);ax.grid(axis='y',which='major');ax.axvspan(19.5,28.5,color='#eaf5f5',zorder=0)
 if log:ax.set_yscale('log')
axs[0].axhline(6,color=RED,ls='--',lw=.7);axs[0].text(.2,6.7,'후보 기준 6g',color=RED,fontsize=8)
axs[0].legend(loc='upper right',fontsize=8,ncol=2)
axs[1].set_xticks(x,s.scenario,rotation=45);axs[1].set_xlabel('조건 ID  /  음영: 정상 D1~D9')
fig.tight_layout();save(fig,'distribution')

# Representative waveform examples; no trace is presented as original MuJoCo data.
fig,axs=plt.subplots(3,2,figsize=(8.1,6.5))
for row,sid in enumerate(['A1','A4','D6']):
 q=z(sid); t=q['t'];tc=float(q['event_center_s']); mask=(t>=tc-.11)&(t<=tc+.16)
 for col,(a,b,label) in enumerate([('latent_a','a','합성 가속도 (g)'),('latent_g','g','합성 각속도 (°/s)')]):
  ax=axs[row,col];ax.plot(t[mask],np.linalg.norm(q[a],axis=1)[mask],color=GRAY,lw=1.3,label='독립 합성 입력')
  ax.plot(t[mask],np.linalg.norm(q[b],axis=1)[mask],color=TEAL,lw=1.4,label='data 센서 출력')
  c=tr[(tr.scenario==sid)&(tr.repeat==1)].iloc[0].data_candidate_s
  if np.isfinite(c):ax.axvline(c,color=RED,lw=.8,ls='--')
  if col==0 and row<2:ax.set_yscale('log');ax.set_ylim(.85,350)
  ax.set_title(f'{sid}  {"가속도" if col==0 else "각속도"}',loc='left',color=NAVY,fontsize=10)
  ax.set_ylabel(label);ax.grid(axis='y');ax.set_xlabel('가상 기록 시각 (s)')
axs[0,0].legend(fontsize=7,loc='upper left')
fig.tight_layout(h_pad=1.1);save(fig,'waveforms')

# Explicit ablation, same input and 1 kHz grid, repeat 1.
abl=[]
for sid in ['A1','A4','C9','D6']:
 q=z(sid);abl.append({'scenario':sid,'latent':q['latent_full_amag'].max(),
  'clip_only':q['clip_only_amag'].max(),'filter_only':q['filter_only_amag'].max(),
  'clip_filter':q['full_amag'].max(),'filter_clip':q['filter_then_clip_amag'].max()})
pd.DataFrame(abl).to_csv(D/'MODEL_sensor_order_ablation.csv',index=False)
q=z('A1');tc=float(q['event_center_s']);mask=abs(q['t_grid']-tc)<.035
fig,ax=plt.subplots(figsize=(8.1,3.3))
for key,c,l in [('clip_only_amag',GRAY,'축 제한만'),('full_amag',TEAL,'축 제한 → 필터 (주 모델)'),
                ('filter_then_clip_amag',GOLD,'필터 → 축 제한 (민감도 예시)')]:
 ax.plot((q['t_grid'][mask]-tc)*1000,q[key][mask],color=c,label=l,lw=1.6)
ax.axhline(np.sqrt(3)*16,color=RED,ls='--',lw=.8,label='축별 ±16g의 합성 상한')
ax.set(xlabel='합성 충격 중심 대비 시간 (ms)',ylabel='합성 가속도 (g)',ylim=(0,31))
ax.legend(fontsize=8,ncol=2,loc='upper right');ax.grid(axis='y');fig.tight_layout();save(fig,'ablation')

# Timing quality and all-phase decimation of the already-filtered data outputs.
intervals=np.concatenate([np.diff(z(i)['t'])*1000 for i in s.scenario])
rates=[]
for rate in [500,200,100,50]:
 step=1000//rate;arr=[]
 for sid in s.scenario:
  v=z(sid)['full_amag'];arr.append(min(v[p::step].max()/v.max() for p in range(step)))
 rates.append({'rate_hz':rate,'median_worst_phase_percent':100*np.median(arr),
  'minimum_worst_phase_percent':100*np.min(arr),'worst_scenario':s.scenario.iloc[np.argmin(arr)]})
pd.DataFrame(rates).to_csv(D/'MODEL_sampling_phase.csv',index=False)
fig,axs=plt.subplots(1,2,figsize=(8.1,3.2))
axs[0].hist(intervals,bins=np.linspace(.8,2.2,100),color=TEAL);axs[0].set_yscale('log')
axs[0].set(xlabel='ESP 가상 타임스탬프 간격 (ms)',ylabel='빈도 (로그)',title='29조건 1회차 간격')
rp=pd.DataFrame(rates);x=np.arange(4)
axs[1].bar(x-.18,rp.median_worst_phase_percent,.35,color=TEAL,label='29조건 중앙값')
axs[1].bar(x+.18,rp.minimum_worst_phase_percent,.35,color=GRAY,label='전체 최저')
axs[1].set_xticks(x,[str(v) for v in rp.rate_hz]);axs[1].set(xlabel='기록률 (Hz)',ylabel='피크 보존율 (%)',ylim=(0,110))
axs[1].legend(fontsize=7);axs[1].grid(axis='y');fig.tight_layout();save(fig,'timing')

q=z('D5');fig,axs=plt.subplots(2,1,figsize=(8.1,4.4),sharex=True)
axs[0].plot(q['t'],q['roll_true'],color=GRAY,label='합성 입력 자세')
axs[0].plot(q['t'],q['roll_est'],color=TEAL,label='6축 추정 자세')
axs[0].set_ylabel('헬멧 뱅크각 (°)');axs[0].legend(fontsize=8,loc='lower left');axs[0].grid(axis='y')
for key,c,l in [('dv_true',GRAY,'합성 입력 참조 ΔV'),('dv_est',TEAL,'추정 자세로 적분'),
                ('dv_oracle',GOLD,'합성 참조 자세로 적분')]:
 axs[1].plot(q['t'],q[key],color=c,lw=1.2,label=l)
axs[1].set(xlabel='가상 기록 시각 (s)',ylabel='150ms ΔV (m/s)',ylim=(0,.9))
axs[1].legend(fontsize=8,loc='upper right');axs[1].grid(axis='y');fig.tight_layout();save(fig,'attitude')

# Consistency checks with scientific meaning.
assert len(tr)==145 and len(s)==29
assert (tr.data_peak_g<=np.sqrt(3)*16+1e-6).all()
assert int(tr.samples_expected.sum()-tr.samples_received.sum())==int(tr.missing_count.sum())
for sid in s.scenario:
 q=z(sid)
 assert (np.diff(q['t'])>0).all()
 assert np.isnan(q['dv_est'][q['t']<.15]).all()
 assert np.max(abs(q['acc_raw'].astype(np.int32)))<=32768
 assert np.isfinite(q['a']).all()
check={'checks_passed':['145 trials / 29 conditions','per-axis int16 and composite bounds',
 'sample-loss accounting','monotonic ESP timestamps','undefined first 150 ms preserved'],
 'data_kind':'synthetic','reference_raw_not_available':True}
(D/'verification.json').write_text(json.dumps(check,indent=2))
print('FIGURES_READY')
print(tr.groupby('class').agg(runs=('candidate','size'),candidates=('candidate','sum'),duration_s=('duration_s','sum')).to_string())
print(tr[tr.scenario.isin(['A1','A4','D5','D6'])].groupby('scenario')[['data_peak_g','data_peak_dps',
 'data_dv_true_peak_mps','data_dv_est_peak_mps','data_dv_oracle_peak_mps','data_dv_rmse_mps',
 'data_bank_mae_deg','data_pose_error_max_deg','data_sensor_latency_ms']].mean().to_string())
print('Ablation:',abl)
print('Sampling:',rates)
