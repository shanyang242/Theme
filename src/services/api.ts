import { z } from "zod";
import { getRpc2Client } from "@/services/rpc2Client";
import {
  MeSchema,
  NodeInfoSchema,
  PublicConfigSchema,
  AdminClientSchema,
  LoadRecordSchema,
  PingRecordSchema,
  PingTaskSchema,
  PingBasicInfoSchema,
  type Me,
  type NodeInfo,
  type PublicConfig,
  type AdminClient,
  type LoadRecordsResponse,
  type PingRecordsResponse,
  type PingTask,
  type PingBasicInfo,
} from "@/types/komari";

const ApiEnvelope = <T extends z.ZodTypeAny>(inner: T) =>
  z.object({
    status: z.string().optional(),
    message: z.string().optional(),
    data: inner,
  });

const RpcRecordsSchema = z
  .object({
    count: z.number().default(0),
    records: z.unknown().optional(),
    tasks: z.unknown().optional(),
    basic_info: z.unknown().optional(),
  })
  .passthrough();

const LOAD_RECORDS_PER_HOUR = 12;
const PING_RECORDS_PER_HOUR = 240;
const MAX_RPC_RECORDS = 20_000;
const OVERVIEW_PING_MAX_COUNT = 4_000;

interface RpcRecordsPayload {
  count?: number;
  records?: unknown;
  tasks?: unknown;
  basic_info?: unknown;
}

interface PingOverviewResponse {
  count: number;
  records: PingRecordsResponse["records"];
  tasks: PingTask[];
  basicInfo: PingBasicInfo[];
}

export class ApiRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly path: string,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

function normalizeRpcLatestStatus(
  payload: unknown,
): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    const maybeRecords = (payload as Record<string, unknown>).records;
    const wrapped = z.record(z.string(), z.unknown()).safeParse(maybeRecords);
    if (wrapped.success) {
      return wrapped.data;
    }
  }

  const direct = z.record(z.string(), z.unknown()).safeParse(payload);
  if (direct.success) {
    return direct.data;
  }

  return {};
}

function getRecordsMaxCount(hours: number, recordsPerHour: number) {
  const safeHours = Number.isFinite(hours) && hours > 0 ? hours : 1;
  return Math.min(
    MAX_RPC_RECORDS,
    Math.max(recordsPerHour, Math.ceil(safeHours * recordsPerHour)),
  );
}

async function apiGet<T>(path: string, schema: z.ZodType<T>): Promise<T> {
  const resp = await fetch(path, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!resp.ok) {
    throw new ApiRequestError(`Request ${path} failed: ${resp.status}`, resp.status, path);
  }
  const json = (await resp.json()) as unknown;
  const envelopeResult = ApiEnvelope(schema).safeParse(json);
  if (envelopeResult.success) return envelopeResult.data.data as T;
  const rawResult = schema.safeParse(json);
  if (rawResult.success) return rawResult.data;
  throw new Error(
    `Schema mismatch on ${path}: ${envelopeResult.error.issues[0]?.message ?? ""}`,
  );
}

async function rpcCall<T>(
  method: string,
  params: Record<string, unknown>,
  schema: z.ZodType<T>,
): Promise<T> {
  const payload = await getRpc2Client().call(method, params);
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new Error(
      `Schema mismatch on rpc:${method}: ${parsed.error.issues[0]?.message ?? ""}`,
    );
  }
  return parsed.data;
}

// Drops individual malformed rows instead of throwing on the whole array. A
// single bad record must not make the RPC normalize throw, because the callers
// catch that and fall back to a full HTTP request — turning one bad row into a
// permanent RPC + HTTP double-fetch on every poll.
function parseArrayLenient<S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S>[] {
  if (!Array.isArray(value)) return [];
  const out: z.infer<S>[] = [];
  for (const item of value) {
    const parsed = schema.safeParse(item);
    if (parsed.success) out.push(parsed.data);
  }
  return out;
}

function extractRpcRecords(payload: RpcRecordsPayload, key?: string): unknown[] {
  if (Array.isArray(payload.records)) return payload.records;
  if (!payload.records || typeof payload.records !== "object") return [];

  const recordsByKey = payload.records as Record<string, unknown>;
  if (key && Array.isArray(recordsByKey[key])) {
    return recordsByKey[key];
  }

  return Object.values(recordsByKey).flatMap((value) =>
    Array.isArray(value) ? value : [],
  );
}

function normalizeRpcLoadRecords(
  uuid: string,
  payload: RpcRecordsPayload,
): LoadRecordsResponse {
  const records = parseArrayLenient(LoadRecordSchema, extractRpcRecords(payload, uuid));
  return {
    count: payload.count || records.length,
    records,
  };
}

function derivePingTasks(records: PingRecordsResponse["records"]): PingTask[] {
  return Array.from(new Set(records.map((record) => record.task_id)))
    .sort((a, b) => a - b)
    .map((id) => ({
      id,
      interval: 60,
      name: `任务 #${id}`,
      loss: 0,
      clients: [],
      type: "icmp",
      target: "",
      weight: id,
    }));
}

function normalizeRpcPingRecords(
  uuid: string,
  payload: RpcRecordsPayload,
): PingRecordsResponse {
  const records = parseArrayLenient(PingRecordSchema, extractRpcRecords(payload, uuid));
  const parsedTasks = z.array(PingTaskSchema).safeParse(payload.tasks);
  const tasks = parsedTasks.success ? parsedTasks.data : derivePingTasks(records);
  return {
    count: payload.count || records.length,
    records,
    tasks,
  };
}

function normalizeRpcPingOverview(
  payload: RpcRecordsPayload,
): PingOverviewResponse {
  const records = parseArrayLenient(PingRecordSchema, extractRpcRecords(payload));
  const parsedTasks = z.array(PingTaskSchema).safeParse(payload.tasks);
  const basicInfo = z.array(PingBasicInfoSchema).safeParse(payload.basic_info);
  return {
    count: payload.count || records.length,
    records,
    tasks: parsedTasks.success ? parsedTasks.data : derivePingTasks(records),
    basicInfo: basicInfo.success ? basicInfo.data : [],
  };
}

export async function getMe(): Promise<Me> {
  return (await apiGet("/api/me", MeSchema)) as Me;
}

export async function getPublic(): Promise<PublicConfig> {
  return (await apiGet("/api/public", PublicConfigSchema)) as PublicConfig;
}

export async function getNodesLatestStatus(
  uuids?: string[],
): Promise<Record<string, unknown>> {
  const payload = await rpcCall(
    "common:getNodesLatestStatus",
    uuids && uuids.length > 0 ? { uuids } : {},
    z.unknown(),
  );
  return normalizeRpcLatestStatus(payload);
}

export async function getNodes(): Promise<NodeInfo[]> {
  return (await apiGet("/api/nodes", z.array(NodeInfoSchema))) as NodeInfo[];
}

export async function getAdminClients(): Promise<AdminClient[]> {
  return (await apiGet("/api/admin/client/list", z.array(AdminClientSchema))) as AdminClient[];
}

export async function getLoadRecords(
  uuid: string,
  hours = 6,
): Promise<LoadRecordsResponse> {
  try {
    const maxCount = getRecordsMaxCount(hours, LOAD_RECORDS_PER_HOUR);
    const payload = await rpcCall(
      "common:getRecords",
      {
        uuid,
        hours,
        type: "load",
        maxCount,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcLoadRecords(uuid, payload);
  } catch {
    return (await apiGet(
      `/api/records/load?uuid=${encodeURIComponent(uuid)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(LoadRecordSchema).default([]),
      }),
    )) as LoadRecordsResponse;
  }
}

export async function getPingRecords(
  uuid: string,
  hours = 6,
): Promise<PingRecordsResponse> {
  try {
    const maxCount = getRecordsMaxCount(hours, PING_RECORDS_PER_HOUR);
    const payload = await rpcCall(
      "common:getRecords",
      {
        uuid,
        hours,
        type: "ping",
        maxCount,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcPingRecords(uuid, payload);
  } catch {
    return (await apiGet(
      `/api/records/ping?uuid=${encodeURIComponent(uuid)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(PingRecordSchema).default([]),
        tasks: z.array(PingTaskSchema).default([]),
      }),
    )) as PingRecordsResponse;
  }
}

export async function getAdminPingTasks(): Promise<PingTask[]> {
  return (await apiGet("/api/admin/ping", z.array(PingTaskSchema))) as PingTask[];
}

export async function saveThemeSettings(
  theme: string,
  settings: Record<string, unknown>,
): Promise<void> {
  const resp = await fetch(`/api/admin/theme/settings?theme=${encodeURIComponent(theme)}`, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(settings),
  });

  if (!resp.ok) {
    let message = `Request /api/admin/theme/settings failed: ${resp.status}`;
    try {
      const json = (await resp.json()) as { message?: string };
      if (json?.message) {
        message = json.message;
      }
    } catch {
      // Keep the fallback error message when the body is not JSON.
    }
    throw new ApiRequestError(message, resp.status, "/api/admin/theme/settings");
  }
}

export async function getPingOverview(
  hours = 1,
  taskId?: number,
): Promise<PingOverviewResponse> {
  try {
    const payload = await rpcCall(
      "common:getRecords",
      {
        hours,
        type: "ping",
        ...(taskId ? { task_id: taskId } : {}),
        maxCount: OVERVIEW_PING_MAX_COUNT,
      },
      RpcRecordsSchema,
    );
    return normalizeRpcPingOverview(payload);
  } catch {
    if (!taskId) {
      throw new Error("Ping overview fallback requires a concrete task_id");
    }

    const data = await apiGet(
      `/api/records/ping?task_id=${encodeURIComponent(taskId)}&hours=${hours}`,
      z.object({
        count: z.number().default(0),
        records: z.array(PingRecordSchema).default([]),
        tasks: z.array(PingTaskSchema).default([]),
        basic_info: z.array(PingBasicInfoSchema).default([]),
      }),
    );
    return {
      count: data.count,
      records: data.records,
      tasks: data.tasks,
      basicInfo: data.basic_info,
    } as PingOverviewResponse;
  }
}
