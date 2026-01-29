import type { ControlPlaneStateV1 } from "../control-plane-state";
import type { RalphEvent } from "../events";

export type ConnectionStatus = "connecting" | "connected" | "disconnected" | "unauthorized";
export type LogTab = "ralph" | "session";

export type WorkerRow = {
  key: string;
  repo: string;
  issue: string;
  taskName: string;
  taskId?: string;
  status?: string;
  workerId?: string;
  sessionId?: string;
  checkpoint?: string;
  activity?: string;
  lastEventTs?: number;
  busySince?: number | null;
  idleSince?: number | null;
  anomalyTotal?: number;
  anomalyRecentBurst?: boolean;
  logs: {
    ralph: string[];
    session: string[];
  };
};

export type ConnectionState = {
  status: ConnectionStatus;
  message?: string;
  updatedAt?: number;
};

export type DashboardModel = {
  rows: Record<string, WorkerRow>;
  order: string[];
  workerIdToKey: Record<string, string>;
  selectedKey: string | null;
  connection: ConnectionState;
  hasWorkerEvents: boolean;
};

export type WorkerRowView = WorkerRow & {
  elapsedMs: number | null;
};

export type DashboardAction =
  | { type: "snapshot.received"; snapshot: ControlPlaneStateV1; receivedAt: number }
  | { type: "event.received"; event: RalphEvent; receivedAt: number; eventTsMs: number | null }
  | { type: "connection.status"; status: ConnectionStatus; message?: string; ts: number }
  | { type: "select.row"; key: string | null };

const MAX_LOG_LINES = 200;

export function createDashboardModel(): DashboardModel {
  return {
    rows: {},
    order: [],
    workerIdToKey: {},
    selectedKey: null,
    connection: { status: "disconnected" },
    hasWorkerEvents: false,
  };
}

function buildRowKey(repo: string, issue: string, taskName: string): string {
  return `${repo}#${issue}:${taskName}`;
}

function ensureRow(model: DashboardModel, key: string, seed: Partial<WorkerRow>): WorkerRow {
  const existing = model.rows[key];
  if (existing) {
    const updated: WorkerRow = {
      ...existing,
      ...seed,
      logs: existing.logs,
    };
    model.rows[key] = updated;
    return updated;
  }

  const created: WorkerRow = {
    key,
    repo: seed.repo ?? "",
    issue: seed.issue ?? "",
    taskName: seed.taskName ?? "",
    taskId: seed.taskId,
    status: seed.status,
    workerId: seed.workerId,
    sessionId: seed.sessionId,
    checkpoint: seed.checkpoint,
    activity: seed.activity,
    lastEventTs: seed.lastEventTs,
    busySince: seed.busySince ?? null,
    idleSince: seed.idleSince ?? null,
    anomalyTotal: seed.anomalyTotal,
    anomalyRecentBurst: seed.anomalyRecentBurst,
    logs: {
      ralph: [],
      session: [],
    },
  };
  model.rows[key] = created;
  model.order.push(key);
  return created;
}

function mergeSnapshotRow(model: DashboardModel, row: WorkerRow, seed: Partial<WorkerRow>): void {
  model.rows[row.key] = {
    ...row,
    repo: seed.repo ?? row.repo,
    issue: seed.issue ?? row.issue,
    taskName: seed.taskName ?? row.taskName,
    taskId: seed.taskId ?? row.taskId,
    status: seed.status ?? row.status,
    sessionId: seed.sessionId ?? row.sessionId,
    lastEventTs: row.lastEventTs ?? seed.lastEventTs,
    logs: row.logs,
  };
}

function findRowBySession(model: DashboardModel, sessionId?: string | null): string | null {
  if (!sessionId) return null;
  for (const key of model.order) {
    const row = model.rows[key];
    if (row?.sessionId && row.sessionId === sessionId) return key;
  }
  return null;
}

function findRowByTaskId(model: DashboardModel, taskId?: string | null): string | null {
  if (!taskId) return null;
  for (const key of model.order) {
    const row = model.rows[key];
    if (row?.taskId === taskId || row?.taskName === taskId) return key;
  }
  return null;
}

function extractTaskInfoFromEvent(event: RalphEvent): { taskName?: string; issue?: string } {
  if (event.type === "worker.became_busy" || event.type === "task.assigned") {
    const data = event.data as { taskName?: string; issue?: string };
    return { taskName: data.taskName, issue: data.issue };
  }
  return {};
}

function findOrCreateRowForEvent(model: DashboardModel, event: RalphEvent, eventTsMs: number | null): WorkerRow {
  const workerId = event.workerId?.trim();
  if (workerId) {
    const existingKey = model.workerIdToKey[workerId];
    if (existingKey && model.rows[existingKey]) return model.rows[existingKey];
  }

  const sessionMatch = findRowBySession(model, event.sessionId);
  if (sessionMatch) return model.rows[sessionMatch];

  const taskMatch = findRowByTaskId(model, event.taskId);
  if (taskMatch) return model.rows[taskMatch];

  const { taskName, issue } = extractTaskInfoFromEvent(event);
  if (taskName && issue && event.repo) {
    const key = buildRowKey(event.repo, issue, taskName);
    const row = ensureRow(model, key, {
      repo: event.repo ?? "",
      issue,
      taskName,
      workerId: workerId,
      lastEventTs: eventTsMs ?? undefined,
    });
    if (workerId) model.workerIdToKey[workerId] = key;
    return row;
  }

  if (workerId) {
    const key = `worker:${workerId}`;
    const row = ensureRow(model, key, {
      repo: event.repo ?? "",
      issue: "",
      taskName: "(unknown task)",
      workerId,
      lastEventTs: eventTsMs ?? undefined,
    });
    model.workerIdToKey[workerId] = key;
    return row;
  }

  const key = "global";
  return ensureRow(model, key, {
    repo: event.repo ?? "",
    issue: "",
    taskName: "(unknown)",
    lastEventTs: eventTsMs ?? undefined,
  });
}

function formatTimestamp(tsMs: number | null): string {
  if (!tsMs) return "";
  const date = new Date(tsMs);
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  const ss = String(date.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

function appendLog(lines: string[], text: string, limit: number): string[] {
  const next = [...lines, ...text.split("\n")];
  if (next.length <= limit) return next;
  return next.slice(next.length - limit);
}

function logPayloadToString(event: RalphEvent, tsMs: number | null): { tab: LogTab; line: string } | null {
  const prefix = formatTimestamp(tsMs);
  const label = prefix ? `[${prefix}] ` : "";

  if (event.type === "log.ralph" || event.type === "log.worker") {
    const message = (event.data as { message?: string })?.message ?? "";
    return { tab: "ralph", line: `${label}${message}`.trimEnd() };
  }

  if (event.type === "log.opencode.text") {
    const text = (event.data as { text?: string })?.text ?? "";
    return { tab: "session", line: `${label}${text}`.trimEnd() };
  }

  if (event.type === "log.opencode.event") {
    const payload = (event.data as { event?: unknown })?.event ?? null;
    const serialized = payload === null ? "" : JSON.stringify(payload);
    return { tab: "session", line: `${label}${serialized}`.trimEnd() };
  }

  return null;
}

function updateSelection(model: DashboardModel): void {
  if (model.selectedKey && model.rows[model.selectedKey]) return;
  model.selectedKey = model.order.length > 0 ? model.order[0] : null;
}

function applySnapshot(model: DashboardModel, snapshot: ControlPlaneStateV1, receivedAt: number): void {
  const seedTasks = [
    ...snapshot.inProgress.map((task) => ({ task, status: "in_progress" })),
    ...snapshot.starting.map((task) => ({ task, status: "starting" })),
    ...snapshot.blocked.map((task) => ({ task, status: "blocked" })),
    ...snapshot.throttled.map((task) => ({ task, status: "throttled" })),
  ];

  const getSessionId = (task: unknown): string | undefined => {
    if (!task || typeof task !== "object") return undefined;
    const sessionId = (task as { sessionId?: unknown }).sessionId;
    if (typeof sessionId !== "string") return undefined;
    return sessionId.trim() ? sessionId : undefined;
  };

  for (const { task, status } of seedTasks) {
    const key = buildRowKey(task.repo, task.issue, task.name);
    const seed: Partial<WorkerRow> = {
      repo: task.repo,
      issue: task.issue,
      taskName: task.name,
      status,
      sessionId: getSessionId(task),
      lastEventTs: receivedAt,
      busySince: status === "in_progress" ? receivedAt : undefined,
    };

    if (model.rows[key]) mergeSnapshotRow(model, model.rows[key], seed);
    else ensureRow(model, key, seed);
  }
}

function applyEvent(model: DashboardModel, event: RalphEvent, receivedAt: number, eventTsMs: number | null): void {
  if (event.workerId) model.hasWorkerEvents = true;
  const row = findOrCreateRowForEvent(model, event, eventTsMs);

  if (event.workerId && row.key) {
    row.workerId = event.workerId;
    model.workerIdToKey[event.workerId] = row.key;
  }

  if (event.repo) row.repo = row.repo || event.repo;
  if (event.taskId) row.taskId = row.taskId ?? event.taskId;
  if (event.sessionId) row.sessionId = row.sessionId ?? event.sessionId;

  row.lastEventTs = eventTsMs ?? receivedAt;

  if (event.type === "worker.became_busy") {
    const data = event.data as { taskName?: string; issue?: string };
    if (data.taskName) row.taskName = data.taskName;
    if (data.issue) row.issue = data.issue;
    row.busySince = eventTsMs ?? receivedAt;
    row.idleSince = null;
    row.status = "in_progress";
  }

  if (event.type === "worker.became_idle") {
    row.idleSince = eventTsMs ?? receivedAt;
    row.busySince = null;
    row.status = "idle";
  }

  if (event.type === "worker.checkpoint.reached") {
    const data = event.data as { checkpoint?: string };
    if (data.checkpoint) row.checkpoint = data.checkpoint;
  }

  if (event.type === "worker.activity.updated") {
    const data = event.data as { activity?: string };
    if (data.activity) row.activity = data.activity;
  }

  if (event.type === "worker.anomaly.updated") {
    const data = event.data as { total?: number; recentBurst?: boolean };
    if (typeof data.total === "number") row.anomalyTotal = data.total;
    if (typeof data.recentBurst === "boolean") row.anomalyRecentBurst = data.recentBurst;
  }

  const logPayload = logPayloadToString(event, eventTsMs ?? receivedAt);
  if (logPayload) {
    const target = row.logs[logPayload.tab];
    row.logs[logPayload.tab] = appendLog(target, logPayload.line, MAX_LOG_LINES);
  }
}

export function reduceDashboardModel(model: DashboardModel, action: DashboardAction): DashboardModel {
  const next: DashboardModel = {
    ...model,
    rows: { ...model.rows },
    order: [...model.order],
    workerIdToKey: { ...model.workerIdToKey },
    connection: { ...model.connection },
  };

  switch (action.type) {
    case "snapshot.received":
      applySnapshot(next, action.snapshot, action.receivedAt);
      updateSelection(next);
      return next;
    case "event.received":
      applyEvent(next, action.event, action.receivedAt, action.eventTsMs);
      updateSelection(next);
      return next;
    case "connection.status":
      next.connection = {
        status: action.status,
        message: action.message,
        updatedAt: action.ts,
      };
      return next;
    case "select.row":
      next.selectedKey = action.key;
      updateSelection(next);
      return next;
    default:
      return next;
  }
}

export function selectWorkerRows(model: DashboardModel, nowMs: number): WorkerRowView[] {
  return model.order
    .map((key) => model.rows[key])
    .filter(Boolean)
    .map((row) => {
      const elapsedBase = row.busySince ?? row.idleSince ?? row.lastEventTs ?? null;
      const elapsedMs = elapsedBase ? Math.max(0, nowMs - elapsedBase) : null;
      return { ...row, elapsedMs };
    });
}

export function selectLogs(model: DashboardModel, key: string | null, tab: LogTab): string[] {
  if (!key || !model.rows[key]) return [];
  return model.rows[key].logs[tab];
}

export function selectConnection(model: DashboardModel): ConnectionState {
  return model.connection;
}

export function selectSelectedKey(model: DashboardModel): string | null {
  return model.selectedKey;
}

export function selectHasWorkerEvents(model: DashboardModel): boolean {
  return model.hasWorkerEvents;
}
