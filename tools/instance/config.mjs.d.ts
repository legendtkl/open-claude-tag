export interface IsolatedInstanceConfig {
  instanceRole: 'primary' | 'isolated';
  instanceId: string;
  port: number;
  apiUrl: string;
  databaseUrl: string;
  apiPidPath: string;
  workerPidPath: string;
  cwd: string;
}

export function sanitizeInstanceId(rawValue: string): string;
export function deriveInstanceRole(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): 'primary' | 'isolated';
export function deriveInstanceId(params?: { cwd?: string; env?: NodeJS.ProcessEnv }): string;
export function deriveApiPort(instanceId: string): number;
export function deriveApiUrl(port: number): string;
export function derivePidPaths(params: {
  instanceRole: 'primary' | 'isolated';
  instanceId: string;
}): { apiPidPath: string; workerPidPath: string };
export function deriveDatabaseUrl(baseDatabaseUrl: string, instanceId: string): string;
export function buildIsolatedInstanceConfig(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): IsolatedInstanceConfig;
export function buildIsolatedEnv(params?: {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv;
