/**
 * Context for tracking a server-side workflow run.
 *
 * The frontend no longer executes steps itself — it calls `workflow.run` on the
 * gateway and polls `workflow.runStatus` at ~500ms intervals. This context just
 * stores the active runId and its associated WorkflowDef for cross-tab banner display.
 */
import {
  type Dispatch,
  type ReactNode,
  type SetStateAction,
  createContext,
  useContext,
  useState,
} from 'react';
import type { WorkflowDef } from '../types.js';

export interface ActiveRunRef {
  runId: string;
  workflowDef: WorkflowDef;
}

export interface WorkflowRunCtxValue {
  activeRunRef: ActiveRunRef | null;
  setActiveRunRef: Dispatch<SetStateAction<ActiveRunRef | null>>;
}

export const WorkflowRunContext = createContext<WorkflowRunCtxValue | null>(null);

export function useWorkflowRun(): WorkflowRunCtxValue {
  const ctx = useContext(WorkflowRunContext);
  if (!ctx) throw new Error('useWorkflowRun must be used inside WorkflowRunProvider');
  return ctx;
}

export function WorkflowRunProvider({ children }: { children: ReactNode }) {
  const [activeRunRef, setActiveRunRef] = useState<ActiveRunRef | null>(null);

  return (
    <WorkflowRunContext.Provider value={{ activeRunRef, setActiveRunRef }}>
      {children}
    </WorkflowRunContext.Provider>
  );
}
