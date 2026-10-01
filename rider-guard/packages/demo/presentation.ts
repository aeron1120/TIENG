import type { DetectionV1, SensorAnalysis } from '../contract/index.ts';
import type { DemoAction, DemoState, EventClip, ScenarioId } from './engine.ts';

/** The server owns the source clip; clients send only elapsed time. */
export type PresentationAction = Exclude<DemoAction, { type: 'tick' }> | { type: 'tick'; dt: number };
export type PresentationCommand = { seq: number; action: PresentationAction };
export type PresentationSource = {
  kind: 'integrated' | 'experiment' | 'import';
  label: string;
  note: string;
  caseId: string | null;
};
export type PresentationSession = {
  id: string;
  source: PresentationSource;
  state: DemoState;
  clip: EventClip;
  analysis: SensorAnalysis | null;
  detection: DetectionV1 | null;
  lastSequence: number;
  receivedAt: string;
  expiresAt: string;
};
export type CreatePresentation = {
  scenario?: ScenarioId;
  caseId?: string;
  detection?: DetectionV1;
  origin?: 'integrated';
  baseWall?: number;
};
/** Capabilities appear only in the creation response, never in a session/report. */
export type CreatedPresentation = PresentationSession & { readToken: string; writeToken: string; monitorPath: string };
