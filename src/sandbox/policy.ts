import {
  DEFAULT_SANDBOX_PROFILES,
  type SandboxConfig,
  type SandboxProfileConfig,
} from '../core/config/schema.js';

export interface ResolvedSandboxProfile extends SandboxProfileConfig {
  name: string;
}

function cloneProfile(profile: SandboxProfileConfig): SandboxProfileConfig {
  return {
    network: profile.network,
    cpu: profile.cpu,
    memoryMb: profile.memoryMb,
    timeoutMs: profile.timeoutMs,
    writableMounts: [...profile.writableMounts],
    readOnlyMounts: [...profile.readOnlyMounts],
  };
}

export function resolveSandboxProfiles(
  config: SandboxConfig | undefined,
): Record<string, SandboxProfileConfig> {
  const merged: Record<string, SandboxProfileConfig> = {};

  for (const [name, profile] of Object.entries(DEFAULT_SANDBOX_PROFILES)) {
    merged[name] = cloneProfile(profile);
  }

  for (const [name, profile] of Object.entries(config?.profiles ?? {})) {
    merged[name] = cloneProfile(profile);
  }

  return merged;
}

export function resolveSandboxProfile(
  config: SandboxConfig | undefined,
  profileName?: string,
): ResolvedSandboxProfile {
  const profiles = resolveSandboxProfiles(config);
  const selectedName = profileName ?? config?.defaultProfile ?? 'restricted';
  const profile = profiles[selectedName];
  if (!profile) {
    throw new Error(`Sandbox profile not found: ${selectedName}`);
  }
  return {
    name: selectedName,
    ...cloneProfile(profile),
  };
}
