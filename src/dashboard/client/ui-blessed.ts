import * as blessed from "blessed";

import { connectControlPlaneEvents, fetchControlPlaneState, DashboardApiError } from "./api";
import {
  createDashboardModel,
  reduceDashboardModel,
  selectConnection,
  selectHasWorkerEvents,
  selectLogs,
  selectSelectedKey,
  selectWorkerRows,
  type LogTab,
} from "./core";

export type DashboardTuiOptions = {
  baseUrl: string;
  token: string;
  replayLast: number;
};

const RENDER_THROTTLE_MS = 50;

function formatDuration(ms: number | null): string {
  if (!ms && ms !== 0) return "-";
  const totalSeconds = Math.floor(ms / 1000);
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return `${hours}h${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1))}…`;
}

function formatRow(row: ReturnType<typeof selectWorkerRows>[number], width: number): string {
  const anomaly = row.anomalyRecentBurst ? "!" : row.anomalyTotal ? "*" : " ";
  const repo = row.repo || "-";
  const issue = row.issue ? `#${row.issue}` : "";
  const task = row.taskName || "-";
  const checkpoint = row.checkpoint || "-";
  const activity = row.activity || "-";
  const elapsed = formatDuration(row.elapsedMs);
  const base = `${anomaly} ${repo} ${issue} | ${task} | ${checkpoint} | ${activity} | ${elapsed}`.trim();
  return truncate(base, Math.max(10, width - 2));
}

function formatTabs(active: LogTab): string {
  return active === "ralph" ? "[Ralph]  Session" : "Ralph  [Session]";
}

function formatFooter(status: string, hint: string | null): string {
  const base = `Status: ${status} | j/k: move  Tab: switch  q: quit`;
  return hint ? `${base} | ${hint}` : base;
}

function safeExit(): void {
  const globalAny = globalThis as typeof globalThis & {
    Bun?: { exit?: (code: number) => void };
    process?: { exit?: (code: number) => void };
  };
  if (globalAny.Bun?.exit) globalAny.Bun.exit(0);
  else globalAny.process?.exit?.(0);
}

export async function startDashboardTui(options: DashboardTuiOptions): Promise<void> {
  const screen = blessed.screen({ smartCSR: true, title: "Ralph Dashboard" });
  const list = blessed.list({
    parent: screen,
    label: "Workers",
    width: "45%",
    height: "100%-1",
    top: 0,
    left: 0,
    keys: true,
    mouse: true,
    border: "line",
    style: {
      selected: { bg: "blue" },
    },
    scrollbar: {
      ch: " ",
      inverse: true,
    },
  });

  const tabs = blessed.box({
    parent: screen,
    top: 0,
    left: "45%",
    width: "55%",
    height: 1,
    tags: false,
  });

  const logs = blessed.box({
    parent: screen,
    top: 1,
    left: "45%",
    width: "55%",
    height: "100%-2",
    border: "line",
    scrollable: true,
    alwaysScroll: true,
    keys: true,
    mouse: true,
  });

  const footer = blessed.box({
    parent: screen,
    bottom: 0,
    left: 0,
    width: "100%",
    height: 1,
  });

  let activeTab: LogTab = "ralph";
  let model = createDashboardModel();
  let renderPending = false;

  const dispatch = (action: Parameters<typeof reduceDashboardModel>[1]) => {
    model = reduceDashboardModel(model, action);
    scheduleRender();
  };

  const scheduleRender = () => {
    if (renderPending) return;
    renderPending = true;
    setTimeout(() => {
      renderPending = false;
      render();
    }, RENDER_THROTTLE_MS);
  };

  const render = () => {
    const rows = selectWorkerRows(model, Date.now());
    const width = typeof list.width === "number" ? list.width : screen.width * 0.45;
    const items = rows.length === 0 ? ["(no workers yet)"] : rows.map((row) => formatRow(row, width));
    list.setItems(items);

    const selectedKey = selectSelectedKey(model);
    if (rows.length > 0 && selectedKey) {
      const index = rows.findIndex((row) => row.key === selectedKey);
      if (index >= 0) list.select(index);
    }

    tabs.setContent(formatTabs(activeTab));

    const logLines = selectLogs(model, selectedKey, activeTab);
    logs.setContent(logLines.length ? logLines.join("\n") : "(no logs yet)");
    logs.setScrollPerc(100);

    const connection = selectConnection(model);
    const hint = selectHasWorkerEvents(model) || rows.length === 0 ? null : "no worker events in replay; try --replay-last 250";
    footer.setContent(formatFooter(connection.status, hint));

    screen.render();
  };

  list.key(["j", "down"], () => list.down(1));
  list.key(["k", "up"], () => list.up(1));
  list.on("select", (_item: blessed.Widgets.BlessedElement, index: number) => {
    const rows = selectWorkerRows(model, Date.now());
    const row = rows[index];
    if (row) dispatch({ type: "select.row", key: row.key });
  });

  screen.key(["tab"], () => {
    activeTab = activeTab === "ralph" ? "session" : "ralph";
    scheduleRender();
  });

  screen.key(["q", "C-c"], () => {
    screen.destroy();
    safeExit();
  });

  screen.on("resize", () => scheduleRender());
  list.focus();

  dispatch({ type: "connection.status", status: "connecting", ts: Date.now() });

  try {
    const snapshot = await fetchControlPlaneState(options.baseUrl, options.token);
    dispatch({ type: "snapshot.received", snapshot, receivedAt: Date.now() });
  } catch (error: any) {
    if (error instanceof DashboardApiError && error.code === "unauthorized") {
      dispatch({ type: "connection.status", status: "unauthorized", message: error.message, ts: Date.now() });
      scheduleRender();
      return;
    }
    dispatch({ type: "connection.status", status: "disconnected", message: error?.message ?? String(error), ts: Date.now() });
  }

  connectControlPlaneEvents({
    baseUrl: options.baseUrl,
    token: options.token,
    replayLast: options.replayLast,
    handlers: {
      onEvent: (event, meta) => dispatch({ type: "event.received", event, receivedAt: meta.receivedAt, eventTsMs: meta.eventTsMs }),
      onStatus: (status, message) => dispatch({ type: "connection.status", status, message, ts: Date.now() }),
      onError: () => {
        // ignore individual parse errors
      },
    },
  });

  render();
}
