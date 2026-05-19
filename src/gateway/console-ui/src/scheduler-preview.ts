export type ScheduleMode = 'cron' | 'interval';

export interface SchedulePreviewFormLike {
  scheduleMode: ScheduleMode;
  cronExpr: string;
  intervalMinutes: number;
}

export interface SchedulePreview {
  valid: boolean;
  cronExpr: string;
  nextRunAt?: number | null;
  error?: string;
}

export interface SchedulePreviewRequest {
  key: string;
  params: {
    cronExpr?: string;
    intervalMinutes?: number;
  };
  fallbackCronExpr: string;
}

export interface SchedulePreviewState {
  preview: SchedulePreview | null;
  loading: boolean;
  requestId: number;
}

export const INITIAL_SCHEDULE_PREVIEW_STATE: SchedulePreviewState = {
  preview: null,
  loading: false,
  requestId: 0,
};

export function buildSchedulePreviewRequest(form: SchedulePreviewFormLike): SchedulePreviewRequest {
  if (form.scheduleMode === 'cron') {
    return {
      key: `cron:${form.cronExpr}`,
      params: {
        cronExpr: form.cronExpr,
      },
      fallbackCronExpr: form.cronExpr,
    };
  }
  return {
    key: `interval:${form.intervalMinutes}`,
    params: {
      intervalMinutes: form.intervalMinutes,
    },
    fallbackCronExpr: `every ${form.intervalMinutes} min`,
  };
}

export function resetSchedulePreviewState(requestId: number): SchedulePreviewState {
  return {
    preview: null,
    loading: false,
    requestId,
  };
}

export function startSchedulePreviewState(
  current: SchedulePreviewState,
  requestId: number,
): SchedulePreviewState {
  return {
    ...current,
    loading: true,
    requestId,
  };
}

export function applySchedulePreviewSuccess(
  current: SchedulePreviewState,
  requestId: number,
  preview: SchedulePreview,
): SchedulePreviewState {
  if (requestId !== current.requestId) {
    return current;
  }
  return {
    ...current,
    preview,
    loading: false,
  };
}

export function applySchedulePreviewFailure(
  current: SchedulePreviewState,
  requestId: number,
  request: SchedulePreviewRequest,
  error: unknown,
): SchedulePreviewState {
  if (requestId !== current.requestId) {
    return current;
  }
  return {
    ...current,
    preview: {
      valid: false,
      cronExpr: request.fallbackCronExpr,
      error: error instanceof Error ? error.message : String(error),
    },
    loading: false,
  };
}