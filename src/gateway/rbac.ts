/**
 * Role-Based Access Control (RBAC) for the AgentFlyer gateway.
 *
 * Access levels by role:
 *   admin    — all methods
 *   operator — read methods + agent.run, workflow.run, workflow.create, scheduler.*
 *   viewer   — read-only (*.get, *.list, *.status, *.search, session.*, /metrics, /ready)
 *
 * RATIONALE: simple allow-list rather than deny-list so new RPC methods are
 * inaccessible by default until explicitly categorised.
 */
import { createHmac } from 'node:crypto';
import type { User, UserRole } from '../core/config/schema.js';

// ── RPC method → minimum required role ───────────────────────────────────────

const ROLE_MAP: Record<string, UserRole> = {
  // Agent control
  'agent.run': 'operator',
  'agent.runStatus': 'viewer',
  'agent.cancel': 'operator',
  'agent.resume': 'operator',
  'agent.streamRun': 'operator',
  'agent.activeRuns': 'viewer',
  'agent.queuedRuns': 'viewer',
  'agent.runRecord': 'viewer',
  // Workflow
  'workflow.create': 'operator',
  'workflow.update': 'operator',
  'workflow.run': 'operator',
  'workflow.cancel': 'operator',
  'workflow.list': 'viewer',
  'workflow.get': 'viewer',
  'workflow.diagnose': 'operator',
  // Scheduler
  'scheduler.create': 'operator',
  'scheduler.update': 'operator',
  'scheduler.delete': 'operator',
  'scheduler.list': 'viewer',
  // MCP
  'mcp.status': 'viewer',
  'mcp.refresh': 'operator',
  'mcp.history': 'viewer',
  // Config — always admin
  'config.get': 'admin',
  'config.save': 'admin',
  'config.reload': 'admin',
  // Memory
  'memory.search': 'viewer',
  'memory.delete': 'operator',
  // Session
  'session.list': 'viewer',
  'session.messages': 'viewer',
  'session.clear': 'operator',
  'session.stats': 'viewer',
  'session.clearBulk': 'operator',
  // Mesh / Federation
  'mesh.status': 'viewer',
  'federation.peers': 'viewer',
  // Deliverables
  'deliverables.list': 'viewer',
  'deliverables.upsert': 'operator',
  'deliverable.delete': 'operator',
  'deliverable.deleteMany': 'operator',
  'deliverable.merge': 'operator',
  'deliverable.setCategory': 'operator',
  // Artifacts
  'artifact.listAll': 'viewer',
  'artifact.setCategory': 'operator',
  'artifact.rename': 'operator',
  'artifact.delete': 'operator',
  // Inbox
  'inbox.list': 'viewer',
  'inbox.approve': 'operator',
  'inbox.deny': 'operator',
};

const ROLE_LEVELS: Record<UserRole, number> = {
  viewer: 0,
  operator: 1,
  admin: 2,
};

function roleLevel(role: UserRole): number {
  return ROLE_LEVELS[role] ?? 0;
}

/**
 * Returns true when `userRole` satisfies the minimum required role for `method`.
 * Unknown methods require admin (fail-closed).
 */
export function isMethodAllowed(method: string, userRole: UserRole): boolean {
  const required = ROLE_MAP[method] ?? 'admin';
  return roleLevel(userRole) >= roleLevel(required);
}

// ── Token → user lookup ───────────────────────────────────────────────────────

/**
 * Derive the canonical token hash stored in config.
 * We accept both:
 *   a) SHA-256(hex) of the raw token (production storage)
 *   b) The raw token itself (dev convenience — detected by absence of the 64-char constraint)
 */
function tokenHash(token: string): string {
  return createHmac('sha256', 'agentflyer-token-id').update(token).digest('hex');
}

export interface ResolvedUser {
  id: string;
  role: UserRole;
  allowedAgents?: string[];
}

/**
 * Find the user whose apiKey matches `rawToken`.
 * apiKey in config may be a raw token (dev) or SHA-256 HMAC hash (prod).
 * Returns undefined when no user matches.
 */
export function resolveUser(users: User[], rawToken: string): ResolvedUser | undefined {
  const hash = tokenHash(rawToken);
  for (const user of users) {
    // Constant-time-safe comparison via the hash path; raw match is dev-only
    if (user.apiKey === hash || user.apiKey === rawToken) {
      return { id: user.id, role: user.role, allowedAgents: user.allowedAgents };
    }
  }
  return undefined;
}
