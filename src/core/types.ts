export interface Monitor {
  id: number;
  name: string;
  url: string;
  method: string;
  expectStatus: number;
  timeoutMs: number;
  intervalS: number;
  active: boolean;
  createdAt: string;
}

export interface Check {
  id: number;
  monitorId: number;
  checkedAt: string;
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export interface CheckResult {
  ok: boolean;
  statusCode: number | null;
  latencyMs: number | null;
  error: string | null;
}

export type DayState = 'up' | 'degraded' | 'down' | 'nodata';

export interface DayBucket {
  date: string;
  total: number;
  ok: number;
  pct: number | null;
  state: DayState;
  avgLatencyMs: number | null;
}

export interface MonitorStatus {
  monitor: Monitor;
  lastCheck: Check | null;
  state: DayState;
  uptime24h: number | null;
  uptime90d: number | null;
  avgLatencyMs24h: number | null;
  openIncident: { id: number; startedAt: string; reason: string } | null;
}
