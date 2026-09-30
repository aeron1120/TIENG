"""PDF summary anchors -> independent illustrative 6-axis signals -> approximate sensor.
Run: python legacy/generate_synthetic.py. Requires numpy, scipy, pandas, matplotlib.
"""
from pathlib import Path
import json, math
from collections import deque
import numpy as np
import pandas as pd
from scipy.signal import lfilter
from scipy.integrate import cumulative_trapezoid
from scipy.optimize import brentq
from scipy.spatial.transform import Rotation

ROOT=Path(__file__).resolve().parent/'generated'; ROOT.mkdir(parents=True,exist_ok=True)
DATA=ROOT/'data'; DATA.mkdir(exist_ok=True)
SEED=20260930; G=9.81; HI_FS=4000; FS=1000
RAW=[
 ('A1','정지 승용차 측면 직각 충돌','accident',48,203.7,15.02,1437,1.550),
 ('A2','주행 승용차 측면 직각 충돌','accident',48,200.8,13.83,1520,1.560),
 ('A3','주행 승용차 측면 45도 충돌','accident',48,143.5,10.44,1016,1.561),
 ('A4','주행 승용차 측면 135도 충돌','accident',48,240.8,13.28,2755,1.550),
 ('A5','승용차와 사선 정면충돌','accident',48,133.9,13.88,1872,1.536),
 ('A6','정지 이륜차 측면 피충돌','accident',0,131.1,9.25,1386,1.528),
 ('A7','전면 모서리 오프셋 충돌','accident',48,28.5,10.59,1595,1.554),
 ('B1','좌회전 차량 진로 차단','accident',40,145.6,12.06,1710,1.565),
 ('B2','정차 차량 후미 추돌','accident',30,56.8,7.50,1075,1.571),
 ('B3','신호 대기 중 후방 피추돌','accident',0,22.1,6.86,1003,1.526),
 ('B4','주차 차량 도어링','accident',30,85.1,7.96,1469,1.545),
 ('B5','차로 변경 차량 측면 스침','boundary',30,1.9,.83,136,np.nan),
 ('C1','저마찰 패치 로우사이드','accident',30,47.1,7.70,1360,3.981),
 ('C2','커브 과속 발판 접지 전도','accident',40,44.2,6.46,1497,1.932),
 ('C3','젖은 노면 제동 앞바퀴 잠김','accident',40,60.2,8.47,1650,2.433),
 ('C4','선회 중 급제동','accident',30,25.7,4.96,1241,4.279),
 ('C5','하이사이드 시도 미재현','unrealized',30,2.2,1.20,277,np.nan),
 ('C6','연석 비스듬히 충돌','accident',25,51.6,7.65,1547,1.722),
 ('C7','볼라드 전신주 정면 충돌','accident',30,73.6,7.74,1309,1.571),
 ('C9','저속 균형 상실 전도','boundary',5,17.4,5.62,1050,1.115),
 ('D1','정속 직진','normal',30,1.0,.01,1,np.nan),
 ('D2','방지턱 통과','normal',20,1.5,.76,101,np.nan),
 ('D3','방지턱 과속 통과','normal',40,2.5,1.61,108,np.nan),
 ('D4','ABS 급제동','normal',40,1.8,1.80,162,np.nan),
 ('D5','정상 선회','normal',30,1.1,.57,31,np.nan),
 ('D6','연석 오르내리기','normal',10,3.5,2.39,314,np.nan),
 ('D7','요철 노면 연속 주행','normal',30,2.7,.44,70,np.nan),
 ('D8','가감속 반복','normal',30,1.2,.81,84,np.nan),
 ('D9','저속 유턴','normal',10,1.0,.41,67,np.nan),
]
REF=pd.DataFrame(RAW,columns=['scenario','name','class','sim_speed_kmh','sim_peak_g','sim_dv_true_mps','sim_peak_dps','sim_candidate_s'])

def delta_v(a,t):
    vel=cumulative_trapezoid(a,t,axis=0,initial=0)
    prev=np.column_stack([np.interp(t-.15,t,vel[:,j]) for j in range(3)])
    dv=np.linalg.norm(vel-prev,axis=1);dv[t-t[0]<.15]=np.nan
    return dv

def rollmax(x,t,window=.5):
    q=deque(); y=np.empty(len(x)); x=np.nan_to_num(x,nan=-np.inf)
    for i,v in enumerate(x):
        while q and t[q[0]]<t[i]-window:q.popleft()
        while q and x[q[-1]]<=v:q.pop()
        q.append(i);y[i]=x[q[0]]
    return y

def estimate_attitude(acc,gyro,t,kp=1.5):
    # Quaternion, body -> world; gravity correction only near 1 g and low rotation.
    out=np.empty((len(t),4));q=[0.,0.,0.,1.];out[0]=q
    for i in range(1,len(t)):
        x,y,z,w=q; ax,ay,az=acc[i]; wx,wy,wz=np.deg2rad(gyro[i])
        an=math.sqrt(ax*ax+ay*ay+az*az)
        if abs(an-1)<.15 and wx*wx+wy*wy+wz*wz<math.radians(50)**2:
            mx,my,mz=ax/an,ay/an,az/an
            px,py,pz=2*(x*z-w*y),2*(y*z+w*x),1-2*(x*x+y*y)
            wx+=kp*(my*pz-mz*py); wy+=kp*(mz*px-mx*pz); wz+=kp*(mx*py-my*px)
        h=(t[i]-t[i-1])*.5
        nq=[x+h*(w*wx+y*wz-z*wy),y+h*(w*wy+z*wx-x*wz),
            z+h*(w*wz+x*wy-y*wx),w-h*(x*wx+y*wy+z*wz)]
        norm=math.sqrt(sum(v*v for v in nq));q=[v/norm for v in nq];out[i]=q
    return Rotation.from_quat(out)

def lowpass(x,fc,t,extra_delay):
    alpha=1-math.exp(-2*math.pi*fc/HI_FS)
    y=lfilter([alpha],[1,-(1-alpha)],x,axis=0,zi=((1-alpha)*x[0])[None,:])[0]
    return np.column_stack([np.interp(t-extra_delay,t,y[:,j]) for j in range(3)])

def latent(row,repeat,rng):
    sid=row.scenario; duration=9. if sid=='D5' else 6.
    t=np.arange(round(duration*HI_FS)+1)/HI_FS
    scale=1+rng.normal(0,.025); dv_scale=1+rng.normal(0,.03)
    target_g=max(row.sim_peak_g*scale,1.00005)
    if sid=='D1':target_g=1.00010
    if sid=='D9':target_g=1.041*scale**.08
    target_dv=row.sim_dv_true_mps*scale*dv_scale
    tc=(4.114 if sid=='C1' else row.sim_candidate_s+.032) if np.isfinite(row.sim_candidate_s) else 2.5
    tc+=rng.normal(0,.002)
    if sid=='D5':
        # Prescribed coordinated turn. Independent from the original MuJoCo trajectory.
        v=30/3.6; w0=.453*scale
        u=np.clip((t-.5)/2.,0,1);h=u*u*(3-2*u)
        yawrate=w0*h;yaw=cumulative_trapezoid(yawrate,t,initial=0)
        phi=-np.arctan(v*yawrate/G)+np.deg2rad(.7)*np.sin(2*np.pi*1.2*t)*h
        phidot=np.gradient(phi,1/HI_FS)
        rot=Rotation.from_rotvec(yaw[:,None]*np.array([0.,0.,1.]))*Rotation.from_rotvec(phi[:,None]*np.array([1.,0.,0.]))
        gyro=np.rad2deg(np.column_stack([phidot,np.sin(phi)*yawrate,np.cos(phi)*yawrate]))
        aw=np.column_stack([-v*yawrate*np.sin(yaw),v*yawrate*np.cos(yaw),np.zeros(len(t))])
        tc=2.5
    else:
        wpeak=row.sim_peak_dps*(1+rng.normal(0,.02))
        axis=np.array([1.,0.,0.])
        if sid=='A4':
            r=2625.8/2755;axis=np.array([r,np.sqrt(1-r*r),0.])
        wrate=wpeak*np.exp(-.5*((t-(tc-.006))/.030)**2)
        theta=np.deg2rad(cumulative_trapezoid(wrate,t,initial=0))
        rot=Rotation.from_rotvec(theta[:,None]*axis)
        gyro=wrate[:,None]*axis
        if row['class']=='accident' or sid=='C9':
            body_dir=np.array([1.,.18,.020])
            if sid=='A4':body_dir=np.array([.8501,.4997,.166])
            if sid not in ('A1','A4'):body_dir+=np.array([0,rng.normal(0,.07),rng.normal(0,.03)])
            body_dir/=np.linalg.norm(body_dir)
            direction=rot[np.argmin(abs(t-tc))].apply(body_dir)
        else: direction=np.array([1.,0.,0.])
        p=-direction[2]+np.sqrt(direction[2]**2+target_g**2-1)
        if row['class']=='accident' or sid=='C9':
            sig=.0016 if target_g>100 else .0035
            narrow=np.exp(-.5*((t-tc)/sig)**2)
            broad=np.exp(-.5*((t-tc)/.045)**2)
            mask=np.abs(t-tc)<=.075
            i1=np.trapezoid(narrow[mask],t[mask]);i2=np.trapezoid(broad[mask],t[mask])
            b=(target_dv/G-p*i1)/(i2-i1)
            if not 0<=b<=p:
                raise ValueError((sid,p,b,target_dv))
            amplitude=(p-b)*narrow+b*broad
        else:
            def dv_for_sig(sig):
                return p*G*sig*np.sqrt(2*np.pi)*math.erf(.075/(np.sqrt(2)*sig))
            if target_dv>=p*G*.15:target_dv=p*G*.15*.99
            sig=brentq(lambda s:dv_for_sig(s)-target_dv,.0003,5.)
            amplitude=p*np.exp(-.5*((t-tc)/sig)**2)
            if sid in ('D7','D8'):
                amplitude=amplitude-p*.75*np.exp(-.5*((t-(tc+1.2))/sig)**2)
        aw=G*amplitude[:,None]*direction
    specific=rot.inv().apply(aw+np.array([0,0,G]))/G
    return t,specific,gyro,aw,rot,tc

def run(row,index,repeat):
    rng=np.random.default_rng(SEED+100*index+repeat)
    t,f,w,aw,rot,tc=latent(row,repeat,rng)
    # All bias/noise distributions below are assumptions, NOT measured device specs.
    ba=rng.normal(0,.004,3);bg=rng.normal(0,.15,3)
    gain=1+rng.normal(0,.008,3)
    fa=f*gain+ba+rng.normal(0,.018,f.shape)
    wa=w+bg+rng.normal(0,.75,w.shape)
    # Declared approximate order: overload -> one-pole LPF + delay -> quantization.
    fclip=np.clip(fa,-16,16-1/2048)
    wclip=np.clip(wa,-2000,2000)
    ff=lowpass(fclip,94,t,.0013);ww=lowpass(wclip,98,t,.0012)
    ar=np.clip(np.rint(ff[::4]*2048),-32768,32767).astype(np.int16)
    gr=np.clip(np.rint(ww[::4]*16.4),-32768,32767).astype(np.int16)
    t0=t[::4]; expected=len(t0); seq=np.arange(expected)
    ts=t0+rng.normal(0,.000025,expected);ts[0]=0.
    keep=rng.random(expected)>=.001;keep[0]=True;keep[-1]=True
    tk=ts[keep];seqk=seq[keep]; a=ar[keep].astype(float)/2048;g=gr[keep].astype(float)/16.4
    rtrue=rot[::4][keep]
    rhat=estimate_attitude(a,g,tk)
    ahat=rhat.apply(a*G)-np.array([0,0,G]);aoracle=rtrue.apply(a*G)-np.array([0,0,G])
    dvhat=delta_v(ahat,tk);dvoracle=delta_v(aoracle,tk)
    dvtrue=delta_v(aw[::4],t0)[keep]
    missing=np.r_[False,np.diff(seqk)>1]
    bad=rollmax(missing.astype(float),tk,.15)>0
    dvhat[bad]=np.nan;dvoracle[bad]=np.nan
    rolltrue=np.rad2deg(np.arctan2(rtrue.as_matrix()[:,2,1],rtrue.as_matrix()[:,2,2]))
    rollhat=np.rad2deg(np.arctan2(rhat.as_matrix()[:,2,1],rhat.as_matrix()[:,2,2]))
    rollerr=(rollhat-rolltrue+180)%360-180
    poseerr=np.rad2deg((rtrue.inv()*rhat).magnitude())
    amag=np.linalg.norm(a,axis=1);gmag=np.linalg.norm(g,axis=1)
    cond=(tk>=.15)&(rollmax(amag,tk)>=6)&((rollmax(gmag,tk)>=300)|(rollmax(dvhat,tk)>=3)|(rollmax(abs(rollhat),tk)>=45))
    ci=np.flatnonzero(cond);cand=tk[ci[0]] if len(ci) else np.nan
    # Generic external trigger is a real convention, never inferred actual contact.
    trigger=tc-.15
    rxdelay=np.maximum(.002,rng.normal(.012,.004,len(tk)))
    rx=np.maximum.accumulate(tk+rxdelay)
    ra=np.any(abs(ar[keep].astype(np.int32))>=32760,axis=1)
    rg=np.any(abs(gr[keep].astype(np.int32))>=32760,axis=1)
    latent_over_a=np.any(abs(fa[::4][keep])>16,axis=1)
    latent_over_g=np.any(abs(wa[::4][keep])>2000,axis=1)
    err=dvhat-dvtrue;valid=np.isfinite(err)
    event=(tk>=tc-.15)&(tk<=tc+.5)
    rowout=dict(data_kind='synthetic',scenario=row.scenario,repeat=repeat,
      duration_s=float(t[-1]),samples_expected=expected,samples_received=len(tk),missing_count=expected-len(tk),
      sample_interval_median_ms=np.median(np.diff(tk))*1000,
      sample_interval_p99_ms=np.quantile(np.diff(tk),.99)*1000,
      data_peak_g=amag.max(),data_peak_dps=gmag.max(),
      data_dv_est_peak_mps=np.nanmax(dvhat),data_dv_true_peak_mps=np.nanmax(dvtrue),
      data_dv_oracle_peak_mps=np.nanmax(dvoracle),data_dv_rmse_mps=np.sqrt(np.mean(err[valid]**2)),
      data_bank_mae_deg=np.mean(abs(rollerr)),data_bank_max_error_deg=abs(rollerr).max(),
      data_pose_error_max_deg=poseerr.max(),data_event_pose_error_max_deg=poseerr[event].max(),
      latent_overrange_acc_samples=int(latent_over_a.sum()),latent_overrange_gyro_samples=int(latent_over_g.sum()),
      observed_acc_rail_samples=int(ra.sum()),observed_gyro_rail_samples=int(rg.sum()),
      observed_acc_rail_axes=','.join('xyz'[j] for j in range(3) if (abs(ar[keep,j].astype(np.int32))>=32760).any()),
      candidate=bool(len(ci)),data_candidate_s=cand,data_trigger_s=trigger,
      data_sensor_latency_ms=(cand-trigger)*1000,
      data_receiver_latency_ms=(rx[ci[0]]-trigger)*1000 if len(ci) else np.nan,
      dv_invalid_fraction=1-np.isfinite(dvhat).mean())
    traces=dict(t=tk,t_grid=t0,seq=seqk,a=a,g=g,acc_raw=ar[keep],gyro_raw=gr[keep],
        latent_a=f[::4][keep],latent_g=w[::4][keep],latent_world_a=aw[::4][keep],
        dv_true=dvtrue,dv_est=dvhat,dv_oracle=dvoracle,roll_true=rolltrue,roll_est=rollhat,
        pose_error=poseerr,rx_time=rx,rail_acc=ra,rail_gyro=rg,
        latent_overrange_acc=latent_over_a,latent_overrange_gyro=latent_over_g,
        dv_invalid=~np.isfinite(dvhat),candidate_latched=np.maximum.accumulate(cond),
        full_amag=np.linalg.norm(ar.astype(float)/2048,axis=1),
        full_gmag=np.linalg.norm(gr.astype(float)/16.4,axis=1),
        event_center_s=np.array(tc))
    if repeat==1:
        # Isolate sensor-chain effects without changing the underlying real input.
        unclipped=lowpass(fa,94,t,.0013)[::4]
        alt=np.clip(unclipped,-16,16-1/2048)
        traces['clip_only_amag']=np.linalg.norm(fclip[::4],axis=1)
        traces['filter_only_amag']=np.linalg.norm(unclipped,axis=1)
        traces['filter_then_clip_amag']=np.linalg.norm(alt,axis=1)
        traces['latent_full_amag']=np.linalg.norm(f[::4],axis=1)
        np.savez_compressed(DATA/f'MODEL_{row.scenario}_repeat1.npz',**traces)
        if row.scenario in ['A1','A4','C9','D5','D6']:
            df=pd.DataFrame({'data_kind':'synthetic','scenario':row.scenario,'repeat':repeat,
              't_esp_s':tk,'packet_seq':seqk,'receiver_time_s':rx})
            for j,axis in enumerate('xyz'):
                df['a'+axis+'_raw']=ar[keep,j];df['g'+axis+'_raw']=gr[keep,j]
                df['a'+axis+'_g']=a[:,j];df['g'+axis+'_dps']=g[:,j]
            for col,key in [('delta_v_est_mps','dv_est'),('data_truth_delta_v_mps','dv_true'),
                  ('bank_est_deg','roll_est'),('data_truth_bank_deg','roll_true'),
                  ('observed_acc_near_rail','rail_acc'),('observed_gyro_near_rail','rail_gyro'),
                  ('data_truth_acc_overrange','latent_overrange_acc'),('data_truth_gyro_overrange','latent_overrange_gyro'),
                  ('delta_v_invalid','dv_invalid'),('candidate_latched','candidate_latched')]:df[col]=traces[key]
            df.to_csv(DATA/f'MODEL_{row.scenario}_repeat1.csv',index=False,float_format='%.7f')
    return rowout

def main():
    REF.to_csv(DATA/'SIM_reference_29_scenarios.csv',index=False,encoding='utf-8-sig')
    rows=[]
    for i,row in REF.iterrows():
        for rep in range(1,6):rows.append(run(row,i,rep))
        print(row.scenario,flush=True)
    trials=pd.DataFrame(rows).merge(REF,on='scenario',how='left')
    trials.to_csv(DATA/'MODEL_trials_145.csv',index=False,encoding='utf-8-sig')
    nums=['data_peak_g','data_peak_dps','data_dv_est_peak_mps','data_dv_true_peak_mps',
          'data_dv_rmse_mps','data_bank_mae_deg','data_sensor_latency_ms']
    agg=trials.groupby('scenario',sort=False)[nums].agg(['mean','std'])
    agg.columns=['_'.join(x) for x in agg.columns]
    agg['candidate_count']=trials.groupby('scenario',sort=False).candidate.sum()
    agg=REF.merge(agg,left_on='scenario',right_index=True)
    agg.to_csv(DATA/'MODEL_summary_29.csv',index=False,encoding='utf-8-sig')
    settings=dict(data_kind='synthetic',seed=SEED,repeats=5,physical_tests_performed=0,
       mujoco_rerun=False,original_simulation_csv_available=False,
       source='User PDF: 헬멧_IMU_시뮬레이션_분석_실험참고.pdf pp.4-5',
       placement='helmet rear center; same nominal site and mapped axes as source PDF',
       high_rate_synthesis_hz=HI_FS,nominal_sensor_hz=FS,
       registers={'PWR_MGMT_1':'0x01','SMPLRT_DIV':'0x00','CONFIG':'0x02','GYRO_CONFIG':'0x18','ACCEL_CONFIG':'0x18'},
       accel_range_g=16,gyro_range_dps=2000,accel_lsb_per_g=2048,gyro_lsb_per_dps=16.4,
       approximate_sensor_chain='axis clip -> 1-pole LPF 94/98 Hz -> extra delay 1.3/1.2 ms -> 1 kHz -> int16',
       ordering_is_assumption=True,noise_before_lpf_std={'accel_g':.018,'gyro_dps':.75},
       residual_bias_std={'accel_g':.004,'gyro_dps':.15},gain_std=.008,
       input_amplitude_std=.025,delta_v_extra_scale_std=.03,gyro_amplitude_std=.02,
       timestamp_jitter_std_s=.000025,random_sample_loss_probability=.001,
       receiver_delay_assumption_s={'mean':.012,'std':.004,'minimum':.002},
       estimator='Quaternion complementary correction kp=1.5, abs(|a|-1)<0.15g, |w|<50dps',
       delta_v_window_s=.15,delta_v_gap_policy='Invalidate any window spanning a missing sequence',
       candidate_rule='after 0.15s: max_0.5s(acc)>=6 AND (max_0.5s(gyro)>=300 OR max_0.5s(dv_est)>=3 OR max_0.5s(abs(bank))>=45)',
       trigger_definition='real pulse center minus 0.15s, not original crash contact time',
       max_composite_acc_g=float(np.sqrt(3)*16),
       summary=dict(runs=len(trials),nominal_duration_s=float(trials.duration_s.sum()),
          expected_samples=int(trials.samples_expected.sum()),received_samples=int(trials.samples_received.sum()),
          dropped_samples=int(trials.missing_count.sum()),
          input_acc_overrange_runs=int((trials.latent_overrange_acc_samples>0).sum()),
          output_acc_rail_runs=int((trials.observed_acc_rail_samples>0).sum())))
    (DATA/'assumptions.json').write_text(json.dumps(settings,ensure_ascii=False,indent=2))
    print(agg[['scenario','data_peak_g_mean','data_peak_dps_mean','data_dv_est_peak_mps_mean','candidate_count']].to_string(index=False))
    print(json.dumps(settings['summary'],indent=2))

if __name__=='__main__':main()
