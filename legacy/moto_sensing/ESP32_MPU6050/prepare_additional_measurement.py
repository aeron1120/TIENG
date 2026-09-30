"""Create an empty real-measurement comparison sheet. Never fills measured data."""
from pathlib import Path
import pandas as pd

ROOT = Path(__file__).parent
DATA = ROOT / 'data'
summary = pd.read_csv(DATA / 'REAL_summary_29.csv')
measured_columns = [
    'actual_run_id', 'actual_date', 'board_id', 'firmware_version',
    'placement_and_axis_mapping', 'mounting_method', 'device_mass_g',
    'accel_range_g', 'gyro_range_dps', 'dlpf_cfg', 'nominal_sample_rate_hz',
    'duration_s', 'samples_expected', 'samples_received', 'missing_count',
    'fifo_overflow_count', 'median_dt_ms', 'p99_dt_ms', 'temperature_c',
    'peak_acc_norm_g', 'peak_gyro_norm_dps', 'acc_near_rail_samples',
    'gyro_near_rail_samples', 'delta_v_est_peak_mps',
    'independent_reference_method', 'reference_delta_v_peak_mps',
    'delta_v_rmse_mps', 'bank_mae_deg', 'candidate_detected',
    'external_event_definition', 'external_event_time_s',
    'first_candidate_time_s', 'sensor_latency_ms', 'receiver_latency_ms',
    'notes',
]
rows = []
for _, row in summary.iterrows():
    for slot in range(1, 6):
        rec = {
            'status': 'UNFILLED_ACTUAL_MEASUREMENT',
            'scenario': row.scenario,
            'name': row['name'],
            'class': row['class'],
            'planned_repeat_slot': slot,
            'sim_peak_g': row.sim_peak_g,
            'sim_peak_dps': row.sim_peak_dps,
            'sim_dv_true_mps': row.sim_dv_true_mps,
            'data_peak_g_mean': row.data_peak_g_mean,
            'data_peak_g_std': row.data_peak_g_std,
            'data_peak_dps_mean': row.data_peak_dps_mean,
            'data_dv_est_peak_mps_mean': row.data_dv_est_peak_mps_mean,
        }
        rec.update({'actual_' + name: None for name in measured_columns})
        # Avoid redundant actual_actual_ prefixes in the two identifier fields.
        rec['actual_run_id'] = rec.pop('actual_actual_run_id')
        rec['actual_date'] = rec.pop('actual_actual_date')
        rows.append(rec)
df = pd.DataFrame(rows)
assert len(df) == 145
assert df.filter(regex='^actual_').isna().all().all()
target = DATA / 'TEMPLATE_additional_measurement.csv'
if target.exists():
    existing = pd.read_csv(target)
    if existing.filter(regex='^actual_').notna().any().any():
        raise FileExistsError('The existing template contains measurements; preserve it before creating another template.')
df.to_csv(target, index=False, encoding='utf-8-sig')
print('Comparison template: 145 planned slots, all actual fields empty.')
