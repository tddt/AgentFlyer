import { describe, expect, it } from 'vitest';
import {
  applySchedulePreviewFailure,
  applySchedulePreviewSuccess,
  buildSchedulePreviewRequest,
  INITIAL_SCHEDULE_PREVIEW_STATE,
  resetSchedulePreviewState,
  startSchedulePreviewState,
} from './scheduler-preview.js';

describe('scheduler-preview', () => {
  it('builds cron and interval preview requests with stable fallback text', () => {
    expect(
      buildSchedulePreviewRequest({
        scheduleMode: 'cron',
        cronExpr: '*/5 * * * *',
        intervalMinutes: 5,
      }),
    ).toEqual({
      key: 'cron:*/5 * * * *',
      params: { cronExpr: '*/5 * * * *' },
      fallbackCronExpr: '*/5 * * * *',
    });

    expect(
      buildSchedulePreviewRequest({
        scheduleMode: 'interval',
        cronExpr: '',
        intervalMinutes: 15,
      }),
    ).toEqual({
      key: 'interval:15',
      params: { intervalMinutes: 15 },
      fallbackCronExpr: 'every 15 min',
    });
  });

  it('ignores stale preview responses after a newer request has started', () => {
    const requestA = buildSchedulePreviewRequest({
      scheduleMode: 'cron',
      cronExpr: '0 * * * *',
      intervalMinutes: 60,
    });
    const requestB = buildSchedulePreviewRequest({
      scheduleMode: 'interval',
      cronExpr: '',
      intervalMinutes: 30,
    });

    const startedA = startSchedulePreviewState(INITIAL_SCHEDULE_PREVIEW_STATE, 1);
    const startedB = startSchedulePreviewState(startedA, 2);
    const appliedB = applySchedulePreviewSuccess(startedB, 2, {
      valid: true,
      cronExpr: '*/30 * * * *',
      nextRunAt: 123,
    });
    const staleA = applySchedulePreviewFailure(appliedB, 1, requestA, new Error('old invalid cron'));

    expect(staleA).toEqual(appliedB);
    expect(staleA.preview?.cronExpr).toBe('*/30 * * * *');
    expect(staleA.loading).toBe(false);
    expect(requestB.fallbackCronExpr).toBe('every 30 min');
  });

  it('invalidates any in-flight response when the modal state resets', () => {
    const reset = resetSchedulePreviewState(5);
    const afterStaleSuccess = applySchedulePreviewSuccess(reset, 4, {
      valid: true,
      cronExpr: '0 0 * * *',
    });

    expect(reset).toEqual({ preview: null, loading: false, requestId: 5 });
    expect(afterStaleSuccess).toEqual(reset);
  });
});