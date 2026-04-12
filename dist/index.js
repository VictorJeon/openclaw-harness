var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __esm = (fn, res) => function __init() {
  return fn && (res = (0, fn[__getOwnPropNames(fn)[0]])(fn = 0)), res;
};
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/checkpoint.ts
var checkpoint_exports = {};
__export(checkpoint_exports, {
  cleanupStaleCheckpoints: () => cleanupStaleCheckpoints,
  findRecoverableCheckpoint: () => findRecoverableCheckpoint,
  getPendingTasks: () => getPendingTasks,
  initCheckpoint: () => initCheckpoint,
  loadCheckpoint: () => loadCheckpoint,
  recordSession: () => recordSession,
  saveCheckpoint: () => saveCheckpoint,
  updateTaskStatus: () => updateTaskStatus
});
function normalizeWorkdirPath(workdir) {
  const resolved = (0, import_path3.resolve)(workdir);
  try {
    return typeof import_fs3.realpathSync.native === "function" ? import_fs3.realpathSync.native(resolved) : (0, import_fs3.realpathSync)(resolved);
  } catch {
    return resolved;
  }
}
function checkpointDir(workdir, runId) {
  return (0, import_path3.join)("/tmp", "harness", runId);
}
function checkpointPath(workdir, runId) {
  return (0, import_path3.join)(checkpointDir(workdir, runId), "checkpoint.json");
}
function initCheckpoint(plan, workdir, executionWorkdir = workdir) {
  const checkpoint = {
    runId: plan.id,
    workdir: normalizeWorkdirPath(workdir),
    executionWorkdir: normalizeWorkdirPath(executionWorkdir),
    status: "running",
    plan,
    tasks: plan.tasks.map((t) => ({
      id: t.id,
      status: "pending"
    })),
    sessions: {},
    lastUpdated: (/* @__PURE__ */ new Date()).toISOString()
  };
  saveCheckpoint(checkpoint, workdir);
  return checkpoint;
}
function saveCheckpoint(checkpoint, workdir) {
  const dir = checkpointDir(workdir, checkpoint.runId);
  try {
    if (!(0, import_fs3.existsSync)(dir)) {
      (0, import_fs3.mkdirSync)(dir, { recursive: true });
    }
    const path = checkpointPath(workdir, checkpoint.runId);
    (0, import_fs3.writeFileSync)(path, JSON.stringify(checkpoint, null, 2));
    console.log(`[checkpoint] Saved: ${path}`);
  } catch (err) {
    console.error(`[checkpoint] Failed to save: ${err.message}`);
  }
}
function loadCheckpoint(runId, workdir) {
  const path = checkpointPath(workdir, runId);
  try {
    if (!(0, import_fs3.existsSync)(path)) return null;
    const raw = (0, import_fs3.readFileSync)(path, "utf-8");
    return JSON.parse(raw);
  } catch (err) {
    console.error(`[checkpoint] Failed to load: ${err.message}`);
    return null;
  }
}
function updateTaskStatus(checkpoint, taskId, status, workdir, extra) {
  const task = checkpoint.tasks.find((t) => t.id === taskId);
  if (!task) {
    console.warn(`[checkpoint] Task ${taskId} not found in checkpoint ${checkpoint.runId}`);
    return;
  }
  task.status = status;
  if (extra) {
    if (extra.reviewPassed !== void 0) task.reviewPassed = extra.reviewPassed;
    if (extra.reviewLoop !== void 0) task.reviewLoop = extra.reviewLoop;
    if (extra.workerResult) task.workerResult = extra.workerResult;
    if (extra.reviewResult) task.reviewResult = extra.reviewResult;
  }
  checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
  const hasActive = checkpoint.tasks.some(
    (t) => t.status === "in-progress" || t.status === "in-review"
  );
  const hasFailed = checkpoint.tasks.some((t) => t.status === "failed");
  const allDone = checkpoint.tasks.every(
    (t) => t.status === "completed" || t.status === "failed"
  );
  const allPassed = checkpoint.tasks.every(
    (t) => t.status === "completed" && t.reviewPassed
  );
  if (allDone) {
    checkpoint.status = allPassed ? "complete" : "failed";
  } else if (hasFailed && !hasActive) {
    checkpoint.status = "failed";
  } else {
    checkpoint.status = "running";
  }
  saveCheckpoint(checkpoint, workdir);
}
function recordSession(checkpoint, taskId, role, sessionId, workdir) {
  if (!checkpoint.sessions[taskId]) {
    checkpoint.sessions[taskId] = {};
  }
  checkpoint.sessions[taskId][role] = sessionId;
  checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
  saveCheckpoint(checkpoint, workdir);
}
function getPendingTasks(checkpoint) {
  return checkpoint.tasks.filter((t) => t.status === "pending" || t.status === "in-progress").map((t) => t.id);
}
function isRecordedSessionAlive(sessionId) {
  if (!sessionId) return false;
  const pidMatch = sessionId.match(/-(\d{5,})$/);
  if (!pidMatch) return true;
  const pid = Number(pidMatch[1]);
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    (0, import_process.kill)(pid, 0);
    return true;
  } catch {
    return false;
  }
}
function checkpointHasLiveSession(checkpoint) {
  const taskStates = new Map(checkpoint.tasks.map((task) => [task.id, task.status]));
  return Object.entries(checkpoint.sessions ?? {}).some(([taskId, session]) => {
    const status = taskStates.get(taskId);
    if (status !== "in-progress" && status !== "in-review") return false;
    return isRecordedSessionAlive(session.worker) || isRecordedSessionAlive(session.reviewer);
  });
}
function reconcileStaleCheckpoint(checkpoint, workdir) {
  if (checkpoint.status !== "running") return checkpoint;
  if (checkpointHasLiveSession(checkpoint)) return checkpoint;
  const resumableIds = new Set(
    checkpoint.tasks.filter((task) => task.status === "in-progress" || task.status === "in-review").map((task) => task.id)
  );
  if (resumableIds.size > 0) {
    const nextResumeCount = (checkpoint.resumeCount ?? 0) + 1;
    if (nextResumeCount > MAX_AUTO_RESUME_COUNT) {
      checkpoint.tasks = checkpoint.tasks.map((task) => {
        if (resumableIds.has(task.id)) {
          return { ...task, status: "failed", reviewPassed: false };
        }
        return task;
      });
      checkpoint.status = "failed";
      checkpoint.resumeCount = nextResumeCount;
      checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
      saveCheckpoint(checkpoint, workdir);
      return checkpoint;
    }
    checkpoint.tasks = checkpoint.tasks.map((task) => {
      if (!resumableIds.has(task.id)) return task;
      return {
        id: task.id,
        status: "pending"
      };
    });
    if (checkpoint.sessions) {
      const nextSessions = {};
      for (const [taskId, session] of Object.entries(checkpoint.sessions)) {
        if (!resumableIds.has(taskId)) {
          nextSessions[taskId] = session;
        }
      }
      checkpoint.sessions = nextSessions;
    }
    checkpoint.resumeCount = nextResumeCount;
    checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
    saveCheckpoint(checkpoint, workdir);
    console.log(
      `[checkpoint] Auto-recovered stale checkpoint ${checkpoint.runId} (reset ${resumableIds.size} task(s) to pending, resumeCount=${nextResumeCount})`
    );
    return checkpoint;
  }
  const allCompleted = checkpoint.tasks.every(
    (task) => task.status === "completed" && task.reviewPassed
  );
  const anyFailed = checkpoint.tasks.some((task) => task.status === "failed");
  if (allCompleted) {
    checkpoint.status = "complete";
    checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
    saveCheckpoint(checkpoint, workdir);
  } else if (anyFailed) {
    checkpoint.status = "failed";
    checkpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
    saveCheckpoint(checkpoint, workdir);
  }
  return checkpoint;
}
function findRecoverableCheckpoint(request, workdir) {
  const checkpointsRoot = (0, import_path3.join)("/tmp", "harness");
  const normalizedWorkdir = normalizeWorkdirPath(workdir);
  try {
    if (!(0, import_fs3.existsSync)(checkpointsRoot)) return null;
    const matches = (0, import_fs3.readdirSync)(checkpointsRoot).map((runId) => (0, import_path3.join)(checkpointsRoot, runId, "checkpoint.json")).filter((path) => (0, import_fs3.existsSync)(path)).map((path) => {
      try {
        const raw = (0, import_fs3.readFileSync)(path, "utf-8");
        const parsed = JSON.parse(raw);
        return reconcileStaleCheckpoint(parsed, workdir);
      } catch {
        return null;
      }
    }).filter((checkpoint) => checkpoint !== null).filter((checkpoint) => checkpoint.status === "running").filter((checkpoint) => checkpoint.plan?.originalRequest === request).filter((checkpoint) => normalizeWorkdirPath(checkpoint.workdir ?? "") === normalizedWorkdir || normalizeWorkdirPath(checkpoint.executionWorkdir ?? "") === normalizedWorkdir).filter(
      (checkpoint) => checkpoint.tasks.some((task) => task.status !== "pending") || Object.keys(checkpoint.sessions ?? {}).length > 0 || (checkpoint.resumeCount ?? 0) > 0
    ).sort((a, b) => Date.parse(b.lastUpdated) - Date.parse(a.lastUpdated));
    return matches[0] ?? null;
  } catch (err) {
    console.warn(`[checkpoint] Failed to search recoverable checkpoints: ${err?.message ?? String(err)}`);
    return null;
  }
}
function cleanupStaleCheckpoints() {
  const checkpointsRoot = (0, import_path3.join)("/tmp", "harness");
  if (!(0, import_fs3.existsSync)(checkpointsRoot)) return { removed: 0, errors: 0 };
  const now = Date.now();
  let removed = 0;
  let errors = 0;
  try {
    for (const dirName of (0, import_fs3.readdirSync)(checkpointsRoot)) {
      const dirPath = (0, import_path3.join)(checkpointsRoot, dirName);
      const cpPath = (0, import_path3.join)(dirPath, "checkpoint.json");
      if (!(0, import_fs3.existsSync)(cpPath)) continue;
      try {
        let cp = JSON.parse((0, import_fs3.readFileSync)(cpPath, "utf-8"));
        const lastUpdated = Date.parse(cp.lastUpdated || "");
        if (isNaN(lastUpdated)) continue;
        if (cp.status === "running") {
          const reconcileWorkdir = cp.workdir || cp.executionWorkdir || "";
          const before = { status: cp.status, resumeCount: cp.resumeCount ?? 0 };
          cp = reconcileStaleCheckpoint(cp, reconcileWorkdir);
          if (cp.status !== before.status || (cp.resumeCount ?? 0) !== before.resumeCount) {
            console.log(
              `[checkpoint] Cleanup reconciled ${cp.runId}: status ${before.status}\u2192${cp.status}, resumeCount ${before.resumeCount}\u2192${cp.resumeCount ?? 0}`
            );
          }
        }
        const reconciledLastUpdated = Date.parse(cp.lastUpdated || "");
        const age = Number.isNaN(reconciledLastUpdated) ? now - lastUpdated : now - reconciledLastUpdated;
        const isTerminal = cp.status === "complete" || cp.status === "failed" || cp.status === "escalated" || cp.status === "aborted";
        let fileAge = age;
        if (cp.status === "running") {
          try {
            const fileStat = (0, import_fs3.statSync)(cpPath);
            fileAge = Math.min(age, now - fileStat.mtimeMs);
          } catch {
          }
        }
        const shouldCleanWorkspace = isTerminal ? age > STALE_WORKSPACE_MS : cp.status === "running" && fileAge > STALE_PLANNING_MS;
        if (shouldCleanWorkspace) {
          cleanupWorkspaceForPlan(dirName);
        }
        const shouldRemoveCheckpoint = isTerminal && age > STALE_CHECKPOINT_MS;
        if (shouldRemoveCheckpoint) {
          (0, import_fs3.rmSync)(dirPath, { recursive: true, force: true });
          removed++;
        }
      } catch {
        errors++;
      }
    }
  } catch {
  }
  if (removed > 0) {
    console.log(`[checkpoint] Stale cleanup: removed ${removed} plan(s), errors ${errors}`);
  }
  cleanupOrphanedWorkspaces(now);
  return { removed, errors };
}
function cleanupWorkspaceForPlan(planId) {
  const statePath = (0, import_path3.join)(WORKSPACE_ROOT, "state", `${planId}.json`);
  try {
    if ((0, import_fs3.existsSync)(statePath)) {
      const state = JSON.parse((0, import_fs3.readFileSync)(statePath, "utf-8"));
      const cleanupRoot = state?.cleanupRoot ?? state?.executionWorkdir;
      if (cleanupRoot && (0, import_fs3.existsSync)(cleanupRoot)) {
        (0, import_fs3.rmSync)(cleanupRoot, { recursive: true, force: true });
        console.log(`[checkpoint] Cleaned workspace: ${cleanupRoot}`);
      }
      (0, import_fs3.rmSync)(statePath, { force: true });
    }
  } catch {
  }
  try {
    if ((0, import_fs3.existsSync)(WORKSPACE_ROOT)) {
      for (const entry of (0, import_fs3.readdirSync)(WORKSPACE_ROOT)) {
        if (entry === "state") continue;
        if (entry.startsWith(planId)) {
          const wsPath = (0, import_path3.join)(WORKSPACE_ROOT, entry);
          (0, import_fs3.rmSync)(wsPath, { recursive: true, force: true });
          console.log(`[checkpoint] Cleaned workspace dir: ${wsPath}`);
        }
      }
    }
  } catch {
  }
}
function cleanupOrphanedWorkspaces(now) {
  if (!(0, import_fs3.existsSync)(WORKSPACE_ROOT)) return;
  const checkpointsRoot = (0, import_path3.join)("/tmp", "harness");
  const activePlanIds = /* @__PURE__ */ new Set();
  try {
    if ((0, import_fs3.existsSync)(checkpointsRoot)) {
      for (const dirName of (0, import_fs3.readdirSync)(checkpointsRoot)) {
        activePlanIds.add(dirName);
      }
    }
  } catch {
  }
  try {
    for (const entry of (0, import_fs3.readdirSync)(WORKSPACE_ROOT)) {
      if (entry === "state") continue;
      const planIdMatch = entry.match(/^(plan-\d{8}-[a-z0-9]+)/);
      if (!planIdMatch) continue;
      const planId = planIdMatch[1];
      if (activePlanIds.has(planId)) continue;
      const wsPath = (0, import_path3.join)(WORKSPACE_ROOT, entry);
      try {
        const stat = (0, import_fs3.statSync)(wsPath);
        const age = now - stat.mtimeMs;
        if (age > STALE_COMPLETE_MS) {
          (0, import_fs3.rmSync)(wsPath, { recursive: true, force: true });
          console.log(`[checkpoint] Cleaned orphaned workspace: ${wsPath} (age ${Math.round(age / 6e4)}min)`);
          const statePath = (0, import_path3.join)(WORKSPACE_ROOT, "state", `${planId}.json`);
          (0, import_fs3.rmSync)(statePath, { force: true });
        }
      } catch {
      }
    }
  } catch {
  }
}
var import_fs3, import_process, import_os3, import_path3, MAX_AUTO_RESUME_COUNT, STALE_PLANNING_MS, STALE_CHECKPOINT_MS, STALE_WORKSPACE_MS, WORKSPACE_ROOT;
var init_checkpoint = __esm({
  "src/checkpoint.ts"() {
    import_fs3 = require("fs");
    import_process = require("process");
    import_os3 = require("os");
    import_path3 = require("path");
    MAX_AUTO_RESUME_COUNT = 5;
    STALE_PLANNING_MS = 30 * 60 * 1e3;
    STALE_CHECKPOINT_MS = 24 * 60 * 60 * 1e3;
    STALE_WORKSPACE_MS = 60 * 60 * 1e3;
    WORKSPACE_ROOT = (0, import_path3.join)((0, import_os3.homedir)(), ".openclaw", "harness-execution-workspaces");
  }
});

// index.ts
var index_exports = {};
__export(index_exports, {
  default: () => index_default,
  register: () => register
});
module.exports = __toCommonJS(index_exports);

// src/tools/claude-launch.ts
var import_fs = require("fs");
var import_path = require("path");
var import_os = require("os");

// node_modules/@sinclair/typebox/build/esm/type/guard/value.mjs
var value_exports = {};
__export(value_exports, {
  HasPropertyKey: () => HasPropertyKey,
  IsArray: () => IsArray,
  IsAsyncIterator: () => IsAsyncIterator,
  IsBigInt: () => IsBigInt,
  IsBoolean: () => IsBoolean,
  IsDate: () => IsDate,
  IsFunction: () => IsFunction,
  IsIterator: () => IsIterator,
  IsNull: () => IsNull,
  IsNumber: () => IsNumber,
  IsObject: () => IsObject,
  IsRegExp: () => IsRegExp,
  IsString: () => IsString,
  IsSymbol: () => IsSymbol,
  IsUint8Array: () => IsUint8Array,
  IsUndefined: () => IsUndefined
});
function HasPropertyKey(value, key) {
  return key in value;
}
function IsAsyncIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.asyncIterator in value;
}
function IsArray(value) {
  return Array.isArray(value);
}
function IsBigInt(value) {
  return typeof value === "bigint";
}
function IsBoolean(value) {
  return typeof value === "boolean";
}
function IsDate(value) {
  return value instanceof globalThis.Date;
}
function IsFunction(value) {
  return typeof value === "function";
}
function IsIterator(value) {
  return IsObject(value) && !IsArray(value) && !IsUint8Array(value) && Symbol.iterator in value;
}
function IsNull(value) {
  return value === null;
}
function IsNumber(value) {
  return typeof value === "number";
}
function IsObject(value) {
  return typeof value === "object" && value !== null;
}
function IsRegExp(value) {
  return value instanceof globalThis.RegExp;
}
function IsString(value) {
  return typeof value === "string";
}
function IsSymbol(value) {
  return typeof value === "symbol";
}
function IsUint8Array(value) {
  return value instanceof globalThis.Uint8Array;
}
function IsUndefined(value) {
  return value === void 0;
}

// node_modules/@sinclair/typebox/build/esm/type/clone/value.mjs
function ArrayType(value) {
  return value.map((value2) => Visit(value2));
}
function DateType(value) {
  return new Date(value.getTime());
}
function Uint8ArrayType(value) {
  return new Uint8Array(value);
}
function RegExpType(value) {
  return new RegExp(value.source, value.flags);
}
function ObjectType(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Visit(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Visit(value[key]);
  }
  return result;
}
function Visit(value) {
  return IsArray(value) ? ArrayType(value) : IsDate(value) ? DateType(value) : IsUint8Array(value) ? Uint8ArrayType(value) : IsRegExp(value) ? RegExpType(value) : IsObject(value) ? ObjectType(value) : value;
}
function Clone(value) {
  return Visit(value);
}

// node_modules/@sinclair/typebox/build/esm/type/clone/type.mjs
function CloneType(schema, options) {
  return options === void 0 ? Clone(schema) : Clone({ ...options, ...schema });
}

// node_modules/@sinclair/typebox/build/esm/value/guard/guard.mjs
function IsObject2(value) {
  return value !== null && typeof value === "object";
}
function IsArray2(value) {
  return globalThis.Array.isArray(value) && !globalThis.ArrayBuffer.isView(value);
}
function IsUndefined2(value) {
  return value === void 0;
}
function IsNumber2(value) {
  return typeof value === "number";
}

// node_modules/@sinclair/typebox/build/esm/system/policy.mjs
var TypeSystemPolicy;
(function(TypeSystemPolicy2) {
  TypeSystemPolicy2.InstanceMode = "default";
  TypeSystemPolicy2.ExactOptionalPropertyTypes = false;
  TypeSystemPolicy2.AllowArrayObject = false;
  TypeSystemPolicy2.AllowNaN = false;
  TypeSystemPolicy2.AllowNullVoid = false;
  function IsExactOptionalProperty(value, key) {
    return TypeSystemPolicy2.ExactOptionalPropertyTypes ? key in value : value[key] !== void 0;
  }
  TypeSystemPolicy2.IsExactOptionalProperty = IsExactOptionalProperty;
  function IsObjectLike(value) {
    const isObject = IsObject2(value);
    return TypeSystemPolicy2.AllowArrayObject ? isObject : isObject && !IsArray2(value);
  }
  TypeSystemPolicy2.IsObjectLike = IsObjectLike;
  function IsRecordLike(value) {
    return IsObjectLike(value) && !(value instanceof Date) && !(value instanceof Uint8Array);
  }
  TypeSystemPolicy2.IsRecordLike = IsRecordLike;
  function IsNumberLike(value) {
    return TypeSystemPolicy2.AllowNaN ? IsNumber2(value) : Number.isFinite(value);
  }
  TypeSystemPolicy2.IsNumberLike = IsNumberLike;
  function IsVoidLike(value) {
    const isUndefined = IsUndefined2(value);
    return TypeSystemPolicy2.AllowNullVoid ? isUndefined || value === null : isUndefined;
  }
  TypeSystemPolicy2.IsVoidLike = IsVoidLike;
})(TypeSystemPolicy || (TypeSystemPolicy = {}));

// node_modules/@sinclair/typebox/build/esm/type/create/immutable.mjs
function ImmutableArray(value) {
  return globalThis.Object.freeze(value).map((value2) => Immutable(value2));
}
function ImmutableDate(value) {
  return value;
}
function ImmutableUint8Array(value) {
  return value;
}
function ImmutableRegExp(value) {
  return value;
}
function ImmutableObject(value) {
  const result = {};
  for (const key of Object.getOwnPropertyNames(value)) {
    result[key] = Immutable(value[key]);
  }
  for (const key of Object.getOwnPropertySymbols(value)) {
    result[key] = Immutable(value[key]);
  }
  return globalThis.Object.freeze(result);
}
function Immutable(value) {
  return IsArray(value) ? ImmutableArray(value) : IsDate(value) ? ImmutableDate(value) : IsUint8Array(value) ? ImmutableUint8Array(value) : IsRegExp(value) ? ImmutableRegExp(value) : IsObject(value) ? ImmutableObject(value) : value;
}

// node_modules/@sinclair/typebox/build/esm/type/create/type.mjs
function CreateType(schema, options) {
  const result = options !== void 0 ? { ...options, ...schema } : schema;
  switch (TypeSystemPolicy.InstanceMode) {
    case "freeze":
      return Immutable(result);
    case "clone":
      return Clone(result);
    default:
      return result;
  }
}

// node_modules/@sinclair/typebox/build/esm/type/error/error.mjs
var TypeBoxError = class extends Error {
  constructor(message) {
    super(message);
  }
};

// node_modules/@sinclair/typebox/build/esm/type/symbols/symbols.mjs
var TransformKind = /* @__PURE__ */ Symbol.for("TypeBox.Transform");
var ReadonlyKind = /* @__PURE__ */ Symbol.for("TypeBox.Readonly");
var OptionalKind = /* @__PURE__ */ Symbol.for("TypeBox.Optional");
var Hint = /* @__PURE__ */ Symbol.for("TypeBox.Hint");
var Kind = /* @__PURE__ */ Symbol.for("TypeBox.Kind");

// node_modules/@sinclair/typebox/build/esm/type/guard/kind.mjs
function IsReadonly(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny(value) {
  return IsKindOf(value, "Any");
}
function IsArgument(value) {
  return IsKindOf(value, "Argument");
}
function IsArray3(value) {
  return IsKindOf(value, "Array");
}
function IsAsyncIterator2(value) {
  return IsKindOf(value, "AsyncIterator");
}
function IsBigInt2(value) {
  return IsKindOf(value, "BigInt");
}
function IsBoolean2(value) {
  return IsKindOf(value, "Boolean");
}
function IsComputed(value) {
  return IsKindOf(value, "Computed");
}
function IsConstructor(value) {
  return IsKindOf(value, "Constructor");
}
function IsDate2(value) {
  return IsKindOf(value, "Date");
}
function IsFunction2(value) {
  return IsKindOf(value, "Function");
}
function IsInteger(value) {
  return IsKindOf(value, "Integer");
}
function IsIntersect(value) {
  return IsKindOf(value, "Intersect");
}
function IsIterator2(value) {
  return IsKindOf(value, "Iterator");
}
function IsKindOf(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralValue(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsLiteral(value) {
  return IsKindOf(value, "Literal");
}
function IsMappedKey(value) {
  return IsKindOf(value, "MappedKey");
}
function IsMappedResult(value) {
  return IsKindOf(value, "MappedResult");
}
function IsNever(value) {
  return IsKindOf(value, "Never");
}
function IsNot(value) {
  return IsKindOf(value, "Not");
}
function IsNull2(value) {
  return IsKindOf(value, "Null");
}
function IsNumber3(value) {
  return IsKindOf(value, "Number");
}
function IsObject3(value) {
  return IsKindOf(value, "Object");
}
function IsPromise(value) {
  return IsKindOf(value, "Promise");
}
function IsRecord(value) {
  return IsKindOf(value, "Record");
}
function IsRef(value) {
  return IsKindOf(value, "Ref");
}
function IsRegExp2(value) {
  return IsKindOf(value, "RegExp");
}
function IsString2(value) {
  return IsKindOf(value, "String");
}
function IsSymbol2(value) {
  return IsKindOf(value, "Symbol");
}
function IsTemplateLiteral(value) {
  return IsKindOf(value, "TemplateLiteral");
}
function IsThis(value) {
  return IsKindOf(value, "This");
}
function IsTransform(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple(value) {
  return IsKindOf(value, "Tuple");
}
function IsUndefined3(value) {
  return IsKindOf(value, "Undefined");
}
function IsUnion(value) {
  return IsKindOf(value, "Union");
}
function IsUint8Array2(value) {
  return IsKindOf(value, "Uint8Array");
}
function IsUnknown(value) {
  return IsKindOf(value, "Unknown");
}
function IsUnsafe(value) {
  return IsKindOf(value, "Unsafe");
}
function IsVoid(value) {
  return IsKindOf(value, "Void");
}
function IsKind(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]);
}
function IsSchema(value) {
  return IsAny(value) || IsArgument(value) || IsArray3(value) || IsBoolean2(value) || IsBigInt2(value) || IsAsyncIterator2(value) || IsComputed(value) || IsConstructor(value) || IsDate2(value) || IsFunction2(value) || IsInteger(value) || IsIntersect(value) || IsIterator2(value) || IsLiteral(value) || IsMappedKey(value) || IsMappedResult(value) || IsNever(value) || IsNot(value) || IsNull2(value) || IsNumber3(value) || IsObject3(value) || IsPromise(value) || IsRecord(value) || IsRef(value) || IsRegExp2(value) || IsString2(value) || IsSymbol2(value) || IsTemplateLiteral(value) || IsThis(value) || IsTuple(value) || IsUndefined3(value) || IsUnion(value) || IsUint8Array2(value) || IsUnknown(value) || IsUnsafe(value) || IsVoid(value) || IsKind(value);
}

// node_modules/@sinclair/typebox/build/esm/type/guard/type.mjs
var type_exports = {};
__export(type_exports, {
  IsAny: () => IsAny2,
  IsArgument: () => IsArgument2,
  IsArray: () => IsArray4,
  IsAsyncIterator: () => IsAsyncIterator3,
  IsBigInt: () => IsBigInt3,
  IsBoolean: () => IsBoolean3,
  IsComputed: () => IsComputed2,
  IsConstructor: () => IsConstructor2,
  IsDate: () => IsDate3,
  IsFunction: () => IsFunction3,
  IsImport: () => IsImport,
  IsInteger: () => IsInteger2,
  IsIntersect: () => IsIntersect2,
  IsIterator: () => IsIterator3,
  IsKind: () => IsKind2,
  IsKindOf: () => IsKindOf2,
  IsLiteral: () => IsLiteral2,
  IsLiteralBoolean: () => IsLiteralBoolean,
  IsLiteralNumber: () => IsLiteralNumber,
  IsLiteralString: () => IsLiteralString,
  IsLiteralValue: () => IsLiteralValue2,
  IsMappedKey: () => IsMappedKey2,
  IsMappedResult: () => IsMappedResult2,
  IsNever: () => IsNever2,
  IsNot: () => IsNot2,
  IsNull: () => IsNull3,
  IsNumber: () => IsNumber4,
  IsObject: () => IsObject4,
  IsOptional: () => IsOptional2,
  IsPromise: () => IsPromise2,
  IsProperties: () => IsProperties,
  IsReadonly: () => IsReadonly2,
  IsRecord: () => IsRecord2,
  IsRecursive: () => IsRecursive,
  IsRef: () => IsRef2,
  IsRegExp: () => IsRegExp3,
  IsSchema: () => IsSchema2,
  IsString: () => IsString3,
  IsSymbol: () => IsSymbol3,
  IsTemplateLiteral: () => IsTemplateLiteral2,
  IsThis: () => IsThis2,
  IsTransform: () => IsTransform2,
  IsTuple: () => IsTuple2,
  IsUint8Array: () => IsUint8Array3,
  IsUndefined: () => IsUndefined4,
  IsUnion: () => IsUnion2,
  IsUnionLiteral: () => IsUnionLiteral,
  IsUnknown: () => IsUnknown2,
  IsUnsafe: () => IsUnsafe2,
  IsVoid: () => IsVoid2,
  TypeGuardUnknownTypeError: () => TypeGuardUnknownTypeError
});
var TypeGuardUnknownTypeError = class extends TypeBoxError {
};
var KnownTypes = [
  "Argument",
  "Any",
  "Array",
  "AsyncIterator",
  "BigInt",
  "Boolean",
  "Computed",
  "Constructor",
  "Date",
  "Enum",
  "Function",
  "Integer",
  "Intersect",
  "Iterator",
  "Literal",
  "MappedKey",
  "MappedResult",
  "Not",
  "Null",
  "Number",
  "Object",
  "Promise",
  "Record",
  "Ref",
  "RegExp",
  "String",
  "Symbol",
  "TemplateLiteral",
  "This",
  "Tuple",
  "Undefined",
  "Union",
  "Uint8Array",
  "Unknown",
  "Void"
];
function IsPattern(value) {
  try {
    new RegExp(value);
    return true;
  } catch {
    return false;
  }
}
function IsControlCharacterFree(value) {
  if (!IsString(value))
    return false;
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 7 && code <= 13 || code === 27 || code === 127) {
      return false;
    }
  }
  return true;
}
function IsAdditionalProperties(value) {
  return IsOptionalBoolean(value) || IsSchema2(value);
}
function IsOptionalBigInt(value) {
  return IsUndefined(value) || IsBigInt(value);
}
function IsOptionalNumber(value) {
  return IsUndefined(value) || IsNumber(value);
}
function IsOptionalBoolean(value) {
  return IsUndefined(value) || IsBoolean(value);
}
function IsOptionalString(value) {
  return IsUndefined(value) || IsString(value);
}
function IsOptionalPattern(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value) && IsPattern(value);
}
function IsOptionalFormat(value) {
  return IsUndefined(value) || IsString(value) && IsControlCharacterFree(value);
}
function IsOptionalSchema(value) {
  return IsUndefined(value) || IsSchema2(value);
}
function IsReadonly2(value) {
  return IsObject(value) && value[ReadonlyKind] === "Readonly";
}
function IsOptional2(value) {
  return IsObject(value) && value[OptionalKind] === "Optional";
}
function IsAny2(value) {
  return IsKindOf2(value, "Any") && IsOptionalString(value.$id);
}
function IsArgument2(value) {
  return IsKindOf2(value, "Argument") && IsNumber(value.index);
}
function IsArray4(value) {
  return IsKindOf2(value, "Array") && value.type === "array" && IsOptionalString(value.$id) && IsSchema2(value.items) && IsOptionalNumber(value.minItems) && IsOptionalNumber(value.maxItems) && IsOptionalBoolean(value.uniqueItems) && IsOptionalSchema(value.contains) && IsOptionalNumber(value.minContains) && IsOptionalNumber(value.maxContains);
}
function IsAsyncIterator3(value) {
  return IsKindOf2(value, "AsyncIterator") && value.type === "AsyncIterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsBigInt3(value) {
  return IsKindOf2(value, "BigInt") && value.type === "bigint" && IsOptionalString(value.$id) && IsOptionalBigInt(value.exclusiveMaximum) && IsOptionalBigInt(value.exclusiveMinimum) && IsOptionalBigInt(value.maximum) && IsOptionalBigInt(value.minimum) && IsOptionalBigInt(value.multipleOf);
}
function IsBoolean3(value) {
  return IsKindOf2(value, "Boolean") && value.type === "boolean" && IsOptionalString(value.$id);
}
function IsComputed2(value) {
  return IsKindOf2(value, "Computed") && IsString(value.target) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema));
}
function IsConstructor2(value) {
  return IsKindOf2(value, "Constructor") && value.type === "Constructor" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsDate3(value) {
  return IsKindOf2(value, "Date") && value.type === "Date" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximumTimestamp) && IsOptionalNumber(value.exclusiveMinimumTimestamp) && IsOptionalNumber(value.maximumTimestamp) && IsOptionalNumber(value.minimumTimestamp) && IsOptionalNumber(value.multipleOfTimestamp);
}
function IsFunction3(value) {
  return IsKindOf2(value, "Function") && value.type === "Function" && IsOptionalString(value.$id) && IsArray(value.parameters) && value.parameters.every((schema) => IsSchema2(schema)) && IsSchema2(value.returns);
}
function IsImport(value) {
  return IsKindOf2(value, "Import") && HasPropertyKey(value, "$defs") && IsObject(value.$defs) && IsProperties(value.$defs) && HasPropertyKey(value, "$ref") && IsString(value.$ref) && value.$ref in value.$defs;
}
function IsInteger2(value) {
  return IsKindOf2(value, "Integer") && value.type === "integer" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsProperties(value) {
  return IsObject(value) && Object.entries(value).every(([key, schema]) => IsControlCharacterFree(key) && IsSchema2(schema));
}
function IsIntersect2(value) {
  return IsKindOf2(value, "Intersect") && (IsString(value.type) && value.type !== "object" ? false : true) && IsArray(value.allOf) && value.allOf.every((schema) => IsSchema2(schema) && !IsTransform2(schema)) && IsOptionalString(value.type) && (IsOptionalBoolean(value.unevaluatedProperties) || IsOptionalSchema(value.unevaluatedProperties)) && IsOptionalString(value.$id);
}
function IsIterator3(value) {
  return IsKindOf2(value, "Iterator") && value.type === "Iterator" && IsOptionalString(value.$id) && IsSchema2(value.items);
}
function IsKindOf2(value, kind) {
  return IsObject(value) && Kind in value && value[Kind] === kind;
}
function IsLiteralString(value) {
  return IsLiteral2(value) && IsString(value.const);
}
function IsLiteralNumber(value) {
  return IsLiteral2(value) && IsNumber(value.const);
}
function IsLiteralBoolean(value) {
  return IsLiteral2(value) && IsBoolean(value.const);
}
function IsLiteral2(value) {
  return IsKindOf2(value, "Literal") && IsOptionalString(value.$id) && IsLiteralValue2(value.const);
}
function IsLiteralValue2(value) {
  return IsBoolean(value) || IsNumber(value) || IsString(value);
}
function IsMappedKey2(value) {
  return IsKindOf2(value, "MappedKey") && IsArray(value.keys) && value.keys.every((key) => IsNumber(key) || IsString(key));
}
function IsMappedResult2(value) {
  return IsKindOf2(value, "MappedResult") && IsProperties(value.properties);
}
function IsNever2(value) {
  return IsKindOf2(value, "Never") && IsObject(value.not) && Object.getOwnPropertyNames(value.not).length === 0;
}
function IsNot2(value) {
  return IsKindOf2(value, "Not") && IsSchema2(value.not);
}
function IsNull3(value) {
  return IsKindOf2(value, "Null") && value.type === "null" && IsOptionalString(value.$id);
}
function IsNumber4(value) {
  return IsKindOf2(value, "Number") && value.type === "number" && IsOptionalString(value.$id) && IsOptionalNumber(value.exclusiveMaximum) && IsOptionalNumber(value.exclusiveMinimum) && IsOptionalNumber(value.maximum) && IsOptionalNumber(value.minimum) && IsOptionalNumber(value.multipleOf);
}
function IsObject4(value) {
  return IsKindOf2(value, "Object") && value.type === "object" && IsOptionalString(value.$id) && IsProperties(value.properties) && IsAdditionalProperties(value.additionalProperties) && IsOptionalNumber(value.minProperties) && IsOptionalNumber(value.maxProperties);
}
function IsPromise2(value) {
  return IsKindOf2(value, "Promise") && value.type === "Promise" && IsOptionalString(value.$id) && IsSchema2(value.item);
}
function IsRecord2(value) {
  return IsKindOf2(value, "Record") && value.type === "object" && IsOptionalString(value.$id) && IsAdditionalProperties(value.additionalProperties) && IsObject(value.patternProperties) && ((schema) => {
    const keys = Object.getOwnPropertyNames(schema.patternProperties);
    return keys.length === 1 && IsPattern(keys[0]) && IsObject(schema.patternProperties) && IsSchema2(schema.patternProperties[keys[0]]);
  })(value);
}
function IsRecursive(value) {
  return IsObject(value) && Hint in value && value[Hint] === "Recursive";
}
function IsRef2(value) {
  return IsKindOf2(value, "Ref") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsRegExp3(value) {
  return IsKindOf2(value, "RegExp") && IsOptionalString(value.$id) && IsString(value.source) && IsString(value.flags) && IsOptionalNumber(value.maxLength) && IsOptionalNumber(value.minLength);
}
function IsString3(value) {
  return IsKindOf2(value, "String") && value.type === "string" && IsOptionalString(value.$id) && IsOptionalNumber(value.minLength) && IsOptionalNumber(value.maxLength) && IsOptionalPattern(value.pattern) && IsOptionalFormat(value.format);
}
function IsSymbol3(value) {
  return IsKindOf2(value, "Symbol") && value.type === "symbol" && IsOptionalString(value.$id);
}
function IsTemplateLiteral2(value) {
  return IsKindOf2(value, "TemplateLiteral") && value.type === "string" && IsString(value.pattern) && value.pattern[0] === "^" && value.pattern[value.pattern.length - 1] === "$";
}
function IsThis2(value) {
  return IsKindOf2(value, "This") && IsOptionalString(value.$id) && IsString(value.$ref);
}
function IsTransform2(value) {
  return IsObject(value) && TransformKind in value;
}
function IsTuple2(value) {
  return IsKindOf2(value, "Tuple") && value.type === "array" && IsOptionalString(value.$id) && IsNumber(value.minItems) && IsNumber(value.maxItems) && value.minItems === value.maxItems && // empty
  (IsUndefined(value.items) && IsUndefined(value.additionalItems) && value.minItems === 0 || IsArray(value.items) && value.items.every((schema) => IsSchema2(schema)));
}
function IsUndefined4(value) {
  return IsKindOf2(value, "Undefined") && value.type === "undefined" && IsOptionalString(value.$id);
}
function IsUnionLiteral(value) {
  return IsUnion2(value) && value.anyOf.every((schema) => IsLiteralString(schema) || IsLiteralNumber(schema));
}
function IsUnion2(value) {
  return IsKindOf2(value, "Union") && IsOptionalString(value.$id) && IsObject(value) && IsArray(value.anyOf) && value.anyOf.every((schema) => IsSchema2(schema));
}
function IsUint8Array3(value) {
  return IsKindOf2(value, "Uint8Array") && value.type === "Uint8Array" && IsOptionalString(value.$id) && IsOptionalNumber(value.minByteLength) && IsOptionalNumber(value.maxByteLength);
}
function IsUnknown2(value) {
  return IsKindOf2(value, "Unknown") && IsOptionalString(value.$id);
}
function IsUnsafe2(value) {
  return IsKindOf2(value, "Unsafe");
}
function IsVoid2(value) {
  return IsKindOf2(value, "Void") && value.type === "void" && IsOptionalString(value.$id);
}
function IsKind2(value) {
  return IsObject(value) && Kind in value && IsString(value[Kind]) && !KnownTypes.includes(value[Kind]);
}
function IsSchema2(value) {
  return IsObject(value) && (IsAny2(value) || IsArgument2(value) || IsArray4(value) || IsBoolean3(value) || IsBigInt3(value) || IsAsyncIterator3(value) || IsComputed2(value) || IsConstructor2(value) || IsDate3(value) || IsFunction3(value) || IsInteger2(value) || IsIntersect2(value) || IsIterator3(value) || IsLiteral2(value) || IsMappedKey2(value) || IsMappedResult2(value) || IsNever2(value) || IsNot2(value) || IsNull3(value) || IsNumber4(value) || IsObject4(value) || IsPromise2(value) || IsRecord2(value) || IsRef2(value) || IsRegExp3(value) || IsString3(value) || IsSymbol3(value) || IsTemplateLiteral2(value) || IsThis2(value) || IsTuple2(value) || IsUndefined4(value) || IsUnion2(value) || IsUint8Array3(value) || IsUnknown2(value) || IsUnsafe2(value) || IsVoid2(value) || IsKind2(value));
}

// node_modules/@sinclair/typebox/build/esm/type/patterns/patterns.mjs
var PatternBoolean = "(true|false)";
var PatternNumber = "(0|[1-9][0-9]*)";
var PatternString = "(.*)";
var PatternNever = "(?!.*)";
var PatternBooleanExact = `^${PatternBoolean}$`;
var PatternNumberExact = `^${PatternNumber}$`;
var PatternStringExact = `^${PatternString}$`;
var PatternNeverExact = `^${PatternNever}$`;

// node_modules/@sinclair/typebox/build/esm/type/sets/set.mjs
function SetIncludes(T, S) {
  return T.includes(S);
}
function SetDistinct(T) {
  return [...new Set(T)];
}
function SetIntersect(T, S) {
  return T.filter((L) => S.includes(L));
}
function SetIntersectManyResolve(T, Init) {
  return T.reduce((Acc, L) => {
    return SetIntersect(Acc, L);
  }, Init);
}
function SetIntersectMany(T) {
  return T.length === 1 ? T[0] : T.length > 1 ? SetIntersectManyResolve(T.slice(1), T[0]) : [];
}
function SetUnionMany(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...L);
  return Acc;
}

// node_modules/@sinclair/typebox/build/esm/type/any/any.mjs
function Any(options) {
  return CreateType({ [Kind]: "Any" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/array/array.mjs
function Array2(items, options) {
  return CreateType({ [Kind]: "Array", type: "array", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/argument/argument.mjs
function Argument(index) {
  return CreateType({ [Kind]: "Argument", index });
}

// node_modules/@sinclair/typebox/build/esm/type/async-iterator/async-iterator.mjs
function AsyncIterator(items, options) {
  return CreateType({ [Kind]: "AsyncIterator", type: "AsyncIterator", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/computed/computed.mjs
function Computed(target, parameters, options) {
  return CreateType({ [Kind]: "Computed", target, parameters }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/discard/discard.mjs
function DiscardKey(value, key) {
  const { [key]: _, ...rest } = value;
  return rest;
}
function Discard(value, keys) {
  return keys.reduce((acc, key) => DiscardKey(acc, key), value);
}

// node_modules/@sinclair/typebox/build/esm/type/never/never.mjs
function Never(options) {
  return CreateType({ [Kind]: "Never", not: {} }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/mapped/mapped-result.mjs
function MappedResult(properties) {
  return CreateType({
    [Kind]: "MappedResult",
    properties
  });
}

// node_modules/@sinclair/typebox/build/esm/type/constructor/constructor.mjs
function Constructor(parameters, returns, options) {
  return CreateType({ [Kind]: "Constructor", type: "Constructor", parameters, returns }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/function/function.mjs
function Function(parameters, returns, options) {
  return CreateType({ [Kind]: "Function", type: "Function", parameters, returns }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union-create.mjs
function UnionCreate(T, options) {
  return CreateType({ [Kind]: "Union", anyOf: T }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union-evaluated.mjs
function IsUnionOptional(types) {
  return types.some((type) => IsOptional(type));
}
function RemoveOptionalFromRest(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType(left) : left);
}
function RemoveOptionalFromType(T) {
  return Discard(T, [OptionalKind]);
}
function ResolveUnion(types, options) {
  const isOptional = IsUnionOptional(types);
  return isOptional ? Optional(UnionCreate(RemoveOptionalFromRest(types), options)) : UnionCreate(RemoveOptionalFromRest(types), options);
}
function UnionEvaluated(T, options) {
  return T.length === 1 ? CreateType(T[0], options) : T.length === 0 ? Never(options) : ResolveUnion(T, options);
}

// node_modules/@sinclair/typebox/build/esm/type/union/union.mjs
function Union(types, options) {
  return types.length === 0 ? Never(options) : types.length === 1 ? CreateType(types[0], options) : UnionCreate(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/parse.mjs
var TemplateLiteralParserError = class extends TypeBoxError {
};
function Unescape(pattern) {
  return pattern.replace(/\\\$/g, "$").replace(/\\\*/g, "*").replace(/\\\^/g, "^").replace(/\\\|/g, "|").replace(/\\\(/g, "(").replace(/\\\)/g, ")");
}
function IsNonEscaped(pattern, index, char) {
  return pattern[index] === char && pattern.charCodeAt(index - 1) !== 92;
}
function IsOpenParen(pattern, index) {
  return IsNonEscaped(pattern, index, "(");
}
function IsCloseParen(pattern, index) {
  return IsNonEscaped(pattern, index, ")");
}
function IsSeparator(pattern, index) {
  return IsNonEscaped(pattern, index, "|");
}
function IsGroup(pattern) {
  if (!(IsOpenParen(pattern, 0) && IsCloseParen(pattern, pattern.length - 1)))
    return false;
  let count = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (count === 0 && index !== pattern.length - 1)
      return false;
  }
  return true;
}
function InGroup(pattern) {
  return pattern.slice(1, pattern.length - 1);
}
function IsPrecedenceOr(pattern) {
  let count = 0;
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0)
      return true;
  }
  return false;
}
function IsPrecedenceAnd(pattern) {
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      return true;
  }
  return false;
}
function Or(pattern) {
  let [count, start] = [0, 0];
  const expressions = [];
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index))
      count += 1;
    if (IsCloseParen(pattern, index))
      count -= 1;
    if (IsSeparator(pattern, index) && count === 0) {
      const range2 = pattern.slice(start, index);
      if (range2.length > 0)
        expressions.push(TemplateLiteralParse(range2));
      start = index + 1;
    }
  }
  const range = pattern.slice(start);
  if (range.length > 0)
    expressions.push(TemplateLiteralParse(range));
  if (expressions.length === 0)
    return { type: "const", const: "" };
  if (expressions.length === 1)
    return expressions[0];
  return { type: "or", expr: expressions };
}
function And(pattern) {
  function Group(value, index) {
    if (!IsOpenParen(value, index))
      throw new TemplateLiteralParserError(`TemplateLiteralParser: Index must point to open parens`);
    let count = 0;
    for (let scan = index; scan < value.length; scan++) {
      if (IsOpenParen(value, scan))
        count += 1;
      if (IsCloseParen(value, scan))
        count -= 1;
      if (count === 0)
        return [index, scan];
    }
    throw new TemplateLiteralParserError(`TemplateLiteralParser: Unclosed group parens in expression`);
  }
  function Range(pattern2, index) {
    for (let scan = index; scan < pattern2.length; scan++) {
      if (IsOpenParen(pattern2, scan))
        return [index, scan];
    }
    return [index, pattern2.length];
  }
  const expressions = [];
  for (let index = 0; index < pattern.length; index++) {
    if (IsOpenParen(pattern, index)) {
      const [start, end] = Group(pattern, index);
      const range = pattern.slice(start, end + 1);
      expressions.push(TemplateLiteralParse(range));
      index = end;
    } else {
      const [start, end] = Range(pattern, index);
      const range = pattern.slice(start, end);
      if (range.length > 0)
        expressions.push(TemplateLiteralParse(range));
      index = end - 1;
    }
  }
  return expressions.length === 0 ? { type: "const", const: "" } : expressions.length === 1 ? expressions[0] : { type: "and", expr: expressions };
}
function TemplateLiteralParse(pattern) {
  return IsGroup(pattern) ? TemplateLiteralParse(InGroup(pattern)) : IsPrecedenceOr(pattern) ? Or(pattern) : IsPrecedenceAnd(pattern) ? And(pattern) : { type: "const", const: Unescape(pattern) };
}
function TemplateLiteralParseExact(pattern) {
  return TemplateLiteralParse(pattern.slice(1, pattern.length - 1));
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/finite.mjs
var TemplateLiteralFiniteError = class extends TypeBoxError {
};
function IsNumberExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "0" && expression.expr[1].type === "const" && expression.expr[1].const === "[1-9][0-9]*";
}
function IsBooleanExpression(expression) {
  return expression.type === "or" && expression.expr.length === 2 && expression.expr[0].type === "const" && expression.expr[0].const === "true" && expression.expr[1].type === "const" && expression.expr[1].const === "false";
}
function IsStringExpression(expression) {
  return expression.type === "const" && expression.const === ".*";
}
function IsTemplateLiteralExpressionFinite(expression) {
  return IsNumberExpression(expression) || IsStringExpression(expression) ? false : IsBooleanExpression(expression) ? true : expression.type === "and" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "or" ? expression.expr.every((expr) => IsTemplateLiteralExpressionFinite(expr)) : expression.type === "const" ? true : (() => {
    throw new TemplateLiteralFiniteError(`Unknown expression type`);
  })();
}
function IsTemplateLiteralFinite(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/generate.mjs
var TemplateLiteralGenerateError = class extends TypeBoxError {
};
function* GenerateReduce(buffer) {
  if (buffer.length === 1)
    return yield* buffer[0];
  for (const left of buffer[0]) {
    for (const right of GenerateReduce(buffer.slice(1))) {
      yield `${left}${right}`;
    }
  }
}
function* GenerateAnd(expression) {
  return yield* GenerateReduce(expression.expr.map((expr) => [...TemplateLiteralExpressionGenerate(expr)]));
}
function* GenerateOr(expression) {
  for (const expr of expression.expr)
    yield* TemplateLiteralExpressionGenerate(expr);
}
function* GenerateConst(expression) {
  return yield expression.const;
}
function* TemplateLiteralExpressionGenerate(expression) {
  return expression.type === "and" ? yield* GenerateAnd(expression) : expression.type === "or" ? yield* GenerateOr(expression) : expression.type === "const" ? yield* GenerateConst(expression) : (() => {
    throw new TemplateLiteralGenerateError("Unknown expression");
  })();
}
function TemplateLiteralGenerate(schema) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  return IsTemplateLiteralExpressionFinite(expression) ? [...TemplateLiteralExpressionGenerate(expression)] : [];
}

// node_modules/@sinclair/typebox/build/esm/type/literal/literal.mjs
function Literal(value, options) {
  return CreateType({
    [Kind]: "Literal",
    const: value,
    type: typeof value
  }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/boolean/boolean.mjs
function Boolean2(options) {
  return CreateType({ [Kind]: "Boolean", type: "boolean" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/bigint/bigint.mjs
function BigInt(options) {
  return CreateType({ [Kind]: "BigInt", type: "bigint" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/number/number.mjs
function Number2(options) {
  return CreateType({ [Kind]: "Number", type: "number" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/string/string.mjs
function String2(options) {
  return CreateType({ [Kind]: "String", type: "string" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/syntax.mjs
function* FromUnion(syntax) {
  const trim = syntax.trim().replace(/"|'/g, "");
  return trim === "boolean" ? yield Boolean2() : trim === "number" ? yield Number2() : trim === "bigint" ? yield BigInt() : trim === "string" ? yield String2() : yield (() => {
    const literals = trim.split("|").map((literal) => Literal(literal.trim()));
    return literals.length === 0 ? Never() : literals.length === 1 ? literals[0] : UnionEvaluated(literals);
  })();
}
function* FromTerminal(syntax) {
  if (syntax[1] !== "{") {
    const L = Literal("$");
    const R = FromSyntax(syntax.slice(1));
    return yield* [L, ...R];
  }
  for (let i = 2; i < syntax.length; i++) {
    if (syntax[i] === "}") {
      const L = FromUnion(syntax.slice(2, i));
      const R = FromSyntax(syntax.slice(i + 1));
      return yield* [...L, ...R];
    }
  }
  yield Literal(syntax);
}
function* FromSyntax(syntax) {
  for (let i = 0; i < syntax.length; i++) {
    if (syntax[i] === "$") {
      const L = Literal(syntax.slice(0, i));
      const R = FromTerminal(syntax.slice(i));
      return yield* [L, ...R];
    }
  }
  yield Literal(syntax);
}
function TemplateLiteralSyntax(syntax) {
  return [...FromSyntax(syntax)];
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/pattern.mjs
var TemplateLiteralPatternError = class extends TypeBoxError {
};
function Escape(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function Visit2(schema, acc) {
  return IsTemplateLiteral(schema) ? schema.pattern.slice(1, schema.pattern.length - 1) : IsUnion(schema) ? `(${schema.anyOf.map((schema2) => Visit2(schema2, acc)).join("|")})` : IsNumber3(schema) ? `${acc}${PatternNumber}` : IsInteger(schema) ? `${acc}${PatternNumber}` : IsBigInt2(schema) ? `${acc}${PatternNumber}` : IsString2(schema) ? `${acc}${PatternString}` : IsLiteral(schema) ? `${acc}${Escape(schema.const.toString())}` : IsBoolean2(schema) ? `${acc}${PatternBoolean}` : (() => {
    throw new TemplateLiteralPatternError(`Unexpected Kind '${schema[Kind]}'`);
  })();
}
function TemplateLiteralPattern(kinds) {
  return `^${kinds.map((schema) => Visit2(schema, "")).join("")}$`;
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/union.mjs
function TemplateLiteralToUnion(schema) {
  const R = TemplateLiteralGenerate(schema);
  const L = R.map((S) => Literal(S));
  return UnionEvaluated(L);
}

// node_modules/@sinclair/typebox/build/esm/type/template-literal/template-literal.mjs
function TemplateLiteral(unresolved, options) {
  const pattern = IsString(unresolved) ? TemplateLiteralPattern(TemplateLiteralSyntax(unresolved)) : TemplateLiteralPattern(unresolved);
  return CreateType({ [Kind]: "TemplateLiteral", type: "string", pattern }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-property-keys.mjs
function FromTemplateLiteral(templateLiteral) {
  const keys = TemplateLiteralGenerate(templateLiteral);
  return keys.map((key) => key.toString());
}
function FromUnion2(types) {
  const result = [];
  for (const type of types)
    result.push(...IndexPropertyKeys(type));
  return result;
}
function FromLiteral(literalValue) {
  return [literalValue.toString()];
}
function IndexPropertyKeys(type) {
  return [...new Set(IsTemplateLiteral(type) ? FromTemplateLiteral(type) : IsUnion(type) ? FromUnion2(type.anyOf) : IsLiteral(type) ? FromLiteral(type.const) : IsNumber3(type) ? ["[number]"] : IsInteger(type) ? ["[number]"] : [])];
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-result.mjs
function FromProperties(type, properties, options) {
  const result = {};
  for (const K2 of Object.getOwnPropertyNames(properties)) {
    result[K2] = Index(type, IndexPropertyKeys(properties[K2]), options);
  }
  return result;
}
function FromMappedResult(type, mappedResult, options) {
  return FromProperties(type, mappedResult.properties, options);
}
function IndexFromMappedResult(type, mappedResult, options) {
  const properties = FromMappedResult(type, mappedResult, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed.mjs
function FromRest(types, key) {
  return types.map((type) => IndexFromPropertyKey(type, key));
}
function FromIntersectRest(types) {
  return types.filter((type) => !IsNever(type));
}
function FromIntersect(types, key) {
  return IntersectEvaluated(FromIntersectRest(FromRest(types, key)));
}
function FromUnionRest(types) {
  return types.some((L) => IsNever(L)) ? [] : types;
}
function FromUnion3(types, key) {
  return UnionEvaluated(FromUnionRest(FromRest(types, key)));
}
function FromTuple(types, key) {
  return key in types ? types[key] : key === "[number]" ? UnionEvaluated(types) : Never();
}
function FromArray(type, key) {
  return key === "[number]" ? type : Never();
}
function FromProperty(properties, propertyKey) {
  return propertyKey in properties ? properties[propertyKey] : Never();
}
function IndexFromPropertyKey(type, propertyKey) {
  return IsIntersect(type) ? FromIntersect(type.allOf, propertyKey) : IsUnion(type) ? FromUnion3(type.anyOf, propertyKey) : IsTuple(type) ? FromTuple(type.items ?? [], propertyKey) : IsArray3(type) ? FromArray(type.items, propertyKey) : IsObject3(type) ? FromProperty(type.properties, propertyKey) : Never();
}
function IndexFromPropertyKeys(type, propertyKeys) {
  return propertyKeys.map((propertyKey) => IndexFromPropertyKey(type, propertyKey));
}
function FromSchema(type, propertyKeys) {
  return UnionEvaluated(IndexFromPropertyKeys(type, propertyKeys));
}
function Index(type, key, options) {
  if (IsRef(type) || IsRef(key)) {
    const error = `Index types using Ref parameters require both Type and Key to be of TSchema`;
    if (!IsSchema(type) || !IsSchema(key))
      throw new TypeBoxError(error);
    return Computed("Index", [type, key]);
  }
  if (IsMappedResult(key))
    return IndexFromMappedResult(type, key, options);
  if (IsMappedKey(key))
    return IndexFromMappedKey(type, key, options);
  return CreateType(IsSchema(key) ? FromSchema(type, IndexPropertyKeys(key)) : FromSchema(type, key), options);
}

// node_modules/@sinclair/typebox/build/esm/type/indexed/indexed-from-mapped-key.mjs
function MappedIndexPropertyKey(type, key, options) {
  return { [key]: Index(type, [key], Clone(options)) };
}
function MappedIndexPropertyKeys(type, propertyKeys, options) {
  return propertyKeys.reduce((result, left) => {
    return { ...result, ...MappedIndexPropertyKey(type, left, options) };
  }, {});
}
function MappedIndexProperties(type, mappedKey, options) {
  return MappedIndexPropertyKeys(type, mappedKey.keys, options);
}
function IndexFromMappedKey(type, mappedKey, options) {
  const properties = MappedIndexProperties(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/iterator/iterator.mjs
function Iterator(items, options) {
  return CreateType({ [Kind]: "Iterator", type: "Iterator", items }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/object/object.mjs
function RequiredArray(properties) {
  return globalThis.Object.keys(properties).filter((key) => !IsOptional(properties[key]));
}
function _Object(properties, options) {
  const required = RequiredArray(properties);
  const schema = required.length > 0 ? { [Kind]: "Object", type: "object", required, properties } : { [Kind]: "Object", type: "object", properties };
  return CreateType(schema, options);
}
var Object2 = _Object;

// node_modules/@sinclair/typebox/build/esm/type/promise/promise.mjs
function Promise2(item, options) {
  return CreateType({ [Kind]: "Promise", type: "Promise", item }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly/readonly.mjs
function RemoveReadonly(schema) {
  return CreateType(Discard(schema, [ReadonlyKind]));
}
function AddReadonly(schema) {
  return CreateType({ ...schema, [ReadonlyKind]: "Readonly" });
}
function ReadonlyWithFlag(schema, F) {
  return F === false ? RemoveReadonly(schema) : AddReadonly(schema);
}
function Readonly(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? ReadonlyFromMappedResult(schema, F) : ReadonlyWithFlag(schema, F);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly/readonly-from-mapped-result.mjs
function FromProperties2(K, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Readonly(K[K2], F);
  return Acc;
}
function FromMappedResult2(R, F) {
  return FromProperties2(R.properties, F);
}
function ReadonlyFromMappedResult(R, F) {
  const P = FromMappedResult2(R, F);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/tuple/tuple.mjs
function Tuple(types, options) {
  return CreateType(types.length > 0 ? { [Kind]: "Tuple", type: "array", items: types, additionalItems: false, minItems: types.length, maxItems: types.length } : { [Kind]: "Tuple", type: "array", minItems: types.length, maxItems: types.length }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/mapped/mapped.mjs
function FromMappedResult3(K, P) {
  return K in P ? FromSchemaType(K, P[K]) : MappedResult(P);
}
function MappedKeyToKnownMappedResultProperties(K) {
  return { [K]: Literal(K) };
}
function MappedKeyToUnknownMappedResultProperties(P) {
  const Acc = {};
  for (const L of P)
    Acc[L] = Literal(L);
  return Acc;
}
function MappedKeyToMappedResultProperties(K, P) {
  return SetIncludes(P, K) ? MappedKeyToKnownMappedResultProperties(K) : MappedKeyToUnknownMappedResultProperties(P);
}
function FromMappedKey(K, P) {
  const R = MappedKeyToMappedResultProperties(K, P);
  return FromMappedResult3(K, R);
}
function FromRest2(K, T) {
  return T.map((L) => FromSchemaType(K, L));
}
function FromProperties3(K, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(T))
    Acc[K2] = FromSchemaType(K, T[K2]);
  return Acc;
}
function FromSchemaType(K, T) {
  const options = { ...T };
  return (
    // unevaluated modifier types
    IsOptional(T) ? Optional(FromSchemaType(K, Discard(T, [OptionalKind]))) : IsReadonly(T) ? Readonly(FromSchemaType(K, Discard(T, [ReadonlyKind]))) : (
      // unevaluated mapped types
      IsMappedResult(T) ? FromMappedResult3(K, T.properties) : IsMappedKey(T) ? FromMappedKey(K, T.keys) : (
        // unevaluated types
        IsConstructor(T) ? Constructor(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsFunction2(T) ? Function(FromRest2(K, T.parameters), FromSchemaType(K, T.returns), options) : IsAsyncIterator2(T) ? AsyncIterator(FromSchemaType(K, T.items), options) : IsIterator2(T) ? Iterator(FromSchemaType(K, T.items), options) : IsIntersect(T) ? Intersect(FromRest2(K, T.allOf), options) : IsUnion(T) ? Union(FromRest2(K, T.anyOf), options) : IsTuple(T) ? Tuple(FromRest2(K, T.items ?? []), options) : IsObject3(T) ? Object2(FromProperties3(K, T.properties), options) : IsArray3(T) ? Array2(FromSchemaType(K, T.items), options) : IsPromise(T) ? Promise2(FromSchemaType(K, T.item), options) : T
      )
    )
  );
}
function MappedFunctionReturnType(K, T) {
  const Acc = {};
  for (const L of K)
    Acc[L] = FromSchemaType(L, T);
  return Acc;
}
function Mapped(key, map, options) {
  const K = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const RT = map({ [Kind]: "MappedKey", keys: K });
  const R = MappedFunctionReturnType(K, RT);
  return Object2(R, options);
}

// node_modules/@sinclair/typebox/build/esm/type/optional/optional.mjs
function RemoveOptional(schema) {
  return CreateType(Discard(schema, [OptionalKind]));
}
function AddOptional(schema) {
  return CreateType({ ...schema, [OptionalKind]: "Optional" });
}
function OptionalWithFlag(schema, F) {
  return F === false ? RemoveOptional(schema) : AddOptional(schema);
}
function Optional(schema, enable) {
  const F = enable ?? true;
  return IsMappedResult(schema) ? OptionalFromMappedResult(schema, F) : OptionalWithFlag(schema, F);
}

// node_modules/@sinclair/typebox/build/esm/type/optional/optional-from-mapped-result.mjs
function FromProperties4(P, F) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Optional(P[K2], F);
  return Acc;
}
function FromMappedResult4(R, F) {
  return FromProperties4(R.properties, F);
}
function OptionalFromMappedResult(R, F) {
  const P = FromMappedResult4(R, F);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-create.mjs
function IntersectCreate(T, options = {}) {
  const allObjects = T.every((schema) => IsObject3(schema));
  const clonedUnevaluatedProperties = IsSchema(options.unevaluatedProperties) ? { unevaluatedProperties: options.unevaluatedProperties } : {};
  return CreateType(options.unevaluatedProperties === false || IsSchema(options.unevaluatedProperties) || allObjects ? { ...clonedUnevaluatedProperties, [Kind]: "Intersect", type: "object", allOf: T } : { ...clonedUnevaluatedProperties, [Kind]: "Intersect", allOf: T }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect-evaluated.mjs
function IsIntersectOptional(types) {
  return types.every((left) => IsOptional(left));
}
function RemoveOptionalFromType2(type) {
  return Discard(type, [OptionalKind]);
}
function RemoveOptionalFromRest2(types) {
  return types.map((left) => IsOptional(left) ? RemoveOptionalFromType2(left) : left);
}
function ResolveIntersect(types, options) {
  return IsIntersectOptional(types) ? Optional(IntersectCreate(RemoveOptionalFromRest2(types), options)) : IntersectCreate(RemoveOptionalFromRest2(types), options);
}
function IntersectEvaluated(types, options = {}) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return ResolveIntersect(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intersect/intersect.mjs
function Intersect(types, options) {
  if (types.length === 1)
    return CreateType(types[0], options);
  if (types.length === 0)
    return Never(options);
  if (types.some((schema) => IsTransform(schema)))
    throw new Error("Cannot intersect transform types");
  return IntersectCreate(types, options);
}

// node_modules/@sinclair/typebox/build/esm/type/ref/ref.mjs
function Ref(...args) {
  const [$ref, options] = typeof args[0] === "string" ? [args[0], args[1]] : [args[0].$id, args[1]];
  if (typeof $ref !== "string")
    throw new TypeBoxError("Ref: $ref must be a string");
  return CreateType({ [Kind]: "Ref", $ref }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/awaited/awaited.mjs
function FromComputed(target, parameters) {
  return Computed("Awaited", [Computed(target, parameters)]);
}
function FromRef($ref) {
  return Computed("Awaited", [Ref($ref)]);
}
function FromIntersect2(types) {
  return Intersect(FromRest3(types));
}
function FromUnion4(types) {
  return Union(FromRest3(types));
}
function FromPromise(type) {
  return Awaited(type);
}
function FromRest3(types) {
  return types.map((type) => Awaited(type));
}
function Awaited(type, options) {
  return CreateType(IsComputed(type) ? FromComputed(type.target, type.parameters) : IsIntersect(type) ? FromIntersect2(type.allOf) : IsUnion(type) ? FromUnion4(type.anyOf) : IsPromise(type) ? FromPromise(type.item) : IsRef(type) ? FromRef(type.$ref) : type, options);
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-property-keys.mjs
function FromRest4(types) {
  const result = [];
  for (const L of types)
    result.push(KeyOfPropertyKeys(L));
  return result;
}
function FromIntersect3(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetUnionMany(propertyKeysArray);
  return propertyKeys;
}
function FromUnion5(types) {
  const propertyKeysArray = FromRest4(types);
  const propertyKeys = SetIntersectMany(propertyKeysArray);
  return propertyKeys;
}
function FromTuple2(types) {
  return types.map((_, indexer) => indexer.toString());
}
function FromArray2(_) {
  return ["[number]"];
}
function FromProperties5(T) {
  return globalThis.Object.getOwnPropertyNames(T);
}
function FromPatternProperties(patternProperties) {
  if (!includePatternProperties)
    return [];
  const patternPropertyKeys = globalThis.Object.getOwnPropertyNames(patternProperties);
  return patternPropertyKeys.map((key) => {
    return key[0] === "^" && key[key.length - 1] === "$" ? key.slice(1, key.length - 1) : key;
  });
}
function KeyOfPropertyKeys(type) {
  return IsIntersect(type) ? FromIntersect3(type.allOf) : IsUnion(type) ? FromUnion5(type.anyOf) : IsTuple(type) ? FromTuple2(type.items ?? []) : IsArray3(type) ? FromArray2(type.items) : IsObject3(type) ? FromProperties5(type.properties) : IsRecord(type) ? FromPatternProperties(type.patternProperties) : [];
}
var includePatternProperties = false;

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof.mjs
function FromComputed2(target, parameters) {
  return Computed("KeyOf", [Computed(target, parameters)]);
}
function FromRef2($ref) {
  return Computed("KeyOf", [Ref($ref)]);
}
function KeyOfFromType(type, options) {
  const propertyKeys = KeyOfPropertyKeys(type);
  const propertyKeyTypes = KeyOfPropertyKeysToRest(propertyKeys);
  const result = UnionEvaluated(propertyKeyTypes);
  return CreateType(result, options);
}
function KeyOfPropertyKeysToRest(propertyKeys) {
  return propertyKeys.map((L) => L === "[number]" ? Number2() : Literal(L));
}
function KeyOf(type, options) {
  return IsComputed(type) ? FromComputed2(type.target, type.parameters) : IsRef(type) ? FromRef2(type.$ref) : IsMappedResult(type) ? KeyOfFromMappedResult(type, options) : KeyOfFromType(type, options);
}

// node_modules/@sinclair/typebox/build/esm/type/keyof/keyof-from-mapped-result.mjs
function FromProperties6(properties, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = KeyOf(properties[K2], Clone(options));
  return result;
}
function FromMappedResult5(mappedResult, options) {
  return FromProperties6(mappedResult.properties, options);
}
function KeyOfFromMappedResult(mappedResult, options) {
  const properties = FromMappedResult5(mappedResult, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/composite/composite.mjs
function CompositeKeys(T) {
  const Acc = [];
  for (const L of T)
    Acc.push(...KeyOfPropertyKeys(L));
  return SetDistinct(Acc);
}
function FilterNever(T) {
  return T.filter((L) => !IsNever(L));
}
function CompositeProperty(T, K) {
  const Acc = [];
  for (const L of T)
    Acc.push(...IndexFromPropertyKeys(L, [K]));
  return FilterNever(Acc);
}
function CompositeProperties(T, K) {
  const Acc = {};
  for (const L of K) {
    Acc[L] = IntersectEvaluated(CompositeProperty(T, L));
  }
  return Acc;
}
function Composite(T, options) {
  const K = CompositeKeys(T);
  const P = CompositeProperties(T, K);
  const R = Object2(P, options);
  return R;
}

// node_modules/@sinclair/typebox/build/esm/type/date/date.mjs
function Date2(options) {
  return CreateType({ [Kind]: "Date", type: "Date" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/null/null.mjs
function Null(options) {
  return CreateType({ [Kind]: "Null", type: "null" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/symbol/symbol.mjs
function Symbol2(options) {
  return CreateType({ [Kind]: "Symbol", type: "symbol" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/undefined/undefined.mjs
function Undefined(options) {
  return CreateType({ [Kind]: "Undefined", type: "undefined" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/uint8array/uint8array.mjs
function Uint8Array2(options) {
  return CreateType({ [Kind]: "Uint8Array", type: "Uint8Array" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/unknown/unknown.mjs
function Unknown(options) {
  return CreateType({ [Kind]: "Unknown" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/const/const.mjs
function FromArray3(T) {
  return T.map((L) => FromValue(L, false));
}
function FromProperties7(value) {
  const Acc = {};
  for (const K of globalThis.Object.getOwnPropertyNames(value))
    Acc[K] = Readonly(FromValue(value[K], false));
  return Acc;
}
function ConditionalReadonly(T, root) {
  return root === true ? T : Readonly(T);
}
function FromValue(value, root) {
  return IsAsyncIterator(value) ? ConditionalReadonly(Any(), root) : IsIterator(value) ? ConditionalReadonly(Any(), root) : IsArray(value) ? Readonly(Tuple(FromArray3(value))) : IsUint8Array(value) ? Uint8Array2() : IsDate(value) ? Date2() : IsObject(value) ? ConditionalReadonly(Object2(FromProperties7(value)), root) : IsFunction(value) ? ConditionalReadonly(Function([], Unknown()), root) : IsUndefined(value) ? Undefined() : IsNull(value) ? Null() : IsSymbol(value) ? Symbol2() : IsBigInt(value) ? BigInt() : IsNumber(value) ? Literal(value) : IsBoolean(value) ? Literal(value) : IsString(value) ? Literal(value) : Object2({});
}
function Const(T, options) {
  return CreateType(FromValue(T, true), options);
}

// node_modules/@sinclair/typebox/build/esm/type/constructor-parameters/constructor-parameters.mjs
function ConstructorParameters(schema, options) {
  return IsConstructor(schema) ? Tuple(schema.parameters, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/enum/enum.mjs
function Enum(item, options) {
  if (IsUndefined(item))
    throw new Error("Enum undefined or empty");
  const values1 = globalThis.Object.getOwnPropertyNames(item).filter((key) => isNaN(key)).map((key) => item[key]);
  const values2 = [...new Set(values1)];
  const anyOf = values2.map((value) => Literal(value));
  return Union(anyOf, { ...options, [Hint]: "Enum" });
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-check.mjs
var ExtendsResolverError = class extends TypeBoxError {
};
var ExtendsResult;
(function(ExtendsResult2) {
  ExtendsResult2[ExtendsResult2["Union"] = 0] = "Union";
  ExtendsResult2[ExtendsResult2["True"] = 1] = "True";
  ExtendsResult2[ExtendsResult2["False"] = 2] = "False";
})(ExtendsResult || (ExtendsResult = {}));
function IntoBooleanResult(result) {
  return result === ExtendsResult.False ? result : ExtendsResult.True;
}
function Throw(message) {
  throw new ExtendsResolverError(message);
}
function IsStructuralRight(right) {
  return type_exports.IsNever(right) || type_exports.IsIntersect(right) || type_exports.IsUnion(right) || type_exports.IsUnknown(right) || type_exports.IsAny(right);
}
function StructuralRight(left, right) {
  return type_exports.IsNever(right) ? FromNeverRight(left, right) : type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsUnknown(right) ? FromUnknownRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : Throw("StructuralRight");
}
function FromAnyRight(left, right) {
  return ExtendsResult.True;
}
function FromAny(left, right) {
  return type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) && right.anyOf.some((schema) => type_exports.IsAny(schema) || type_exports.IsUnknown(schema)) ? ExtendsResult.True : type_exports.IsUnion(right) ? ExtendsResult.Union : type_exports.IsUnknown(right) ? ExtendsResult.True : type_exports.IsAny(right) ? ExtendsResult.True : ExtendsResult.Union;
}
function FromArrayRight(left, right) {
  return type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : type_exports.IsNever(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromArray4(left, right) {
  return type_exports.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsArray(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromAsyncIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsAsyncIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromBigInt(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsBigInt(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBooleanRight(left, right) {
  return type_exports.IsLiteralBoolean(left) ? ExtendsResult.True : type_exports.IsBoolean(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromBoolean(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsBoolean(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromConstructor(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsConstructor(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromDate(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsDate(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromFunction(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsFunction(right) ? ExtendsResult.False : left.parameters.length > right.parameters.length ? ExtendsResult.False : !left.parameters.every((schema, index) => IntoBooleanResult(Visit3(right.parameters[index], schema)) === ExtendsResult.True) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.returns, right.returns));
}
function FromIntegerRight(left, right) {
  return type_exports.IsLiteral(left) && value_exports.IsNumber(left.const) ? ExtendsResult.True : type_exports.IsNumber(left) || type_exports.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromInteger(left, right) {
  return type_exports.IsInteger(right) || type_exports.IsNumber(right) ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : ExtendsResult.False;
}
function FromIntersectRight(left, right) {
  return right.allOf.every((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIntersect4(left, right) {
  return left.allOf.some((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromIterator(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : !type_exports.IsIterator(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.items, right.items));
}
function FromLiteral2(left, right) {
  return type_exports.IsLiteral(right) && right.const === left.const ? ExtendsResult.True : IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsString(right) ? FromStringRight(left, right) : type_exports.IsNumber(right) ? FromNumberRight(left, right) : type_exports.IsInteger(right) ? FromIntegerRight(left, right) : type_exports.IsBoolean(right) ? FromBooleanRight(left, right) : ExtendsResult.False;
}
function FromNeverRight(left, right) {
  return ExtendsResult.False;
}
function FromNever(left, right) {
  return ExtendsResult.True;
}
function UnwrapTNot(schema) {
  let [current, depth] = [schema, 0];
  while (true) {
    if (!type_exports.IsNot(current))
      break;
    current = current.not;
    depth += 1;
  }
  return depth % 2 === 0 ? current : Unknown();
}
function FromNot(left, right) {
  return type_exports.IsNot(left) ? Visit3(UnwrapTNot(left), right) : type_exports.IsNot(right) ? Visit3(left, UnwrapTNot(right)) : Throw("Invalid fallthrough for Not");
}
function FromNull(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsNull(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumberRight(left, right) {
  return type_exports.IsLiteralNumber(left) ? ExtendsResult.True : type_exports.IsNumber(left) || type_exports.IsInteger(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromNumber(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsInteger(right) || type_exports.IsNumber(right) ? ExtendsResult.True : ExtendsResult.False;
}
function IsObjectPropertyCount(schema, count) {
  return Object.getOwnPropertyNames(schema.properties).length === count;
}
function IsObjectStringLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectSymbolLike(schema) {
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "description" in schema.properties && type_exports.IsUnion(schema.properties.description) && schema.properties.description.anyOf.length === 2 && (type_exports.IsString(schema.properties.description.anyOf[0]) && type_exports.IsUndefined(schema.properties.description.anyOf[1]) || type_exports.IsString(schema.properties.description.anyOf[1]) && type_exports.IsUndefined(schema.properties.description.anyOf[0]));
}
function IsObjectNumberLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBooleanLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectBigIntLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectDateLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectUint8ArrayLike(schema) {
  return IsObjectArrayLike(schema);
}
function IsObjectFunctionLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectConstructorLike(schema) {
  return IsObjectPropertyCount(schema, 0);
}
function IsObjectArrayLike(schema) {
  const length = Number2();
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "length" in schema.properties && IntoBooleanResult(Visit3(schema.properties["length"], length)) === ExtendsResult.True;
}
function IsObjectPromiseLike(schema) {
  const then = Function([Any()], Any());
  return IsObjectPropertyCount(schema, 0) || IsObjectPropertyCount(schema, 1) && "then" in schema.properties && IntoBooleanResult(Visit3(schema.properties["then"], then)) === ExtendsResult.True;
}
function Property(left, right) {
  return Visit3(left, right) === ExtendsResult.False ? ExtendsResult.False : type_exports.IsOptional(left) && !type_exports.IsOptional(right) ? ExtendsResult.False : ExtendsResult.True;
}
function FromObjectRight(left, right) {
  return type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : type_exports.IsNever(left) || type_exports.IsLiteralString(left) && IsObjectStringLike(right) || type_exports.IsLiteralNumber(left) && IsObjectNumberLike(right) || type_exports.IsLiteralBoolean(left) && IsObjectBooleanLike(right) || type_exports.IsSymbol(left) && IsObjectSymbolLike(right) || type_exports.IsBigInt(left) && IsObjectBigIntLike(right) || type_exports.IsString(left) && IsObjectStringLike(right) || type_exports.IsSymbol(left) && IsObjectSymbolLike(right) || type_exports.IsNumber(left) && IsObjectNumberLike(right) || type_exports.IsInteger(left) && IsObjectNumberLike(right) || type_exports.IsBoolean(left) && IsObjectBooleanLike(right) || type_exports.IsUint8Array(left) && IsObjectUint8ArrayLike(right) || type_exports.IsDate(left) && IsObjectDateLike(right) || type_exports.IsConstructor(left) && IsObjectConstructorLike(right) || type_exports.IsFunction(left) && IsObjectFunctionLike(right) ? ExtendsResult.True : type_exports.IsRecord(left) && type_exports.IsString(RecordKey(left)) ? (() => {
    return right[Hint] === "Record" ? ExtendsResult.True : ExtendsResult.False;
  })() : type_exports.IsRecord(left) && type_exports.IsNumber(RecordKey(left)) ? (() => {
    return IsObjectPropertyCount(right, 0) ? ExtendsResult.True : ExtendsResult.False;
  })() : ExtendsResult.False;
}
function FromObject(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : !type_exports.IsObject(right) ? ExtendsResult.False : (() => {
    for (const key of Object.getOwnPropertyNames(right.properties)) {
      if (!(key in left.properties) && !type_exports.IsOptional(right.properties[key])) {
        return ExtendsResult.False;
      }
      if (type_exports.IsOptional(right.properties[key])) {
        return ExtendsResult.True;
      }
      if (Property(left.properties[key], right.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })();
}
function FromPromise2(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) && IsObjectPromiseLike(right) ? ExtendsResult.True : !type_exports.IsPromise(right) ? ExtendsResult.False : IntoBooleanResult(Visit3(left.item, right.item));
}
function RecordKey(schema) {
  return PatternNumberExact in schema.patternProperties ? Number2() : PatternStringExact in schema.patternProperties ? String2() : Throw("Unknown record key pattern");
}
function RecordValue(schema) {
  return PatternNumberExact in schema.patternProperties ? schema.patternProperties[PatternNumberExact] : PatternStringExact in schema.patternProperties ? schema.patternProperties[PatternStringExact] : Throw("Unable to get record value schema");
}
function FromRecordRight(left, right) {
  const [Key, Value] = [RecordKey(right), RecordValue(right)];
  return type_exports.IsLiteralString(left) && type_exports.IsNumber(Key) && IntoBooleanResult(Visit3(left, Value)) === ExtendsResult.True ? ExtendsResult.True : type_exports.IsUint8Array(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsString(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsArray(left) && type_exports.IsNumber(Key) ? Visit3(left, Value) : type_exports.IsObject(left) ? (() => {
    for (const key of Object.getOwnPropertyNames(left.properties)) {
      if (Property(Value, left.properties[key]) === ExtendsResult.False) {
        return ExtendsResult.False;
      }
    }
    return ExtendsResult.True;
  })() : ExtendsResult.False;
}
function FromRecord(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : !type_exports.IsRecord(right) ? ExtendsResult.False : Visit3(RecordValue(left), RecordValue(right));
}
function FromRegExp(left, right) {
  const L = type_exports.IsRegExp(left) ? String2() : left;
  const R = type_exports.IsRegExp(right) ? String2() : right;
  return Visit3(L, R);
}
function FromStringRight(left, right) {
  return type_exports.IsLiteral(left) && value_exports.IsString(left.const) ? ExtendsResult.True : type_exports.IsString(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromString(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsString(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromSymbol(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsSymbol(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromTemplateLiteral2(left, right) {
  return type_exports.IsTemplateLiteral(left) ? Visit3(TemplateLiteralToUnion(left), right) : type_exports.IsTemplateLiteral(right) ? Visit3(left, TemplateLiteralToUnion(right)) : Throw("Invalid fallthrough for TemplateLiteral");
}
function IsArrayOfTuple(left, right) {
  return type_exports.IsArray(right) && left.items !== void 0 && left.items.every((schema) => Visit3(schema, right.items) === ExtendsResult.True);
}
function FromTupleRight(left, right) {
  return type_exports.IsNever(left) ? ExtendsResult.True : type_exports.IsUnknown(left) ? ExtendsResult.False : type_exports.IsAny(left) ? ExtendsResult.Union : ExtendsResult.False;
}
function FromTuple3(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) && IsObjectArrayLike(right) ? ExtendsResult.True : type_exports.IsArray(right) && IsArrayOfTuple(left, right) ? ExtendsResult.True : !type_exports.IsTuple(right) ? ExtendsResult.False : value_exports.IsUndefined(left.items) && !value_exports.IsUndefined(right.items) || !value_exports.IsUndefined(left.items) && value_exports.IsUndefined(right.items) ? ExtendsResult.False : value_exports.IsUndefined(left.items) && !value_exports.IsUndefined(right.items) ? ExtendsResult.True : left.items.every((schema, index) => Visit3(schema, right.items[index]) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUint8Array(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsUint8Array(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUndefined(left, right) {
  return IsStructuralRight(right) ? StructuralRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsRecord(right) ? FromRecordRight(left, right) : type_exports.IsVoid(right) ? FromVoidRight(left, right) : type_exports.IsUndefined(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnionRight(left, right) {
  return right.anyOf.some((schema) => Visit3(left, schema) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnion6(left, right) {
  return left.anyOf.every((schema) => Visit3(schema, right) === ExtendsResult.True) ? ExtendsResult.True : ExtendsResult.False;
}
function FromUnknownRight(left, right) {
  return ExtendsResult.True;
}
function FromUnknown(left, right) {
  return type_exports.IsNever(right) ? FromNeverRight(left, right) : type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : type_exports.IsString(right) ? FromStringRight(left, right) : type_exports.IsNumber(right) ? FromNumberRight(left, right) : type_exports.IsInteger(right) ? FromIntegerRight(left, right) : type_exports.IsBoolean(right) ? FromBooleanRight(left, right) : type_exports.IsArray(right) ? FromArrayRight(left, right) : type_exports.IsTuple(right) ? FromTupleRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsUnknown(right) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoidRight(left, right) {
  return type_exports.IsUndefined(left) ? ExtendsResult.True : type_exports.IsUndefined(left) ? ExtendsResult.True : ExtendsResult.False;
}
function FromVoid(left, right) {
  return type_exports.IsIntersect(right) ? FromIntersectRight(left, right) : type_exports.IsUnion(right) ? FromUnionRight(left, right) : type_exports.IsUnknown(right) ? FromUnknownRight(left, right) : type_exports.IsAny(right) ? FromAnyRight(left, right) : type_exports.IsObject(right) ? FromObjectRight(left, right) : type_exports.IsVoid(right) ? ExtendsResult.True : ExtendsResult.False;
}
function Visit3(left, right) {
  return (
    // resolvable
    type_exports.IsTemplateLiteral(left) || type_exports.IsTemplateLiteral(right) ? FromTemplateLiteral2(left, right) : type_exports.IsRegExp(left) || type_exports.IsRegExp(right) ? FromRegExp(left, right) : type_exports.IsNot(left) || type_exports.IsNot(right) ? FromNot(left, right) : (
      // standard
      type_exports.IsAny(left) ? FromAny(left, right) : type_exports.IsArray(left) ? FromArray4(left, right) : type_exports.IsBigInt(left) ? FromBigInt(left, right) : type_exports.IsBoolean(left) ? FromBoolean(left, right) : type_exports.IsAsyncIterator(left) ? FromAsyncIterator(left, right) : type_exports.IsConstructor(left) ? FromConstructor(left, right) : type_exports.IsDate(left) ? FromDate(left, right) : type_exports.IsFunction(left) ? FromFunction(left, right) : type_exports.IsInteger(left) ? FromInteger(left, right) : type_exports.IsIntersect(left) ? FromIntersect4(left, right) : type_exports.IsIterator(left) ? FromIterator(left, right) : type_exports.IsLiteral(left) ? FromLiteral2(left, right) : type_exports.IsNever(left) ? FromNever(left, right) : type_exports.IsNull(left) ? FromNull(left, right) : type_exports.IsNumber(left) ? FromNumber(left, right) : type_exports.IsObject(left) ? FromObject(left, right) : type_exports.IsRecord(left) ? FromRecord(left, right) : type_exports.IsString(left) ? FromString(left, right) : type_exports.IsSymbol(left) ? FromSymbol(left, right) : type_exports.IsTuple(left) ? FromTuple3(left, right) : type_exports.IsPromise(left) ? FromPromise2(left, right) : type_exports.IsUint8Array(left) ? FromUint8Array(left, right) : type_exports.IsUndefined(left) ? FromUndefined(left, right) : type_exports.IsUnion(left) ? FromUnion6(left, right) : type_exports.IsUnknown(left) ? FromUnknown(left, right) : type_exports.IsVoid(left) ? FromVoid(left, right) : Throw(`Unknown left type operand '${left[Kind]}'`)
    )
  );
}
function ExtendsCheck(left, right) {
  return Visit3(left, right);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-result.mjs
function FromProperties8(P, Right, True, False, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extends(P[K2], Right, True, False, Clone(options));
  return Acc;
}
function FromMappedResult6(Left, Right, True, False, options) {
  return FromProperties8(Left.properties, Right, True, False, options);
}
function ExtendsFromMappedResult(Left, Right, True, False, options) {
  const P = FromMappedResult6(Left, Right, True, False, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends.mjs
function ExtendsResolve(left, right, trueType, falseType) {
  const R = ExtendsCheck(left, right);
  return R === ExtendsResult.Union ? Union([trueType, falseType]) : R === ExtendsResult.True ? trueType : falseType;
}
function Extends(L, R, T, F, options) {
  return IsMappedResult(L) ? ExtendsFromMappedResult(L, R, T, F, options) : IsMappedKey(L) ? CreateType(ExtendsFromMappedKey(L, R, T, F, options)) : CreateType(ExtendsResolve(L, R, T, F), options);
}

// node_modules/@sinclair/typebox/build/esm/type/extends/extends-from-mapped-key.mjs
function FromPropertyKey(K, U, L, R, options) {
  return {
    [K]: Extends(Literal(K), U, L, R, Clone(options))
  };
}
function FromPropertyKeys(K, U, L, R, options) {
  return K.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey(LK, U, L, R, options) };
  }, {});
}
function FromMappedKey2(K, U, L, R, options) {
  return FromPropertyKeys(K.keys, U, L, R, options);
}
function ExtendsFromMappedKey(T, U, L, R, options) {
  const P = FromMappedKey2(T, U, L, R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-template-literal.mjs
function ExcludeFromTemplateLiteral(L, R) {
  return Exclude(TemplateLiteralToUnion(L), R);
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude.mjs
function ExcludeRest(L, R) {
  const excluded = L.filter((inner) => ExtendsCheck(inner, R) === ExtendsResult.False);
  return excluded.length === 1 ? excluded[0] : Union(excluded);
}
function Exclude(L, R, options = {}) {
  if (IsTemplateLiteral(L))
    return CreateType(ExcludeFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExcludeFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExcludeRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? Never() : L, options);
}

// node_modules/@sinclair/typebox/build/esm/type/exclude/exclude-from-mapped-result.mjs
function FromProperties9(P, U) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Exclude(P[K2], U);
  return Acc;
}
function FromMappedResult7(R, T) {
  return FromProperties9(R.properties, T);
}
function ExcludeFromMappedResult(R, T) {
  const P = FromMappedResult7(R, T);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-template-literal.mjs
function ExtractFromTemplateLiteral(L, R) {
  return Extract(TemplateLiteralToUnion(L), R);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract.mjs
function ExtractRest(L, R) {
  const extracted = L.filter((inner) => ExtendsCheck(inner, R) !== ExtendsResult.False);
  return extracted.length === 1 ? extracted[0] : Union(extracted);
}
function Extract(L, R, options) {
  if (IsTemplateLiteral(L))
    return CreateType(ExtractFromTemplateLiteral(L, R), options);
  if (IsMappedResult(L))
    return CreateType(ExtractFromMappedResult(L, R), options);
  return CreateType(IsUnion(L) ? ExtractRest(L.anyOf, R) : ExtendsCheck(L, R) !== ExtendsResult.False ? L : Never(), options);
}

// node_modules/@sinclair/typebox/build/esm/type/extract/extract-from-mapped-result.mjs
function FromProperties10(P, T) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Extract(P[K2], T);
  return Acc;
}
function FromMappedResult8(R, T) {
  return FromProperties10(R.properties, T);
}
function ExtractFromMappedResult(R, T) {
  const P = FromMappedResult8(R, T);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/instance-type/instance-type.mjs
function InstanceType(schema, options) {
  return IsConstructor(schema) ? CreateType(schema.returns, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/readonly-optional/readonly-optional.mjs
function ReadonlyOptional(schema) {
  return Readonly(Optional(schema));
}

// node_modules/@sinclair/typebox/build/esm/type/record/record.mjs
function RecordCreateFromPattern(pattern, T, options) {
  return CreateType({ [Kind]: "Record", type: "object", patternProperties: { [pattern]: T } }, options);
}
function RecordCreateFromKeys(K, T, options) {
  const result = {};
  for (const K2 of K)
    result[K2] = T;
  return Object2(result, { ...options, [Hint]: "Record" });
}
function FromTemplateLiteralKey(K, T, options) {
  return IsTemplateLiteralFinite(K) ? RecordCreateFromKeys(IndexPropertyKeys(K), T, options) : RecordCreateFromPattern(K.pattern, T, options);
}
function FromUnionKey(key, type, options) {
  return RecordCreateFromKeys(IndexPropertyKeys(Union(key)), type, options);
}
function FromLiteralKey(key, type, options) {
  return RecordCreateFromKeys([key.toString()], type, options);
}
function FromRegExpKey(key, type, options) {
  return RecordCreateFromPattern(key.source, type, options);
}
function FromStringKey(key, type, options) {
  const pattern = IsUndefined(key.pattern) ? PatternStringExact : key.pattern;
  return RecordCreateFromPattern(pattern, type, options);
}
function FromAnyKey(_, type, options) {
  return RecordCreateFromPattern(PatternStringExact, type, options);
}
function FromNeverKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNeverExact, type, options);
}
function FromBooleanKey(_key, type, options) {
  return Object2({ true: type, false: type }, options);
}
function FromIntegerKey(_key, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function FromNumberKey(_, type, options) {
  return RecordCreateFromPattern(PatternNumberExact, type, options);
}
function Record(key, type, options = {}) {
  return IsUnion(key) ? FromUnionKey(key.anyOf, type, options) : IsTemplateLiteral(key) ? FromTemplateLiteralKey(key, type, options) : IsLiteral(key) ? FromLiteralKey(key.const, type, options) : IsBoolean2(key) ? FromBooleanKey(key, type, options) : IsInteger(key) ? FromIntegerKey(key, type, options) : IsNumber3(key) ? FromNumberKey(key, type, options) : IsRegExp2(key) ? FromRegExpKey(key, type, options) : IsString2(key) ? FromStringKey(key, type, options) : IsAny(key) ? FromAnyKey(key, type, options) : IsNever(key) ? FromNeverKey(key, type, options) : Never(options);
}
function RecordPattern(record) {
  return globalThis.Object.getOwnPropertyNames(record.patternProperties)[0];
}
function RecordKey2(type) {
  const pattern = RecordPattern(type);
  return pattern === PatternStringExact ? String2() : pattern === PatternNumberExact ? Number2() : String2({ pattern });
}
function RecordValue2(type) {
  return type.patternProperties[RecordPattern(type)];
}

// node_modules/@sinclair/typebox/build/esm/type/instantiate/instantiate.mjs
function FromConstructor2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromFunction2(args, type) {
  type.parameters = FromTypes(args, type.parameters);
  type.returns = FromType(args, type.returns);
  return type;
}
function FromIntersect5(args, type) {
  type.allOf = FromTypes(args, type.allOf);
  return type;
}
function FromUnion7(args, type) {
  type.anyOf = FromTypes(args, type.anyOf);
  return type;
}
function FromTuple4(args, type) {
  if (IsUndefined(type.items))
    return type;
  type.items = FromTypes(args, type.items);
  return type;
}
function FromArray5(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromAsyncIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromIterator2(args, type) {
  type.items = FromType(args, type.items);
  return type;
}
function FromPromise3(args, type) {
  type.item = FromType(args, type.item);
  return type;
}
function FromObject2(args, type) {
  const mappedProperties = FromProperties11(args, type.properties);
  return { ...type, ...Object2(mappedProperties) };
}
function FromRecord2(args, type) {
  const mappedKey = FromType(args, RecordKey2(type));
  const mappedValue = FromType(args, RecordValue2(type));
  const result = Record(mappedKey, mappedValue);
  return { ...type, ...result };
}
function FromArgument(args, argument) {
  return argument.index in args ? args[argument.index] : Unknown();
}
function FromProperty2(args, type) {
  const isReadonly = IsReadonly(type);
  const isOptional = IsOptional(type);
  const mapped = FromType(args, type);
  return isReadonly && isOptional ? ReadonlyOptional(mapped) : isReadonly && !isOptional ? Readonly(mapped) : !isReadonly && isOptional ? Optional(mapped) : mapped;
}
function FromProperties11(args, properties) {
  return globalThis.Object.getOwnPropertyNames(properties).reduce((result, key) => {
    return { ...result, [key]: FromProperty2(args, properties[key]) };
  }, {});
}
function FromTypes(args, types) {
  return types.map((type) => FromType(args, type));
}
function FromType(args, type) {
  return IsConstructor(type) ? FromConstructor2(args, type) : IsFunction2(type) ? FromFunction2(args, type) : IsIntersect(type) ? FromIntersect5(args, type) : IsUnion(type) ? FromUnion7(args, type) : IsTuple(type) ? FromTuple4(args, type) : IsArray3(type) ? FromArray5(args, type) : IsAsyncIterator2(type) ? FromAsyncIterator2(args, type) : IsIterator2(type) ? FromIterator2(args, type) : IsPromise(type) ? FromPromise3(args, type) : IsObject3(type) ? FromObject2(args, type) : IsRecord(type) ? FromRecord2(args, type) : IsArgument(type) ? FromArgument(args, type) : type;
}
function Instantiate(type, args) {
  return FromType(args, CloneType(type));
}

// node_modules/@sinclair/typebox/build/esm/type/integer/integer.mjs
function Integer(options) {
  return CreateType({ [Kind]: "Integer", type: "integer" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic-from-mapped-key.mjs
function MappedIntrinsicPropertyKey(K, M, options) {
  return {
    [K]: Intrinsic(Literal(K), M, Clone(options))
  };
}
function MappedIntrinsicPropertyKeys(K, M, options) {
  const result = K.reduce((Acc, L) => {
    return { ...Acc, ...MappedIntrinsicPropertyKey(L, M, options) };
  }, {});
  return result;
}
function MappedIntrinsicProperties(T, M, options) {
  return MappedIntrinsicPropertyKeys(T["keys"], M, options);
}
function IntrinsicFromMappedKey(T, M, options) {
  const P = MappedIntrinsicProperties(T, M, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/intrinsic.mjs
function ApplyUncapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toLowerCase(), rest].join("");
}
function ApplyCapitalize(value) {
  const [first, rest] = [value.slice(0, 1), value.slice(1)];
  return [first.toUpperCase(), rest].join("");
}
function ApplyUppercase(value) {
  return value.toUpperCase();
}
function ApplyLowercase(value) {
  return value.toLowerCase();
}
function FromTemplateLiteral3(schema, mode, options) {
  const expression = TemplateLiteralParseExact(schema.pattern);
  const finite = IsTemplateLiteralExpressionFinite(expression);
  if (!finite)
    return { ...schema, pattern: FromLiteralValue(schema.pattern, mode) };
  const strings = [...TemplateLiteralExpressionGenerate(expression)];
  const literals = strings.map((value) => Literal(value));
  const mapped = FromRest5(literals, mode);
  const union = Union(mapped);
  return TemplateLiteral([union], options);
}
function FromLiteralValue(value, mode) {
  return typeof value === "string" ? mode === "Uncapitalize" ? ApplyUncapitalize(value) : mode === "Capitalize" ? ApplyCapitalize(value) : mode === "Uppercase" ? ApplyUppercase(value) : mode === "Lowercase" ? ApplyLowercase(value) : value : value.toString();
}
function FromRest5(T, M) {
  return T.map((L) => Intrinsic(L, M));
}
function Intrinsic(schema, mode, options = {}) {
  return (
    // Intrinsic-Mapped-Inference
    IsMappedKey(schema) ? IntrinsicFromMappedKey(schema, mode, options) : (
      // Standard-Inference
      IsTemplateLiteral(schema) ? FromTemplateLiteral3(schema, mode, options) : IsUnion(schema) ? Union(FromRest5(schema.anyOf, mode), options) : IsLiteral(schema) ? Literal(FromLiteralValue(schema.const, mode), options) : (
        // Default Type
        CreateType(schema, options)
      )
    )
  );
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/capitalize.mjs
function Capitalize(T, options = {}) {
  return Intrinsic(T, "Capitalize", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/lowercase.mjs
function Lowercase(T, options = {}) {
  return Intrinsic(T, "Lowercase", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/uncapitalize.mjs
function Uncapitalize(T, options = {}) {
  return Intrinsic(T, "Uncapitalize", options);
}

// node_modules/@sinclair/typebox/build/esm/type/intrinsic/uppercase.mjs
function Uppercase(T, options = {}) {
  return Intrinsic(T, "Uppercase", options);
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-result.mjs
function FromProperties12(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Omit(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult9(mappedResult, propertyKeys, options) {
  return FromProperties12(mappedResult.properties, propertyKeys, options);
}
function OmitFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult9(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit.mjs
function FromIntersect6(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromUnion8(types, propertyKeys) {
  return types.map((type) => OmitResolve(type, propertyKeys));
}
function FromProperty3(properties, key) {
  const { [key]: _, ...R } = properties;
  return R;
}
function FromProperties13(properties, propertyKeys) {
  return propertyKeys.reduce((T, K2) => FromProperty3(T, K2), properties);
}
function FromObject3(type, propertyKeys, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties13(properties, propertyKeys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function OmitResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect6(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion8(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject3(type, propertyKeys, type.properties) : Object2({});
}
function Omit(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? OmitFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? OmitFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Omit", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Omit", [type, typeKey], options) : CreateType({ ...OmitResolve(type, propertyKeys), ...options });
}

// node_modules/@sinclair/typebox/build/esm/type/omit/omit-from-mapped-key.mjs
function FromPropertyKey2(type, key, options) {
  return { [key]: Omit(type, [key], Clone(options)) };
}
function FromPropertyKeys2(type, propertyKeys, options) {
  return propertyKeys.reduce((Acc, LK) => {
    return { ...Acc, ...FromPropertyKey2(type, LK, options) };
  }, {});
}
function FromMappedKey3(type, mappedKey, options) {
  return FromPropertyKeys2(type, mappedKey.keys, options);
}
function OmitFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey3(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-result.mjs
function FromProperties14(properties, propertyKeys, options) {
  const result = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(properties))
    result[K2] = Pick(properties[K2], propertyKeys, Clone(options));
  return result;
}
function FromMappedResult10(mappedResult, propertyKeys, options) {
  return FromProperties14(mappedResult.properties, propertyKeys, options);
}
function PickFromMappedResult(mappedResult, propertyKeys, options) {
  const properties = FromMappedResult10(mappedResult, propertyKeys, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick.mjs
function FromIntersect7(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromUnion9(types, propertyKeys) {
  return types.map((type) => PickResolve(type, propertyKeys));
}
function FromProperties15(properties, propertyKeys) {
  const result = {};
  for (const K2 of propertyKeys)
    if (K2 in properties)
      result[K2] = properties[K2];
  return result;
}
function FromObject4(Type2, keys, properties) {
  const options = Discard(Type2, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties15(properties, keys);
  return Object2(mappedProperties, options);
}
function UnionFromPropertyKeys2(propertyKeys) {
  const result = propertyKeys.reduce((result2, key) => IsLiteralValue(key) ? [...result2, Literal(key)] : result2, []);
  return Union(result);
}
function PickResolve(type, propertyKeys) {
  return IsIntersect(type) ? Intersect(FromIntersect7(type.allOf, propertyKeys)) : IsUnion(type) ? Union(FromUnion9(type.anyOf, propertyKeys)) : IsObject3(type) ? FromObject4(type, propertyKeys, type.properties) : Object2({});
}
function Pick(type, key, options) {
  const typeKey = IsArray(key) ? UnionFromPropertyKeys2(key) : key;
  const propertyKeys = IsSchema(key) ? IndexPropertyKeys(key) : key;
  const isTypeRef = IsRef(type);
  const isKeyRef = IsRef(key);
  return IsMappedResult(type) ? PickFromMappedResult(type, propertyKeys, options) : IsMappedKey(key) ? PickFromMappedKey(type, key, options) : isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : !isTypeRef && isKeyRef ? Computed("Pick", [type, typeKey], options) : isTypeRef && !isKeyRef ? Computed("Pick", [type, typeKey], options) : CreateType({ ...PickResolve(type, propertyKeys), ...options });
}

// node_modules/@sinclair/typebox/build/esm/type/pick/pick-from-mapped-key.mjs
function FromPropertyKey3(type, key, options) {
  return {
    [key]: Pick(type, [key], Clone(options))
  };
}
function FromPropertyKeys3(type, propertyKeys, options) {
  return propertyKeys.reduce((result, leftKey) => {
    return { ...result, ...FromPropertyKey3(type, leftKey, options) };
  }, {});
}
function FromMappedKey4(type, mappedKey, options) {
  return FromPropertyKeys3(type, mappedKey.keys, options);
}
function PickFromMappedKey(type, mappedKey, options) {
  const properties = FromMappedKey4(type, mappedKey, options);
  return MappedResult(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/partial/partial.mjs
function FromComputed3(target, parameters) {
  return Computed("Partial", [Computed(target, parameters)]);
}
function FromRef3($ref) {
  return Computed("Partial", [Ref($ref)]);
}
function FromProperties16(properties) {
  const partialProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    partialProperties[K] = Optional(properties[K]);
  return partialProperties;
}
function FromObject5(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties16(properties);
  return Object2(mappedProperties, options);
}
function FromRest6(types) {
  return types.map((type) => PartialResolve(type));
}
function PartialResolve(type) {
  return (
    // Mappable
    IsComputed(type) ? FromComputed3(type.target, type.parameters) : IsRef(type) ? FromRef3(type.$ref) : IsIntersect(type) ? Intersect(FromRest6(type.allOf)) : IsUnion(type) ? Union(FromRest6(type.anyOf)) : IsObject3(type) ? FromObject5(type, type.properties) : (
      // Intrinsic
      IsBigInt2(type) ? type : IsBoolean2(type) ? type : IsInteger(type) ? type : IsLiteral(type) ? type : IsNull2(type) ? type : IsNumber3(type) ? type : IsString2(type) ? type : IsSymbol2(type) ? type : IsUndefined3(type) ? type : (
        // Passthrough
        Object2({})
      )
    )
  );
}
function Partial(type, options) {
  if (IsMappedResult(type)) {
    return PartialFromMappedResult(type, options);
  } else {
    return CreateType({ ...PartialResolve(type), ...options });
  }
}

// node_modules/@sinclair/typebox/build/esm/type/partial/partial-from-mapped-result.mjs
function FromProperties17(K, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(K))
    Acc[K2] = Partial(K[K2], Clone(options));
  return Acc;
}
function FromMappedResult11(R, options) {
  return FromProperties17(R.properties, options);
}
function PartialFromMappedResult(R, options) {
  const P = FromMappedResult11(R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/required/required.mjs
function FromComputed4(target, parameters) {
  return Computed("Required", [Computed(target, parameters)]);
}
function FromRef4($ref) {
  return Computed("Required", [Ref($ref)]);
}
function FromProperties18(properties) {
  const requiredProperties = {};
  for (const K of globalThis.Object.getOwnPropertyNames(properties))
    requiredProperties[K] = Discard(properties[K], [OptionalKind]);
  return requiredProperties;
}
function FromObject6(type, properties) {
  const options = Discard(type, [TransformKind, "$id", "required", "properties"]);
  const mappedProperties = FromProperties18(properties);
  return Object2(mappedProperties, options);
}
function FromRest7(types) {
  return types.map((type) => RequiredResolve(type));
}
function RequiredResolve(type) {
  return (
    // Mappable
    IsComputed(type) ? FromComputed4(type.target, type.parameters) : IsRef(type) ? FromRef4(type.$ref) : IsIntersect(type) ? Intersect(FromRest7(type.allOf)) : IsUnion(type) ? Union(FromRest7(type.anyOf)) : IsObject3(type) ? FromObject6(type, type.properties) : (
      // Intrinsic
      IsBigInt2(type) ? type : IsBoolean2(type) ? type : IsInteger(type) ? type : IsLiteral(type) ? type : IsNull2(type) ? type : IsNumber3(type) ? type : IsString2(type) ? type : IsSymbol2(type) ? type : IsUndefined3(type) ? type : (
        // Passthrough
        Object2({})
      )
    )
  );
}
function Required(type, options) {
  if (IsMappedResult(type)) {
    return RequiredFromMappedResult(type, options);
  } else {
    return CreateType({ ...RequiredResolve(type), ...options });
  }
}

// node_modules/@sinclair/typebox/build/esm/type/required/required-from-mapped-result.mjs
function FromProperties19(P, options) {
  const Acc = {};
  for (const K2 of globalThis.Object.getOwnPropertyNames(P))
    Acc[K2] = Required(P[K2], options);
  return Acc;
}
function FromMappedResult12(R, options) {
  return FromProperties19(R.properties, options);
}
function RequiredFromMappedResult(R, options) {
  const P = FromMappedResult12(R, options);
  return MappedResult(P);
}

// node_modules/@sinclair/typebox/build/esm/type/module/compute.mjs
function DereferenceParameters(moduleProperties, types) {
  return types.map((type) => {
    return IsRef(type) ? Dereference(moduleProperties, type.$ref) : FromType2(moduleProperties, type);
  });
}
function Dereference(moduleProperties, ref) {
  return ref in moduleProperties ? IsRef(moduleProperties[ref]) ? Dereference(moduleProperties, moduleProperties[ref].$ref) : FromType2(moduleProperties, moduleProperties[ref]) : Never();
}
function FromAwaited(parameters) {
  return Awaited(parameters[0]);
}
function FromIndex(parameters) {
  return Index(parameters[0], parameters[1]);
}
function FromKeyOf(parameters) {
  return KeyOf(parameters[0]);
}
function FromPartial(parameters) {
  return Partial(parameters[0]);
}
function FromOmit(parameters) {
  return Omit(parameters[0], parameters[1]);
}
function FromPick(parameters) {
  return Pick(parameters[0], parameters[1]);
}
function FromRequired(parameters) {
  return Required(parameters[0]);
}
function FromComputed5(moduleProperties, target, parameters) {
  const dereferenced = DereferenceParameters(moduleProperties, parameters);
  return target === "Awaited" ? FromAwaited(dereferenced) : target === "Index" ? FromIndex(dereferenced) : target === "KeyOf" ? FromKeyOf(dereferenced) : target === "Partial" ? FromPartial(dereferenced) : target === "Omit" ? FromOmit(dereferenced) : target === "Pick" ? FromPick(dereferenced) : target === "Required" ? FromRequired(dereferenced) : Never();
}
function FromArray6(moduleProperties, type) {
  return Array2(FromType2(moduleProperties, type));
}
function FromAsyncIterator3(moduleProperties, type) {
  return AsyncIterator(FromType2(moduleProperties, type));
}
function FromConstructor3(moduleProperties, parameters, instanceType) {
  return Constructor(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, instanceType));
}
function FromFunction3(moduleProperties, parameters, returnType) {
  return Function(FromTypes2(moduleProperties, parameters), FromType2(moduleProperties, returnType));
}
function FromIntersect8(moduleProperties, types) {
  return Intersect(FromTypes2(moduleProperties, types));
}
function FromIterator3(moduleProperties, type) {
  return Iterator(FromType2(moduleProperties, type));
}
function FromObject7(moduleProperties, properties) {
  return Object2(globalThis.Object.keys(properties).reduce((result, key) => {
    return { ...result, [key]: FromType2(moduleProperties, properties[key]) };
  }, {}));
}
function FromRecord3(moduleProperties, type) {
  const [value, pattern] = [FromType2(moduleProperties, RecordValue2(type)), RecordPattern(type)];
  const result = CloneType(type);
  result.patternProperties[pattern] = value;
  return result;
}
function FromTransform(moduleProperties, transform) {
  return IsRef(transform) ? { ...Dereference(moduleProperties, transform.$ref), [TransformKind]: transform[TransformKind] } : transform;
}
function FromTuple5(moduleProperties, types) {
  return Tuple(FromTypes2(moduleProperties, types));
}
function FromUnion10(moduleProperties, types) {
  return Union(FromTypes2(moduleProperties, types));
}
function FromTypes2(moduleProperties, types) {
  return types.map((type) => FromType2(moduleProperties, type));
}
function FromType2(moduleProperties, type) {
  return (
    // Modifiers
    IsOptional(type) ? CreateType(FromType2(moduleProperties, Discard(type, [OptionalKind])), type) : IsReadonly(type) ? CreateType(FromType2(moduleProperties, Discard(type, [ReadonlyKind])), type) : (
      // Transform
      IsTransform(type) ? CreateType(FromTransform(moduleProperties, type), type) : (
        // Types
        IsArray3(type) ? CreateType(FromArray6(moduleProperties, type.items), type) : IsAsyncIterator2(type) ? CreateType(FromAsyncIterator3(moduleProperties, type.items), type) : IsComputed(type) ? CreateType(FromComputed5(moduleProperties, type.target, type.parameters)) : IsConstructor(type) ? CreateType(FromConstructor3(moduleProperties, type.parameters, type.returns), type) : IsFunction2(type) ? CreateType(FromFunction3(moduleProperties, type.parameters, type.returns), type) : IsIntersect(type) ? CreateType(FromIntersect8(moduleProperties, type.allOf), type) : IsIterator2(type) ? CreateType(FromIterator3(moduleProperties, type.items), type) : IsObject3(type) ? CreateType(FromObject7(moduleProperties, type.properties), type) : IsRecord(type) ? CreateType(FromRecord3(moduleProperties, type)) : IsTuple(type) ? CreateType(FromTuple5(moduleProperties, type.items || []), type) : IsUnion(type) ? CreateType(FromUnion10(moduleProperties, type.anyOf), type) : type
      )
    )
  );
}
function ComputeType(moduleProperties, key) {
  return key in moduleProperties ? FromType2(moduleProperties, moduleProperties[key]) : Never();
}
function ComputeModuleProperties(moduleProperties) {
  return globalThis.Object.getOwnPropertyNames(moduleProperties).reduce((result, key) => {
    return { ...result, [key]: ComputeType(moduleProperties, key) };
  }, {});
}

// node_modules/@sinclair/typebox/build/esm/type/module/module.mjs
var TModule = class {
  constructor($defs) {
    const computed = ComputeModuleProperties($defs);
    const identified = this.WithIdentifiers(computed);
    this.$defs = identified;
  }
  /** `[Json]` Imports a Type by Key. */
  Import(key, options) {
    const $defs = { ...this.$defs, [key]: CreateType(this.$defs[key], options) };
    return CreateType({ [Kind]: "Import", $defs, $ref: key });
  }
  // prettier-ignore
  WithIdentifiers($defs) {
    return globalThis.Object.getOwnPropertyNames($defs).reduce((result, key) => {
      return { ...result, [key]: { ...$defs[key], $id: key } };
    }, {});
  }
};
function Module(properties) {
  return new TModule(properties);
}

// node_modules/@sinclair/typebox/build/esm/type/not/not.mjs
function Not(type, options) {
  return CreateType({ [Kind]: "Not", not: type }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/parameters/parameters.mjs
function Parameters(schema, options) {
  return IsFunction2(schema) ? Tuple(schema.parameters, options) : Never();
}

// node_modules/@sinclair/typebox/build/esm/type/recursive/recursive.mjs
var Ordinal = 0;
function Recursive(callback, options = {}) {
  if (IsUndefined(options.$id))
    options.$id = `T${Ordinal++}`;
  const thisType = CloneType(callback({ [Kind]: "This", $ref: `${options.$id}` }));
  thisType.$id = options.$id;
  return CreateType({ [Hint]: "Recursive", ...thisType }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/regexp/regexp.mjs
function RegExp2(unresolved, options) {
  const expr = IsString(unresolved) ? new globalThis.RegExp(unresolved) : unresolved;
  return CreateType({ [Kind]: "RegExp", type: "RegExp", source: expr.source, flags: expr.flags }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/rest/rest.mjs
function RestResolve(T) {
  return IsIntersect(T) ? T.allOf : IsUnion(T) ? T.anyOf : IsTuple(T) ? T.items ?? [] : [];
}
function Rest(T) {
  return RestResolve(T);
}

// node_modules/@sinclair/typebox/build/esm/type/return-type/return-type.mjs
function ReturnType(schema, options) {
  return IsFunction2(schema) ? CreateType(schema.returns, options) : Never(options);
}

// node_modules/@sinclair/typebox/build/esm/type/transform/transform.mjs
var TransformDecodeBuilder = class {
  constructor(schema) {
    this.schema = schema;
  }
  Decode(decode) {
    return new TransformEncodeBuilder(this.schema, decode);
  }
};
var TransformEncodeBuilder = class {
  constructor(schema, decode) {
    this.schema = schema;
    this.decode = decode;
  }
  EncodeTransform(encode, schema) {
    const Encode = (value) => schema[TransformKind].Encode(encode(value));
    const Decode = (value) => this.decode(schema[TransformKind].Decode(value));
    const Codec = { Encode, Decode };
    return { ...schema, [TransformKind]: Codec };
  }
  EncodeSchema(encode, schema) {
    const Codec = { Decode: this.decode, Encode: encode };
    return { ...schema, [TransformKind]: Codec };
  }
  Encode(encode) {
    return IsTransform(this.schema) ? this.EncodeTransform(encode, this.schema) : this.EncodeSchema(encode, this.schema);
  }
};
function Transform(schema) {
  return new TransformDecodeBuilder(schema);
}

// node_modules/@sinclair/typebox/build/esm/type/unsafe/unsafe.mjs
function Unsafe(options = {}) {
  return CreateType({ [Kind]: options[Kind] ?? "Unsafe" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/void/void.mjs
function Void(options) {
  return CreateType({ [Kind]: "Void", type: "void" }, options);
}

// node_modules/@sinclair/typebox/build/esm/type/type/type.mjs
var type_exports2 = {};
__export(type_exports2, {
  Any: () => Any,
  Argument: () => Argument,
  Array: () => Array2,
  AsyncIterator: () => AsyncIterator,
  Awaited: () => Awaited,
  BigInt: () => BigInt,
  Boolean: () => Boolean2,
  Capitalize: () => Capitalize,
  Composite: () => Composite,
  Const: () => Const,
  Constructor: () => Constructor,
  ConstructorParameters: () => ConstructorParameters,
  Date: () => Date2,
  Enum: () => Enum,
  Exclude: () => Exclude,
  Extends: () => Extends,
  Extract: () => Extract,
  Function: () => Function,
  Index: () => Index,
  InstanceType: () => InstanceType,
  Instantiate: () => Instantiate,
  Integer: () => Integer,
  Intersect: () => Intersect,
  Iterator: () => Iterator,
  KeyOf: () => KeyOf,
  Literal: () => Literal,
  Lowercase: () => Lowercase,
  Mapped: () => Mapped,
  Module: () => Module,
  Never: () => Never,
  Not: () => Not,
  Null: () => Null,
  Number: () => Number2,
  Object: () => Object2,
  Omit: () => Omit,
  Optional: () => Optional,
  Parameters: () => Parameters,
  Partial: () => Partial,
  Pick: () => Pick,
  Promise: () => Promise2,
  Readonly: () => Readonly,
  ReadonlyOptional: () => ReadonlyOptional,
  Record: () => Record,
  Recursive: () => Recursive,
  Ref: () => Ref,
  RegExp: () => RegExp2,
  Required: () => Required,
  Rest: () => Rest,
  ReturnType: () => ReturnType,
  String: () => String2,
  Symbol: () => Symbol2,
  TemplateLiteral: () => TemplateLiteral,
  Transform: () => Transform,
  Tuple: () => Tuple,
  Uint8Array: () => Uint8Array2,
  Uncapitalize: () => Uncapitalize,
  Undefined: () => Undefined,
  Union: () => Union,
  Unknown: () => Unknown,
  Unsafe: () => Unsafe,
  Uppercase: () => Uppercase,
  Void: () => Void
});

// node_modules/@sinclair/typebox/build/esm/type/type/index.mjs
var Type = type_exports2;

// src/shared.ts
var HARNESS_GLOBAL_KEY = "__openclawHarnessGlobalState__";
var DEFAULT_PLUGIN_CONFIG = {
  maxSessions: 5,
  defaultBudgetUsd: 5,
  idleTimeoutMinutes: 30,
  maxPersistedSessions: 50,
  maxAutoResponds: 10,
  maxReviewLoops: 10,
  routerMaxTokens: 500,
  plannerMaxTokens: 2e3,
  reviewerMaxTokens: 1e3,
  workerBackend: "remote-realtime",
  enableLegacyTools: false
};
function cloneDefaultPluginConfig() {
  return { ...DEFAULT_PLUGIN_CONFIG };
}
function getHarnessState() {
  const globalState = globalThis;
  if (!globalState[HARNESS_GLOBAL_KEY]) {
    globalState[HARNESS_GLOBAL_KEY] = {
      sessionManager: null,
      notificationRouter: null,
      pluginConfig: cloneDefaultPluginConfig(),
      pluginRuntime: null
    };
  }
  return globalState[HARNESS_GLOBAL_KEY];
}
var sessionManager = getHarnessState().sessionManager;
var notificationRouter = getHarnessState().notificationRouter;
var pluginConfig = new Proxy({}, {
  get(_target, prop) {
    return getHarnessState().pluginConfig[prop];
  },
  set(_target, prop, value) {
    getHarnessState().pluginConfig[prop] = value;
    return true;
  },
  ownKeys() {
    return Reflect.ownKeys(getHarnessState().pluginConfig);
  },
  getOwnPropertyDescriptor(_target, prop) {
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: getHarnessState().pluginConfig[prop]
    };
  }
});
function getPluginConfig() {
  return getHarnessState().pluginConfig;
}
function setPluginConfig(config) {
  let agentChannels = config.agentChannels;
  if (agentChannels) {
    const expanded = {};
    for (const [key, value] of Object.entries(agentChannels)) {
      const resolvedKey = key.replace(/\$\{(\w+)\}/g, (match, varName) => {
        const envValue = process.env[varName];
        return envValue !== void 0 ? envValue : match;
      });
      expanded[resolvedKey] = value;
    }
    agentChannels = expanded;
  }
  getHarnessState().pluginConfig = {
    maxSessions: config.maxSessions ?? 5,
    defaultBudgetUsd: config.defaultBudgetUsd ?? 5,
    defaultModel: config.defaultModel,
    defaultWorkdir: config.defaultWorkdir,
    idleTimeoutMinutes: config.idleTimeoutMinutes ?? 30,
    maxPersistedSessions: config.maxPersistedSessions ?? 50,
    fallbackChannel: config.fallbackChannel,
    permissionMode: config.permissionMode,
    agentChannels,
    maxAutoResponds: config.maxAutoResponds ?? 10,
    skipSafetyChecks: config.skipSafetyChecks,
    maxReviewLoops: config.maxReviewLoops ?? 10,
    reviewModel: config.reviewModel,
    plannerModel: config.plannerModel,
    realtimeModel: config.realtimeModel,
    workerModel: config.workerModel,
    workerEffort: config.workerEffort,
    reviewerReasoningEffort: config.reviewerReasoningEffort,
    consensusReviewerModel: config.consensusReviewerModel,
    consensusReviewerApiKey: config.consensusReviewerApiKey,
    consensusReviewerEndpoint: config.consensusReviewerEndpoint,
    openRouterApiKey: config.openRouterApiKey,
    workerBackend: config.workerBackend ?? "remote-realtime",
    memoryV3Endpoint: config.memoryV3Endpoint,
    routerMaxTokens: config.routerMaxTokens ?? 500,
    plannerMaxTokens: config.plannerMaxTokens ?? 2e3,
    reviewerMaxTokens: config.reviewerMaxTokens ?? 1e3,
    enableLegacyTools: config.enableLegacyTools ?? false
  };
}
function isLegacyToolsEnabled() {
  return getPluginConfig().enableLegacyTools ?? true;
}
function formatLegacyToolsDisabledMessage(entrypoint) {
  return [
    `Legacy direct-session surface is disabled (enableLegacyTools=false).`,
    `${entrypoint} is unavailable.`,
    `Use harness_execute instead.`
  ].join(" ");
}
function legacyToolDisabledResult(toolName) {
  return {
    content: [
      {
        type: "text",
        text: formatLegacyToolsDisabledMessage(toolName)
      }
    ]
  };
}
function legacyCommandDisabledResult(commandName) {
  return {
    text: formatLegacyToolsDisabledMessage(`/${commandName}`)
  };
}
function setSessionManager(sm) {
  getHarnessState().sessionManager = sm;
  sessionManager = sm;
}
function getSessionManager() {
  return getHarnessState().sessionManager;
}
function setNotificationRouter(nr) {
  getHarnessState().notificationRouter = nr;
  notificationRouter = nr;
}
function setPluginRuntime(rt) {
  getHarnessState().pluginRuntime = rt;
}
function getPluginRuntime() {
  return getHarnessState().pluginRuntime;
}
function resolveOriginChannel(ctx, explicitChannel) {
  if (explicitChannel && String(explicitChannel).includes("|")) {
    return String(explicitChannel);
  }
  if (ctx?.channel && ctx?.chatId) {
    return `${ctx.channel}|${ctx.chatId}`;
  }
  if (ctx?.channel && ctx?.senderId) {
    return `${ctx.channel}|${ctx.senderId}`;
  }
  if (ctx?.id && /^-?\d+$/.test(String(ctx.id))) {
    return `telegram|${ctx.id}`;
  }
  if (ctx?.channelId && String(ctx.channelId).includes("|")) {
    return String(ctx.channelId);
  }
  const fallback = getPluginConfig().fallbackChannel ?? "unknown";
  console.log(`[resolveOriginChannel] Could not resolve channel from ctx keys: ${ctx ? Object.keys(ctx).join(", ") : "null"}, using fallback=${fallback}`);
  return fallback;
}
function extractAgentId(channelStr) {
  const parts = channelStr.split("|");
  if (parts.length >= 3 && parts[1]) {
    return parts[1];
  }
  return void 0;
}
function resolveAgentId(workdir) {
  const channel = resolveAgentChannel(workdir);
  if (!channel) return void 0;
  return extractAgentId(channel);
}
function resolveAgentChannel(workdir) {
  const config = getPluginConfig();
  console.log(`[resolveAgentChannel] workdir=${workdir}, agentChannels=${JSON.stringify(config.agentChannels)}`);
  const mapping = config.agentChannels;
  if (!mapping) return void 0;
  const normalise = (p) => p.replace(/\/+$/, "");
  const normWorkdir = normalise(workdir);
  const entries = Object.entries(mapping).sort(
    (a, b) => b[0].length - a[0].length
  );
  for (const [dir, channel] of entries) {
    if (normWorkdir === normalise(dir) || normWorkdir.startsWith(normalise(dir) + "/")) {
      return channel;
    }
  }
  const fallback = config.fallbackChannel;
  if (fallback) {
    console.log(`[resolveAgentChannel] No match for ${workdir}, using fallbackChannel=${fallback}`);
    return fallback;
  }
  return void 0;
}
function hasValidOriginChannel(session) {
  return !!session.originChannel && session.originChannel !== "unknown";
}
function formatDuration(ms) {
  const seconds = Math.floor(ms / 1e3);
  const minutes = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (minutes > 0) return `${minutes}m${secs}s`;
  return `${secs}s`;
}
var STOP_WORDS = /* @__PURE__ */ new Set([
  "a",
  "an",
  "the",
  "is",
  "are",
  "was",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "shall",
  "can",
  "need",
  "must",
  "i",
  "me",
  "my",
  "we",
  "our",
  "you",
  "your",
  "it",
  "its",
  "he",
  "she",
  "to",
  "of",
  "in",
  "for",
  "on",
  "with",
  "at",
  "by",
  "from",
  "as",
  "into",
  "through",
  "about",
  "that",
  "this",
  "these",
  "those",
  "and",
  "or",
  "but",
  "if",
  "then",
  "so",
  "not",
  "no",
  "please",
  "just",
  "also",
  "very",
  "all",
  "some",
  "any",
  "each",
  "make",
  "write",
  "create",
  "build",
  "implement",
  "add",
  "update"
]);
function generateSessionName(prompt) {
  const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !STOP_WORDS.has(w));
  const keywords = words.slice(0, 3);
  if (keywords.length === 0) return "session";
  return keywords.join("-");
}
var STATUS_ICONS = {
  starting: "\u{1F7E1}",
  running: "\u{1F7E2}",
  completed: "\u2705",
  failed: "\u274C",
  killed: "\u26D4"
};
function formatSessionListing(session) {
  const icon = STATUS_ICONS[session.status] ?? "\u2753";
  const duration = formatDuration(session.duration);
  const fg = session.foregroundChannels.size > 0 ? "foreground" : "background";
  const mode = session.multiTurn ? "multi-turn" : "single";
  const promptSummary = session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt;
  const lines = [
    `${icon} ${session.name} [${session.id}] (${duration}) \u2014 ${fg}, ${mode}`,
    `   \u{1F4C1} ${session.workdir}`,
    `   \u{1F4DD} "${promptSummary}"`
  ];
  if (session.claudeSessionId) {
    lines.push(`   \u{1F517} Claude ID: ${session.claudeSessionId}`);
  }
  if (session.resumeSessionId) {
    lines.push(`   \u21A9\uFE0F  Resumed from: ${session.resumeSessionId}${session.forkSession ? " (forked)" : ""}`);
  }
  return lines.join("\n");
}
function formatStats(metrics) {
  const avgDurationMs = metrics.sessionsWithDuration > 0 ? metrics.totalDurationMs / metrics.sessionsWithDuration : 0;
  const activeSessionManager = getSessionManager();
  const running = activeSessionManager ? activeSessionManager.list("running").length : 0;
  const { completed, failed, killed } = metrics.sessionsByStatus;
  const totalFinished = completed + failed + killed;
  const lines = [
    `\u{1F4CA} Claude Code Plugin Stats`,
    ``,
    `\u{1F4CB} Sessions`,
    `   Launched:   ${metrics.totalLaunched}`,
    `   Running:    ${running}`,
    `   Completed:  ${completed}`,
    `   Failed:     ${failed}`,
    `   Killed:     ${killed}`,
    ``,
    `\u23F1\uFE0F  Average duration: ${avgDurationMs > 0 ? formatDuration(avgDurationMs) : "n/a"}`
  ];
  if (metrics.mostExpensive) {
    const me = metrics.mostExpensive;
    lines.push(
      ``,
      `\u{1F3C6} Notable session`,
      `   ${me.name} [${me.id}]`,
      `   \u{1F4DD} "${me.prompt}"`
    );
  }
  return lines.join("\n");
}

// src/tools/claude-launch.ts
function makeClaudeLaunchTool(ctx) {
  console.log(`[claude-launch] Factory ctx: agentId=${ctx.agentId}, workspaceDir=${ctx.workspaceDir}, messageChannel=${ctx.messageChannel}, agentAccountId=${ctx.agentAccountId}`);
  return {
    name: "harness_launch",
    description: "[LEGACY] Launch a Claude Code session directly in background. For new coding tasks, prefer harness_execute which adds automatic planning, cross-model review, and structured results. Use harness_launch only for interactive/multi-turn sessions that need direct PTY access. Sessions are multi-turn by default \u2014 they stay open for follow-up messages via harness_respond. Set multi_turn_disabled: true for fire-and-forget sessions. Supports resuming previous sessions. Returns a session ID and name for tracking.",
    parameters: Type.Object({
      prompt: Type.String({ description: "The task prompt to execute" }),
      name: Type.Optional(
        Type.String({
          description: "Short human-readable name for the session (kebab-case, e.g. 'fix-auth'). Auto-generated from prompt if omitted."
        })
      ),
      workdir: Type.Optional(
        Type.String({ description: "Working directory (defaults to cwd)" })
      ),
      model: Type.Optional(
        Type.String({ description: "Model name to use" })
      ),
      max_budget_usd: Type.Optional(
        Type.Number({
          description: "Maximum budget in USD (default 5)"
        })
      ),
      system_prompt: Type.Optional(
        Type.String({ description: "Additional system prompt" })
      ),
      allowed_tools: Type.Optional(
        Type.Array(Type.String(), {
          description: "List of allowed tools"
        })
      ),
      resume_session_id: Type.Optional(
        Type.String({
          description: "Claude session ID to resume (from a previous session's claudeSessionId). Continues the conversation from where it left off."
        })
      ),
      fork_session: Type.Optional(
        Type.Boolean({
          description: "When resuming, fork to a new session instead of continuing the existing one. Use with resume_session_id."
        })
      ),
      multi_turn_disabled: Type.Optional(
        Type.Boolean({
          description: "Disable multi-turn mode. By default sessions stay open for follow-up messages. Set to true for fire-and-forget sessions."
        })
      ),
      permission_mode: Type.Optional(
        Type.Union(
          [
            Type.Literal("default"),
            Type.Literal("plan"),
            Type.Literal("acceptEdits"),
            Type.Literal("bypassPermissions")
          ],
          {
            description: "Permission mode for the session. Defaults to plugin config or 'bypassPermissions'."
          }
        )
      )
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_launch");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const maxBudgetUsd = params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5;
      try {
        let resolvedResumeId = params.resume_session_id;
        if (resolvedResumeId) {
          const resolved = sessionManager.resolveClaudeSessionId(resolvedResumeId, ctx.agentId);
          if (!resolved) {
            return {
              content: [
                {
                  type: "text",
                  text: `Error: Could not resolve resume_session_id "${resolvedResumeId}" to a Claude session ID. Use claude_sessions to list available sessions.`
                }
              ]
            };
          }
          resolvedResumeId = resolved;
        }
        let originChannel;
        if (ctx.workspaceDir) {
          originChannel = resolveAgentChannel(ctx.workspaceDir);
        }
        if (!originChannel && ctx.messageChannel && ctx.agentAccountId) {
          const parts = ctx.messageChannel.split("|");
          if (parts.length >= 2) {
            originChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
          }
        }
        if (!originChannel && ctx.messageChannel && ctx.messageChannel.includes("|")) {
          originChannel = ctx.messageChannel;
        }
        if (!originChannel) {
          originChannel = pluginConfig.fallbackChannel ?? "unknown";
        }
        let deliverChannel;
        if (ctx.workspaceDir) {
          deliverChannel = resolveAgentChannel(ctx.workspaceDir);
        }
        if (!deliverChannel && ctx.messageChannel && ctx.agentAccountId) {
          const parts = ctx.messageChannel.split("|");
          if (parts.length >= 2) {
            deliverChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
          }
        }
        if (!deliverChannel && ctx.messageChannel && ctx.messageChannel.includes("|")) {
          deliverChannel = ctx.messageChannel;
        }
        if (!deliverChannel) {
          deliverChannel = originChannel;
        }
        const agentWorkspace = ctx.workspaceDir;
        if (pluginConfig.skipSafetyChecks) {
          console.log(`[claude-launch] Safety checks skipped (skipSafetyChecks=true)`);
        } else if (!agentWorkspace) {
          console.log(`[claude-launch] No agent workspace detected (ctx.workspaceDir is undefined) \u2014 blocking launch`);
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: [
                  `ERROR: Launch blocked \u2014 no agent workspace detected.`,
                  ``,
                  `ctx.workspaceDir is undefined, so safety guards and channel routing`,
                  `cannot resolve the agent's workspace. This usually means the tool was`,
                  `invoked outside an agent context.`,
                  ``,
                  `Ensure the agent has a configured workspaceDir before launching sessions.`
                ].join("\n")
              }
            ]
          };
        } else {
          const autonomySkillPath = (0, import_path.join)(agentWorkspace, "skills", "claude-code-autonomy", "SKILL.md");
          if (!(0, import_fs.existsSync)(autonomySkillPath)) {
            console.log(`[claude-launch] Autonomy skill not found at ${autonomySkillPath} \u2014 blocking launch`);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: [
                    `ERROR: Launch blocked \u2014 no autonomy skill found.`,
                    ``,
                    `No autonomy skill found. You MUST ask the user what level of autonomy they want to give Claude Code sessions. Then create the skill at skills/claude-code-autonomy/ with their preferences. Only then can you launch sessions.`,
                    ``,
                    `Do NOT create the skill without asking the user first. Ask them how they want you to handle Claude Code interactions. For example:`,
                    `- "Respond to everything automatically except architecture choices"`,
                    `- "Always ask me before responding"`,
                    `- "Handle everything yourself, just notify me when done"`,
                    ``,
                    `After the user responds, create the skill:`,
                    `1. Create directory: skills/claude-code-autonomy/`,
                    `2. Create SKILL.md with structured rules based on the user's response`,
                    `3. Create autonomy.md with the user's raw preferences`,
                    `4. Then re-call claude_launch to start the session.`,
                    ``,
                    `The skill MUST also define these notification formats that the agent uses:`,
                    ``,
                    `\u{1F44B} [session-name] Important question \u2014 needs your decision:`,
                    `> "question text"`,
                    `(Used when Claude asks something that requires the user's input \u2014 architecture, destructive ops, ambiguous requirements)`,
                    ``,
                    `\u{1F916} [session-name] finished:`,
                    `Summary of what Claude did, files changed, issues found.`,
                    `(Used when a session completes \u2014 the agent reads the output and summarizes)`,
                    ``,
                    `Note: \u{1F514} Claude asks and \u21A9\uFE0F Responded notifications are handled automatically by the plugin. The skill only needs to define rules for \u{1F44B} (when to forward vs auto-respond) and \u{1F916} (summary format).`
                  ].join("\n")
                }
              ]
            };
          }
          const agentId = ctx.agentId || resolveAgentId(agentWorkspace);
          if (agentId && !ctx.agentId) {
            console.warn(`[claude-launch] Using resolveAgentId fallback for agentId="${agentId}" \u2014 this may be an account alias, not the real agent ID`);
          }
          if (agentId) {
            const openclawConfigPath = (0, import_path.join)((0, import_os.homedir)(), ".openclaw", "openclaw.json");
            let heartbeatConfigured = false;
            let heartbeatEvery;
            try {
              if ((0, import_fs.existsSync)(openclawConfigPath)) {
                const raw = (0, import_fs.readFileSync)(openclawConfigPath, "utf-8");
                const openclawConfig = JSON.parse(raw);
                const agentsList = openclawConfig?.agents?.list;
                if (Array.isArray(agentsList)) {
                  const agentEntry = agentsList.find((a) => a.id === agentId);
                  if (agentEntry && agentEntry.heartbeat != null) {
                    heartbeatConfigured = true;
                    heartbeatEvery = agentEntry.heartbeat.every;
                  }
                }
              }
            } catch (err) {
              console.log(`[claude-launch] Failed to read openclaw config at ${openclawConfigPath}: ${err.message}`);
            }
            if (!heartbeatConfigured) {
              console.log(`[claude-launch] Heartbeat not configured for agent "${agentId}" \u2014 blocking launch`);
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: [
                      `ERROR: Launch blocked \u2014 no heartbeat configured for this agent.`,
                      ``,
                      `Claude Code sessions require heartbeat to be enabled for automatic "waiting for input" notifications.`,
                      ``,
                      `You must configure the heartbeat FIRST. Here's what to do:`,
                      ``,
                      `1. Edit ~/.openclaw/openclaw.json and add heartbeat config for agent "${agentId}":`,
                      ``,
                      `   jq '.agents.list |= map(if .id == "${agentId}" then . + {"heartbeat": {"every": "60m", "target": "last"}} else . end)' ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json`,
                      ``,
                      `2. Verify the config was applied:`,
                      ``,
                      `   cat ~/.openclaw/openclaw.json | jq '.agents.list[] | select(.id == "${agentId}") | .heartbeat'`,
                      ``,
                      `3. Launch a Claude Code session to restart the Gateway and wake you back:`,
                      ``,
                      `   claude_launch(`,
                      `     prompt="STEP 1: Restart Gateway to activate heartbeat: openclaw gateway restart`,
                      `             STEP 2: Wait 5 seconds`,
                      `             STEP 3: Wake the agent: openclaw agent --agent ${agentId} --message 'Heartbeat configured, continuing task'`,
                      `             STEP 4: Continue the original task: [USER_TASK]",`,
                      `     name="setup-heartbeat"`,
                      `   )`
                    ].join("\n")
                  }
                ]
              };
            }
            if (heartbeatEvery === "5s") {
              console.log(`[claude-launch] Heartbeat interval too short (5s) for agent "${agentId}" \u2014 blocking launch`);
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: [
                      `ERROR: Launch blocked \u2014 heartbeat interval too short (5s).`,
                      ``,
                      `A heartbeat interval of 5s wastes tokens unnecessarily. Targeted agent messages wake you instantly, so the heartbeat interval only affects regular polling.`,
                      ``,
                      `Fix the heartbeat interval to 60m:`,
                      ``,
                      `   jq '.agents.list |= map(if .id == "${agentId}" then .heartbeat.every = "60m" else . end)' ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json`,
                      ``,
                      `Then ask the user to restart the gateway. Do NOT restart the gateway yourself \u2014 only the user can do this safely. After the user confirms the restart, retry your launch.`
                    ].join("\n")
                  }
                ]
              };
            }
          }
          const heartbeatMdPath = (0, import_path.join)(agentWorkspace, "HEARTBEAT.md");
          let heartbeatMdValid = false;
          try {
            if ((0, import_fs.existsSync)(heartbeatMdPath)) {
              const heartbeatContent = (0, import_fs.readFileSync)(heartbeatMdPath, "utf-8");
              const effectivelyEmpty = /^(\s|#.*)*$/.test(heartbeatContent);
              if (!effectivelyEmpty) {
                heartbeatMdValid = true;
              }
            }
          } catch (err) {
            console.log(`[claude-launch] Failed to read HEARTBEAT.md at ${heartbeatMdPath}: ${err.message}`);
          }
          if (!heartbeatMdValid) {
            console.log(`[claude-launch] HEARTBEAT.md missing or empty at ${heartbeatMdPath} \u2014 blocking launch`);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: [
                    `ERROR: Launch blocked \u2014 no HEARTBEAT.md file found or file is effectively empty.`,
                    ``,
                    `Claude Code sessions require a HEARTBEAT.md with real content as a safety-net fallback.`,
                    `The plugin wakes you instantly via targeted agent messages when sessions need attention,`,
                    `but the heartbeat acts as a 60m backup in case a wake message is lost.`,
                    ``,
                    `You must create HEARTBEAT.md FIRST. Here's what to do:`,
                    ``,
                    `1. Create ${agentWorkspace}/HEARTBEAT.md with this content:`,
                    ``,
                    `cat > ${agentWorkspace}/HEARTBEAT.md << 'EOF'`,
                    `# Heartbeat Agent`,
                    ``,
                    `## Check Claude Code sessions (safety-net fallback)`,
                    `Note: The plugin sends targeted wake messages instantly when sessions need attention.`,
                    `This heartbeat is a 60m backup in case a wake message was lost.`,
                    ``,
                    `Si des sessions Claude Code sont en attente (waiting for input) :`,
                    `1. \`claude_sessions\` pour lister les sessions actives`,
                    `2. Si session waiting \u2192 \`claude_output(session)\` pour voir la question`,
                    `3. Traiter ou notifier l'utilisateur`,
                    ``,
                    `Sinon \u2192 HEARTBEAT_OK`,
                    `EOF`,
                    ``,
                    `2. Verify the heartbeat frequency is set to 60m:`,
                    ``,
                    `cat ~/.openclaw/openclaw.json | jq '.agents.list[] | .heartbeat.every'`,
                    ``,
                    `If NOT "60m", update it:`,
                    ``,
                    `jq '.agents.list |= map(.heartbeat.every = "60m")' ~/.openclaw/openclaw.json > /tmp/openclaw-updated.json && mv /tmp/openclaw-updated.json ~/.openclaw/openclaw.json`,
                    ``,
                    `3. Launch Claude Code to restart Gateway:`,
                    ``,
                    `   claude_launch(`,
                    `     prompt="STEP 1: Restart Gateway: openclaw gateway restart`,
                    `             STEP 2: Wait 5s`,
                    `             STEP 3: Wake agent: openclaw agent --message 'HEARTBEAT.md configured'`,
                    `             STEP 4: Continue task: [USER_TASK]",`,
                    `     name="setup-heartbeat-md"`,
                    `   )`
                  ].join("\n")
                }
              ]
            };
          }
          const agentChannelForWorkspace = agentWorkspace ? resolveAgentChannel(agentWorkspace) : void 0;
          if (!agentChannelForWorkspace) {
            const displayPath = ctx.workspaceDir || workdir;
            console.log(`[claude-launch] No agentChannels mapping for agent workspace "${displayPath}" \u2014 blocking launch`);
            return {
              isError: true,
              content: [
                {
                  type: "text",
                  text: [
                    `ERROR: Launch blocked \u2014 no agentChannels mapping found for agent workspace "${displayPath}".`,
                    ``,
                    `The agentChannels config maps agent workspaces to notification channels.`,
                    `Your agent workspace must be configured so notifications can be routed correctly.`,
                    ``,
                    `Add your agent workspace to agentChannels in ~/.openclaw/openclaw.json:`,
                    ``,
                    `   plugins.entries["openclaw-claude-code-plugin"].config.agentChannels["${displayPath}"] = "telegram|accountId|chatId"`,
                    ``,
                    `Then restart the Gateway and retry the launch.`
                  ].join("\n")
                }
              ]
            };
          }
        }
        const session = sessionManager.spawn({
          prompt: params.prompt,
          name: params.name,
          workdir,
          model: params.model || pluginConfig.defaultModel,
          maxBudgetUsd,
          systemPrompt: params.system_prompt,
          allowedTools: params.allowed_tools,
          resumeSessionId: resolvedResumeId,
          forkSession: params.fork_session,
          multiTurn: !params.multi_turn_disabled,
          permissionMode: params.permission_mode,
          originChannel,
          deliverChannel,
          originAgentId: ctx.agentId || void 0
        });
        const promptSummary = params.prompt.length > 80 ? params.prompt.slice(0, 80) + "..." : params.prompt;
        const details = [
          `Session launched successfully.`,
          `  Name: ${session.name}`,
          `  ID: ${session.id}`,
          `  Dir: ${workdir}`,
          `  Model: ${session.model ?? "default"}`,
          `  Prompt: "${promptSummary}"`
        ];
        if (params.resume_session_id) {
          details.push(`  Resume: ${params.resume_session_id}${params.fork_session ? " (forked)" : ""}`);
        }
        if (params.multi_turn_disabled) {
          details.push(`  Mode: single-turn (fire-and-forget)`);
        } else {
          details.push(`  Mode: multi-turn (use claude_respond to send follow-up messages)`);
        }
        details.push(``);
        details.push(`Use claude_sessions to check status, claude_output to see output.`);
        return {
          content: [
            {
              type: "text",
              text: details.join("\n")
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error launching session: ${err.message}`
            }
          ]
        };
      }
    }
  };
}

// src/tools/harness-execute.ts
var import_child_process4 = require("child_process");
var import_crypto3 = require("crypto");
var import_fs7 = require("fs");
var import_os7 = require("os");
var import_path7 = require("path");

// src/backend/local-cc.ts
var import_child_process = require("child_process");
var import_crypto = require("crypto");
var import_fs2 = require("fs");
var import_os2 = require("os");
var import_path2 = require("path");
var LOCAL_CC_COMMAND = "claude";
var LOCAL_CC_STATE_VERSION = 1;
var LOCAL_CC_ROUND_TIMEOUT_MS = parseInt(process.env.LOCAL_CC_ROUND_TIMEOUT_MS ?? "", 10) || 5 * 60 * 1e3;
var LOCAL_CC_STATE_ROOT = (0, import_path2.join)((0, import_os2.tmpdir)(), "openclaw-harness-local-cc");
var localCcCommandExecutor = defaultLocalCcCommandExecutor;
var localCcBackend = {
  name: "local-cc",
  available() {
    return true;
  },
  describe() {
    return "Opt-in local Claude Code CLI worker with one-shot rounds and jobId-backed state reuse.";
  },
  async executeWorker(context) {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const reusableRound = findReusableExecuteRound(state);
      if (reusableRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          state.status === "done" ? "done" : "waiting",
          reusableRound.summary,
          reusableRound.workerResult
        );
      }
      const prompt = buildInitialLocalCcPrompt(context.task, context.plan, context.workdir, context.jobId);
      return await runLocalCcRound(context, state, "execute", prompt);
    });
  },
  async continueWorker(context, feedback) {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const latestCompletedRound = findLatestCompletedRound(state);
      if (!latestCompletedRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          "error",
          "",
          null,
          `local-cc job ${context.jobId} has no completed round to continue. Run executeWorker first.`
        );
      }
      const reusableRound = findReusableContinueRound(state, feedback);
      if (reusableRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          state.status === "done" ? "done" : "waiting",
          reusableRound.summary,
          reusableRound.workerResult
        );
      }
      if (state.status === "done") {
        return buildLocalCcExecutionResult(
          context.jobId,
          "done",
          latestCompletedRound.summary,
          latestCompletedRound.workerResult
        );
      }
      const prompt = buildContinueLocalCcPrompt(
        context.task,
        context.plan,
        context.workdir,
        context.jobId,
        latestCompletedRound.workerResult,
        feedback
      );
      return await runLocalCcRound(context, state, "continue", prompt, feedback);
    });
  },
  async finalizeWorker(context) {
    return withLocalCcErrorBoundary(context, async () => {
      const state = loadOrCreateLocalCcState(context);
      const latestCompletedRound = findLatestCompletedRound(state);
      if (!latestCompletedRound?.workerResult) {
        return buildLocalCcExecutionResult(
          context.jobId,
          "error",
          "",
          null,
          `local-cc job ${context.jobId} has no completed output to finalize.`
        );
      }
      state.status = "done";
      state.finalizedAt = (/* @__PURE__ */ new Date()).toISOString();
      state.updatedAt = state.finalizedAt;
      delete state.lastError;
      persistLocalCcState(state);
      return buildLocalCcExecutionResult(
        context.jobId,
        "done",
        latestCompletedRound.summary,
        latestCompletedRound.workerResult
      );
    });
  }
};
function getLocalCcStateDir(jobId) {
  return (0, import_path2.join)(LOCAL_CC_STATE_ROOT, jobId);
}
function readLocalCcJobState(jobId) {
  const statePath = (0, import_path2.join)(getLocalCcStateDir(jobId), "state.json");
  try {
    if (!(0, import_fs2.existsSync)(statePath)) return null;
    return JSON.parse((0, import_fs2.readFileSync)(statePath, "utf8"));
  } catch {
    return null;
  }
}
async function withLocalCcErrorBoundary(context, fn) {
  try {
    return await fn();
  } catch (error) {
    const message = error?.message ?? String(error);
    try {
      const state = readLocalCcJobState(context.jobId);
      if (state) {
        state.status = "error";
        state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
        state.lastError = message;
        persistLocalCcState(state);
      }
    } catch {
    }
    return buildLocalCcExecutionResult(context.jobId, "error", "", null, message);
  }
}
function loadOrCreateLocalCcState(context) {
  const stateDir = getLocalCcStateDir(context.jobId);
  (0, import_fs2.mkdirSync)(stateDir, { recursive: true });
  const existing = readLocalCcJobState(context.jobId);
  if (existing) {
    validateLocalCcState(existing, context);
    return existing;
  }
  const now = (/* @__PURE__ */ new Date()).toISOString();
  const state = {
    version: LOCAL_CC_STATE_VERSION,
    jobId: context.jobId,
    workdir: (0, import_path2.resolve)(context.workdir),
    taskId: context.task.id,
    planId: context.plan.id,
    model: normalizeLocalCcModel(context.workerModel),
    status: "idle",
    createdAt: now,
    updatedAt: now,
    rounds: []
  };
  persistLocalCcState(state);
  return state;
}
function validateLocalCcState(state, context) {
  const expectedWorkdir = (0, import_path2.resolve)(context.workdir);
  if (state.taskId !== context.task.id) {
    throw new Error(
      `local-cc state collision for jobId ${context.jobId}: task mismatch (${state.taskId} != ${context.task.id}).`
    );
  }
  if (state.planId !== context.plan.id) {
    throw new Error(
      `local-cc state collision for jobId ${context.jobId}: plan mismatch (${state.planId} != ${context.plan.id}).`
    );
  }
  if (state.workdir !== expectedWorkdir) {
    const oldWorkdir = state.workdir;
    const oldWorkdirExists = (0, import_fs2.existsSync)(oldWorkdir);
    console.error(
      `[local-cc] workdir migrated for jobId ${context.jobId}: ${oldWorkdir} -> ${expectedWorkdir} (old workdir ${oldWorkdirExists ? "still exists" : "vanished"})`
    );
    state.workdir = expectedWorkdir;
    state.updatedAt = (/* @__PURE__ */ new Date()).toISOString();
    persistLocalCcState(state);
  }
}
function persistLocalCcState(state) {
  const stateDir = getLocalCcStateDir(state.jobId);
  (0, import_fs2.mkdirSync)(stateDir, { recursive: true });
  (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, "state.json"), JSON.stringify(state, null, 2), "utf8");
  (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, "status"), `${state.status}
`, "utf8");
  if (state.lastError) {
    (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, "error.txt"), `${state.lastError}
`, "utf8");
  } else {
    (0, import_fs2.rmSync)((0, import_path2.join)(stateDir, "error.txt"), { force: true });
  }
}
function findLatestCompletedRound(state) {
  for (let index = state.rounds.length - 1; index >= 0; index--) {
    const round = state.rounds[index];
    if (round.status === "completed" && round.workerResult) {
      return round;
    }
  }
  return null;
}
function findReusableExecuteRound(state) {
  return findLatestCompletedRound(state);
}
function findReusableContinueRound(state, feedback) {
  const feedbackHash = hashLocalCcFeedback(feedback);
  for (let index = state.rounds.length - 1; index >= 0; index--) {
    const round = state.rounds[index];
    if (round.kind === "continue" && round.status === "completed" && round.feedbackHash === feedbackHash && round.workerResult) {
      return round;
    }
  }
  return null;
}
async function runLocalCcRound(context, state, kind, prompt, feedback) {
  const nextRound = state.rounds.length + 1;
  const roundPrefix = `round-${String(nextRound).padStart(4, "0")}`;
  const stateDir = getLocalCcStateDir(context.jobId);
  const promptFile = `${roundPrefix}.prompt.txt`;
  const stdoutFile = `${roundPrefix}.stdout.txt`;
  const stderrFile = `${roundPrefix}.stderr.txt`;
  const feedbackFile = feedback ? `${roundPrefix}.feedback.txt` : void 0;
  const startedAt = (/* @__PURE__ */ new Date()).toISOString();
  const model = normalizeLocalCcModel(context.workerModel);
  (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, promptFile), `${prompt}
`, "utf8");
  if (feedbackFile) {
    (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, feedbackFile), `${feedback ?? ""}
`, "utf8");
  }
  state.model = model;
  state.status = "running";
  state.updatedAt = startedAt;
  delete state.lastError;
  persistLocalCcState(state);
  (0, import_fs2.writeFileSync)(
    (0, import_path2.join)(stateDir, "status"),
    `running round ${nextRound} since ${startedAt}
`,
    "utf8"
  );
  const roundTimeoutMs = LOCAL_CC_ROUND_TIMEOUT_MS;
  const commandResult = await localCcCommandExecutor({
    cwd: (0, import_path2.resolve)(context.workdir),
    prompt,
    model,
    effort: context.workerEffort,
    timeoutMs: roundTimeoutMs
  });
  const stdout = normalizeLocalCcOutput(commandResult.stdout);
  const stderr = normalizeLocalCcOutput(commandResult.stderr);
  const completedAt = (/* @__PURE__ */ new Date()).toISOString();
  (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, stdoutFile), stdout, "utf8");
  (0, import_fs2.writeFileSync)((0, import_path2.join)(stateDir, stderrFile), stderr, "utf8");
  const output = stdout || stderr;
  if (commandResult.exitCode !== 0 || commandResult.error) {
    const elapsedMs = new Date(completedAt).getTime() - new Date(startedAt).getTime();
    const elapsedSec = Math.round(elapsedMs / 1e3);
    const isStuckTimeout = elapsedMs >= roundTimeoutMs * 0.95;
    const error = formatLocalCcCommandFailure(commandResult, stderr, stdout);
    const errorDetail = isStuckTimeout ? `local-cc round ${nextRound} for job ${context.jobId} stuck: killed after ${elapsedSec}s (timeout ${Math.round(roundTimeoutMs / 1e3)}s). Check ${stateDir} for logs.` : void 0;
    state.rounds.push({
      round: nextRound,
      kind,
      status: "failed",
      promptFile,
      stdoutFile,
      stderrFile,
      feedbackFile,
      feedbackHash: feedback ? hashLocalCcFeedback(feedback) : void 0,
      summary: summarizeLocalCcOutput(output),
      error: errorDetail ?? error,
      startedAt,
      completedAt
    });
    state.status = "error";
    state.updatedAt = completedAt;
    state.lastError = errorDetail ?? error;
    persistLocalCcState(state);
    return buildLocalCcExecutionResult(context.jobId, "error", output, null, errorDetail ?? error, errorDetail);
  }
  if (!output) {
    const error = `local-cc worker ${context.jobId} produced no output.`;
    state.rounds.push({
      round: nextRound,
      kind,
      status: "failed",
      promptFile,
      stdoutFile,
      stderrFile,
      feedbackFile,
      feedbackHash: feedback ? hashLocalCcFeedback(feedback) : void 0,
      summary: "",
      error,
      startedAt,
      completedAt
    });
    state.status = "error";
    state.updatedAt = completedAt;
    state.lastError = error;
    persistLocalCcState(state);
    return buildLocalCcExecutionResult(context.jobId, "error", "", null, error);
  }
  const workerResult = buildLocalCcWorkerResult(
    context.task.id,
    output,
    context.jobId,
    context.workdir
  );
  state.rounds.push({
    round: nextRound,
    kind,
    status: "completed",
    promptFile,
    stdoutFile,
    stderrFile,
    feedbackFile,
    feedbackHash: feedback ? hashLocalCcFeedback(feedback) : void 0,
    summary: workerResult.summary,
    workerResult,
    startedAt,
    completedAt
  });
  state.status = "waiting";
  state.updatedAt = completedAt;
  delete state.lastError;
  persistLocalCcState(state);
  return buildLocalCcExecutionResult(
    context.jobId,
    "waiting",
    output,
    workerResult
  );
}
function buildLocalCcExecutionResult(jobId, status, output, workerResult, error, errorDetail) {
  return {
    jobId,
    stateDir: getLocalCcStateDir(jobId),
    output,
    status,
    workerResult,
    error,
    errorDetail
  };
}
function buildInitialLocalCcPrompt(task, plan, workdir, jobId) {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria : ["Complete the requested change without expanding scope."];
  return [
    "You are Claude Code executing one task inside the OpenClaw harness.",
    `Job ID: ${jobId}`,
    `Work only in this repository/worktree: ${(0, import_path2.resolve)(workdir)}`,
    "",
    `## Task`,
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    `## Scope`,
    task.scope,
    "",
    `## Acceptance Criteria`,
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `## Rules`,
    `- Make the requested code changes directly in the workdir.`,
    `- Stay tightly within the stated scope.`,
    `- Do not depend on any remote worker, SDK session, or Hetzner flow.`,
    `- Run focused validation when practical.`,
    "",
    ...buildLocalCcResponseFormat()
  ].join("\n");
}
function buildContinueLocalCcPrompt(task, plan, workdir, jobId, previousWorkerResult, feedback) {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria : ["Complete the requested change without expanding scope."];
  return [
    "You are Claude Code continuing an OpenClaw harness task in a fresh one-shot run.",
    `Job ID: ${jobId}`,
    `Work only in this repository/worktree: ${(0, import_path2.resolve)(workdir)}`,
    "",
    `## Task`,
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    `## Scope`,
    task.scope,
    "",
    `## Acceptance Criteria`,
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    `## Previous Worker Summary`,
    clipLocalCcText(previousWorkerResult.summary, 120, 12e3),
    "",
    `## Reviewer Feedback To Address`,
    clipLocalCcText(feedback, 120, 12e3),
    "",
    `## Rules`,
    `- Fix only the issues raised in the reviewer feedback.`,
    `- Preserve already-correct work unless a fix requires touching it.`,
    `- Run focused validation when practical.`,
    "",
    ...buildLocalCcResponseFormat()
  ].join("\n");
}
function buildLocalCcResponseFormat() {
  return [
    "## Final Response Format",
    "Return plain text using these exact section headers:",
    "Summary:",
    "Files changed:",
    "Tests run:",
    "Warnings:"
  ];
}
function buildLocalCcWorkerResult(taskId, output, sessionId, workdir) {
  return {
    taskId,
    status: "completed",
    summary: summarizeLocalCcOutput(output),
    filesChanged: extractLocalCcFilePaths(output, workdir),
    testsRun: extractLocalCcTestCount(output),
    warnings: extractLocalCcWarnings(output),
    sessionId
  };
}
function summarizeLocalCcOutput(output) {
  const normalized = normalizeLocalCcOutput(output);
  if (!normalized) return "";
  const tailLines = normalized.split("\n").slice(-80).join("\n");
  if (tailLines.length <= 8e3) {
    return tailLines;
  }
  return tailLines.slice(-8e3);
}
function extractLocalCcFilePaths(output, workdir) {
  const paths = [];
  const root = (0, import_path2.resolve)(workdir);
  const regex = /(?:^|[\s`'"(\[])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+|\/[\w./-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),:;\]])/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    let candidate = match[1].trim();
    if (!candidate) continue;
    if (candidate.startsWith("/")) {
      if (!candidate.startsWith(root + "/")) continue;
      candidate = (0, import_path2.relative)(root, candidate);
    }
    candidate = candidate.replace(/^\.\//, "");
    if (!candidate || candidate === ".." || candidate.startsWith("../")) continue;
    paths.push(candidate);
  }
  return [...new Set(paths)];
}
function extractLocalCcTestCount(output) {
  const match = output.match(/(\d+)\s*(?:tests?|specs?)\s*(?:passed|ran|ok)/i);
  return match ? parseInt(match[1], 10) : 0;
}
function extractLocalCcWarnings(output) {
  return output.split("\n").map((line) => line.trim()).filter((line) => /\b(?:warning|warn)\b/i.test(line)).slice(0, 10);
}
function normalizeLocalCcOutput(output) {
  return String(output ?? "").replace(/\r/g, "").trim();
}
function clipLocalCcText(text, maxLines, maxChars) {
  const normalized = normalizeLocalCcOutput(text);
  if (!normalized) return "";
  const tailLines = normalized.split("\n").slice(-maxLines).join("\n");
  if (tailLines.length <= maxChars) {
    return tailLines;
  }
  return tailLines.slice(-maxChars);
}
function hashLocalCcFeedback(feedback) {
  return (0, import_crypto.createHash)("sha256").update(feedback.trim()).digest("hex");
}
function normalizeLocalCcModel(workerModel) {
  const raw = (workerModel ?? "").trim();
  const normalized = raw.toLowerCase();
  if (!raw) return "sonnet";
  if (raw.includes("/")) {
    const [provider, model] = raw.split("/", 2);
    if (provider === "anthropic" && model) {
      return model;
    }
    return normalized.includes("opus") ? "opus" : "sonnet";
  }
  if (normalized === "claude" || normalized === "sonnet") {
    return "sonnet";
  }
  if (normalized === "opus") {
    return "opus";
  }
  if (normalized.includes("claude-opus") || normalized.includes("opus")) {
    return raw;
  }
  if (normalized.includes("claude-sonnet") || normalized.includes("sonnet")) {
    return raw;
  }
  return normalized.includes("opus") ? "opus" : "sonnet";
}
function buildLocalCcArgs(model, prompt, effort) {
  const args = [
    "-p",
    "--output-format",
    "text",
    "--no-session-persistence",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    model
  ];
  if (effort) {
    args.push("--effort", effort);
  }
  args.push(prompt);
  return args;
}
function buildLocalCcChildEnv(baseEnv) {
  const env = { ...baseEnv };
  const home = (env.HOME ?? "").trim() || (0, import_os2.homedir)();
  const claudeCredentialsPath = (0, import_path2.join)(home, ".claude", ".credentials.json");
  if ((0, import_fs2.existsSync)(claudeCredentialsPath)) {
    delete env.ANTHROPIC_API_KEY;
  }
  return env;
}
async function defaultLocalCcCommandExecutor(input) {
  return await new Promise((resolvePromise) => {
    const child = (0, import_child_process.spawn)(LOCAL_CC_COMMAND, buildLocalCcArgs(input.model, input.prompt, input.effort), {
      cwd: input.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: buildLocalCcChildEnv(process.env)
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let hardKillTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      resolvePromise(result);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 5e3);
    }, input.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      const message = error.code === "ENOENT" ? `Claude Code CLI not found on PATH. Install the local \`${LOCAL_CC_COMMAND}\` CLI or switch workerBackend to "remote-realtime".` : error.message;
      finish({
        exitCode: -1,
        stdout,
        stderr,
        error: message
      });
    });
    child.on("close", (code, signal) => {
      if (timedOut) {
        finish({
          exitCode: code ?? -1,
          stdout,
          stderr,
          error: `Claude Code CLI timed out after ${input.timeoutMs}ms${signal ? ` (${signal})` : ""}.`
        });
        return;
      }
      finish({
        exitCode: code ?? 0,
        stdout,
        stderr
      });
    });
  });
}
function formatLocalCcCommandFailure(result, stderr, stdout) {
  if (result.error) {
    return [
      result.error,
      stderr,
      stdout
    ].filter(Boolean).join("\n\n");
  }
  return [
    `Claude Code CLI exited with code ${result.exitCode}.`,
    stderr,
    stdout
  ].filter(Boolean).join("\n\n");
}

// src/backend/remote-realtime.ts
var remoteRealtimeBackend = {
  name: "remote-realtime",
  available() {
    return true;
  },
  describe() {
    return "Current stable lane: remote Claude realtime worker on Hetzner.";
  },
  async executeWorker(context) {
    return executeRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.workerModel,
      context.workerEffort,
      context.jobId
    );
  },
  async continueWorker(context, feedback) {
    return continueRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.jobId,
      feedback
    );
  },
  async finalizeWorker(context) {
    return finalizeRealtimeTask(
      context.task,
      context.plan,
      context.workdir,
      context.ctx,
      context.jobId
    );
  }
};

// src/backend/factory.ts
var BACKENDS = {
  "remote-realtime": remoteRealtimeBackend,
  "local-cc": localCcBackend
};
function resolveWorkerBackend(config) {
  const selected = config.workerBackend ?? "remote-realtime";
  return BACKENDS[selected] ?? remoteRealtimeBackend;
}

// src/router.ts
var TIER0_PATTERNS = [
  /\b(설정|config|setting|환경)\s*(변경|수정|바꿔|업데이트)/i,
  /\b(오타|typo|오탈자)\s*(수정|고쳐|fix)/i,
  /\b(문서|doc|readme|changelog)\s*(수정|추가|업데이트|작성)/i,
  /\b(버전|version)\s*(올려|bump|업데이트)/i,
  /\bpackage\.json\b.*\b(수정|업데이트)\b/i,
  /\b\.env\b.*\b(수정|추가)\b/i,
  /\btsconfig\b/i,
  /\b(단순|간단)\s*(패치|수정)\b/i,
  // Agent/workspace files
  /\b(AGENTS|MEMORY|SOUL|USER|TOOLS|IDENTITY|HEARTBEAT|BOOTSTRAP)\.md\b/i,
  // Simple line edits
  /\b(한 줄|한줄|one line|1줄)\s*(추가|수정|삭제|변경)/i,
  /\b(주석|코멘트|comment)\s*(추가|수정|삭제)/i,
  // Plist / LaunchAgent config
  /\b(plist|LaunchAgent)\b.*\b(수정|추가|변경)/i,
  // Shell script config changes
  /\b(\.sh|\.toml|\.yaml|\.yml)\b.*\b(수정|변경|업데이트)/i,
  // Import/export tweaks
  /\b(import|export)\s*(추가|수정|삭제)/i,
  // Simple rename/move
  /\b(이름|name)\s*(변경|바꿔|rename)/i
];
async function classifyRequest(request) {
  for (const pattern of TIER0_PATTERNS) {
    if (pattern.test(request)) {
      return {
        tier: 0,
        confidence: "pattern",
        reason: `Pattern match: ${pattern.source}`
      };
    }
  }
  const llmResult = await classifyWithLlm(request);
  if (llmResult) return llmResult;
  return {
    tier: 1,
    confidence: "fallback",
    reason: "LLM classification unavailable \u2014 defaulted to tier 1"
  };
}
var LLM_ROUTER_PROMPT = `You are a task complexity classifier. Given a coding task request, classify it as exactly one tier:

- tier 1: Single bug fix, single feature, single refactor, or a small focused change. One logical unit of work.
- tier 2: Multiple interrelated changes, migration, architecture change, multi-file refactor, or a task that needs decomposition into subtasks.

Respond with ONLY a JSON object, no other text:
{"tier": 1 or 2, "reason": "one sentence explanation"}`;
var LLM_ROUTER_TIMEOUT_MS = 15e3;
async function classifyWithLlm(request) {
  const sm = getSessionManager();
  if (!sm) return null;
  const routerModel = pluginConfig.plannerModel || "sonnet";
  try {
    const session = sm.spawn({
      prompt: `${LLM_ROUTER_PROMPT}

Request:
${request.slice(0, 2e3)}`,
      name: `router-llm-${Date.now()}`,
      workdir: process.cwd(),
      model: routerModel,
      maxBudgetUsd: 0.05,
      permissionMode: "default",
      allowedTools: [],
      multiTurn: false,
      internal: true
    });
    const startTime = Date.now();
    while (Date.now() - startTime < LLM_ROUTER_TIMEOUT_MS) {
      const s = sm.get(session.id);
      if (!s) break;
      if (s.status === "completed" || s.status === "failed" || s.status === "killed") {
        const output = s.getOutput().join("\n").trim();
        const parsed = parseLlmRouterOutput(output);
        if (parsed) {
          console.log(`[router] LLM classification: tier=${parsed.tier}, model=${routerModel}, reason=${parsed.reason}`);
          return parsed;
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    try {
      sm.kill(session.id);
    } catch {
    }
  } catch (err) {
    console.warn(`[router] LLM classification failed: ${err?.message ?? String(err)}`);
  }
  return null;
}
function parseLlmRouterOutput(output) {
  const jsonMatch = output.match(/\{[\s\S]*?\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    const tier = parsed.tier === 1 ? 1 : parsed.tier === 2 ? 2 : null;
    if (tier === null) return null;
    return {
      tier,
      confidence: "llm",
      reason: `LLM: ${typeof parsed.reason === "string" ? parsed.reason.slice(0, 200) : "classified"}`
    };
  } catch {
    return null;
  }
}

// src/planner.ts
var REPORT_SECTION_HEADERS = [
  /^return\s*:?$/i,
  /^output\s*:?$/i,
  /^deliverables?\s*:?$/i,
  /^response format\s*:?$/i,
  /^report back\s*:?$/i,
  /^when done\s*:?$/i,
  /^include in (?:the )?response\s*:?$/i
];
var TASK_SECTION_HEADERS = [
  /^tasks?\s*:?$/i,
  /^requested changes\s*:?$/i,
  /^workstreams?\s*:?$/i,
  /^plan\s*:?$/i,
  /^fixes?\s*:?$/i,
  /^implement\s*:?$/i
];
var TASK_LEAD_VERBS = /^(fix|add|update|improve|refactor|build|create|implement|remove|validate|write|test|document|ensure|route|investigate|ship|polish|clean up|stabilize|repair)\b/i;
var REPORT_BULLET_PREFIX = /^(root cause|files changed|commit hash|what still remains|remaining issues?|summary|tests run|warnings?)\b/i;
function nextPlanId() {
  const date = (/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "");
  const rand = Math.random().toString(36).slice(2, 8);
  return `plan-${date}-${rand}`;
}
function nextTaskId(index) {
  return `task-${index + 1}`;
}
async function searchMemory(projectName) {
  const endpoint = pluginConfig.memoryV3Endpoint;
  if (!endpoint) return "";
  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: `${projectName} \uD604\uC7AC \uC0C1\uD0DC` }),
      signal: AbortSignal.timeout(5e3)
    });
    if (!res.ok) return "";
    const data = await res.json();
    return typeof data === "string" ? data : JSON.stringify(data);
  } catch {
    return "";
  }
}
function buildPlan(request, tier, memoryContext = "") {
  if (tier === 0) {
    return {
      id: nextPlanId(),
      originalRequest: request,
      tasks: [{
        id: nextTaskId(0),
        title: "Direct execution",
        scope: request,
        acceptanceCriteria: ["Request fulfilled as specified"],
        agent: "claude"
      }],
      mode: "solo",
      estimatedComplexity: "low",
      tier: 0
    };
  }
  if (tier === 1) {
    return {
      id: nextPlanId(),
      originalRequest: request,
      tasks: [{
        id: nextTaskId(0),
        title: extractTitle(request),
        scope: request,
        acceptanceCriteria: extractAcceptanceCriteria(request),
        agent: "codex"
      }],
      mode: "solo",
      estimatedComplexity: "medium",
      tier: 1,
      plannerMetadata: {
        backend: "heuristic",
        fallback: false
      }
    };
  }
  const tasks = decomposeTasks(request);
  const mode = tasks.length === 1 ? "solo" : canParallelize(tasks) ? "parallel" : "sequential";
  return {
    id: nextPlanId(),
    originalRequest: request,
    tasks,
    mode,
    estimatedComplexity: "high",
    tier: 2,
    plannerMetadata: {
      backend: "heuristic",
      fallback: false
    }
  };
}
function buildPlannerPrompt(request, memoryContext) {
  const parts = [
    `You are a task planner. Decompose this request into concrete, independent implementation tasks.`,
    ``,
    `IMPORTANT: Return your plan as a single fenced JSON code block. Do not use YAML.`,
    `Any text outside the JSON code block will be ignored.`,
    ``,
    `## Request`,
    request
  ];
  if (memoryContext) {
    parts.push(``, `## Memory Context (previous work)`, memoryContext);
  }
  parts.push(
    ``,
    `## Output Format`,
    `Respond with exactly one fenced JSON block:`,
    ``,
    "```json",
    `{`,
    `  "tasks": [`,
    `    {`,
    `      "id": "task-1",`,
    `      "title": "Short descriptive title",`,
    `      "scope": "specific files/functions to modify",`,
    `      "acceptance_criteria": ["concrete, testable criterion"],`,
    `      "agent": "codex"`,
    `    }`,
    `  ],`,
    `  "mode": "parallel | sequential | solo",`,
    `  "estimated_complexity": "low | medium | high"`,
    `}`,
    "```",
    ``,
    `## Rules`,
    `- Prefer fewer, coherent tasks over many literal fragments.`,
    `- Group file references under the real implementation task; never emit a standalone file-name task.`,
    `- Keep implementation + tests + build verification together when they belong to one change. Do NOT split tests-only or verification-only follow-up tasks unless they operate on disjoint files.`,
    `- Ignore report-only sections like Return:, Output:, Deliverables:, or response-format bullets when forming tasks.`,
    `- Scope must be specific (file paths, function names).`,
    `- Acceptance criteria must be concrete and testable.`,
    `- Use "codex" as default agent unless a Claude worker is clearly better.`,
    `- Use "parallel" when tasks don't share files.`,
    `- Use "sequential" when later tasks depend on earlier ones.`,
    `- Maximum 6 tasks per plan.`
  );
  return parts.join("\n");
}
function extractFencedJson(output) {
  const matches = [...output.matchAll(/```json\s*\n([\s\S]*?)```/g)];
  if (matches.length > 0) {
    return matches[matches.length - 1][1].trim();
  }
  const genericMatches = [...output.matchAll(/```\s*\n([\s\S]*?)```/g)];
  for (let i = genericMatches.length - 1; i >= 0; i--) {
    const content = genericMatches[i][1].trim();
    if (content.startsWith("{") || content.startsWith("[")) {
      return content;
    }
  }
  return null;
}
function validatePlannerTask(raw, index) {
  if (!raw || typeof raw !== "object") return null;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : `task-${index + 1}`;
  const title = typeof raw.title === "string" && raw.title.trim() ? raw.title.trim() : null;
  if (!title) return null;
  if (shouldIgnoreStandaloneTaskBullet(title)) return null;
  const scope = typeof raw.scope === "string" && raw.scope.trim() ? raw.scope.trim() : title;
  const normalizedScope = scope.trim() || title;
  const agent = typeof raw.agent === "string" && raw.agent.trim() ? raw.agent.trim() : "codex";
  let acceptanceCriteria = [];
  if (Array.isArray(raw.acceptance_criteria)) {
    acceptanceCriteria = raw.acceptance_criteria.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim());
  }
  if (acceptanceCriteria.length === 0) {
    acceptanceCriteria = [title];
  }
  return { id, title, scope: normalizedScope, acceptance_criteria: acceptanceCriteria, agent };
}
var VALID_MODES = /* @__PURE__ */ new Set(["parallel", "sequential", "solo"]);
var VALID_COMPLEXITIES = /* @__PURE__ */ new Set(["low", "medium", "high"]);
function parsePlannerJson(output) {
  try {
    const jsonStr = extractFencedJson(output);
    if (!jsonStr) {
      const trimmed = output.trim();
      if (trimmed.startsWith("{")) {
        return parsePlannerJsonFromString(trimmed);
      }
      return null;
    }
    return parsePlannerJsonFromString(jsonStr);
  } catch {
    return null;
  }
}
function parsePlannerJsonFromString(jsonStr) {
  let parsed;
  try {
    parsed = JSON.parse(jsonStr);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (!Array.isArray(parsed.tasks) || parsed.tasks.length === 0) return null;
  const tasks = [];
  for (let i = 0; i < parsed.tasks.length; i++) {
    const validated = validatePlannerTask(parsed.tasks[i], i);
    if (validated) tasks.push(validated);
  }
  if (tasks.length === 0) return null;
  const modeRaw = typeof parsed.mode === "string" ? parsed.mode.trim().toLowerCase() : "";
  const complexityRaw = typeof parsed.estimated_complexity === "string" ? parsed.estimated_complexity.trim().toLowerCase() : "";
  return {
    tasks,
    mode: VALID_MODES.has(modeRaw) ? modeRaw : "sequential",
    estimated_complexity: VALID_COMPLEXITIES.has(complexityRaw) ? complexityRaw : "high"
  };
}
function yamlToHarnessPlan(parsed, request, metadata, tier = 2) {
  const normalized = normalizePlannerTasks(parsed.tasks);
  const pruned = pruneRedundantPlannerTasks(normalized, request);
  const tasks = pruned.map((task, index) => ({
    id: nextTaskId(index),
    title: task.title.length > 60 ? task.title.slice(0, 57) + "..." : task.title,
    scope: task.scope,
    acceptanceCriteria: task.acceptance_criteria,
    agent: task.agent === "claude" ? "claude" : "codex"
  }));
  const cappedTasks = tasks.slice(0, 6);
  const modeNorm = parsed.mode.toLowerCase();
  const complexityNorm = parsed.estimated_complexity.toLowerCase();
  return {
    id: nextPlanId(),
    originalRequest: request,
    tasks: cappedTasks,
    mode: cappedTasks.length === 1 ? "solo" : modeNorm === "parallel" ? "parallel" : modeNorm === "solo" ? "solo" : "sequential",
    estimatedComplexity: complexityNorm === "low" ? "low" : complexityNorm === "medium" ? "medium" : "high",
    tier,
    plannerMetadata: metadata
  };
}
function pruneRedundantPlannerTasks(tasks, request) {
  if (tasks.length <= 1) return tasks;
  const cleanupSignals = /(abort older active|stale harness runs|leftover pid|lock files?|clean state|terminate older)/i;
  const outputContractSignals = /(return exactly|output only|artifact path|five lines|stdout|stderr|exit code|final realtime status|first blocking error)/i;
  const requestSuggestsSingleFlow = cleanupSignals.test(request) && outputContractSignals.test(request);
  if (!requestSuggestsSingleFlow) return tasks;
  const verificationSignals = /(verify|validation|validate|smoke|report|return exactly|output only|artifact path|five lines|stdout|stderr|exit code|final realtime status|first blocking error)/i;
  const implementationTasks = tasks.filter((task) => !verificationSignals.test(`${task.title}
${task.scope}`));
  const verificationTasks = tasks.filter((task) => verificationSignals.test(`${task.title}
${task.scope}`));
  if (implementationTasks.length !== 1 || verificationTasks.length === 0) {
    return tasks;
  }
  const primary = {
    ...implementationTasks[0],
    acceptance_criteria: unique([
      ...implementationTasks[0].acceptance_criteria,
      ...verificationTasks.flatMap((task) => task.acceptance_criteria)
    ])
  };
  primary.scope = mergeScope(
    primary.scope,
    verificationTasks.map((task) => task.scope).join("\n")
  );
  return [primary];
}
function normalizePlannerTasks(tasks) {
  const merged = [];
  for (const task of tasks) {
    const previous = merged[merged.length - 1];
    if (previous && shouldMergePlannerTask(previous, task)) {
      previous.scope = mergeScope(previous.scope, task.scope);
      previous.acceptance_criteria = unique([
        ...previous.acceptance_criteria,
        ...task.acceptance_criteria
      ]);
      continue;
    }
    merged.push({
      ...task,
      acceptance_criteria: [...task.acceptance_criteria]
    });
  }
  return merged;
}
function shouldMergePlannerTask(previous, current) {
  const currentText = `${current.title}
${current.scope}
${current.acceptance_criteria.join("\n")}`;
  const currentFiles = extractScopeFiles(current.scope);
  const prevFiles = extractScopeFiles(previous.scope);
  const testOnlyFiles = currentFiles.length > 0 && currentFiles.every(isTestFile);
  const testsOnlyTask = /(test|tests|pytest|spec|unit test|integration test)/i.test(currentText) && (testOnlyFiles || currentFiles.length === 0);
  const verificationOnlyTask = /(verify|validation|build|dry-run|smoke|summary|report|commit hash|files changed)/i.test(currentText) && currentFiles.every((file) => isTestFile(file) || !file);
  const overlapsPrevious = currentFiles.length === 0 || currentFiles.some((file) => prevFiles.includes(file)) || currentFiles.every(isTestFile);
  return overlapsPrevious && (testsOnlyTask || verificationOnlyTask);
}
function mergeScope(base, extra) {
  const normalizedBase = normalizeText(base);
  const normalizedExtra = normalizeText(extra);
  if (!normalizedExtra || normalizedBase.includes(normalizedExtra)) {
    return base;
  }
  return `${base}
Also include: ${normalizedExtra}`;
}
function isTestFile(file) {
  return /(^|\/)(test|tests)\//i.test(file) || /\.(test|spec)\.[^.]+$/i.test(file);
}
function uniquePlannerModels(models) {
  const seen = /* @__PURE__ */ new Set();
  const unique2 = [];
  for (const model of models) {
    const normalized = model.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique2.push(normalized);
  }
  return unique2;
}
function formatPlannerFailures(failures) {
  if (failures.length === 0) return void 0;
  return failures.join("; ");
}
async function runPlannerWithSession(input) {
  const sessionManager2 = getSessionManager();
  if (!sessionManager2) {
    throw new Error("SessionManager not available for model-backed planner");
  }
  const plannerSession = sessionManager2.spawn({
    prompt: input.prompt,
    name: `planner-${input.requestedModel.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}`,
    workdir: input.workdir,
    model: input.requestedModel,
    maxBudgetUsd: 0.5,
    permissionMode: "default",
    allowedTools: [],
    multiTurn: false,
    internal: true
  });
  const output = await waitForPlannerOutput(plannerSession.id);
  if (!output.trim()) {
    throw new Error("Planner session produced no assistant output");
  }
  return {
    output,
    launchModel: plannerSession.model ?? input.requestedModel
  };
}
async function buildModelPlan(request, memoryContext = "", workdir = process.cwd(), runner = runPlannerWithSession, tier = 2) {
  const prompt = buildPlannerPrompt(request, memoryContext);
  const plannerModels = uniquePlannerModels([
    pluginConfig.plannerModel || "opus",
    "sonnet"
  ]);
  const failures = [];
  for (const requestedModel of plannerModels) {
    try {
      console.log(`[planner] Attempting model-backed planning with model=${requestedModel}, tier=${tier}`);
      const result = await runner({ prompt, requestedModel, workdir });
      const parsed = parsePlannerJson(result.output);
      if (!parsed) {
        throw new Error("Failed to parse planner output: model did not return valid fenced JSON");
      }
      const metadata = {
        backend: "model",
        model: result.launchModel ?? requestedModel,
        fallback: failures.length > 0,
        fallbackReason: formatPlannerFailures(failures)
      };
      console.log(`[planner] Model-backed plan created: model=${metadata.model ?? requestedModel}, tasks=${parsed.tasks.length}, mode=${parsed.mode}`);
      return yamlToHarnessPlan(parsed, request, metadata, tier);
    } catch (error) {
      const message = error?.message ?? String(error);
      failures.push(`${requestedModel}: ${message}`);
      console.warn(`[planner] Model planner failed (model=${requestedModel}): ${message}`);
    }
  }
  console.log(`[planner] All model attempts failed, falling back to heuristic planner`);
  const heuristicPlan = buildPlan(request, tier, memoryContext);
  heuristicPlan.plannerMetadata = {
    backend: "heuristic",
    fallback: true,
    fallbackReason: formatPlannerFailures(failures) ?? "Model planner unavailable"
  };
  return heuristicPlan;
}
async function waitForPlannerOutput(sessionId) {
  const maxWaitMs = 5 * 60 * 1e3;
  const pollIntervalMs = 1e3;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const session = getSessionManager()?.get(sessionId);
    if (!session) return "";
    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return session.getOutput().join("\n");
    }
    await new Promise((resolve6) => setTimeout(resolve6, pollIntervalMs));
  }
  getSessionManager()?.kill(sessionId);
  return "";
}
function extractTitle(request) {
  const firstSentence = request.split(/[.!?\n]/)[0]?.trim() ?? request;
  if (firstSentence.length <= 60) return firstSentence;
  return firstSentence.slice(0, 57) + "...";
}
function extractAcceptanceCriteria(request) {
  const criteria = collectMeaningfulBullets(splitLines(request));
  if (criteria.length > 0) {
    return criteria;
  }
  return [
    "Implementation matches the request specification",
    "No regressions in existing functionality"
  ];
}
function decomposeTasks(request) {
  const numberedTasks = decomposeNumberedTasks(request);
  if (numberedTasks.length >= 2) {
    return numberedTasks;
  }
  const bulletTasks = decomposeBulletTasks(request);
  if (bulletTasks.length >= 2) {
    return bulletTasks;
  }
  return [
    buildTaskSpec(0, request, request, extractAcceptanceCriteria(request))
  ];
}
function decomposeNumberedTasks(request) {
  const blocks = extractNumberedBlocks(request);
  if (blocks.length < 2) return [];
  return blocks.map((block, index) => {
    const criteria = collectMeaningfulBullets(block.lines);
    const fileRefs = extractScopeFiles([block.title, ...block.lines].join("\n"));
    const scope = buildTaskScope(block.title, fileRefs, block.lines);
    return buildTaskSpec(index, block.title, scope, criteria);
  });
}
function decomposeBulletTasks(request) {
  const tasks = [];
  let section = "neutral";
  for (const line of splitLines(request)) {
    const trimmed = normalizeText(line);
    if (!trimmed) continue;
    if (isReportSectionHeader(trimmed)) {
      section = "report";
      continue;
    }
    if (isTaskSectionHeader(trimmed)) {
      section = "task";
      continue;
    }
    const bullet = parseBulletLine(trimmed);
    if (!bullet) {
      if (/:$/.test(trimmed)) {
        section = "neutral";
      }
      continue;
    }
    if (section === "report") continue;
    if (isLikelyFileReference(bullet)) {
      if (tasks.length > 0) {
        appendFilesToTaskScope(tasks[tasks.length - 1], extractScopeFiles(bullet));
      }
      continue;
    }
    if (shouldIgnoreStandaloneTaskBullet(bullet)) continue;
    if (section !== "task" && !looksLikeActionableTask(bullet)) continue;
    const criteria = [bullet];
    const files = extractScopeFiles(bullet);
    const scope = buildTaskScope(bullet, files, []);
    tasks.push(buildTaskSpec(tasks.length, bullet, scope, criteria));
  }
  return tasks;
}
function extractNumberedBlocks(request) {
  const blocks = [];
  let current = null;
  for (const line of splitLines(request)) {
    const trimmed = line.trim();
    const numbered = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (numbered) {
      current = {
        title: normalizeText(numbered[1]),
        lines: []
      };
      blocks.push(current);
      continue;
    }
    if (current) {
      current.lines.push(line);
    }
  }
  return blocks.filter((block) => !shouldIgnoreStandaloneTaskBullet(block.title));
}
function buildTaskSpec(index, titleSource, scope, acceptanceCriteria) {
  return {
    id: nextTaskId(index),
    title: extractTitle(titleSource),
    scope,
    acceptanceCriteria: acceptanceCriteria.length > 0 ? acceptanceCriteria : [normalizeText(titleSource)],
    agent: "codex"
  };
}
function buildTaskScope(title, fileRefs, bodyLines) {
  const parts = [normalizeText(title)];
  if (fileRefs.length > 0) {
    parts.push(`Relevant files: ${fileRefs.join(", ")}`);
  }
  const contextNotes = bodyLines.map((line) => normalizeText(line)).filter((line) => {
    if (!line) return false;
    if (parseBulletLine(line) || parseNumberedLine(line)) return false;
    return !isSectionHeader(line);
  }).slice(0, 2);
  if (contextNotes.length > 0) {
    parts.push(`Context: ${contextNotes.join(" ")}`);
  }
  return parts.join("\n");
}
function appendFilesToTaskScope(task, fileRefs) {
  if (fileRefs.length === 0) return;
  const uniqueFiles = unique(fileRefs);
  const existingMatch = task.scope.match(/\nRelevant files: (.+)$/m);
  if (!existingMatch) {
    task.scope = `${task.scope}
Relevant files: ${uniqueFiles.join(", ")}`;
    return;
  }
  const existingFiles = existingMatch[1].split(",").map((file) => file.trim()).filter(Boolean);
  const merged = unique([...existingFiles, ...uniqueFiles]);
  task.scope = task.scope.replace(/\nRelevant files: .+$/m, `
Relevant files: ${merged.join(", ")}`);
}
function collectMeaningfulBullets(lines) {
  const criteria = [];
  let inReportSection = false;
  for (const rawLine of lines) {
    const trimmed = normalizeText(rawLine);
    if (!trimmed) continue;
    if (isReportSectionHeader(trimmed)) {
      inReportSection = true;
      continue;
    }
    if (isSectionHeader(trimmed) && !isReportSectionHeader(trimmed)) {
      inReportSection = false;
    }
    const bullet = parseBulletLine(trimmed) ?? parseNumberedLine(trimmed);
    if (!bullet || inReportSection) continue;
    if (shouldIgnoreCriterion(bullet)) continue;
    criteria.push(bullet);
  }
  return unique(criteria);
}
function parseBulletLine(line) {
  const match = line.match(/^[-•*]\s+(.+)$/);
  return match ? normalizeText(match[1]) : null;
}
function parseNumberedLine(line) {
  const match = line.match(/^\d+[.)]\s+(.+)$/);
  return match ? normalizeText(match[1]) : null;
}
function shouldIgnoreCriterion(text) {
  return REPORT_BULLET_PREFIX.test(text) || isLikelyFileReference(text);
}
function shouldIgnoreStandaloneTaskBullet(text) {
  return REPORT_BULLET_PREFIX.test(text) || isLikelyFileReference(text);
}
function looksLikeActionableTask(text) {
  if (TASK_LEAD_VERBS.test(text)) return true;
  if (/^\d+[.)]\s+/.test(text)) return true;
  return false;
}
function isLikelyFileReference(text) {
  const cleaned = text.replace(/[`"'(),]/g, " ").trim();
  if (!/\.[a-z][a-z0-9]{0,4}\b/i.test(cleaned)) return false;
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length > 4) return false;
  return words.every((word) => /[./]/.test(word) || /^[a-z0-9_-]+$/i.test(word));
}
function isReportSectionHeader(text) {
  return REPORT_SECTION_HEADERS.some((pattern) => pattern.test(text));
}
function isTaskSectionHeader(text) {
  return TASK_SECTION_HEADERS.some((pattern) => pattern.test(text));
}
function isSectionHeader(text) {
  return /:$/.test(text) || isReportSectionHeader(text) || isTaskSectionHeader(text);
}
function splitLines(text) {
  return text.replace(/\r\n?/g, "\n").split("\n");
}
function normalizeText(text) {
  return text.replace(/\s+/g, " ").trim();
}
function unique(items) {
  return [...new Set(items)];
}
function canParallelize(tasks) {
  if (tasks.length <= 1) return false;
  for (const task of tasks) {
    if (/\b(after|then|다음에|이후에|완료\s*후)\b/i.test(task.scope)) {
      return false;
    }
  }
  const filesByTask = tasks.map((t) => extractScopeFiles(t.scope));
  for (const files of filesByTask) {
    if (files.length === 0) {
      return false;
    }
  }
  for (let i = 0; i < filesByTask.length; i++) {
    for (let j = i + 1; j < filesByTask.length; j++) {
      const overlap = filesByTask[i].filter((f) => filesByTask[j].includes(f));
      if (overlap.length > 0) {
        return false;
      }
    }
  }
  return true;
}
function extractScopeFiles(scope) {
  const matches = scope.match(/[\w\-./]+\.[a-z][a-z0-9]{0,4}/gi);
  return matches ? [...new Set(matches)] : [];
}

// src/tools/harness-execute.ts
init_checkpoint();

// src/gap-types.ts
var GAP_MIN_SEVERITY_THRESHOLD = 0.5;
var GAP_DEFINITIONS = {
  assumption_injection: {
    type: "assumption_injection",
    label: "Assumption Injection",
    description: "Added assumptions or decisions not present in the original request.",
    severity: 0.8,
    examples: [
      "Adding JWT authentication when not requested",
      "Choosing a specific database without being asked",
      "Adding rate limiting that wasn't in the spec"
    ]
  },
  scope_creep: {
    type: "scope_creep",
    label: "Scope Creep",
    description: "Added features or complexity beyond what was requested.",
    severity: 0.7,
    examples: [
      "Adding a notification system to a TODO app",
      "Building an admin dashboard when only asked for a form",
      "Adding i18n support for a single-language project"
    ]
  },
  direction_drift: {
    type: "direction_drift",
    label: "Direction Drift",
    description: "Implementation direction diverges from the original intent.",
    severity: 1,
    examples: [
      "Building a full-stack framework for a simple API",
      "Using microservices architecture for a CLI tool",
      "Converting a script to a full application"
    ]
  },
  missing_core: {
    type: "missing_core",
    label: "Missing Core",
    description: "Core functionality from the request was not implemented.",
    severity: 1,
    examples: [
      "Search feature not implemented in a search task",
      "Error handling omitted from API endpoint",
      "Missing validation on user input fields"
    ]
  },
  over_engineering: {
    type: "over_engineering",
    label: "Over-Engineering",
    description: "Excessive abstraction or generalization beyond what the task needs.",
    severity: 0.3,
    examples: [
      "DI container for simple CRUD operations",
      "Abstract factory pattern for a single implementation",
      "Generic middleware framework for one endpoint"
    ]
  }
};
var REVIEWER_SYSTEM_PROMPT = `You are a code reviewer. Your job is to review code changes against the original task specification and acceptance criteria.

You must check for these 5 gap types:
${Object.values(GAP_DEFINITIONS).map((g) => `- ${g.type}: ${g.description}`).join("\n")}

Your ENTIRE response must be a single JSON object. No markdown, no explanation, no code blocks. Just the JSON.

Output schema:
{
  "taskId": "<task id>",
  "result": "pass" | "fail",
  "gaps": [
    {
      "type": "<gap type>",
      "evidence": "<specific evidence from the code>",
      "fixHint": "<concrete suggestion to fix>"
    }
  ],
  "rerunNeeded": true | false
}

Pass example:
{"taskId":"task-1","result":"pass","gaps":[],"rerunNeeded":false}

Fail example:
{"taskId":"task-1","result":"fail","gaps":[{"type":"missing_core","evidence":"The required --force flag is not implemented in the changed command.","fixHint":"Add --force handling and update the command validation path."}],"rerunNeeded":true}

Rules:
- You are READ-ONLY. Never modify code yourself.
- Only report gaps with concrete evidence from the code diff.
- "pass" means no gaps found. "fail" means at least one gap exists.
- Be strict on missing_core (required features). Be lenient on minor over_engineering.
- If the code fully satisfies the acceptance criteria with no gaps, result is "pass".`;

// src/reviewer.ts
var VALID_GAP_TYPES = [
  "assumption_injection",
  "scope_creep",
  "direction_drift",
  "missing_core",
  "over_engineering"
];
var GAP_TYPE_PATTERNS = [
  { type: "assumption_injection", pattern: /\bassumption[_\s-]?injection\b/i },
  { type: "scope_creep", pattern: /\bscope[_\s-]?creep\b/i },
  { type: "direction_drift", pattern: /\bdirection[_\s-]?drift\b/i },
  { type: "missing_core", pattern: /\bmissing[_\s-]?core\b/i },
  { type: "over_engineering", pattern: /\bover[_\s-]?engineering\b/i }
];
function buildReviewPrompt(task, workerResult, originalRequest, previousGaps) {
  const lines = [
    `## Review Task`,
    ``,
    `**Original request:** ${originalRequest}`,
    ``,
    `### Task Specification`,
    `- **ID:** ${task.id}`,
    `- **Title:** ${task.title}`,
    `- **Scope:** ${task.scope}`,
    `- **Acceptance criteria:**`,
    ...task.acceptanceCriteria.map((c) => `  - ${c}`),
    ``,
    `### Worker Result`,
    `- **Status:** ${workerResult.status}`,
    `- **Summary:** ${workerResult.summary}`,
    `- **Files changed:**`,
    ...workerResult.filesChanged.map((f) => `  - ${f}`),
    `- **Tests run:** ${workerResult.testsRun}`
  ];
  if (workerResult.warnings.length > 0) {
    lines.push(`- **Warnings:**`);
    for (const w of workerResult.warnings) {
      lines.push(`  - ${w}`);
    }
  }
  if (previousGaps && previousGaps.length > 0) {
    lines.push(
      ``,
      `### Previous Gaps (from last review \u2014 verify these are fixed)`
    );
    for (const gap of previousGaps) {
      lines.push(`- **${gap.type}:** ${gap.evidence}`);
      lines.push(`  Fix hint: ${gap.fixHint}`);
    }
    lines.push(
      ``,
      `**IMPORTANT:** Verify that the previous gaps have been addressed. If they persist, report them again.`
    );
  }
  lines.push(
    ``,
    `### Instructions`,
    `Review the changed files against the acceptance criteria. Output JSON as specified in system prompt.`,
    `Read each changed file and check if the acceptance criteria are met.`
  );
  return lines.join("\n");
}
function parseReviewOutput(output, taskId) {
  for (const candidate of extractJsonCandidates(output)) {
    try {
      const parsed = JSON.parse(candidate);
      return validateReviewResult(parsed, taskId);
    } catch {
    }
  }
  const fallback = parseFallbackReviewOutput(output, taskId);
  if (fallback) {
    return fallback;
  }
  console.warn(`[reviewer] Failed to parse review output for ${taskId}, requesting reviewer retry`);
  return {
    taskId,
    result: "fail",
    gaps: [],
    rerunNeeded: true,
    retryReviewer: true
  };
}
function validateReviewResult(parsed, taskId) {
  const gaps = [];
  if (Array.isArray(parsed.gaps)) {
    for (const gap of parsed.gaps) {
      if (VALID_GAP_TYPES.includes(gap.type) && gap.evidence) {
        gaps.push({
          type: gap.type,
          evidence: String(gap.evidence),
          fixHint: String(gap.fixHint ?? "")
        });
      }
    }
  }
  const normalizedResult = parsed?.result === "fail" ? "fail" : parsed?.result === "pass" ? "pass" : void 0;
  if (normalizedResult === "fail" && gaps.length === 0) {
    return {
      taskId: parsed.taskId ?? taskId,
      result: "fail",
      gaps: [],
      rerunNeeded: true,
      retryReviewer: true
    };
  }
  const hardGaps = gaps.filter((gap) => {
    const def = GAP_DEFINITIONS[gap.type];
    return def ? def.severity >= GAP_MIN_SEVERITY_THRESHOLD : true;
  });
  const softGaps = gaps.filter((gap) => {
    const def = GAP_DEFINITIONS[gap.type];
    return def ? def.severity < GAP_MIN_SEVERITY_THRESHOLD : false;
  });
  if (softGaps.length > 0) {
    console.log(`[reviewer] Soft-filtered ${softGaps.length} gap(s) below severity threshold: ${softGaps.map((g) => g.type).join(", ")}`);
  }
  const derivedResult = hardGaps.length > 0 ? "fail" : "pass";
  return {
    taskId: parsed.taskId ?? taskId,
    result: derivedResult,
    gaps,
    // Report ALL gaps (hard + soft) for transparency
    rerunNeeded: hardGaps.length > 0,
    retryReviewer: false
  };
}
function extractJsonCandidates(output) {
  const candidates = /* @__PURE__ */ new Set();
  const trimmed = output.trim();
  if (trimmed) {
    candidates.add(trimmed);
  }
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/i);
  if (codeBlockMatch?.[1]) {
    candidates.add(codeBlockMatch[1].trim());
  }
  const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
  if (jsonMatch?.[0]) {
    candidates.add(jsonMatch[0].trim());
  }
  return [...candidates];
}
function parseFallbackReviewOutput(output, taskId) {
  const hasFailMarker = /\bresult\b[^a-zA-Z]{0,10}fail\b/i.test(output) || /"fail"/i.test(output) || /\bfail\b/i.test(output);
  const hasPassMarker = /\bresult\b[^a-zA-Z]{0,10}pass\b/i.test(output) || /"pass"/i.test(output) || /\bno gaps?\b/i.test(output);
  if (hasFailMarker) {
    const gaps = extractFallbackGaps(output);
    if (gaps.length > 0) {
      return {
        taskId,
        result: "fail",
        gaps,
        rerunNeeded: true,
        retryReviewer: false
      };
    }
  }
  if (hasPassMarker) {
    return {
      taskId,
      result: "pass",
      gaps: [],
      rerunNeeded: false,
      retryReviewer: false
    };
  }
  return null;
}
function extractFallbackGaps(output) {
  const evidence = extractField(output, ["evidence", "gap", "issue", "reason"]) ?? extractInlineFailReason(output) ?? extractDescriptiveLine(output);
  if (!evidence) {
    return [];
  }
  const fixHint = extractField(output, ["fixHint", "fix hint", "fix", "suggestion", "recommendation"]) ?? "";
  return [{
    type: detectGapType(output) ?? "missing_core",
    evidence,
    fixHint
  }];
}
function detectGapType(output) {
  for (const entry of GAP_TYPE_PATTERNS) {
    if (entry.pattern.test(output)) {
      return entry.type;
    }
  }
  return null;
}
function extractField(output, fieldNames) {
  for (const field of fieldNames) {
    const escaped = field.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const quoted = new RegExp(`"${escaped}"\\s*:\\s*"([^"]+)"`, "i");
    const quotedMatch = output.match(quoted);
    if (quotedMatch?.[1]) {
      return quotedMatch[1].trim();
    }
    const inline = new RegExp(`${escaped}\\s*[:=-]\\s*(.+)`, "i");
    const inlineMatch = output.match(inline);
    if (inlineMatch?.[1]) {
      return sanitizeExtractedText(inlineMatch[1]);
    }
  }
  return null;
}
function extractInlineFailReason(output) {
  const match = output.match(/\bfail\b\s*[:\-]\s*(.+)/i);
  return match?.[1] ? sanitizeExtractedText(match[1]) : null;
}
function extractDescriptiveLine(output) {
  const lines = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith("```")).filter((line) => !/^[\[\]{},"]+$/.test(line)).filter((line) => !/^(taskid|result|gaps|rerunneeded)\b/i.test(line)).filter((line) => !/^\b(?:pass|fail)\b$/i.test(line));
  for (const line of lines) {
    const cleaned = sanitizeExtractedText(line);
    if (cleaned && cleaned.length > 12) {
      return cleaned;
    }
  }
  return null;
}
function sanitizeExtractedText(text) {
  return text.trim().replace(/^["'`\-:\s]+/, "").replace(/["'`,\s]+$/, "");
}

// src/review-loop.ts
function initReviewLoop(taskId) {
  return {
    taskId,
    currentLoop: 0,
    maxLoops: pluginConfig.maxReviewLoops,
    gaps: [],
    passed: false,
    escalated: false,
    history: []
  };
}
function buildReviewRequest(task, workerResult, originalRequest, state) {
  const previousGaps = state.currentLoop > 0 ? state.gaps : void 0;
  return buildReviewPrompt(task, workerResult, originalRequest, previousGaps);
}

// src/reviewer-runner.ts
var import_child_process2 = require("child_process");
var import_fs5 = require("fs");
var import_os5 = require("os");
var import_path5 = require("path");

// node_modules/nanoid/index.js
var import_crypto2 = __toESM(require("crypto"), 1);

// node_modules/nanoid/url-alphabet/index.js
var urlAlphabet = "useandom-26T198340PX75pxJACKVERYMINDBUSHWOLF_GQZbfghjklqvwyzrict";

// node_modules/nanoid/index.js
var POOL_SIZE_MULTIPLIER = 128;
var pool;
var poolOffset;
var fillPool = (bytes) => {
  if (!pool || pool.length < bytes) {
    pool = Buffer.allocUnsafe(bytes * POOL_SIZE_MULTIPLIER);
    import_crypto2.default.randomFillSync(pool);
    poolOffset = 0;
  } else if (poolOffset + bytes > pool.length) {
    import_crypto2.default.randomFillSync(pool);
    poolOffset = 0;
  }
  poolOffset += bytes;
};
var nanoid = (size = 21) => {
  fillPool(size |= 0);
  let id = "";
  for (let i = poolOffset - size; i < poolOffset; i++) {
    id += urlAlphabet[pool[i] & 63];
  }
  return id;
};

// src/model-resolution.ts
var import_fs4 = require("fs");
var import_os4 = require("os");
var import_path4 = require("path");
var aliasCache = null;
function getOpenClawConfigPath() {
  const explicit = process.env.OPENCLAW_CONFIG_PATH?.trim();
  if (explicit) return explicit;
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  if (stateDir) return (0, import_path4.join)(stateDir, "openclaw.json");
  return (0, import_path4.join)((0, import_os4.homedir)(), ".openclaw", "openclaw.json");
}
function stripJsonComments(input) {
  let result = "";
  let inString = false;
  let stringQuote = "";
  let escape = false;
  let inLineComment = false;
  let inBlockComment = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    const next = input[i + 1];
    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        result += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inString) {
      result += char;
      if (escape) {
        escape = false;
      } else if (char === "\\") {
        escape = true;
      } else if (char === stringQuote) {
        inString = false;
        stringQuote = "";
      }
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringQuote = char;
      result += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i++;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    result += char;
  }
  return result;
}
function loadAliasIndex() {
  const configPath = getOpenClawConfigPath();
  if (!(0, import_fs4.existsSync)(configPath)) return /* @__PURE__ */ new Map();
  const stat = (0, import_fs4.statSync)(configPath);
  if (aliasCache && aliasCache.path === configPath && aliasCache.mtimeMs === stat.mtimeMs) {
    return aliasCache.aliases;
  }
  const aliases = /* @__PURE__ */ new Map();
  try {
    const raw = (0, import_fs4.readFileSync)(configPath, "utf8");
    const parsed = JSON.parse(stripJsonComments(raw));
    const models = parsed?.agents?.defaults?.models;
    if (models && typeof models === "object") {
      for (const [canonicalRef, entry] of Object.entries(models)) {
        const alias = typeof entry?.alias === "string" ? entry.alias.trim() : "";
        if (!alias) continue;
        aliases.set(alias.toLowerCase(), canonicalRef.trim());
      }
    }
  } catch (error) {
    console.warn(`[model-resolution] Failed to read model aliases from ${configPath}: ${error?.message ?? String(error)}`);
  }
  aliasCache = {
    path: configPath,
    mtimeMs: stat.mtimeMs,
    aliases
  };
  return aliases;
}
function normalizeClaudeLaunchModel(model) {
  const normalized = model.trim().toLowerCase();
  if (normalized === "anthropic/claude-opus-4-6") return "opus";
  if (normalized === "anthropic/claude-sonnet-4-6") return "sonnet";
  if (normalized === "anthropic/claude-opus-4-5") return "opus";
  if (normalized === "anthropic/claude-sonnet-4-5") return "sonnet";
  if (normalized === "anthropic/claude-opus-4-1") return "opus";
  if (normalized === "anthropic/claude-sonnet-4-1") return "sonnet";
  return model;
}
function resolveModelAlias(model) {
  if (typeof model !== "string") return void 0;
  const trimmed = model.trim();
  if (!trimmed) return void 0;
  const aliases = loadAliasIndex();
  const canonical = trimmed.includes("/") ? trimmed : aliases.get(trimmed.toLowerCase()) ?? trimmed;
  return normalizeClaudeLaunchModel(canonical);
}

// src/reviewer-runner.ts
function normalizeCodexReasoningEffort(level) {
  const normalized = level?.trim().toLowerCase();
  switch (normalized) {
    case "minimal":
    case "low":
    case "medium":
    case "high":
    case "xhigh":
      return normalized;
    case "max":
      return "xhigh";
    default:
      return void 0;
  }
}
var DEFAULT_TIMEOUT_MS = parseInt(process.env.OPENCLAW_HARNESS_REVIEW_TIMEOUT_MS ?? "", 10) || 2 * 60 * 1e3;
function resolveReviewerExecutionTarget(reviewModel, fallbackModel) {
  const requestedModel = resolveModelAlias(reviewModel ?? fallbackModel);
  if (!requestedModel) {
    return {
      backend: "claude-session",
      requestedModel: fallbackModel,
      launchModel: fallbackModel
    };
  }
  if (isCodexCapableModel(requestedModel)) {
    return {
      backend: "codex-cli",
      requestedModel,
      launchModel: normalizeCodexModel(requestedModel)
    };
  }
  return {
    backend: "claude-session",
    requestedModel,
    launchModel: requestedModel
  };
}
function isCodexCapableModel(model) {
  if (!model) return false;
  const normalized = model.trim().toLowerCase();
  if (!normalized) return false;
  if (normalized.startsWith("openai-codex/") || normalized.startsWith("openai/")) {
    return true;
  }
  return /^(gpt-|o1\b|o3\b|o4\b|codex\b)/i.test(normalized);
}
function normalizeCodexModel(model) {
  if (!model) return void 0;
  const trimmed = model.trim();
  if (!trimmed) return void 0;
  if (trimmed.startsWith("openai-codex/") || trimmed.startsWith("openai/")) {
    const [, providerModel] = trimmed.split(/\/(.+)/, 2);
    return providerModel?.trim() || void 0;
  }
  return trimmed;
}
function buildCodexReviewerCommand(options) {
  const isResume = !!options.resumeSessionId;
  const args = isResume ? [
    "exec",
    "resume",
    "--skip-git-repo-check",
    "--output-last-message",
    options.outputFile,
    options.resumeSessionId,
    "-"
  ] : [
    "exec",
    "-",
    "--skip-git-repo-check",
    "--sandbox",
    "read-only",
    "--color",
    "never",
    "--output-last-message",
    options.outputFile,
    "-C",
    options.workdir
  ];
  if (options.model) {
    args.push("-m", options.model);
  }
  const reasoningEffort = normalizeCodexReasoningEffort(options.reasoningEffort);
  if (reasoningEffort) {
    args.push("-c", `model_reasoning_effort=${JSON.stringify(reasoningEffort)}`);
  }
  const prompt = isResume ? options.prompt : [REVIEWER_SYSTEM_PROMPT, "", options.prompt].join("\n");
  return {
    command: "codex",
    args,
    prompt
  };
}
async function runReviewerWithCodexCli(options) {
  const sessionId = options.resumeSessionId ?? `codex-review-${nanoid(8)}`;
  const tempDir = (0, import_fs5.mkdtempSync)((0, import_path5.join)((0, import_os5.tmpdir)(), "openclaw-harness-review-"));
  const outputFile = (0, import_path5.join)(tempDir, "last-message.txt");
  const normalizedModel = normalizeCodexModel(options.model);
  const command = buildCodexReviewerCommand({
    workdir: options.workdir,
    outputFile,
    model: normalizedModel,
    prompt: options.prompt,
    reasoningEffort: options.reasoningEffort,
    resumeSessionId: options.resumeSessionId
  });
  try {
    const { output, codexSessionId } = await runCommand(command, options.timeoutMs ?? DEFAULT_TIMEOUT_MS, options.workdir, outputFile);
    return {
      sessionId: codexSessionId ?? sessionId,
      output,
      model: normalizedModel
    };
  } finally {
    try {
      (0, import_fs5.rmSync)(tempDir, { recursive: true, force: true });
    } catch {
    }
  }
}
async function runCommand(command, timeoutMs, workdir, outputFile) {
  return new Promise((resolve6, reject) => {
    const child = (0, import_child_process2.spawn)(command.command, command.args, {
      cwd: workdir,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let hardKillTimer = null;
    const finish = (err, output) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (hardKillTimer) clearTimeout(hardKillTimer);
      if (err) {
        reject(err);
        return;
      }
      const sessionMatch = stderr.match(/session id:\s*([0-9a-f-]{36})/i);
      resolve6({ output: output ?? "", codexSessionId: sessionMatch?.[1] });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      hardKillTimer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
        }
      }, 5e3);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      finish(error);
    });
    child.on("close", (code, signal) => {
      const finalOutput = readCodexOutput(outputFile, stdout);
      if (code === 0) {
        finish(void 0, finalOutput);
        return;
      }
      if (timedOut && finalOutput) {
        console.warn(`[harness] Reviewer Codex CLI exceeded timeout (${timeoutMs}ms) but produced final output; salvaging result.`);
        finish(void 0, finalOutput);
        return;
      }
      const details = [
        timedOut ? `Reviewer Codex CLI timed out after ${timeoutMs}ms${signal ? ` (signal ${signal})` : ""}.` : `Reviewer Codex CLI exited with code ${code ?? "unknown"}${signal ? ` (signal ${signal})` : ""}.`,
        stderr.trim(),
        stdout.trim()
      ].filter(Boolean).join("\n\n");
      finish(new Error(details || "Reviewer Codex CLI failed."), finalOutput);
    });
    child.stdin.end(command.prompt);
  });
}
function readCodexOutput(outputFile, stdout) {
  if ((0, import_fs5.existsSync)(outputFile)) {
    const saved = (0, import_fs5.readFileSync)(outputFile, "utf8").trim();
    if (saved) return saved;
  }
  return stdout.trim();
}

// src/reviewer-openrouter.ts
var DEFAULT_TIMEOUT_MS2 = 12e4;
var OPENROUTER_ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
var ZAI_CODING_ENDPOINT = "https://api.z.ai/api/coding/paas/v4/chat/completions";
function resolveEndpoint() {
  if (pluginConfig.consensusReviewerEndpoint) {
    return pluginConfig.consensusReviewerEndpoint;
  }
  const key = pluginConfig.consensusReviewerApiKey ?? pluginConfig.openRouterApiKey ?? "";
  if (key.startsWith("sk-or-")) return OPENROUTER_ENDPOINT;
  return ZAI_CODING_ENDPOINT;
}
function resolveApiKey() {
  return pluginConfig.consensusReviewerApiKey ?? pluginConfig.openRouterApiKey;
}
async function runReviewerWithSecondaryApi(options) {
  const apiKey = resolveApiKey();
  if (!apiKey) {
    throw new Error("No API key configured for secondary reviewer (consensusReviewerApiKey or openRouterApiKey)");
  }
  const endpoint = resolveEndpoint();
  const model = options.model ?? pluginConfig.consensusReviewerModel ?? "glm-5.1";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS2;
  const body = JSON.stringify({
    model,
    messages: [
      { role: "system", content: REVIEWER_SYSTEM_PROMPT },
      { role: "user", content: options.prompt }
    ],
    max_tokens: 2e3,
    temperature: 0
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    };
    if (endpoint === OPENROUTER_ENDPOINT) {
      headers["HTTP-Referer"] = "https://openclaw.ai";
      headers["X-Title"] = "OpenClaw Harness Reviewer";
    }
    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body,
      signal: controller.signal
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      throw new Error(`Secondary reviewer API ${res.status}: ${errText.slice(0, 300)}`);
    }
    const data = await res.json();
    const output = data?.choices?.[0]?.message?.content ?? "";
    return { output, model };
  } catch (err) {
    if (err.name === "AbortError") {
      return { output: "", model, error: `Secondary reviewer timeout after ${timeoutMs}ms` };
    }
    return { output: "", model, error: err?.message ?? String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// src/reviewer-consensus.ts
async function runReviewerConsensus(options) {
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const secondaryModel = pluginConfig.consensusReviewerModel;
  const reasoningEffort = pluginConfig.reviewerReasoningEffort;
  const prompt = buildReviewRequest(
    options.task,
    options.workerResult,
    options.originalRequest,
    options.reviewLoopState
  );
  const primaryPromise = runReviewerWithCodexCli({
    prompt,
    workdir: options.workdir,
    model: reviewModel,
    reasoningEffort,
    resumeSessionId: options.resumeSessionId
  }).then((run) => ({
    output: run.output,
    sessionId: run.sessionId,
    error: null
  })).catch((err) => ({
    output: "",
    sessionId: "",
    error: err?.message ?? String(err)
  }));
  const hasOpenRouter = !!pluginConfig.openRouterApiKey;
  let secondaryPromise = null;
  if (hasOpenRouter && secondaryModel) {
    secondaryPromise = runReviewerWithSecondaryApi({
      prompt,
      model: secondaryModel
    }).then((run) => ({
      output: run.output,
      sessionId: `openrouter-${run.model}`,
      error: run.error ?? null
    })).catch((err) => ({
      output: "",
      sessionId: "",
      error: err?.message ?? String(err)
    }));
  }
  const [primaryRaw, secondaryRaw] = await Promise.all([
    primaryPromise,
    secondaryPromise ?? Promise.resolve(null)
  ]);
  const primaryResult = primaryRaw.error ? null : parseReviewOutput(primaryRaw.output, options.task.id);
  const secondaryResult = secondaryRaw && !secondaryRaw.error ? parseReviewOutput(secondaryRaw.output, options.task.id) : null;
  if (primaryResult && secondaryResult) {
    const bothPass = primaryResult.result === "pass" && secondaryResult.result === "pass";
    const bothFail = primaryResult.result === "fail" && secondaryResult.result === "fail";
    if (bothPass) {
      console.log(`[consensus] Both reviewers pass for ${options.task.id}`);
      return { primary: primaryResult, secondary: secondaryResult, consensus: primaryResult, mode: "both", primarySessionId: primaryRaw.sessionId };
    }
    if (bothFail) {
      const mergedGaps = [...primaryResult.gaps];
      for (const gap of secondaryResult.gaps) {
        if (!mergedGaps.some((g) => g.type === gap.type && g.evidence === gap.evidence)) {
          mergedGaps.push(gap);
        }
      }
      const merged = {
        ...primaryResult,
        gaps: mergedGaps
      };
      console.log(`[consensus] Both reviewers fail for ${options.task.id}: ${mergedGaps.length} merged gaps`);
      return { primary: primaryResult, secondary: secondaryResult, consensus: merged, mode: "both", primarySessionId: primaryRaw.sessionId };
    }
    const failResult = primaryResult.result === "fail" ? primaryResult : secondaryResult;
    console.log(`[consensus] Reviewer disagreement for ${options.task.id}: primary=${primaryResult.result}, secondary=${secondaryResult.result} \u2192 using fail`);
    return { primary: primaryResult, secondary: secondaryResult, consensus: failResult, mode: "both", primarySessionId: primaryRaw.sessionId };
  }
  if (primaryResult) {
    if (secondaryRaw?.error) {
      console.warn(`[consensus] Secondary reviewer failed: ${secondaryRaw.error}`);
    }
    return { primary: primaryResult, secondary: null, consensus: primaryResult, mode: "primary-only", primarySessionId: primaryRaw.sessionId };
  }
  if (secondaryResult) {
    console.warn(`[consensus] Primary reviewer failed: ${primaryRaw.error}`);
    return { primary: secondaryResult, secondary: null, consensus: secondaryResult, mode: "secondary-only", primarySessionId: void 0 };
  }
  console.error(`[consensus] Both reviewers failed: primary=${primaryRaw.error}, secondary=${secondaryRaw?.error}`);
  const fallback = {
    taskId: options.task.id,
    result: "fail",
    gaps: [],
    rerunNeeded: true,
    retryReviewer: true
  };
  return { primary: fallback, secondary: null, consensus: fallback, mode: "primary-only", primarySessionId: void 0 };
}

// src/workspace-isolation.ts
var import_fs6 = require("fs");
var import_child_process3 = require("child_process");
var import_os6 = require("os");
var import_path6 = require("path");
function runGit(cwd, args, input) {
  return (0, import_child_process3.execFileSync)("git", args, {
    cwd,
    encoding: "utf8",
    stdio: input == null ? ["ignore", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    input
  }).trim();
}
function readGitPatch(cwd, args) {
  return (0, import_child_process3.execFileSync)("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
function getRepoRoot(workdir) {
  try {
    return runGit(workdir, ["rev-parse", "--show-toplevel"]);
  } catch {
    return null;
  }
}
function hasDirtyWorktree(repoRoot) {
  try {
    const status = runGit(repoRoot, ["status", "--porcelain"]);
    return status.trim().length > 0;
  } catch {
    return false;
  }
}
function hasHeadCommit(repoRoot) {
  try {
    runGit(repoRoot, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}
var PROJECT_CONTEXT_FILES = [
  "CLAUDE.md",
  "AGENTS.md"
];
function copyFileIntoClone(repoRoot, cloneDir, relativePath) {
  const source = (0, import_path6.join)(repoRoot, relativePath);
  if (!(0, import_fs6.existsSync)(source)) return;
  const target = (0, import_path6.join)(cloneDir, relativePath);
  (0, import_fs6.mkdirSync)((0, import_path6.dirname)(target), { recursive: true });
  (0, import_fs6.cpSync)(source, target, { recursive: true, dereference: false });
}
function copyUntrackedFiles(repoRoot, cloneDir) {
  let output = "";
  try {
    output = (0, import_child_process3.execFileSync)("git", ["ls-files", "--others", "--exclude-standard", "-z"], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch {
    output = "";
  }
  const copied = /* @__PURE__ */ new Set();
  const paths = output.split("\0").map((value) => value.trim()).filter(Boolean);
  for (const relativePath of paths) {
    copyFileIntoClone(repoRoot, cloneDir, relativePath);
    copied.add(relativePath);
  }
  for (const relativePath of PROJECT_CONTEXT_FILES) {
    if (copied.has(relativePath)) continue;
    copyFileIntoClone(repoRoot, cloneDir, relativePath);
  }
}
function copyWorkingTreeContents(repoRoot, cloneDir) {
  for (const entry of (0, import_fs6.readdirSync)(repoRoot, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    (0, import_fs6.cpSync)((0, import_path6.join)(repoRoot, entry.name), (0, import_path6.join)(cloneDir, entry.name), {
      recursive: true,
      dereference: false
    });
  }
}
function configureSnapshotGitIdentity(repoRoot) {
  runGit(repoRoot, ["config", "user.name", "OpenClaw Harness"]);
  runGit(repoRoot, ["config", "user.email", "harness@openclaw.local"]);
}
var EXECUTION_WORKSPACE_ROOT = (0, import_path6.join)((0, import_os6.homedir)(), ".openclaw", "harness-execution-workspaces");
function isolationStatePath(planId) {
  return (0, import_path6.join)(EXECUTION_WORKSPACE_ROOT, "state", `${planId}.json`);
}
function writeIsolationState(repoRoot, planId, executionWorkdir, cleanupRoot) {
  const statePath = isolationStatePath(planId);
  (0, import_fs6.mkdirSync)((0, import_path6.dirname)(statePath), { recursive: true });
  (0, import_fs6.writeFileSync)(
    statePath,
    JSON.stringify({
      planId,
      repoRoot,
      executionWorkdir,
      cleanupRoot,
      createdAt: (/* @__PURE__ */ new Date()).toISOString()
    }, null, 2) + "\n",
    "utf8"
  );
  return statePath;
}
function readIsolationState(planId) {
  const statePath = isolationStatePath(planId);
  try {
    if (!(0, import_fs6.existsSync)(statePath)) return null;
    const parsed = JSON.parse((0, import_fs6.readFileSync)(statePath, "utf8"));
    if (!parsed?.executionWorkdir || !parsed?.repoRoot) return null;
    return parsed;
  } catch {
    return null;
  }
}
function prepareExecutionWorkspace(originalWorkdir, planId) {
  const resolvedWorkdir = (0, import_path6.resolve)(originalWorkdir);
  const repoRoot = getRepoRoot(resolvedWorkdir);
  if (!repoRoot || !hasDirtyWorktree(repoRoot)) {
    return {
      originalWorkdir: resolvedWorkdir,
      executionWorkdir: resolvedWorkdir,
      isolated: false
    };
  }
  const existingState = readIsolationState(planId);
  if (existingState && (0, import_path6.resolve)(existingState.repoRoot) === repoRoot && (0, import_fs6.existsSync)(existingState.executionWorkdir)) {
    return {
      originalWorkdir: resolvedWorkdir,
      executionWorkdir: existingState.executionWorkdir,
      isolated: true,
      statePath: isolationStatePath(planId),
      cleanupPath: existingState.cleanupRoot
    };
  }
  (0, import_fs6.mkdirSync)(EXECUTION_WORKSPACE_ROOT, { recursive: true });
  const tempRoot = (0, import_fs6.mkdtempSync)((0, import_path6.join)(EXECUTION_WORKSPACE_ROOT, `${planId}-`));
  const tempDir = (0, import_path6.join)(tempRoot, (0, import_path6.basename)(repoRoot));
  const repoHasHead = hasHeadCommit(repoRoot);
  runGit(process.cwd(), ["clone", "--quiet", repoRoot, tempDir]);
  configureSnapshotGitIdentity(tempDir);
  if (repoHasHead) {
    runGit(tempDir, ["reset", "--hard", "HEAD"]);
    const trackedPatch = readGitPatch(repoRoot, ["diff", "--binary", "HEAD"]);
    if (trackedPatch.trim()) {
      (0, import_child_process3.execFileSync)("git", ["apply", "--binary", "-"], {
        cwd: tempDir,
        input: trackedPatch,
        stdio: ["pipe", "pipe", "pipe"]
      });
    }
    copyUntrackedFiles(repoRoot, tempDir);
  } else {
    copyWorkingTreeContents(repoRoot, tempDir);
  }
  runGit(tempDir, ["add", "-A"]);
  try {
    runGit(tempDir, ["commit", "--quiet", "--no-gpg-sign", "-m", `harness: dirty snapshot ${planId}`]);
  } catch {
  }
  const statePath = writeIsolationState(repoRoot, planId, tempDir, tempRoot);
  return {
    originalWorkdir: resolvedWorkdir,
    executionWorkdir: tempDir,
    isolated: true,
    statePath,
    cleanupPath: tempRoot
  };
}
function materializeExecutionWorkspace(prepared) {
  if (!prepared.isolated) return { applied: false };
  const lockPath = (0, import_path6.join)(prepared.executionWorkdir, ".git", "index.lock");
  if ((0, import_fs6.existsSync)(lockPath)) {
    try {
      (0, import_fs6.rmSync)(lockPath, { force: true });
    } catch {
    }
  }
  runGit(prepared.executionWorkdir, ["add", "-A"]);
  const patch = readGitPatch(prepared.executionWorkdir, ["diff", "--binary", "HEAD"]);
  if (!patch.trim()) {
    try {
      (0, import_fs6.rmSync)(prepared.cleanupPath ?? prepared.executionWorkdir, { recursive: true, force: true });
    } catch {
    }
    if (prepared.statePath) {
      try {
        (0, import_fs6.rmSync)(prepared.statePath, { force: true });
      } catch {
      }
    }
    return { applied: true };
  }
  const patchPath = (0, import_path6.join)(prepared.executionWorkdir, "worker-delta.patch");
  (0, import_fs6.writeFileSync)(patchPath, patch, "utf8");
  try {
    (0, import_child_process3.execFileSync)("git", ["apply", "--binary", patchPath], {
      cwd: prepared.originalWorkdir,
      stdio: ["ignore", "pipe", "pipe"]
    });
  } catch (plainError) {
    try {
      (0, import_child_process3.execFileSync)("git", ["apply", "--3way", "--binary", patchPath], {
        cwd: prepared.originalWorkdir,
        stdio: ["ignore", "pipe", "pipe"]
      });
    } catch (error) {
      return {
        applied: false,
        patchPath,
        error: error?.message ?? plainError?.message ?? String(error)
      };
    }
  }
  try {
    (0, import_fs6.rmSync)(prepared.cleanupPath ?? prepared.executionWorkdir, { recursive: true, force: true });
  } catch {
  }
  if (prepared.statePath) {
    try {
      (0, import_fs6.rmSync)(prepared.statePath, { force: true });
    } catch {
    }
  }
  return {
    applied: true,
    patchPath
  };
}

// src/tools/harness-execute.ts
function makeHarnessExecuteTool(ctx) {
  return {
    name: "harness_execute",
    description: "Primary path for coding tasks. Execute a coding task through the Plan-Work-Review harness. Automatically classifies complexity, decomposes tasks, dispatches workers, and runs cross-model review. Returns a structured result with gaps detected.",
    parameters: Type.Object({
      request: Type.String({
        description: "The coding task to execute (natural language)"
      }),
      workdir: Type.Optional(
        Type.String({ description: "Working directory for the task" })
      ),
      tier_override: Type.Optional(
        Type.Union(
          [Type.Literal(0), Type.Literal(1), Type.Literal(2)],
          { description: "Override automatic tier classification" }
        )
      ),
      max_budget_usd: Type.Optional(
        Type.Number({ description: "Maximum budget in USD (default from config)" })
      ),
      reviewOnly: Type.Optional(
        Type.Boolean({ description: "Skip planner/worker and review existing local changes only" })
      )
    }),
    async execute(_id, params) {
      const activeSessionManager = getSessionManager();
      if (!activeSessionManager) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: "Error: SessionManager not initialized. The harness service must be running."
          }]
        };
      }
      const workdir = params.workdir || ctx.workspaceDir || pluginConfig.defaultWorkdir || process.cwd();
      const mode = "autonomous";
      const maxBudgetUsd = params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5;
      if (params.reviewOnly) {
        return await executeReviewOnly(params.request, workdir, ctx);
      }
      const autoResumeCheckpoint = findRecoverableCheckpoint(params.request, workdir);
      const route = await classifyRequest(params.request);
      const routerTier = params.tier_override ?? route.tier;
      console.log(`[harness] Route: tier=${routerTier}, confidence=${route.confidence}, reason=${route.reason}`);
      if (routerTier >= 1 && isAnalysisOnlyRequest(params.request)) {
        return {
          content: [{
            type: "text",
            text: [
              `## Harness: Analysis Mode (read-only)`,
              ``,
              `Request detected as analysis/review \u2014 no file modifications.`,
              `Execute this analysis directly without spawning a worker.`,
              ``,
              `**Request:** ${params.request}`,
              `**Workdir:** ${workdir}`
            ].join("\n")
          }]
        };
      }
      const existingCheckpoint = autoResumeCheckpoint;
      if (existingCheckpoint) {
        const hasActiveWork = Object.keys(existingCheckpoint.sessions ?? {}).length > 0 && existingCheckpoint.tasks.some(
          (t) => t.status === "in-progress" || t.status === "in-review"
        );
        if (existingCheckpoint.status === "running" && hasActiveWork) {
          console.log(`[harness] Existing run still active: ${existingCheckpoint.runId} \u2014 skipping duplicate execution`);
          return {
            content: [{
              type: "text",
              text: [
                `## Harness: Already Running`,
                ``,
                `**Plan:** ${existingCheckpoint.runId}`,
                `**Status:** running`,
                `**Tasks:** ${existingCheckpoint.tasks.length}`,
                ``,
                `A background run for this request is already in progress. Results will be pushed when complete.`,
                `Monitor: \`cat /tmp/harness/${existingCheckpoint.runId}/checkpoint.json\``
              ].join("\n")
            }]
          };
        }
        console.log(`[harness] Auto-resuming recoverable checkpoint: ${existingCheckpoint.runId}`);
        const plan2 = existingCheckpoint.plan;
        const runState = buildExecutionRunState(existingCheckpoint);
        if (runState.mode === "resumed" && existingCheckpoint.status !== "complete") {
          existingCheckpoint.status = "running";
          existingCheckpoint.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
          saveCheckpoint(existingCheckpoint, workdir);
          console.log(
            `[harness] Resuming checkpoint ${existingCheckpoint.runId}: skippedCompleted=${runState.skippedCompletedTaskIds.length}, remaining=${runState.resumedTaskIds.length}`
          );
        }
        const preparedWorkspace2 = plan2.tier > 0 ? prepareExecutionWorkspace(workdir, plan2.id) : { originalWorkdir: workdir, executionWorkdir: workdir, isolated: false };
        const taskResults = await executePlan(plan2, preparedWorkspace2.executionWorkdir, maxBudgetUsd, ctx, existingCheckpoint);
        const materialized = plan2.tier > 0 ? materializeExecutionWorkspace(preparedWorkspace2) : null;
        return {
          content: [{
            type: "text",
            text: formatFinalResult(plan2, route, taskResults, mode, existingCheckpoint, runState, materialized)
          }]
        };
      }
      if (routerTier === 0) {
        return {
          content: [{
            type: "text",
            text: [
              `## Harness: Tier 0 \u2014 Direct Execution`,
              ``,
              `Simple config/doc/patch task. Execute directly without spawning a worker.`,
              ``,
              `**Request:** ${params.request}`,
              `**Workdir:** ${workdir}`,
              `**Route reason:** ${route.reason}`
            ].join("\n")
          }]
        };
      }
      const memoryContext = await loadPlanningMemory(workdir);
      const plan = await createExecutionPlan(params.request, routerTier, memoryContext, workdir);
      const effectiveTier = Math.min(routerTier, plan.tier);
      if (effectiveTier !== plan.tier) {
        console.log(`[harness] effectiveTier override: planner=${plan.tier} \u2192 effective=${effectiveTier} (router=${routerTier})`);
        plan.tier = effectiveTier;
      }
      console.log(`[harness] Plan: id=${plan.id}, tasks=${plan.tasks.length}, mode=${plan.mode}, effectiveTier=${effectiveTier}`);
      const preparedWorkspace = prepareExecutionWorkspace(workdir, plan.id);
      const checkpoint = initCheckpoint(plan, workdir, preparedWorkspace.executionWorkdir);
      const notificationChannel = ctx.messageChannel;
      void (async () => {
        try {
          const taskResults = await executePlan(plan, preparedWorkspace.executionWorkdir, maxBudgetUsd, ctx, checkpoint);
          const materialized = materializeExecutionWorkspace(preparedWorkspace);
          const finalText = formatFinalResult(plan, route, taskResults, mode, checkpoint, freshExecutionRunState(), materialized);
          await sendHarnessNotification(notificationChannel, ctx, `\uC644\uB8CC \u2014 plan ${plan.id}

${finalText}`);
          console.log(`[harness] Background run complete: plan=${plan.id}, tasks=${taskResults.length}`);
        } catch (err) {
          const errorMsg = `\uD558\uB124\uC2A4 \uC2E4\uD328 \u2014 plan ${plan.id}: ${err?.message ?? String(err)}`;
          await sendHarnessNotification(notificationChannel, ctx, errorMsg);
          console.error(`[harness] Background run failed: plan=${plan.id}`, err);
        }
      })();
      return {
        content: [{
          type: "text",
          text: [
            `## Harness: Started (async)`,
            ``,
            `**Plan:** ${plan.id}`,
            `**Tasks:** ${plan.tasks.length} (${plan.mode})`,
            `**Tier:** ${effectiveTier} | **Route:** ${route.confidence}`,
            `**Workdir:** ${workdir}`,
            ``,
            `Worker is running in background. Results will be pushed to your channel when complete.`,
            `Monitor: \`cat /tmp/harness/${plan.id}/checkpoint.json\``
          ].join("\n")
        }]
      };
    }
  };
}
async function loadPlanningMemory(workdir) {
  try {
    return await searchMemory((0, import_path7.basename)(workdir) || "project");
  } catch {
    return "";
  }
}
async function createExecutionPlan(request, tier, memoryContext, workdir) {
  return await buildModelPlan(request, memoryContext, workdir, void 0, tier);
}
async function executeReviewOnly(request, workdir, ctx) {
  const { changedFiles, diffStat } = await collectLocalChanges(workdir);
  if (changedFiles.length === 0) {
    return {
      isError: true,
      content: [{
        type: "text",
        text: `Error: No local changes found in ${workdir}. Nothing to review.`
      }]
    };
  }
  const taskId = "review-1";
  const planId = `review-${(/* @__PURE__ */ new Date()).toISOString().slice(0, 10).replace(/-/g, "")}-${Math.random().toString(36).slice(2, 8)}`;
  const task = {
    id: taskId,
    title: request.slice(0, 120),
    scope: workdir,
    acceptanceCriteria: [request],
    agent: "codex"
  };
  const syntheticWorkerResult = {
    taskId,
    status: "completed",
    summary: diffStat || `${changedFiles.length} file(s) changed locally`,
    filesChanged: changedFiles,
    testsRun: 0,
    warnings: []
  };
  const plan = {
    id: planId,
    originalRequest: request,
    tasks: [task],
    mode: "solo",
    estimatedComplexity: "low",
    tier: 0
  };
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const reviewerReasoningEffort = pluginConfig.reviewerReasoningEffort;
  const reviewerTarget = resolveReviewerExecutionTarget(reviewModel, pluginConfig.defaultModel);
  const reviewLoop = initReviewLoop(taskId);
  let reviewResult = null;
  let reviewerRetryCount = 0;
  while (true) {
    const consensusResult = await runReviewerConsensus({
      task,
      workerResult: syntheticWorkerResult,
      originalRequest: request,
      reviewLoopState: reviewLoop,
      workdir
    });
    console.log(`[harness] Review-only consensus done: mode=${consensusResult.mode}, result=${consensusResult.consensus.result}, retry=${reviewerRetryCount}`);
    reviewResult = consensusResult.consensus;
    if (!reviewResult.retryReviewer) break;
    reviewerRetryCount++;
    if (reviewerRetryCount >= 3) {
      return {
        isError: true,
        content: [{
          type: "text",
          text: `Error: Reviewer output could not be parsed after 3 attempts in review-only mode.`
        }]
      };
    }
    console.warn(`[harness] Review-only reviewer output malformed: retry=${reviewerRetryCount}/3`);
  }
  if (!reviewResult) {
    throw new Error("Reviewer result missing after retry loop");
  }
  const action = processReviewResult(reviewLoop, reviewResult);
  return {
    content: [{
      type: "text",
      text: formatReviewOnlyResult(plan, syntheticWorkerResult, reviewResult, reviewLoop, action.action)
    }]
  };
}
async function collectLocalChanges(workdir) {
  const [diffNames, diffStat] = await Promise.all([
    execFileCapture("git", ["diff", "--name-only", "HEAD"], workdir, 15e3).catch(() => execFileCapture("git", ["diff", "--name-only"], workdir, 15e3)).catch(() => ({ exitCode: 1, stdout: "", stderr: "" })),
    execFileCapture("git", ["diff", "--stat", "HEAD"], workdir, 15e3).catch(() => execFileCapture("git", ["diff", "--stat"], workdir, 15e3)).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }))
  ]);
  const untracked = await execFileCapture(
    "git",
    ["ls-files", "--others", "--exclude-standard"],
    workdir,
    15e3
  ).catch(() => ({ exitCode: 1, stdout: "", stderr: "" }));
  const changedFiles = [
    ...diffNames.stdout.trim().split("\n").filter(Boolean),
    ...untracked.stdout.trim().split("\n").filter(Boolean)
  ];
  const uniqueFiles = [...new Set(changedFiles)];
  return {
    changedFiles: uniqueFiles,
    diffStat: diffStat.stdout.trim()
  };
}
function formatReviewOnlyResult(plan, workerResult, reviewResult, reviewLoop, action) {
  const passed = reviewResult.result === "pass";
  const lines = [
    `## Harness: Review Only \u2014 ${passed ? "Pass" : "Gaps Found"}`,
    ``,
    `**Mode:** review-only | **Plan:** ${plan.id}`,
    `**Changed files:** ${workerResult.filesChanged.length}`,
    `**Review loops:** ${reviewLoop.history.length}`,
    `**Result:** ${reviewResult.result}${reviewResult.gaps.length > 0 ? ` (${reviewResult.gaps.length} gap${reviewResult.gaps.length > 1 ? "s" : ""})` : ""}`,
    ``,
    `### Changed Files`,
    ...workerResult.filesChanged.map((f) => `- ${f}`),
    ``,
    `### Review Result`
  ];
  if (passed) {
    lines.push(`No gaps detected. All acceptance criteria appear to be met.`);
  } else {
    for (const gap of reviewResult.gaps) {
      lines.push(`- **${gap.type}:** ${gap.evidence}`);
      if (gap.fixHint) lines.push(`  Fix hint: ${gap.fixHint}`);
    }
  }
  return lines.join("\n");
}
var REALTIME_STATE_ROOT = (0, import_path7.join)("/tmp", "claude-realtime");
var REALTIME_SCRIPT_PATH = (0, import_path7.join)(
  (0, import_os7.homedir)(),
  ".openclaw",
  "workspace-nova",
  "scripts",
  "claude-realtime.sh"
);
var GIT_SYNC_SCRIPT_PATH = (0, import_path7.join)(
  (0, import_os7.homedir)(),
  ".openclaw",
  "workspace-nova",
  "scripts",
  "git-sync.sh"
);
var REALTIME_REMOTE_HOST = process.env.OPENCLAW_REALTIME_REMOTE_HOST || "hetzner-build";
var REALTIME_EMBEDDED_PLAN_REVIEW_ENV = "OPENCLAW_HARNESS_EMBEDDED_PLAN_REVIEW";
var REALTIME_LAUNCH_TIMEOUT_MS = 9e4;
var REALTIME_PULL_TIMEOUT_MS = 18e4;
var REALTIME_POLL_INTERVAL_MS = 5e3;
var REALTIME_MAX_WAIT_MS = 2 * 60 * 60 * 1e3 + 5 * 60 * 1e3;
function requireHarnessSessionManager() {
  const activeSessionManager = getSessionManager();
  if (!activeSessionManager) {
    throw new Error("SessionManager not initialized. The harness service must be running.");
  }
  return activeSessionManager;
}
async function executePlan(plan, workdir, maxBudgetUsd, ctx, checkpoint) {
  const resultsByTaskId = /* @__PURE__ */ new Map();
  const tasksToRun = [];
  for (const task of plan.tasks) {
    const completedResult = buildCompletedCheckpointResult(checkpoint, task.id);
    if (completedResult) {
      resultsByTaskId.set(task.id, completedResult);
      continue;
    }
    tasksToRun.push(task);
  }
  if (tasksToRun.length === 0) {
    return plan.tasks.map((task) => resultsByTaskId.get(task.id)).filter((result) => result != null);
  }
  const budgetPerTask = maxBudgetUsd / tasksToRun.length;
  if (plan.mode === "parallel" && tasksToRun.length > 1) {
    let i = 0;
    while (i < tasksToRun.length) {
      const hasSlot = await requireHarnessSessionManager().waitForSlot();
      if (!hasSlot) {
        for (let j = i; j < tasksToRun.length; j++) {
          resultsByTaskId.set(tasksToRun[j].id, {
            taskId: tasksToRun[j].id,
            workerSessionId: "",
            workerResult: null,
            reviewPassed: false,
            reviewLoops: 0,
            escalated: true,
            error: "No session slots available (timeout)"
          });
        }
        break;
      }
      const batchSize = Math.max(1, Math.floor(requireHarnessSessionManager().availableSlots() / 2));
      const batch = tasksToRun.slice(i, i + batchSize);
      const batchPromises = batch.map(
        (task) => executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint).catch((err) => ({
          taskId: task.id,
          workerSessionId: "",
          workerResult: null,
          reviewPassed: false,
          reviewLoops: 0,
          escalated: true,
          error: err?.message ?? String(err)
        }))
      );
      i += batch.length;
      const batchResults = await Promise.all(batchPromises);
      for (const result of batchResults) {
        resultsByTaskId.set(result.taskId, result);
      }
      if (i < tasksToRun.length) {
        await Promise.allSettled(batchPromises);
      }
    }
  } else {
    for (const task of tasksToRun) {
      const result = await executeTask(task, plan, workdir, budgetPerTask, ctx, checkpoint);
      resultsByTaskId.set(task.id, result);
      if (plan.mode === "sequential" && !result.reviewPassed) {
        break;
      }
    }
  }
  return plan.tasks.map((task) => resultsByTaskId.get(task.id)).filter((result) => result != null);
}
async function executeTask(task, plan, workdir, budgetUsd, ctx, checkpoint) {
  const activeSessionManager = requireHarnessSessionManager();
  const workerModel = pluginConfig.realtimeModel ?? pluginConfig.workerModel ?? "claude";
  const workerEffort = pluginConfig.workerEffort;
  const reviewModel = pluginConfig.reviewModel ?? "codex";
  const reviewerReasoningEffort = pluginConfig.reviewerReasoningEffort;
  const useBackendDispatch = plan.tier >= 1;
  const backend = useBackendDispatch ? resolveWorkerBackend(pluginConfig) : null;
  const isRealtimeBackend = backend?.name === "remote-realtime";
  if (backend && !backend.available()) {
    updateTaskStatus(checkpoint, task.id, "failed", workdir);
    return {
      taskId: task.id,
      workerSessionId: "",
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: `Worker backend "${backend.name}" is not available: ${backend.describe()}`
    };
  }
  const reviewerTarget = resolveReviewerExecutionTarget(
    reviewModel,
    pluginConfig.defaultModel
  );
  const maxLoops = Math.max(0, pluginConfig.maxReviewLoops);
  const workerBudget = budgetUsd * 0.5;
  let remainingBudget = budgetUsd * 0.5;
  const totalPhases = maxLoops === 0 ? 1 : 1 + 2 * maxLoops;
  const perPhaseBudget = remainingBudget / totalPhases;
  let workerSessionId = "";
  const totalReviewLoops = (outerLoops) => outerLoops + (isRealtimeBackend ? getRealtimeImplementationReviewLoops(workerSessionId) : 0);
  try {
    resetCheckpointTaskForRetry(checkpoint, task.id);
    updateTaskStatus(checkpoint, task.id, "in-progress", workdir);
    const workerPrompt = buildWorkerPrompt(task, plan);
    let workerResult = null;
    if (useBackendDispatch && backend) {
      const existingJobId = checkpoint.sessions[task.id]?.worker ?? "";
      const recoveredResult = isRealtimeBackend && existingJobId ? recoverCompletedRealtimeWorkerResult(task.id, existingJobId) : null;
      if (recoveredResult) {
        workerSessionId = existingJobId;
        workerResult = recoveredResult;
        console.log(
          `[harness] Recovered completed worker from checkpoint: task=${task.id}, jobId=${workerSessionId}, backend=${backend.name}`
        );
      } else {
        workerSessionId = existingJobId || buildRealtimeJobId(plan.id, task.id);
        recordSession(checkpoint, task.id, "worker", workerSessionId, workdir);
        const backendCtx = {
          task,
          plan,
          workdir,
          ctx,
          workerModel,
          workerEffort,
          jobId: workerSessionId
        };
        const backendResult = await backend.executeWorker(backendCtx);
        if (!isRealtimeReviewReadyStatus(backendResult.status) || !backendResult.workerResult) {
          updateTaskStatus(checkpoint, task.id, "failed", workdir, {
            workerResult: backendResult.workerResult ?? void 0
          });
          const backendError = backendResult.errorDetail ?? backendResult.error ?? `Worker job ${workerSessionId} ended with status=${backendResult.status}`;
          return {
            taskId: task.id,
            workerSessionId,
            workerResult: backendResult.workerResult,
            reviewPassed: false,
            reviewLoops: 0,
            escalated: true,
            error: isRealtimeBackend ? formatRealtimeFailureForCaller(ctx, workdir, backendError) : backendError
          };
        }
        workerResult = backendResult.workerResult;
      }
    } else {
      console.warn(`[harness] Fallback to sessionManager.spawn (tier 0 / no realtime)`);
      const workerSession = activeSessionManager.spawn({
        prompt: workerPrompt,
        name: `harness-${plan.id}-${task.id}`,
        workdir,
        model: workerModel,
        maxBudgetUsd: workerBudget,
        permissionMode: pluginConfig.permissionMode ?? "bypassPermissions",
        originChannel: ctx.messageChannel,
        originAgentId: ctx.agentId,
        multiTurn: false
      });
      workerSessionId = workerSession.id;
      workerResult = await waitForCompletion(workerSession.id, task.id);
    }
    recordSession(checkpoint, task.id, "worker", workerSessionId, workdir);
    console.log(
      `[harness] Worker done: task=${task.id}, session=${workerSessionId}, model=${workerModel}, backend=${backend?.name ?? "session-fallback"}`
    );
    if (!workerResult) {
      updateTaskStatus(checkpoint, task.id, "failed", workdir);
      return {
        taskId: task.id,
        workerSessionId,
        workerResult: null,
        reviewPassed: false,
        reviewLoops: 0,
        escalated: true,
        error: "Worker session did not produce a result"
      };
    }
    updateTaskStatus(checkpoint, task.id, "completed", workdir, {
      reviewPassed: true,
      reviewLoop: totalReviewLoops(0),
      workerResult
    });
    return {
      taskId: task.id,
      workerSessionId,
      workerResult,
      reviewPassed: true,
      reviewLoops: totalReviewLoops(0),
      escalated: false
    };
  } catch (err) {
    updateTaskStatus(checkpoint, task.id, "failed", workdir);
    const detailedError = `${err.message}
${err.stack ?? ""}`;
    return {
      taskId: task.id,
      workerSessionId,
      workerResult: null,
      reviewPassed: false,
      reviewLoops: 0,
      escalated: true,
      error: isRealtimeBackend ? formatRealtimeFailureForCaller(ctx, workdir, detailedError) : detailedError
    };
  } finally {
  }
}
async function executeRealtimeTask(task, plan, workdir, ctx, workerModel, workerEffort, jobId) {
  const resolvedWorkdir = (0, import_path7.resolve)(workdir);
  assertRealtimeProjectContext(resolvedWorkdir);
  const spec = buildRealtimeSpec(task, plan, resolvedWorkdir);
  const realtimeModel = resolveRealtimeModel(workerModel);
  const notifyAgent = resolveRealtimeNotifyAgent(ctx, resolvedWorkdir);
  console.log(
    `[harness] Realtime worker invoking claude-realtime.sh: script=${REALTIME_SCRIPT_PATH}, jobId=${jobId}, workdir=${resolvedWorkdir}, model=${realtimeModel}, effort=${workerEffort ?? "default"}, notifyAgent=${notifyAgent}`
  );
  const launch = await launchRealtimeJob(spec, resolvedWorkdir, jobId, realtimeModel, workerEffort, notifyAgent);
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, launch.jobId, launch.stateDir, "round-complete");
}
async function continueRealtimeTask(task, plan, workdir, ctx, jobId, feedback) {
  const resolvedWorkdir = (0, import_path7.resolve)(workdir);
  const stateDir = (0, import_path7.join)(REALTIME_STATE_ROOT, jobId);
  await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, feedback);
  console.log(`[harness] Tier 2 follow-up feedback sent: jobId=${jobId}`);
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, jobId, stateDir, "round-complete");
}
async function finalizeRealtimeTask(task, plan, workdir, ctx, jobId) {
  const resolvedWorkdir = (0, import_path7.resolve)(workdir);
  const stateDir = (0, import_path7.join)(REALTIME_STATE_ROOT, jobId);
  const currentStatus = readRealtimeStatus(stateDir);
  if (currentStatus !== "done") {
    await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, "DONE");
    console.log(`[harness] Tier 2 final DONE sent: jobId=${jobId}, previousStatus=${currentStatus ?? "missing"}`);
  }
  return await waitForRealtimeCheckpoint(task, plan, resolvedWorkdir, ctx, jobId, stateDir, "terminal");
}
async function waitForRealtimeCheckpoint(task, plan, workdir, ctx, jobId, stateDir, goal) {
  const terminal = await waitForRealtimeTerminalState(
    stateDir,
    jobId,
    task,
    plan,
    ctx,
    workdir,
    goal
  );
  if (terminal.status === "waiting" || terminal.status === "done") {
    await syncRealtimeWorktreeFromRemote(workdir);
  }
  const workerResult = buildRealtimeWorkerResult(task.id, terminal.status, terminal.summary, terminal.sessionId ?? jobId);
  return {
    jobId,
    stateDir,
    output: terminal.summary,
    status: terminal.status,
    workerResult,
    error: isRealtimeReviewReadyStatus(terminal.status) || terminal.status === "done" ? void 0 : formatRealtimeFailure(jobId, stateDir, terminal.status, terminal.summary)
  };
}
async function launchRealtimeJob(spec, workdir, jobId, model, effort, notifyAgent) {
  if (!(0, import_fs7.existsSync)(REALTIME_SCRIPT_PATH)) {
    throw new Error(`claude-realtime.sh not found at ${REALTIME_SCRIPT_PATH}`);
  }
  const args = [
    REALTIME_SCRIPT_PATH,
    spec,
    workdir,
    "--remote",
    "--bg",
    "--job-id",
    jobId,
    "--model",
    model,
    ...effort ? ["--effort", effort] : [],
    "--notify-agent",
    notifyAgent
  ];
  const launch = await execFileCapture(
    "bash",
    args,
    workdir,
    REALTIME_LAUNCH_TIMEOUT_MS,
    { [REALTIME_EMBEDDED_PLAN_REVIEW_ENV]: "0" }
  );
  const combinedOutput = [launch.stdout, launch.stderr].filter(Boolean).join("\n").trim();
  const stateDir = parseRealtimeStateDir(combinedOutput, jobId);
  if (launch.exitCode !== 0) {
    throw new Error([
      `claude-realtime.sh launch failed (exit ${launch.exitCode})`,
      combinedOutput
    ].filter(Boolean).join("\n"));
  }
  console.log(
    `[harness] Realtime worker launched: jobId=${jobId}, stateDir=${stateDir}, output=${combinedOutput || "(empty)"}`
  );
  return {
    jobId,
    stateDir,
    output: combinedOutput
  };
}
async function execFileCapture(command, args, cwd, timeoutMs = REALTIME_LAUNCH_TIMEOUT_MS, envOverrides) {
  return await new Promise((resolvePromise) => {
    (0, import_child_process4.execFile)(
      command,
      args,
      {
        cwd,
        env: { ...process.env, ...envOverrides ?? {} },
        timeout: timeoutMs,
        maxBuffer: 1024 * 1024
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolvePromise({ exitCode: 0, stdout, stderr });
          return;
        }
        const err = error;
        const errorMessage = err.message?.trim();
        const mergedStderr = errorMessage && !stderr.includes(errorMessage) ? [stderr, errorMessage].filter(Boolean).join("\n") : stderr;
        resolvePromise({
          exitCode: typeof err.code === "number" ? err.code : -1,
          stdout,
          stderr: mergedStderr
        });
      }
    );
  });
}
async function syncRealtimeWorktreeFromRemote(workdir) {
  if (!(0, import_fs7.existsSync)(GIT_SYNC_SCRIPT_PATH)) {
    throw new Error(`git-sync.sh not found at ${GIT_SYNC_SCRIPT_PATH}`);
  }
  const result = await execFileCapture(
    "bash",
    [GIT_SYNC_SCRIPT_PATH, "pull", workdir, "--remote-host", REALTIME_REMOTE_HOST],
    workdir,
    REALTIME_PULL_TIMEOUT_MS,
    { [REALTIME_EMBEDDED_PLAN_REVIEW_ENV]: "0" }
  );
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  if (result.exitCode !== 0) {
    throw new Error(`git-sync pull failed for ${workdir}${output ? `
${output}` : ""}`);
  }
  console.log(
    `[harness] Tier 2 sync pull complete: workdir=${workdir}, remote=${REALTIME_REMOTE_HOST}${output ? `, output=${output}` : ""}`
  );
}
function realtimeCheckpointReviewModeForStatus(status, _stateDir, _goal) {
  return null;
}
function reviewArtifactPrefix(kind, round) {
  return kind === "plan" ? `plan-review-round-${round}` : `implementation-review-round-${round}`;
}
async function waitForRealtimeTerminalState(stateDir, jobId, task, plan, ctx, workdir, goal = "terminal") {
  const startedAt = Date.now();
  let lastStatus = readRealtimeStatus(stateDir) ?? "launching";
  const reviewedCheckpoints = /* @__PURE__ */ new Set();
  let lastHeartbeatAt = startedAt;
  const HEARTBEAT_INTERVAL_MS = 3 * 60 * 1e3;
  const HEARTBEAT_INITIAL_MS = 6e4;
  const notifyChannel = ctx.messageChannel;
  while (Date.now() - startedAt < REALTIME_MAX_WAIT_MS) {
    const currentStatus = readRealtimeStatus(stateDir);
    if (currentStatus) {
      lastStatus = currentStatus;
    }
    const elapsed = Date.now() - startedAt;
    const timeSinceLastHbeat = Date.now() - lastHeartbeatAt;
    const heartbeatDue = elapsed < HEARTBEAT_INITIAL_MS + 5e3 ? timeSinceLastHbeat >= HEARTBEAT_INITIAL_MS : timeSinceLastHbeat >= HEARTBEAT_INTERVAL_MS;
    if (heartbeatDue) {
      try {
        const cpPath = (0, import_path7.join)("/tmp", "harness", plan.id, "checkpoint.json");
        if ((0, import_fs7.existsSync)(cpPath)) {
          const now = /* @__PURE__ */ new Date();
          require("fs").utimesSync(cpPath, now, now);
        }
      } catch {
      }
      if (notifyChannel && notifyChannel !== "unknown") {
        const round = detectLatestRealtimeRound(stateDir);
        const implReviews = countImplReviewFiles(stateDir);
        const lastVerdict = readLastImplVerdict(stateDir, implReviews);
        const elapsedMin = Math.round(elapsed / 6e4);
        const statusEmoji = lastStatus === "waiting" ? "\u{1F50D}" : lastStatus === "done" ? "\u2705" : "\u2699\uFE0F";
        const verdictInfo = lastVerdict ? ` \u2192 ${lastVerdict}` : "";
        sendHarnessNotification(
          notifyChannel,
          ctx,
          `${statusEmoji} ${task.title.slice(0, 40)} (${plan.id.slice(-6)})
Task ${task.id} | Round ${round}${verdictInfo} | ${elapsedMin}min`
        ).catch(() => {
        });
      }
      lastHeartbeatAt = Date.now();
    }
    const reviewMode = realtimeCheckpointReviewModeForStatus(lastStatus, stateDir, goal);
    if (reviewMode) {
      const currentRound = detectLatestRealtimeRound(stateDir);
      const reviewKey = `${reviewMode}:${currentRound}`;
      if (!reviewedCheckpoints.has(reviewKey)) {
        reviewedCheckpoints.add(reviewKey);
        const artifactPrefix = reviewArtifactPrefix(
          reviewMode === "embedded-plan" ? "plan" : "implementation",
          currentRound
        );
        try {
          const review = await runEmbeddedRealtimePlanReview({
            stateDir,
            jobId,
            round: currentRound,
            task,
            plan,
            ctx,
            workdir,
            kind: "plan"
          });
          (0, import_fs7.writeFileSync)((0, import_path7.join)(stateDir, `${artifactPrefix}.raw.txt`), review.rawText, "utf8");
          (0, import_fs7.writeFileSync)((0, import_path7.join)(stateDir, `${artifactPrefix}.feedback.txt`), review.feedback, "utf8");
          (0, import_fs7.writeFileSync)(
            (0, import_path7.join)(stateDir, `${artifactPrefix}.source.txt`),
            [
              "source=embedded-agent",
              `kind=${review.kind}`,
              `agent=${ctx.agentId ?? ctx.agentAccountId ?? "main"}`,
              `reviewerSessionId=${review.reviewerSessionId}`,
              `verdict=${review.verdict}`
            ].join("\n") + "\n",
            "utf8"
          );
          await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, review.feedback);
          console.log(
            `[harness] Embedded ${review.kind} review sent: job=${jobId}, round=${currentRound}, verdict=${review.verdict}, reviewer=${review.reviewerSessionId}`
          );
        } catch (err) {
          const detail = `Embedded caller-agent plan review failed for ${jobId} round ${currentRound}: ${err?.message ?? String(err)}`;
          (0, import_fs7.writeFileSync)((0, import_path7.join)(stateDir, `${artifactPrefix}.error.txt`), detail + "\n", "utf8");
          try {
            await writeRealtimeFeedback(REALTIME_REMOTE_HOST, stateDir, "ABORT");
          } catch (feedbackErr) {
            console.warn(
              `[harness] Failed to send ABORT after embedded plan review error: ${feedbackErr?.message ?? String(feedbackErr)}`
            );
          }
          return {
            status: "error:plan-review",
            ...buildRealtimeSummary(
              stateDir,
              "error:plan-review",
              detail
            )
          };
        }
      }
      await sleep(REALTIME_POLL_INTERVAL_MS);
      continue;
    }
    if (goal === "round-complete" && lastStatus === "waiting") {
      await sleep(REALTIME_POLL_INTERVAL_MS);
      continue;
    }
    if (lastStatus === "plan_violation") {
      const handling = classifyPlanViolationHandling(stateDir, goal);
      if (handling === "waiting") {
        return {
          status: "waiting",
          ...buildRealtimeSummary(
            stateDir,
            "waiting",
            "Recovered round-complete after transient plan_violation with a later successful worker result."
          )
        };
      }
      if (handling === "defer") {
        await sleep(REALTIME_POLL_INTERVAL_MS);
        continue;
      }
    }
    if (isRealtimeTerminalStatus(lastStatus)) {
      const recoveredSuccess2 = goal === "terminal" ? recoverSuccessfulRealtimeTerminalState(stateDir, lastStatus) : null;
      if (recoveredSuccess2) {
        return recoveredSuccess2;
      }
      return {
        status: lastStatus,
        ...buildRealtimeSummary(stateDir, lastStatus)
      };
    }
    await sleep(REALTIME_POLL_INTERVAL_MS);
  }
  const recoveredSuccess = goal === "terminal" ? recoverSuccessfulRealtimeTerminalState(stateDir, "error:timeout") : null;
  if (recoveredSuccess) {
    return recoveredSuccess;
  }
  const timeoutStatus = "error:timeout";
  return {
    status: timeoutStatus,
    ...buildRealtimeSummary(
      stateDir,
      timeoutStatus,
      `Timed out waiting for realtime ${goal}. Last observed status: ${lastStatus}.`
    )
  };
}
async function runEmbeddedRealtimePlanReview(params) {
  const runtime = getPluginRuntime();
  if (!runtime?.agent?.runEmbeddedPiAgent || !runtime?.config?.loadConfig) {
    throw new Error("plugin runtime.agent.runEmbeddedPiAgent is unavailable");
  }
  const agentId = params.ctx.agentId ?? params.ctx.agentAccountId ?? "main";
  const cfg = await runtime.config.loadConfig();
  const agentDir = void 0;
  const latestResult = readLatestRealtimeResult(params.stateDir);
  let retryReason = "";
  const embeddedReviewerTarget = resolveEmbeddedReviewerProviderAndModel(
    pluginConfig.reviewModel,
    pluginConfig.defaultModel
  );
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const tempDir = (0, import_fs7.mkdtempSync)((0, import_path7.join)((0, import_os7.tmpdir)(), "harness-plan-review-"));
    const reviewWorkspaceDir = (0, import_path7.join)(tempDir, "ws");
    (0, import_fs7.mkdirSync)(reviewWorkspaceDir, { recursive: true });
    const reviewerSessionId = `harness-plan-review-${params.jobId}-r${params.round}-a${attempt}-${Date.now()}`;
    const reviewerSessionKey = buildHarnessSubagentSessionKey(
      agentId,
      params.jobId,
      `${params.task.id}-${params.kind}-r${params.round}-a${attempt}`,
      "reviewer"
    );
    const sessionFile = (0, import_path7.join)(tempDir, "session.jsonl");
    try {
      const prompt = buildEmbeddedPlanReviewPrompt({
        ...params,
        agentId,
        latestResultText: latestResult?.resultText ?? "",
        retryReason,
        compact: attempt >= 2
      });
      const resolvedTimeoutMs = runtime.agent.resolveAgentTimeoutMs ? runtime.agent.resolveAgentTimeoutMs(cfg) : 24e4;
      const timeoutMs = typeof resolvedTimeoutMs === "number" && resolvedTimeoutMs > 0 ? Math.min(resolvedTimeoutMs, 24e4) : 24e4;
      const result = await runtime.agent.runEmbeddedPiAgent({
        sessionId: reviewerSessionId,
        sessionKey: reviewerSessionKey,
        agentId,
        sessionFile,
        workspaceDir: reviewWorkspaceDir,
        agentDir,
        config: cfg,
        prompt,
        provider: embeddedReviewerTarget.provider,
        model: embeddedReviewerTarget.model,
        timeoutMs,
        runId: (0, import_crypto3.randomUUID)(),
        trigger: "manual",
        disableTools: true,
        bootstrapContextMode: "lightweight"
      });
      const rawText = collectEmbeddedPayloadText(result?.payloads);
      (0, import_fs7.writeFileSync)(
        (0, import_path7.join)(params.stateDir, `${reviewArtifactPrefix("plan", params.round)}.attempt-${attempt}.txt`),
        rawText || "",
        "utf8"
      );
      const parsed = parseEmbeddedPlanReviewResponse(rawText);
      const feedback = parsed.verdict === "DONE" ? "DONE" : parsed.verdict === "ABORT" ? "ABORT" : parsed.body;
      if ((parsed.verdict === "PROCEED" || parsed.verdict === "REVISE") && feedback.trim().length < 200) {
        retryReason = `Your previous ${parsed.verdict} response was too short (${feedback.trim().length} chars). Keep the same verdict only if still correct, but rewrite the body to at least 220 characters with concrete next-step instructions for Claude Code.`;
        continue;
      }
      return {
        kind: params.kind,
        verdict: parsed.verdict,
        body: parsed.body,
        feedback,
        rawText,
        reviewerSessionId,
        round: params.round
      };
    } catch (err) {
      const message = err?.message ?? String(err);
      lastError = message;
      const exhausted = attempt >= 4 || !isTransientEmbeddedReviewError(message);
      if (exhausted) {
        const truncated = message.replace(/\s+/g, " ").trim().slice(0, 240);
        const fallbackBody = [
          `Plan review fallback: the embedded reviewer was unavailable after ${attempt} attempt(s) (last error: ${truncated}).`,
          `Proceeding with the worker's current plan as-is. Worker should follow the spec strictly:`,
          `implement only what the acceptance criteria require, do not expand scope, run focused validation,`,
          `and surface any blockers explicitly. Implementation review will catch divergence in a later round.`
        ].join(" ");
        console.warn(
          `[harness] Embedded ${params.kind} review giving up after ${attempt} attempt(s) \u2014 falling back to PROCEED. Error: ${message}`
        );
        return {
          kind: params.kind,
          verdict: "PROCEED",
          body: fallbackBody,
          feedback: fallbackBody,
          rawText: `[fallback] ${message}`,
          reviewerSessionId,
          round: params.round
        };
      }
      const backoffMs = Math.min(5e3 * attempt, 15e3);
      console.warn(
        `[harness] Embedded ${params.kind} review transient failure: job=${params.jobId}, round=${params.round}, attempt=${attempt}/4, retryInMs=${backoffMs}, error=${message}`
      );
      await sleep(backoffMs);
      continue;
    } finally {
      (0, import_fs7.rmSync)(tempDir, { recursive: true, force: true });
    }
  }
  throw new Error(lastError ?? `embedded ${params.kind} review did not return a valid verdict/body for ${params.jobId} round ${params.round}`);
}
function buildEmbeddedPlanReviewPrompt(params) {
  const compact = params.compact === true;
  const latestResult = params.latestResultText.trim() ? tailText(params.latestResultText, compact ? 18 : 40, compact ? 1400 : 3200) : "(latest Claude result unavailable)";
  const acceptanceCriteria = params.task.acceptanceCriteria.length > 0 ? params.task.acceptanceCriteria.slice(0, compact ? 6 : 10).map((item) => `- ${tailText(item, 2, compact ? 180 : 280)}`).join("\n") : "- Complete the requested change without expanding scope.";
  const originalRequest = tailText(params.plan.originalRequest, compact ? 10 : 20, compact ? 900 : 1800);
  const taskScope = tailText(params.task.scope, compact ? 6 : 12, compact ? 500 : 900);
  const isPlanReview = params.kind === "plan";
  return [
    `You are the OpenClaw agent \`${params.agentId}\` reviewing a Claude Code ${isPlanReview ? "planning" : "implementation"} checkpoint for the coding harness.`,
    `The harness was invoked by this same agent, so the verdict and feedback must come from you directly.`,
    params.retryReason ? `Retry requirement: ${params.retryReason}` : "",
    compact ? "Compact mode: focus only on the current task, not the whole conversation." : "",
    "",
    "Return format (strict):",
    "- First line must be exactly one of: VERDICT: PROCEED | VERDICT: REVISE | VERDICT: DONE | VERDICT: ABORT",
    isPlanReview ? "- For plan checkpoints, use PROCEED to approve the plan, REVISE to request a different implementation path, DONE only if the task is already finished, and ABORT if the task must stop." : "- For implementation checkpoints, use DONE if the task satisfies the acceptance criteria, REVISE to request concrete follow-up changes, and ABORT only if the task must stop. Do not use PROCEED for implementation checkpoints.",
    "- If the verdict is PROCEED or REVISE, the body must be 220-1200 characters, concrete, and addressed to Claude Code.",
    isPlanReview ? "- For PROCEED, restate the approved path, scope, constraints, and validation steps." : "- For REVISE, explain exactly what is wrong in the current implementation and what Claude Code must change next.",
    isPlanReview ? "- For REVISE, explain exactly what is wrong and what Claude Code must change before implementing." : "- For DONE, body is optional; use it only if a short justification materially helps.",
    "- For DONE or ABORT, body is optional.",
    "- No markdown fences. No intro. No notes to Mason. No tool calls.",
    "",
    "Job context:",
    `- jobId: ${params.jobId}`,
    `- round: ${params.round}`,
    `- checkpoint kind: ${params.kind}`,
    `- repo/workdir: ${params.workdir}`,
    `- original request: ${originalRequest}`,
    `- task title: ${params.task.title}`,
    `- task scope: ${taskScope}`,
    "",
    "Acceptance criteria:",
    acceptanceCriteria,
    "",
    "Latest Claude Code checkpoint:",
    latestResult
  ].filter(Boolean).join("\n");
}
function parseEmbeddedPlanReviewResponse(rawText) {
  const normalized = rawText.replace(/\r/g, "").trim();
  if (!normalized) {
    throw new Error("embedded plan review returned empty output");
  }
  const verdictStart = normalized.search(/VERDICT:/i);
  const candidate = verdictStart >= 0 ? normalized.slice(verdictStart).trim() : normalized;
  const verdictMatch = candidate.match(/VERDICT:\s*(PROCEED|REVISE|DONE|ABORT)/i);
  if (!verdictMatch) {
    throw new Error(`embedded plan review missing VERDICT. Output head: ${tailText(normalized, 8, 400)}`);
  }
  const verdict = verdictMatch[1].toUpperCase();
  const lines = candidate.split("\n");
  const firstVerdictLineIndex = lines.findIndex((line) => /VERDICT:/i.test(line));
  const firstVerdictLine = firstVerdictLineIndex >= 0 ? lines[firstVerdictLineIndex] : candidate;
  const inlineBody = firstVerdictLine.replace(/.*VERDICT:\s*(?:PROCEED|REVISE|DONE|ABORT)\s*/i, "").trim();
  const body = [inlineBody, ...lines.slice(firstVerdictLineIndex + 1)].join("\n").trim();
  return { verdict, body };
}
function isTransientEmbeddedReviewError(message) {
  if (/context overflow|prompt too large/i.test(message)) return false;
  return /(temporarily overloaded|overloaded|rate limit|try again in a moment|timeout|timed out|temporarily unavailable)/i.test(message);
}
function collectEmbeddedPayloadText(payloads) {
  return (payloads ?? []).map((payload) => payload?.text ?? "").filter(Boolean).join("\n").trim();
}
async function writeRealtimeFeedback(remoteHost, stateDir, feedback) {
  const stateDirB64 = Buffer.from(stateDir, "utf8").toString("base64");
  const feedbackB64 = Buffer.from(feedback, "utf8").toString("base64");
  const python = [
    "import base64",
    "from pathlib import Path",
    `state_dir = Path(base64.b64decode("${stateDirB64}").decode("utf-8"))`,
    `feedback = base64.b64decode("${feedbackB64}").decode("utf-8")`,
    "state_dir.mkdir(parents=True, exist_ok=True)",
    '(state_dir / "feedback").write_text(feedback, encoding="utf-8")',
    'history = state_dir / "feedback-history.log"',
    'fh = history.open("a", encoding="utf-8")',
    'fh.write(feedback.rstrip("\\n") + "\\n")',
    "fh.close()"
  ].join("; ");
  const result = await execFileCapture(
    "ssh",
    [remoteHost, `python3 -c '${python}'`],
    process.cwd(),
    3e4
  );
  if (result.exitCode !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`failed to write realtime feedback to ${remoteHost}:${stateDir}${output ? `
${output}` : ""}`);
  }
}
function detectLatestRealtimeRound(stateDir) {
  try {
    if (!(0, import_fs7.existsSync)(stateDir)) return 1;
    const resultFiles = (0, import_fs7.readdirSync)(stateDir).filter((name) => /^result-\d+\.json$/.test(name)).sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    if (resultFiles.length === 0) return 1;
    return Math.max(1, extractRealtimeRound(resultFiles[resultFiles.length - 1]));
  } catch {
    return 1;
  }
}
function countImplReviewFiles(stateDir) {
  try {
    return (0, import_fs7.readdirSync)(stateDir).filter((f) => /^implementation-review-round-\d+\.source\.txt$/.test(f)).length;
  } catch {
    return 0;
  }
}
function readLastImplVerdict(stateDir, count) {
  if (count === 0) return null;
  try {
    const content = readTextFileIfExists((0, import_path7.join)(stateDir, `implementation-review-round-${count}.source.txt`));
    const match = content?.match(/verdict=(\w+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}
function readRealtimeStatus(stateDir) {
  return readTextFileIfExists((0, import_path7.join)(stateDir, "status"))?.trim() || null;
}
function isRealtimeTerminalStatus(status) {
  if (!status) return false;
  return status === "done" || status === "aborted" || status === "plan_violation" || status === "loop" || status === "error" || status.startsWith("error:");
}
function extractArtifactRound(filename) {
  const match = filename.match(/-(\d+)\.[^.]+(?:\.[^.]+)?$/);
  return match ? parseInt(match[1], 10) : 0;
}
function listRealtimeArtifacts(stateDir, pattern) {
  try {
    if (!(0, import_fs7.existsSync)(stateDir)) return [];
    return (0, import_fs7.readdirSync)(stateDir).filter((name) => pattern.test(name)).map((name) => ({ round: extractArtifactRound(name), path: (0, import_path7.join)(stateDir, name) })).sort((a, b) => a.round - b.round);
  } catch {
    return [];
  }
}
function parseReviewVerdictFromSource(path) {
  const text = readTextFileIfExists(path);
  if (!text) return null;
  const match = text.match(/^verdict=(.+)$/m);
  return match?.[1]?.trim() || null;
}
function collectRealtimeReviewDiagnostics(stateDir) {
  const implementationSources = listRealtimeArtifacts(stateDir, /^implementation-review-round-\d+\.source\.txt$/);
  const implementationVerdicts = implementationSources.map(({ round, path }) => {
    const verdict = parseReviewVerdictFromSource(path);
    return verdict ? `r${round}=${verdict}` : null;
  }).filter((value) => Boolean(value));
  const planSources = listRealtimeArtifacts(stateDir, /^plan-review-round-\d+\.source\.txt$/);
  const planErrors = listRealtimeArtifacts(stateDir, /^plan-review-round-\d+\.error\.txt$/);
  const lastPlanReviewError = planErrors.length > 0 ? readTextFileIfExists(planErrors[planErrors.length - 1].path) ?? void 0 : void 0;
  return {
    implementationRounds: implementationSources.length,
    implementationVerdicts,
    planReviewRounds: planSources.length,
    lastPlanReviewError
  };
}
function getRealtimeImplementationReviewLoops(jobId) {
  if (!jobId) return 0;
  return collectRealtimeReviewDiagnostics((0, import_path7.join)(REALTIME_STATE_ROOT, jobId)).implementationRounds;
}
function isLikelyRealtimePlanSummary(result) {
  const text = result?.resultText?.trim() ?? "";
  if (!text) return false;
  return /^plan summary:/i.test(text);
}
function isSubstantiveRealtimeSuccess(result) {
  if (!result?.resultText) return false;
  if (result.isError === true) return false;
  if (result.subtype && result.subtype !== "success") return false;
  if (isLikelyRealtimePlanSummary(result)) return false;
  if ((result.permissionDenials ?? []).includes("ExitPlanMode")) return false;
  return true;
}
function classifyPlanViolationHandling(stateDir, goal) {
  if (goal !== "round-complete") {
    return "terminal";
  }
  const latestResult = readLatestRealtimeResult(stateDir);
  if (isSubstantiveRealtimeSuccess(latestResult)) {
    return "waiting";
  }
  const hasExitPlanModeDenial = (latestResult?.permissionDenials ?? []).includes("ExitPlanMode");
  if (hasExitPlanModeDenial || isLikelyRealtimePlanSummary(latestResult)) {
    return "defer";
  }
  return "terminal";
}
function parseRealtimeStateDir(output, jobId) {
  const match = output.match(/BG:(\/tmp\/claude-realtime\/[^\s]+)/);
  return match?.[1] ?? (0, import_path7.join)(REALTIME_STATE_ROOT, jobId);
}
function buildRealtimeSummary(stateDir, status, extraDetail) {
  const latestResult = readLatestRealtimeResult(stateDir);
  const reviewDiagnostics = collectRealtimeReviewDiagnostics(stateDir);
  const verifyReport = readTextFileIfExists((0, import_path7.join)(stateDir, "verify-report.txt"));
  const outputLog = readTextFileIfExists((0, import_path7.join)(stateDir, "output.log"));
  const sections = [`claude-realtime job ${(0, import_path7.basename)(stateDir)} status=${status}`];
  if (latestResult?.resultText) {
    const metadata = [
      latestResult.numTurns != null ? `turns=${latestResult.numTurns}` : "",
      latestResult.costUsd != null ? `cost=$${latestResult.costUsd.toFixed(2)}` : ""
    ].filter(Boolean).join(", ");
    sections.push([
      `Latest worker result (Claude Code)${metadata ? ` (${metadata})` : ""}:`,
      tailText(latestResult.resultText, 16, 1600)
    ].join("\n"));
  }
  if (reviewDiagnostics.implementationRounds > 0) {
    sections.push(
      `Implementation reviews: ${reviewDiagnostics.implementationRounds}` + (reviewDiagnostics.implementationVerdicts.length > 0 ? ` (${reviewDiagnostics.implementationVerdicts.join(", ")})` : "")
    );
  }
  if (reviewDiagnostics.planReviewRounds > 0) {
    sections.push(`Embedded plan reviews: ${reviewDiagnostics.planReviewRounds}`);
  }
  if (reviewDiagnostics.lastPlanReviewError) {
    sections.push(`Last embedded plan-review error:
${tailText(reviewDiagnostics.lastPlanReviewError, 8, 1200)}`);
  }
  if (verifyReport) {
    sections.push(`Verify report:
${tailText(verifyReport, 24, 2400)}`);
  }
  if (extraDetail) {
    sections.push(extraDetail);
  }
  if (outputLog && status !== "done") {
    sections.push(`Launcher log tail:
${tailText(outputLog, 30, 2400)}`);
  }
  return {
    summary: sections.join("\n\n"),
    sessionId: latestResult?.sessionId
  };
}
function readLatestRealtimeResult(stateDir) {
  try {
    if (!(0, import_fs7.existsSync)(stateDir)) return null;
    const candidates = [];
    const resultFiles = (0, import_fs7.readdirSync)(stateDir).filter((name) => /^result-\d+\.json$/.test(name)).sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    for (const filename of resultFiles) {
      const payload = JSON.parse((0, import_fs7.readFileSync)((0, import_path7.join)(stateDir, filename), "utf-8"));
      candidates.push({
        ...buildLatestRealtimeResult(payload, extractRealtimeRound(filename)),
        sourcePriority: 2
      });
    }
    const streamFiles = (0, import_fs7.readdirSync)(stateDir).filter((name) => /^stream-\d+\.jsonl$/.test(name)).sort((a, b) => extractRealtimeRound(a) - extractRealtimeRound(b));
    for (const filename of streamFiles) {
      const round = extractRealtimeRound(filename);
      const lines = (0, import_fs7.readFileSync)((0, import_path7.join)(stateDir, filename), "utf-8").split("\n");
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const payload = JSON.parse(trimmed);
          if (payload?.type !== "result") continue;
          candidates.push({
            ...buildLatestRealtimeResult(payload, round),
            sourcePriority: 1
          });
        } catch {
          continue;
        }
      }
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => {
      const roundDelta = (a.round ?? 0) - (b.round ?? 0);
      if (roundDelta !== 0) return roundDelta;
      return a.sourcePriority - b.sourcePriority;
    });
    const latest = candidates[candidates.length - 1];
    const { sourcePriority: _sourcePriority, ...result } = latest;
    return result;
  } catch {
    return null;
  }
}
function buildLatestRealtimeResult(payload, round) {
  const permissionDenials = Array.isArray(payload?.permission_denials) ? payload.permission_denials.map((entry) => typeof entry?.tool_name === "string" ? entry.tool_name : null).filter((value) => Boolean(value)) : [];
  return {
    sessionId: typeof payload?.session_id === "string" ? payload.session_id : void 0,
    resultText: typeof payload?.result === "string" ? payload.result : void 0,
    numTurns: typeof payload?.num_turns === "number" ? payload.num_turns : void 0,
    costUsd: typeof payload?.total_cost_usd === "number" ? payload.total_cost_usd : void 0,
    subtype: typeof payload?.subtype === "string" ? payload.subtype : void 0,
    isError: typeof payload?.is_error === "boolean" ? payload.is_error : void 0,
    round,
    permissionDenials
  };
}
function recoverSuccessfulRealtimeTerminalState(stateDir, observedStatus) {
  const latestResult = readLatestRealtimeResult(stateDir);
  if (!latestResult?.resultText) return null;
  if (latestResult.isError === true) return null;
  if (latestResult.subtype && latestResult.subtype !== "success") return null;
  const feedbackHistory = readTextFileIfExists((0, import_path7.join)(stateDir, "feedback-history.log")) ?? "";
  const hasDoneFeedback = /(^|\n)DONE(\n|$)/m.test(feedbackHistory);
  if (!hasDoneFeedback && observedStatus !== "done") return null;
  return {
    status: "done",
    ...buildRealtimeSummary(
      stateDir,
      "done",
      `Recovered terminal success after late ${observedStatus} status override.`
    )
  };
}
function isRealtimeReviewReadyStatus(status) {
  return status === "waiting" || status === "done";
}
function buildRealtimeWorkerResult(taskId, status, summary, sessionId) {
  return {
    taskId,
    status: isRealtimeReviewReadyStatus(status) ? "completed" : "failed",
    summary,
    filesChanged: extractFilePaths(summary),
    testsRun: extractTestCount(summary),
    warnings: extractWarnings(summary),
    sessionId
  };
}
function recoverCompletedRealtimeWorkerResult(taskId, jobId) {
  if (!jobId) return null;
  const stateDir = (0, import_path7.join)(REALTIME_STATE_ROOT, jobId);
  const status = readRealtimeStatus(stateDir);
  if (status !== "done") {
    return null;
  }
  const { summary, sessionId } = buildRealtimeSummary(stateDir, status);
  return buildRealtimeWorkerResult(taskId, status, summary, sessionId ?? jobId);
}
function extractRealtimeRound(filename) {
  const match = filename.match(/^(?:result|stream)-(\d+)\.(?:json|jsonl)$/);
  return match ? parseInt(match[1], 10) : 0;
}
function readTextFileIfExists(path) {
  try {
    if (!(0, import_fs7.existsSync)(path)) return null;
    return (0, import_fs7.readFileSync)(path, "utf-8");
  } catch {
    return null;
  }
}
function tailText(text, maxLines, maxChars) {
  const trimmed = text.trim();
  if (!trimmed) return "";
  const tailLines = trimmed.split("\n").slice(-maxLines).join("\n");
  if (tailLines.length <= maxChars) {
    return tailLines;
  }
  return tailLines.slice(-maxChars);
}
function formatRealtimeFailure(jobId, stateDir, status, summary) {
  return [
    `Tier 2 realtime job ${jobId} ended with status=${status}.`,
    `State dir: ${stateDir}`,
    summary ? `Details:
${summary}` : ""
  ].filter(Boolean).join("\n");
}
function buildRealtimeSpec(task, plan, workdir) {
  const acceptanceCriteria = task.acceptanceCriteria.length > 0 ? task.acceptanceCriteria : ["Complete the requested change without expanding scope."];
  return [
    "## Goal",
    task.title,
    "",
    `Original request: ${plan.originalRequest}`,
    "",
    "## Scope",
    `- Working directory: \`${workdir}\``,
    `- \uC218\uC815: ${task.scope}`,
    `- \uAE08\uC9C0: Do not change unrelated legacy registration, gating, or harness architecture outside this task.`,
    "",
    "## Acceptance Criteria",
    ...acceptanceCriteria.map((criterion) => `- ${criterion}`),
    "",
    "## Context",
    `- Harness plan: ${plan.id}`,
    `- Task id: ${task.id}`,
    `- Plan mode: ${plan.mode}`,
    `- Estimated complexity: ${plan.estimatedComplexity}`
  ].join("\n");
}
function buildRealtimeJobId(planId, taskId) {
  const planPart = sanitizeRealtimeFragment(planId).slice(0, 32);
  const taskPart = sanitizeRealtimeFragment(taskId).slice(0, 24);
  return `harness-${planPart || "plan"}-${taskPart || "task"}-${Date.now()}`;
}
function hasRealtimeProjectContext(workdir) {
  return (0, import_fs7.existsSync)((0, import_path7.join)(workdir, "CLAUDE.md")) || (0, import_fs7.existsSync)((0, import_path7.join)(workdir, ".claude", "CLAUDE.md"));
}
function assertRealtimeProjectContext(workdir) {
  if (hasRealtimeProjectContext(workdir)) {
    return;
  }
  throw new Error(
    [
      `Realtime worker requires project context before launch: ${workdir}`,
      "Missing CLAUDE.md (or .claude/CLAUDE.md).",
      "Create a project context file before using harness_execute with the realtime worker."
    ].join("\n")
  );
}
function sanitizeRealtimeFragment(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}
function inferAgentIdFromWorkdir(workdir) {
  const normalized = (0, import_path7.resolve)(workdir);
  const workspaceMatch = normalized.match(/\/workspace-([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (workspaceMatch?.[1]) {
    return workspaceMatch[1];
  }
  const agentsMatch = normalized.match(/\/agents\/([a-zA-Z0-9_-]+)(?:\/|$)/);
  if (agentsMatch?.[1]) {
    return agentsMatch[1];
  }
  return void 0;
}
function resolveCallerAgentId(ctx) {
  return ctx.agentId || ctx.agentAccountId || process.env.OPENCLAW_NOTIFY_AGENT_DEFAULT || "nova";
}
function resolveRealtimeNotifyAgent(ctx, workdir) {
  return inferAgentIdFromWorkdir(workdir) || resolveCallerAgentId(ctx);
}
function formatRealtimeFailureForCaller(ctx, workdir, detailedError) {
  const callerAgent = resolveCallerAgentId(ctx);
  const targetAgent = resolveRealtimeNotifyAgent(ctx, workdir);
  if (targetAgent !== callerAgent) {
    return `Tier 2 failure was routed to ${targetAgent}. Detailed error was sent to that agent's channel.`;
  }
  return detailedError;
}
function resolveRealtimeModel(workerModel) {
  return workerModel.toLowerCase().includes("opus") ? "opus" : "sonnet";
}
function resolveSubagentProviderAndModel(requestedModel, fallback) {
  const raw = (requestedModel ?? "").trim();
  const lower = raw.toLowerCase();
  if (!raw) {
    return fallback;
  }
  if (raw.includes("/")) {
    const [provider, model] = raw.split("/", 2);
    if (provider && model) {
      return { provider, model };
    }
  }
  if (lower === "codex" || lower === "gpt5.4" || lower === "gpt-5.4" || lower === "gpt") {
    return { provider: "openai-codex", model: "gpt-5.4" };
  }
  if (lower === "opus" || lower === "opus46" || lower === "claude-opus-4-6") {
    return { provider: "anthropic", model: "claude-opus-4-6" };
  }
  if (lower === "claude" || lower === "sonnet" || lower === "sonnet46" || lower === "claude-sonnet-4-6") {
    return { provider: "anthropic", model: "claude-sonnet-4-6" };
  }
  if (lower.includes("codex") || lower.startsWith("gpt")) {
    return { provider: "openai-codex", model: "gpt-5.4" };
  }
  if (lower.includes("opus")) {
    return { provider: "anthropic", model: "claude-opus-4-6" };
  }
  if (lower.includes("claude") || lower.includes("sonnet")) {
    return { provider: "anthropic", model: "claude-sonnet-4-6" };
  }
  return fallback;
}
function resolveEmbeddedReviewerProviderAndModel(reviewModel, fallbackModel) {
  const normalizedModel = resolveModelAlias(reviewModel ?? fallbackModel) ?? reviewModel?.trim() ?? fallbackModel?.trim() ?? "openai-codex/gpt-5.4";
  return resolveSubagentProviderAndModel(normalizedModel, {
    provider: "openai-codex",
    model: "gpt-5.4"
  });
}
function buildHarnessSubagentSessionKey(agentId, planId, taskId, role) {
  const composite = `${planId}|${taskId}|${role}`;
  const hash = (0, import_crypto3.createHash)("sha256").update(composite).digest("hex").slice(0, 12);
  return `h${hash}`;
}
async function waitForSessionEnd(sessionId) {
  const activeSessionManager = requireHarnessSessionManager();
  const maxWaitMs = 10 * 60 * 1e3;
  const pollIntervalMs = 3e3;
  const startTime = Date.now();
  while (Date.now() - startTime < maxWaitMs) {
    const session = activeSessionManager.get(sessionId);
    if (!session) {
      return { status: "failed", output: "", error: "Session disappeared" };
    }
    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return {
        status: session.status,
        output: session.getOutput().join("\n"),
        error: session.error
      };
    }
    await sleep(pollIntervalMs);
  }
  console.warn(`[harness] Timeout waiting for session ${sessionId}`);
  activeSessionManager.kill(sessionId);
  return { status: "timeout", output: "", error: "Session timed out after 10 minutes" };
}
async function waitForCompletion(sessionId, taskId) {
  const completion = await waitForSessionEnd(sessionId);
  if (completion.status !== "completed") {
    console.warn(`[harness] Worker session ${sessionId} ended with status=${completion.status}: ${completion.error}`);
    return null;
  }
  if (!completion.output) return null;
  return {
    taskId,
    status: "completed",
    summary: completion.output.length > 500 ? completion.output.slice(-500) : completion.output,
    filesChanged: extractFilePaths(completion.output),
    testsRun: extractTestCount(completion.output),
    warnings: extractWarnings(completion.output),
    sessionId
  };
}
function sleep(ms) {
  return new Promise((resolve6) => setTimeout(resolve6, ms));
}
async function sendHarnessNotification(channel, ctx, message) {
  try {
    const { execFile: execFileCb } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFileCb);
    const fallback = pluginConfig.fallbackChannel;
    const channelHasTarget = !!channel && channel.split("|").length >= 2;
    let target;
    if (channelHasTarget) {
      target = channel;
    } else if (fallback && (!channel || fallback.startsWith(`${channel}|`))) {
      target = fallback;
    } else {
      target = channel || fallback;
    }
    if (!target || target === "unknown") {
      console.warn(`[harness] No notification channel available, logging result only`);
      return;
    }
    const parts = target.split("|");
    const args = ["message", "send", "--message", message.slice(0, 4e3)];
    if (parts.length >= 3) {
      args.push("--channel", parts[0], "--account", parts[1], "-t", parts[2]);
    } else if (parts.length === 2) {
      args.push("--channel", parts[0], "-t", parts[1]);
    } else {
      console.warn(`[harness] Notification channel "${target}" lacks a target \u2014 skipping send`);
      return;
    }
    await execFileAsync("openclaw", args, { timeout: 15e3 });
  } catch (err) {
    console.warn(`[harness] Notification send failed: ${err?.message ?? String(err)}`);
  }
}
var MAX_ANALYSIS_REQUEST_LENGTH = 500;
var ANALYSIS_KEYWORDS_KO = /(분석|검토|조사|확인|현황|리뷰|점검|비교|상태|살펴|파악)/;
var ANALYSIS_KEYWORDS_EN = /\b(analy[sz]e|review|inspect|audit|check|status|compare|investigate|examine|diagnose)\b/i;
var CODING_SIGNALS = /(create|add|implement|fix|update|modify|write|build|refactor|delete|remove|생성|추가|구현|수정|작성|만들|고쳐|삭제|제거|리팩토링)/i;
function isAnalysisOnlyRequest(request) {
  if (request.length > MAX_ANALYSIS_REQUEST_LENGTH) return false;
  const hasAnalysis = ANALYSIS_KEYWORDS_KO.test(request) || ANALYSIS_KEYWORDS_EN.test(request);
  const hasCoding = CODING_SIGNALS.test(request);
  return hasAnalysis && !hasCoding;
}
function extractFilePaths(output) {
  return extractRelevantFilePaths(output);
}
function extractRelevantFilePaths(output, repoRoot) {
  const paths = [];
  const root = repoRoot ? (0, import_path7.resolve)(repoRoot) : null;
  const regex = /(?:^|[\s`'"(\[])(\.?\/?(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z0-9]+|\/[\w./-]+\.[A-Za-z0-9]+)(?=$|[\s`'"),:;\]])/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    let candidate = match[1].trim();
    if (!candidate) continue;
    if (candidate.startsWith("/")) {
      if (!root || !candidate.startsWith(root + "/")) continue;
      candidate = (0, import_path7.relative)(root, candidate);
    }
    candidate = candidate.replace(/^\.\//, "");
    if (!candidate || candidate.startsWith("../") || candidate === "..") continue;
    paths.push(candidate);
  }
  return [...new Set(paths)];
}
function extractTestCount(output) {
  const match = output.match(/(\d+)\s*(?:tests?|specs?)\s*(?:passed|ran|ok)/i);
  return match ? parseInt(match[1], 10) : 0;
}
function extractWarnings(output) {
  const warnings = [];
  const lines = output.split("\n");
  for (const line of lines) {
    if (/\b(?:warning|warn|⚠️)\b/i.test(line)) {
      warnings.push(line.trim());
    }
  }
  return warnings.slice(0, 10);
}
function buildWorkerPrompt(task, plan) {
  return [
    `## Task: ${task.title}`,
    ``,
    `**Original request:** ${plan.originalRequest}`,
    ``,
    `**Scope:** ${task.scope}`,
    ``,
    `**Acceptance criteria:**`,
    ...task.acceptanceCriteria.map((c) => `- ${c}`),
    ``,
    `## Rules`,
    `- Stay within the specified scope. Do not add features beyond what is requested.`,
    `- Do not modify files outside the scope unless absolutely necessary.`,
    `- When done, summarize: files changed, tests run, warnings.`,
    `- If you encounter ambiguity, make the simplest reasonable choice and document it.`
  ].join("\n");
}
function formatPlannerMetadata(metadata) {
  if (!metadata) return [];
  const lines = [
    `**Planner:** ${metadata.backend}${metadata.model ? ` | model=${metadata.model}` : ""} | fallback=${metadata.fallback ? "yes" : "no"}`
  ];
  if (metadata.fallbackReason) {
    lines.push(`**Planner fallback:** ${metadata.fallbackReason}`);
  }
  return lines;
}
function formatFinalResult(plan, route, results, mode, checkpoint, runState, materialized) {
  const passed = results.filter((r) => r.reviewPassed).length;
  const failed = results.filter((r) => !r.reviewPassed).length;
  const escalated = results.filter((r) => r.escalated).length;
  const totalLoops = results.reduce((sum, r) => sum + r.reviewLoops, 0);
  const status = failed === 0 ? "success" : escalated > 0 ? "escalated" : "partial";
  const lines = [
    `## Harness: ${status === "success" ? "Complete" : status === "escalated" ? "Escalation Required" : "Partial Completion"}`,
    ``,
    `**Tier:** ${route.tier} | **Mode:** ${mode} | **Plan:** ${plan.id}`,
    `**Run:** ${runState.mode === "resumed" ? "resumed from checkpoint" : "fresh"}`,
    `**Result:** ${passed}/${plan.tasks.length} passed | ${totalLoops} review loops`,
    `**Checkpoint:** ${checkpoint.runId}`,
    ...formatPlannerMetadata(plan.plannerMetadata)
  ];
  if (runState.mode === "resumed") {
    lines.push(
      `**Skipped completed:** ${formatTaskIdList(runState.skippedCompletedTaskIds)}`,
      `**Continued tasks:** ${formatTaskIdList(runState.resumedTaskIds)}`
    );
  }
  if (materialized?.error) {
    lines.push(`**Workspace materialization:** failed`, `**Patch:** ${materialized.patchPath ?? "(none)"}`, `**Reason:** ${materialized.error}`);
  } else if (materialized?.applied) {
    lines.push(`**Workspace materialization:** applied${materialized.patchPath ? ` (${materialized.patchPath})` : ""}`);
  }
  lines.push(``, `### Task Results`);
  for (const r of results) {
    const icon = r.reviewPassed ? "\u2705" : r.escalated ? "\u{1F6A8}" : "\u274C";
    lines.push(`${icon} **${r.taskId}** \u2014 reviews: ${r.reviewLoops}, passed: ${r.reviewPassed}`);
    if (r.workerResult) {
      if (r.workerResult.filesChanged.length > 0) {
        lines.push(`   Files: ${r.workerResult.filesChanged.join(", ")}`);
      }
    }
    if (r.error) {
      lines.push(`   Error: ${r.error}`);
    }
    if (r.escalationReason) {
      lines.push(``, r.escalationReason);
    }
  }
  return lines.join("\n");
}
function freshExecutionRunState() {
  return {
    mode: "fresh",
    skippedCompletedTaskIds: [],
    resumedTaskIds: []
  };
}
function buildExecutionRunState(checkpoint) {
  if (!hasCheckpointProgress(checkpoint)) {
    return freshExecutionRunState();
  }
  const skippedCompletedTaskIds = checkpoint.plan.tasks.map((task) => task.id).filter((taskId) => isCheckpointTaskComplete(getCheckpointTask(checkpoint, taskId)));
  const pendingTaskIds = new Set(getPendingTasks(checkpoint));
  const resumedTaskIds = checkpoint.plan.tasks.map((task) => task.id).filter((taskId) => {
    const task = getCheckpointTask(checkpoint, taskId);
    return pendingTaskIds.has(taskId) || task != null && !isCheckpointTaskComplete(task);
  });
  return {
    mode: "resumed",
    skippedCompletedTaskIds,
    resumedTaskIds
  };
}
function hasCheckpointProgress(checkpoint) {
  return checkpoint.tasks.some((task) => task.status !== "pending") || Object.keys(checkpoint.sessions).length > 0;
}
function getCheckpointTask(checkpoint, taskId) {
  return checkpoint.tasks.find((task) => task.id === taskId);
}
function isCheckpointTaskComplete(task) {
  return task?.status === "completed" && task.reviewPassed === true;
}
function buildCompletedCheckpointResult(checkpoint, taskId) {
  const task = getCheckpointTask(checkpoint, taskId);
  if (!isCheckpointTaskComplete(task)) {
    return null;
  }
  return {
    taskId,
    workerSessionId: checkpoint.sessions[taskId]?.worker ?? task.workerResult?.sessionId ?? "",
    workerResult: task.workerResult ?? null,
    reviewPassed: true,
    reviewLoops: task.reviewLoop ?? 0,
    escalated: false
  };
}
function resetCheckpointTaskForRetry(checkpoint, taskId) {
  const task = getCheckpointTask(checkpoint, taskId);
  if (!task || isCheckpointTaskComplete(task)) {
    return;
  }
  delete task.reviewPassed;
  delete task.reviewLoop;
  delete task.workerResult;
  delete task.reviewResult;
}
function formatTaskIdList(taskIds) {
  if (taskIds.length === 0) {
    return "none";
  }
  return taskIds.join(", ");
}

// src/tools/claude-sessions.ts
function makeClaudeSessionsTool(ctx) {
  return {
    name: "harness_sessions",
    description: "[LEGACY] List all Claude Code sessions with their status and progress. Used to monitor sessions launched via harness_launch. For tasks executed through harness_execute, status is returned directly in the result.",
    parameters: Type.Object({
      status: Type.Optional(
        Type.Union(
          [
            Type.Literal("all"),
            Type.Literal("running"),
            Type.Literal("completed"),
            Type.Literal("failed")
          ],
          { description: 'Filter by status (default "all")' }
        )
      )
      // Uncomment to allow agents to see all sessions across agents:
      // scope: Type.Optional(
      //   Type.Union(
      //     [Type.Literal("mine"), Type.Literal("all")],
      //     { description: 'Scope: "mine" (default) shows only this agent\'s sessions, "all" shows every session.' },
      //   ),
      // ),
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_sessions");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const filter = params.status || "all";
      const allSessions = sessionManager.list(filter);
      let sessions = allSessions;
      const agentId = ctx?.agentId;
      if (agentId) {
        console.log(`[claude_sessions] Filtering sessions by agentId=${agentId}`);
        sessions = allSessions.filter((s) => s.originAgentId === agentId);
      } else if (ctx?.workspaceDir) {
        const agentChannel = resolveAgentChannel(ctx.workspaceDir);
        if (agentChannel) {
          console.log(`[claude_sessions] Filtering sessions by agentChannel=${agentChannel}`);
          sessions = allSessions.filter((s) => s.originChannel === agentChannel);
        } else {
          console.log(`[claude_sessions] No agentChannel found for workspaceDir=${ctx.workspaceDir}, returning all sessions`);
        }
      }
      if (sessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No sessions found."
            }
          ]
        };
      }
      const lines = sessions.map(formatSessionListing);
      return {
        content: [
          {
            type: "text",
            text: lines.join("\n\n")
          }
        ]
      };
    }
  };
}

// src/tools/claude-kill.ts
function makeClaudeKillTool(ctx) {
  return {
    name: "harness_kill",
    description: "[LEGACY] Terminate a running Claude Code session by name or ID. Used for sessions launched via harness_launch. harness_execute manages its own session lifecycle internally.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to terminate" })
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_kill");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const session = sessionManager.resolve(params.session, ctx?.agentId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session "${params.session}" not found.`
            }
          ]
        };
      }
      if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`
            }
          ]
        };
      }
      sessionManager.kill(session.id);
      return {
        content: [
          {
            type: "text",
            text: `Session ${session.name} [${session.id}] has been terminated.`
          }
        ]
      };
    }
  };
}

// src/tools/claude-output.ts
function makeClaudeOutputTool(ctx) {
  return {
    name: "harness_output",
    description: "[LEGACY] Show recent output from a Claude Code session (by name or ID). Used for sessions launched via harness_launch. harness_execute returns structured results directly and does not require this tool.",
    parameters: Type.Object({
      session: Type.String({ description: "Session name or ID to get output from" }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of recent lines to show (default 50)"
        })
      ),
      full: Type.Optional(
        Type.Boolean({
          description: "Show all available output"
        })
      )
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_output");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const session = sessionManager.resolve(params.session, ctx?.agentId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session "${params.session}" not found.`
            }
          ]
        };
      }
      const outputLines = params.full ? session.getOutput() : session.getOutput(params.lines ?? 50);
      const duration = formatDuration(session.duration);
      const header = [
        `Session: ${session.name} [${session.id}] | Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"\u2500".repeat(60)}`
      ].join("\n");
      if (outputLines.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `${header}
(no output yet)`
            }
          ]
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `${header}
${outputLines.join("\n")}`
          }
        ]
      };
    }
  };
}

// src/tools/claude-fg.ts
function makeClaudeFgTool(ctx) {
  let fallbackChannel;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  }
  if (!fallbackChannel && ctx?.workspaceDir) {
    fallbackChannel = resolveAgentChannel(ctx.workspaceDir);
  }
  if (!fallbackChannel && ctx?.messageChannel && ctx.messageChannel.includes("|")) {
    fallbackChannel = ctx.messageChannel;
  }
  console.log(`[claude-fg] Factory context: messageChannel=${ctx?.messageChannel}, agentAccountId=${ctx?.agentAccountId}, workspaceDir=${ctx?.workspaceDir}, fallbackChannel=${fallbackChannel}`);
  return {
    name: "harness_fg",
    description: "[LEGACY] Bring a Claude Code session to foreground (by name or ID). Shows buffered output and streams new output. Only applies to sessions launched via harness_launch; harness_execute sessions are fully managed by the harness.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session name or ID to bring to foreground"
      }),
      lines: Type.Optional(
        Type.Number({
          description: "Number of recent buffered lines to show (default 30)"
        })
      )
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_fg");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const session = sessionManager.resolve(params.session, ctx?.agentId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session "${params.session}" not found.`
            }
          ]
        };
      }
      let channelId = resolveOriginChannel({ id: _id }, fallbackChannel);
      console.log(`[claude-fg] channelId resolved: ${channelId}, session.workdir=${session.workdir}`);
      if (channelId === "unknown" && hasValidOriginChannel(session)) {
        channelId = session.originChannel;
      }
      const catchupLines = session.getCatchupOutput(channelId);
      session.foregroundChannels.add(channelId);
      const duration = formatDuration(session.duration);
      const header = [
        `Session ${session.name} [${session.id}] now in foreground.`,
        `Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"\u2500".repeat(60)}`
      ].join("\n");
      let catchupSection = "";
      if (catchupLines.length > 0) {
        catchupSection = [
          `\u{1F4CB} Catchup (${catchupLines.length} missed output${catchupLines.length === 1 ? "" : "s"}):`,
          catchupLines.join("\n"),
          `${"\u2500".repeat(60)}`
        ].join("\n");
      }
      const body = catchupLines.length > 0 ? catchupSection : session.getOutput(params.lines ?? 30).length > 0 ? session.getOutput(params.lines ?? 30).join("\n") : "(no output yet)";
      const footer = session.status === "running" || session.status === "starting" ? `
${"\u2500".repeat(60)}
Streaming new output... Use claude_bg to detach.` : `
${"\u2500".repeat(60)}
Session is ${session.status}. No more output expected.`;
      session.markFgOutputSeen(channelId);
      return {
        content: [
          {
            type: "text",
            text: `${header}
${body}${footer}`
          }
        ]
      };
    }
  };
}

// src/tools/claude-bg.ts
function makeClaudeBgTool(ctx) {
  let fallbackChannel;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  }
  if (!fallbackChannel && ctx?.workspaceDir) {
    fallbackChannel = resolveAgentChannel(ctx.workspaceDir);
  }
  if (!fallbackChannel && ctx?.messageChannel && ctx.messageChannel.includes("|")) {
    fallbackChannel = ctx.messageChannel;
  }
  console.log(`[claude-bg] Factory context: messageChannel=${ctx?.messageChannel}, agentAccountId=${ctx?.agentAccountId}, workspaceDir=${ctx?.workspaceDir}, fallbackChannel=${fallbackChannel}`);
  return {
    name: "harness_bg",
    description: "[LEGACY] Send a Claude Code session back to background (stop streaming). If no session specified, detaches whichever session is currently in foreground. Only applies to sessions launched via harness_launch.",
    parameters: Type.Object({
      session: Type.Optional(
        Type.String({
          description: "Session name or ID to send to background. If omitted, detaches the current foreground session."
        })
      )
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_bg");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      if (params.session) {
        const session = sessionManager.resolve(params.session, ctx?.agentId);
        if (!session) {
          return {
            content: [
              {
                type: "text",
                text: `Error: Session "${params.session}" not found.`
              }
            ]
          };
        }
        let channelId = resolveOriginChannel({ id: _id }, fallbackChannel);
        console.log(`[claude-bg] channelId resolved: ${channelId}, session.workdir=${session.workdir}`);
        if (channelId === "unknown" && hasValidOriginChannel(session)) {
          channelId = session.originChannel;
        }
        session.saveFgOutputOffset(channelId);
        session.foregroundChannels.delete(channelId);
        return {
          content: [
            {
              type: "text",
              text: `Session ${session.name} [${session.id}] moved to background.`
            }
          ]
        };
      }
      let resolvedId = resolveOriginChannel({ id: _id }, fallbackChannel);
      console.log(`[claude-bg] resolvedId (no session): ${resolvedId}`);
      if (resolvedId === "unknown") {
        const allSessionsForLookup = sessionManager.list("all");
        for (const s of allSessionsForLookup) {
          if (hasValidOriginChannel(s) && s.foregroundChannels.has(s.originChannel)) {
            resolvedId = s.originChannel;
            break;
          }
        }
      }
      const allSessions = sessionManager.list("all");
      const fgSessions = allSessions.filter(
        (s) => s.foregroundChannels.has(resolvedId)
      );
      if (fgSessions.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "No session is currently in foreground."
            }
          ]
        };
      }
      const names = [];
      for (const s of fgSessions) {
        s.saveFgOutputOffset(resolvedId);
        s.foregroundChannels.delete(resolvedId);
        names.push(`${s.name} [${s.id}]`);
      }
      return {
        content: [
          {
            type: "text",
            text: `Moved to background: ${names.join(", ")}`
          }
        ]
      };
    }
  };
}

// src/tools/claude-respond.ts
function makeClaudeRespondTool(ctx) {
  let fallbackChannel;
  if (ctx?.messageChannel && ctx?.agentAccountId) {
    const parts = ctx.messageChannel.split("|");
    if (parts.length >= 2) {
      fallbackChannel = `${parts[0]}|${ctx.agentAccountId}|${parts.slice(1).join("|")}`;
    }
  }
  if (!fallbackChannel && ctx?.workspaceDir) {
    fallbackChannel = resolveAgentChannel(ctx.workspaceDir);
  }
  if (!fallbackChannel && ctx?.messageChannel && ctx.messageChannel.includes("|")) {
    fallbackChannel = ctx.messageChannel;
  }
  return {
    name: "harness_respond",
    description: "[LEGACY] Send a follow-up message to a running Claude Code session. The session must be running. Sessions are multi-turn by default, so this works with any session unless it was launched with multi_turn_disabled: true. Only applies to sessions launched via harness_launch; harness_execute manages its own review-fix loop internally.",
    parameters: Type.Object({
      session: Type.String({
        description: "Session name or ID to respond to"
      }),
      message: Type.String({
        description: "The message to send to the session"
      }),
      interrupt: Type.Optional(
        Type.Boolean({
          description: "If true, interrupt the current turn before sending the message. Useful to redirect the session mid-response."
        })
      ),
      userInitiated: Type.Optional(
        Type.Boolean({
          description: "Set to true when the message comes from the user (not auto-generated). Resets the auto-respond counter and bypasses the auto-respond limit."
        })
      )
    }),
    async execute(_id, params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_respond");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const session = sessionManager.resolve(params.session, ctx?.agentId);
      if (!session) {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session "${params.session}" not found.`
            }
          ]
        };
      }
      if (session.status !== "running") {
        return {
          content: [
            {
              type: "text",
              text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}). Cannot send a message to a non-running session.`
            }
          ]
        };
      }
      const maxAutoResponds = pluginConfig.maxAutoResponds ?? 10;
      if (params.userInitiated) {
        session.resetAutoRespond();
      } else if (session.autoRespondCount >= maxAutoResponds) {
        return {
          content: [
            {
              type: "text",
              text: `\u26A0\uFE0F Auto-respond limit reached (${session.autoRespondCount}/${maxAutoResponds}). Ask the user to provide the answer for session ${session.name}. Then call claude_respond with their answer and set userInitiated: true to reset the counter.`
            }
          ]
        };
      }
      try {
        if (params.interrupt) {
          await session.interrupt();
        }
        await session.sendMessage(params.message);
        if (!params.userInitiated) {
          session.incrementAutoRespond();
        }
        if (sessionManager) {
          const respondMsg = [
            `\u21A9\uFE0F [${session.name}] Responded:`,
            params.message.length > 200 ? params.message.slice(0, 200) + "..." : params.message
          ].join("\n");
          sessionManager.deliverToTelegram(session, respondMsg, "responded");
        }
        const msgSummary = params.message.length > 80 ? params.message.slice(0, 80) + "..." : params.message;
        return {
          content: [
            {
              type: "text",
              text: [
                `Message sent to session ${session.name} [${session.id}].`,
                params.interrupt ? `  (interrupted current turn first)` : "",
                `  Message: "${msgSummary}"`,
                ``,
                `Use claude_output to see the response.`
              ].filter(Boolean).join("\n")
            }
          ]
        };
      } catch (err) {
        return {
          content: [
            {
              type: "text",
              text: `Error sending message: ${err.message}`
            }
          ]
        };
      }
    }
  };
}

// src/tools/claude-stats.ts
function makeClaudeStatsTool(_ctx) {
  return {
    name: "harness_stats",
    description: "[LEGACY] Show Claude Code Plugin usage metrics: session counts by status, average duration, and notable sessions. Covers all sessions \u2014 both harness_execute (primary path) and harness_launch (LEGACY direct path). For new coding work, prefer harness_execute.",
    parameters: Type.Object({}),
    async execute(_id, _params) {
      if (!isLegacyToolsEnabled()) {
        return legacyToolDisabledResult("harness_stats");
      }
      if (!sessionManager) {
        return {
          content: [
            {
              type: "text",
              text: "Error: SessionManager not initialized. The claude-code service must be running."
            }
          ]
        };
      }
      const metrics = sessionManager.getMetrics();
      const text = formatStats(metrics);
      return {
        content: [{ type: "text", text }]
      };
    }
  };
}

// src/commands/claude.ts
function registerClaudeCommand(api) {
  api.registerCommand({
    name: "harness",
    description: "[LEGACY] Launch a Claude Code session directly. For coding tasks with planning and review, use harness_execute instead. Usage: /harness [--name <name>] <prompt>",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      let args = (ctx.args ?? "").trim();
      if (!args) {
        return { text: "Usage: /harness [--name <name>] <prompt>" };
      }
      let name;
      const nameMatch = args.match(/^--name\s+(\S+)\s+/);
      if (nameMatch) {
        name = nameMatch[1];
        args = args.slice(nameMatch[0].length).trim();
      }
      const prompt = args;
      if (!prompt) {
        return { text: "Usage: /harness [--name <name>] <prompt>" };
      }
      try {
        const session = sessionManager.spawn({
          prompt,
          name,
          workdir: pluginConfig.defaultWorkdir || process.cwd(),
          model: pluginConfig.defaultModel,
          maxBudgetUsd: pluginConfig.defaultBudgetUsd ?? 5,
          originChannel: resolveOriginChannel(ctx)
        });
        const promptSummary = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        return {
          text: [
            `Session launched.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Prompt: "${promptSummary}"`,
            `  Status: ${session.status}`
          ].join("\n")
        };
      } catch (err) {
        return { text: `Error: ${err.message}` };
      }
    }
  });
}

// src/commands/claude-sessions.ts
function registerClaudeSessionsCommand(api) {
  api.registerCommand({
    name: "harness_sessions",
    description: "[LEGACY] List all Claude Code sessions (for sessions launched via /harness or harness_launch)",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_sessions");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const sessions = sessionManager.list("all");
      if (sessions.length === 0) {
        return { text: "No sessions found." };
      }
      const lines = sessions.map(formatSessionListing);
      return { text: lines.join("\n\n") };
    }
  });
}

// src/commands/claude-kill.ts
function registerClaudeKillCommand(api) {
  api.registerCommand({
    name: "harness_kill",
    description: "[LEGACY] Kill a Claude Code session by name or ID (for sessions launched via /harness or harness_launch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_kill");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const ref = ctx.args?.trim();
      if (!ref) {
        return { text: "Usage: /harness_kill <name-or-id>" };
      }
      const session = sessionManager.resolve(ref);
      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }
      if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
        return {
          text: `Session ${session.name} [${session.id}] is already ${session.status}. No action needed.`
        };
      }
      sessionManager.kill(session.id);
      return { text: `Session ${session.name} [${session.id}] has been terminated.` };
    }
  });
}

// src/commands/claude-fg.ts
function registerClaudeFgCommand(api) {
  api.registerCommand({
    name: "harness_fg",
    description: "[LEGACY] Bring a Claude Code session to foreground by name or ID (for sessions launched via /harness or harness_launch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_fg");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const ref = ctx.args?.trim();
      if (!ref) {
        return { text: "Usage: /harness_fg <name-or-id>" };
      }
      const session = sessionManager.resolve(ref);
      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }
      const channelId = resolveOriginChannel(ctx);
      const catchupLines = session.getCatchupOutput(channelId);
      session.foregroundChannels.add(channelId);
      const duration = formatDuration(session.duration);
      const header = [
        `Session ${session.name} [${session.id}] now in foreground.`,
        `Status: ${session.status.toUpperCase()} | Duration: ${duration}`,
        `${"\u2500".repeat(60)}`
      ].join("\n");
      let catchupSection = "";
      if (catchupLines.length > 0) {
        catchupSection = [
          `\u{1F4CB} Catchup (${catchupLines.length} missed output${catchupLines.length === 1 ? "" : "s"}):`,
          catchupLines.join("\n"),
          `${"\u2500".repeat(60)}`
        ].join("\n");
      }
      const body = catchupLines.length > 0 ? catchupSection : session.getOutput(30).length > 0 ? session.getOutput(30).join("\n") : "(no output yet)";
      const footer = session.status === "running" || session.status === "starting" ? `
${"\u2500".repeat(60)}
Streaming... Use /harness_bg to detach.` : `
${"\u2500".repeat(60)}
Session is ${session.status}.`;
      session.markFgOutputSeen(channelId);
      return { text: `${header}
${body}${footer}` };
    }
  });
}

// src/commands/claude-bg.ts
function registerClaudeBgCommand(api) {
  api.registerCommand({
    name: "harness_bg",
    description: "[LEGACY] Send the current foreground session back to background (for sessions launched via /harness or harness_launch)",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_bg");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const channelId = resolveOriginChannel(ctx);
      const ref = ctx.args?.trim();
      if (ref) {
        const session = sessionManager.resolve(ref);
        if (!session) {
          return { text: `Error: Session "${ref}" not found.` };
        }
        session.saveFgOutputOffset(channelId);
        session.foregroundChannels.delete(channelId);
        return {
          text: `Session ${session.name} [${session.id}] moved to background.`
        };
      }
      const allSessions = sessionManager.list("all");
      const fgSessions = allSessions.filter(
        (s) => s.foregroundChannels.has(channelId)
      );
      if (fgSessions.length === 0) {
        return { text: "No session is currently in foreground." };
      }
      const names = [];
      for (const s of fgSessions) {
        s.saveFgOutputOffset(channelId);
        s.foregroundChannels.delete(channelId);
        names.push(`${s.name} [${s.id}]`);
      }
      return { text: `Moved to background: ${names.join(", ")}` };
    }
  });
}

// src/commands/claude-resume.ts
function registerClaudeResumeCommand(api) {
  api.registerCommand({
    name: "harness_resume",
    description: "[LEGACY] Resume a previous Claude Code session launched via /harness or harness_launch. Usage: /harness_resume <id-or-name> [prompt] or /harness_resume --list to see resumable sessions.",
    acceptsArgs: true,
    requireAuth: true,
    handler: (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_resume");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      let args = (ctx.args ?? "").trim();
      if (!args) {
        return {
          text: "Usage: /harness_resume <id-or-name> [prompt]\n       /harness_resume --list \u2014 list resumable sessions\n       /harness_resume --fork <id-or-name> [prompt] \u2014 fork instead of continuing"
        };
      }
      if (args === "--list") {
        const persisted2 = sessionManager.listPersistedSessions();
        if (persisted2.length === 0) {
          return { text: "No resumable sessions found. Sessions are persisted after completion." };
        }
        const lines = persisted2.map((info) => {
          const promptSummary = info.prompt.length > 60 ? info.prompt.slice(0, 60) + "..." : info.prompt;
          const completedStr = info.completedAt ? `completed ${formatDuration(Date.now() - info.completedAt)} ago` : info.status;
          return [
            `  ${info.name} \u2014 ${completedStr}`,
            `    Claude ID: ${info.claudeSessionId}`,
            `    \u{1F4C1} ${info.workdir}`,
            `    \u{1F4DD} "${promptSummary}"`
          ].join("\n");
        });
        return {
          text: `Resumable sessions:

${lines.join("\n\n")}`
        };
      }
      let fork = false;
      if (args.startsWith("--fork ")) {
        fork = true;
        args = args.slice("--fork ".length).trim();
      }
      const spaceIdx = args.indexOf(" ");
      let ref;
      let prompt;
      if (spaceIdx === -1) {
        ref = args;
        prompt = "Continue where you left off.";
      } else {
        ref = args.slice(0, spaceIdx);
        prompt = args.slice(spaceIdx + 1).trim() || "Continue where you left off.";
      }
      const claudeSessionId = sessionManager.resolveClaudeSessionId(ref);
      if (!claudeSessionId) {
        return {
          text: `Error: Could not find a Claude session ID for "${ref}".
Use /harness_resume --list to see available sessions.`
        };
      }
      const config = ctx.config ?? {};
      const persisted = sessionManager.getPersistedSession(ref);
      const workdir = persisted?.workdir ?? process.cwd();
      try {
        const session = sessionManager.spawn({
          prompt,
          workdir,
          model: persisted?.model ?? config.defaultModel,
          maxBudgetUsd: config.defaultBudgetUsd ?? 5,
          resumeSessionId: claudeSessionId,
          forkSession: fork,
          originChannel: resolveOriginChannel(ctx),
          deliverChannel: persisted?.deliverChannel
        });
        const promptSummary = prompt.length > 80 ? prompt.slice(0, 80) + "..." : prompt;
        return {
          text: [
            `Session resumed${fork ? " (forked)" : ""}.`,
            `  Name: ${session.name}`,
            `  ID: ${session.id}`,
            `  Resume from: ${claudeSessionId}`,
            `  Dir: ${workdir}`,
            `  Prompt: "${promptSummary}"`
          ].join("\n")
        };
      } catch (err) {
        return { text: `Error: ${err.message}` };
      }
    }
  });
}

// src/commands/claude-respond.ts
function registerClaudeRespondCommand(api) {
  api.registerCommand({
    name: "harness_respond",
    description: "[LEGACY] Send a follow-up message to a running Claude Code session launched via /harness or harness_launch. Usage: /harness_respond <id-or-name> <message>",
    acceptsArgs: true,
    requireAuth: true,
    handler: async (ctx) => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_respond");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const args = (ctx.args ?? "").trim();
      if (!args) {
        return {
          text: "Usage: /harness_respond <id-or-name> <message>\n       /harness_respond --interrupt <id-or-name> <message>"
        };
      }
      let interrupt = false;
      let remaining = args;
      if (remaining.startsWith("--interrupt ")) {
        interrupt = true;
        remaining = remaining.slice("--interrupt ".length).trim();
      }
      const spaceIdx = remaining.indexOf(" ");
      if (spaceIdx === -1) {
        return {
          text: "Error: Missing message. Usage: /harness_respond <id-or-name> <message>"
        };
      }
      const ref = remaining.slice(0, spaceIdx);
      const message = remaining.slice(spaceIdx + 1).trim();
      if (!message) {
        return {
          text: "Error: Empty message. Usage: /harness_respond <id-or-name> <message>"
        };
      }
      const session = sessionManager.resolve(ref);
      if (!session) {
        return { text: `Error: Session "${ref}" not found.` };
      }
      if (session.status !== "running") {
        return {
          text: `Error: Session ${session.name} [${session.id}] is not running (status: ${session.status}).`
        };
      }
      try {
        if (interrupt) {
          await session.interrupt();
        }
        await session.sendMessage(message);
        session.resetAutoRespond();
        if (sessionManager) {
          const respondMsg = [
            `\u21A9\uFE0F [${session.name}] Responded:`,
            message.length > 200 ? message.slice(0, 200) + "..." : message
          ].join("\n");
          sessionManager.deliverToTelegram(session, respondMsg, "responded");
        }
        const msgSummary = message.length > 80 ? message.slice(0, 80) + "..." : message;
        return {
          text: [
            `Message sent to ${session.name} [${session.id}].`,
            interrupt ? `  (interrupted current turn)` : "",
            `  "${msgSummary}"`
          ].filter(Boolean).join("\n")
        };
      } catch (err) {
        return { text: `Error: ${err.message}` };
      }
    }
  });
}

// src/commands/claude-stats.ts
function registerClaudeStatsCommand(api) {
  api.registerCommand({
    name: "harness_stats",
    description: "[LEGACY] Show Claude Code Plugin usage metrics (covers both harness_execute primary path and harness_launch LEGACY path). Part of the direct-session surface \u2014 for new coding tasks prefer harness_execute.",
    acceptsArgs: false,
    requireAuth: true,
    handler: () => {
      if (!isLegacyToolsEnabled()) {
        return legacyCommandDisabledResult("harness_stats");
      }
      if (!sessionManager) {
        return {
          text: "Error: SessionManager not initialized. The claude-code service must be running."
        };
      }
      const metrics = sessionManager.getMetrics();
      return { text: formatStats(metrics) };
    }
  });
}

// src/gateway.ts
var import_fs8 = require("fs");
var import_path8 = require("path");
init_checkpoint();
var harnessExecuteFactory = null;
function setHarnessExecuteFactory(factory) {
  harnessExecuteFactory = factory;
}
function registerGatewayMethods(api) {
  api.registerGatewayMethod("harness.execute", ({ respond, params }) => {
    if (!harnessExecuteFactory) {
      return respond(false, { error: "harness_execute factory not registered" });
    }
    if (!params?.request) {
      return respond(false, { error: "Missing required parameter: request" });
    }
    const ctx = {
      agentId: params.agentId ?? "gateway",
      workspaceDir: params.workdir ?? pluginConfig.defaultWorkdir ?? process.cwd(),
      messageChannel: params.channel ?? pluginConfig.fallbackChannel
    };
    respond(true, { status: "accepted", message: "Harness execution started. Results will be pushed to channel." });
    void (async () => {
      try {
        const tool = harnessExecuteFactory(ctx);
        await tool.execute("gateway-rpc", {
          request: params.request,
          workdir: params.workdir,
          tier_override: params.tier_override,
          max_budget_usd: params.max_budget_usd,
          reviewOnly: params.reviewOnly
        });
      } catch (err) {
        console.error(`[harness.execute] Gateway RPC background error: ${err?.message ?? String(err)}`);
      }
    })();
  });
  api.registerGatewayMethod("harness.kill", ({ respond, params }) => {
    const planId = params?.planId;
    if (!planId) {
      return respond(false, { error: "Missing required parameter: planId" });
    }
    const checkpointDir2 = (0, import_path8.join)("/tmp", "harness", planId);
    const cpPath = (0, import_path8.join)(checkpointDir2, "checkpoint.json");
    if (!(0, import_fs8.existsSync)(cpPath)) {
      return respond(false, { error: `Checkpoint not found: ${planId}` });
    }
    try {
      const cp = JSON.parse((0, import_fs8.readFileSync)(cpPath, "utf-8"));
      const stateRoot = (0, import_path8.join)("/tmp", "claude-realtime");
      const killedJobs = [];
      for (const [taskId, session] of Object.entries(cp.sessions ?? {})) {
        const jobId = session.worker;
        if (!jobId) continue;
        const stateDir = (0, import_path8.join)(stateRoot, jobId);
        try {
          (0, import_fs8.writeFileSync)((0, import_path8.join)(stateDir, "feedback"), "ABORT\n", "utf8");
        } catch {
        }
        try {
          (0, import_fs8.writeFileSync)((0, import_path8.join)(stateDir, "status"), "aborted\n", "utf8");
        } catch {
        }
        try {
          const pidStr = (0, import_fs8.readFileSync)((0, import_path8.join)(stateDir, "pid"), "utf8").trim();
          const pid = parseInt(pidStr, 10);
          if (pid > 0) {
            process.kill(pid, "SIGTERM");
            killedJobs.push(`${jobId} (pid ${pid})`);
          }
        } catch {
        }
        killedJobs.push(jobId);
      }
      cp.status = "failed";
      cp.tasks = cp.tasks.map((t) => {
        if (t.status === "in-progress" || t.status === "in-review") {
          return { ...t, status: "failed", reviewPassed: false };
        }
        return t;
      });
      cp.lastUpdated = (/* @__PURE__ */ new Date()).toISOString();
      saveCheckpoint(cp, cp.workdir ?? "");
      respond(true, {
        planId,
        status: "killed",
        killedJobs,
        message: `Plan ${planId} aborted. ${killedJobs.length} job(s) signaled.`
      });
    } catch (err) {
      respond(false, { error: `Failed to kill plan: ${err?.message ?? String(err)}` });
    }
  });
  api.registerGatewayMethod("claude-code.sessions", ({ respond, params }) => {
    const sessionManager2 = getSessionManager();
    if (!sessionManager2) {
      return respond(false, { error: "SessionManager not initialized" });
    }
    const filter = params?.status ?? "all";
    const sessions = sessionManager2.list(filter);
    const result = sessions.map((s) => ({
      id: s.id,
      name: s.name,
      status: s.status,
      prompt: s.prompt,
      workdir: s.workdir,
      model: s.model,
      costUsd: s.costUsd,
      startedAt: s.startedAt,
      completedAt: s.completedAt,
      durationMs: s.duration,
      claudeSessionId: s.claudeSessionId,
      foreground: s.foregroundChannels.size > 0,
      multiTurn: s.multiTurn,
      // Also include human-readable listing
      display: formatSessionListing(s)
    }));
    respond(true, { sessions: result, count: result.length });
  });
  api.registerGatewayMethod("claude-code.launch", ({ respond, params }) => {
    const sessionManager2 = getSessionManager();
    if (!sessionManager2) {
      return respond(false, { error: "SessionManager not initialized" });
    }
    if (!params?.prompt) {
      return respond(false, { error: "Missing required parameter: prompt" });
    }
    try {
      const session = sessionManager2.spawn({
        prompt: params.prompt,
        name: params.name,
        workdir: params.workdir || pluginConfig.defaultWorkdir || process.cwd(),
        model: params.model || pluginConfig.defaultModel,
        maxBudgetUsd: params.maxBudgetUsd ?? params.max_budget_usd ?? pluginConfig.defaultBudgetUsd ?? 5,
        systemPrompt: params.systemPrompt ?? params.system_prompt,
        allowedTools: params.allowedTools ?? params.allowed_tools,
        resumeSessionId: params.resumeSessionId ?? params.resume_session_id,
        forkSession: params.forkSession ?? params.fork_session,
        multiTurn: !(params.multiTurnDisabled ?? params.multi_turn_disabled),
        originChannel: params.originChannel ?? "gateway"
      });
      respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        workdir: session.workdir,
        model: session.model
      });
    } catch (err) {
      respond(false, { error: err.message });
    }
  });
  api.registerGatewayMethod("claude-code.kill", ({ respond, params }) => {
    const sessionManager2 = getSessionManager();
    if (!sessionManager2) {
      return respond(false, { error: "SessionManager not initialized" });
    }
    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }
    const session = sessionManager2.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }
    if (session.status === "completed" || session.status === "failed" || session.status === "killed") {
      return respond(true, {
        id: session.id,
        name: session.name,
        status: session.status,
        message: `Session already ${session.status}`
      });
    }
    sessionManager2.kill(session.id);
    respond(true, {
      id: session.id,
      name: session.name,
      status: "killed",
      message: `Session ${session.name} [${session.id}] terminated`
    });
  });
  api.registerGatewayMethod("claude-code.output", ({ respond, params }) => {
    const sessionManager2 = getSessionManager();
    if (!sessionManager2) {
      return respond(false, { error: "SessionManager not initialized" });
    }
    const ref = params?.session ?? params?.id;
    if (!ref) {
      return respond(false, { error: "Missing required parameter: session (name or ID)" });
    }
    const session = sessionManager2.resolve(ref);
    if (!session) {
      return respond(false, { error: `Session "${ref}" not found` });
    }
    const lines = params?.full ? session.getOutput() : session.getOutput(params?.lines ?? 50);
    respond(true, {
      id: session.id,
      name: session.name,
      status: session.status,
      costUsd: session.costUsd,
      durationMs: session.duration,
      duration: formatDuration(session.duration),
      lines,
      lineCount: lines.length,
      result: session.result ?? null
    });
  });
  api.registerGatewayMethod("claude-code.stats", ({ respond, params }) => {
    const sessionManager2 = getSessionManager();
    if (!sessionManager2) {
      return respond(false, { error: "SessionManager not initialized" });
    }
    const metrics = sessionManager2.getMetrics();
    const costPerDay = {};
    for (const [key, val] of metrics.costPerDay) {
      costPerDay[key] = val;
    }
    const running = sessionManager2.list("running").length;
    respond(true, {
      totalCostUsd: metrics.totalCostUsd,
      costPerDay,
      sessionsByStatus: {
        ...metrics.sessionsByStatus,
        running
      },
      totalLaunched: metrics.totalLaunched,
      averageDurationMs: metrics.sessionsWithDuration > 0 ? metrics.totalDurationMs / metrics.sessionsWithDuration : 0,
      mostExpensive: metrics.mostExpensive,
      // Human-readable version too
      display: formatStats(metrics)
    });
  });
}

// src/session-manager.ts
var import_child_process6 = require("child_process");

// src/session.ts
var import_fs10 = require("fs");
var import_os8 = require("os");
var import_path10 = require("path");
var import_claude_agent_sdk = require("@anthropic-ai/claude-agent-sdk");

// src/git-sync-recovery.ts
var import_fs9 = require("fs");
var import_child_process5 = require("child_process");
var import_path9 = require("path");
var UNTRACKED_OVERWRITE_PATTERN = /The following untracked working tree files would be overwritten by (?:merge|checkout|switch):/i;
var STOP_LINE_PATTERN = /Please move or remove them before you (?:merge|switch branches|checkout)\./i;
function sanitizeTimestamp(value) {
  return value.replace(/[:.]/g, "-");
}
function extractBlockingPaths(errorText) {
  const lines = errorText.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => UNTRACKED_OVERWRITE_PATTERN.test(line));
  if (startIndex === -1) return [];
  const paths = [];
  for (let i = startIndex + 1; i < lines.length; i++) {
    const line = lines[i];
    if (STOP_LINE_PATTERN.test(line) || /^Aborting\b/i.test(line.trim())) {
      break;
    }
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("error:")) continue;
    if (/^hint:/i.test(trimmed)) continue;
    paths.push(trimmed);
  }
  return [...new Set(paths)];
}
function getGitRepoRoot(workdir) {
  try {
    return (0, import_child_process5.execFileSync)("git", ["rev-parse", "--show-toplevel"], {
      cwd: workdir,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() || null;
  } catch {
    return null;
  }
}
function isUntracked(repoRoot, relativePath) {
  try {
    const output = (0, import_child_process5.execFileSync)(
      "git",
      ["ls-files", "--others", "--exclude-standard", "--", relativePath],
      {
        cwd: repoRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trim();
    return output.split(/\r?\n/).some((line) => line.trim() === relativePath);
  } catch {
    return false;
  }
}
function safeMove(source, destination) {
  (0, import_fs9.mkdirSync)((0, import_path9.dirname)(destination), { recursive: true });
  try {
    (0, import_fs9.renameSync)(source, destination);
    return;
  } catch (error) {
    if (error?.code !== "EXDEV") {
      throw error;
    }
  }
  const stats = (0, import_fs9.lstatSync)(source);
  if (stats.isDirectory()) {
    (0, import_fs9.cpSync)(source, destination, { recursive: true, errorOnExist: true });
    (0, import_fs9.rmSync)(source, { recursive: true, force: false });
    return;
  }
  (0, import_fs9.cpSync)(source, destination, { errorOnExist: true });
  (0, import_fs9.rmSync)(source, { force: false });
}
function createUniqueBackupPath(backupRoot, relativePath) {
  const normalized = relativePath.replace(/^\/+/, "");
  let candidate = (0, import_path9.join)(backupRoot, normalized);
  if (!(0, import_fs9.existsSync)(candidate)) return candidate;
  const baseDir = (0, import_path9.dirname)(candidate);
  const fileName = candidate.slice(baseDir.length + 1);
  let index = 2;
  while (true) {
    const next = (0, import_path9.join)(baseDir, `${fileName}.bak-${index}`);
    if (!(0, import_fs9.existsSync)(next)) return next;
    index++;
  }
}
function isRealtimeSyncConflictError(input) {
  const text = typeof input === "string" ? input : input instanceof Error ? input.message : String(input ?? "");
  return UNTRACKED_OVERWRITE_PATTERN.test(text);
}
function tryRecoverRealtimeSyncConflict(workdir, errorText) {
  if (!isRealtimeSyncConflictError(errorText)) return null;
  const repoRoot = getGitRepoRoot(workdir);
  if (!repoRoot) return null;
  const blockingPaths = extractBlockingPaths(errorText);
  if (blockingPaths.length === 0) return null;
  const verified = blockingPaths.map((relativePath) => {
    const absolutePath = (0, import_path9.resolve)(repoRoot, relativePath);
    const relativeToRoot = (0, import_path9.relative)(repoRoot, absolutePath);
    if (relativeToRoot.startsWith("..") || relativeToRoot.includes(`..${import_path9.sep}`)) {
      return null;
    }
    if (!(0, import_fs9.existsSync)(absolutePath)) return null;
    if (!isUntracked(repoRoot, relativePath)) return null;
    return { relativePath, absolutePath };
  }).filter((entry) => entry !== null);
  if (verified.length === 0) return null;
  const backupRoot = (0, import_path9.join)(
    repoRoot,
    ".openclaw-harness",
    "realtime-sync-conflicts",
    sanitizeTimestamp((/* @__PURE__ */ new Date()).toISOString())
  );
  const moved = [];
  for (const entry of verified) {
    const backupPath = createUniqueBackupPath(backupRoot, entry.relativePath);
    safeMove(entry.absolutePath, backupPath);
    moved.push({
      original: entry.absolutePath,
      backup: backupPath
    });
  }
  (0, import_fs9.mkdirSync)(backupRoot, { recursive: true });
  (0, import_fs9.writeFileSync)(
    (0, import_path9.join)(backupRoot, "manifest.json"),
    JSON.stringify(
      {
        recoveredAt: (/* @__PURE__ */ new Date()).toISOString(),
        reason: "untracked working tree files would be overwritten by realtime git sync",
        repoRoot,
        errorExcerpt: errorText.slice(0, 4e3),
        moved
      },
      null,
      2
    ),
    "utf8"
  );
  return {
    repoRoot,
    backupRoot,
    moved
  };
}

// src/session.ts
var OUTPUT_BUFFER_MAX = 200;
var claudeSdkAuthScrubDepth = 0;
var savedAnthropicApiKey;
function shouldPreferClaudeCredentials(baseEnv) {
  const apiKey = (baseEnv.ANTHROPIC_API_KEY ?? "").trim();
  if (!apiKey) return false;
  const home = (baseEnv.HOME ?? "").trim() || (0, import_os8.homedir)();
  const credentialsPath = (0, import_path10.join)(home, ".claude", ".credentials.json");
  return (0, import_fs10.existsSync)(credentialsPath);
}
async function withClaudeSdkAuthEnv(fn) {
  if (!shouldPreferClaudeCredentials(process.env)) {
    return await fn();
  }
  if (claudeSdkAuthScrubDepth === 0) {
    savedAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    console.warn("[Session] Scrubbing ANTHROPIC_API_KEY for Claude SDK because ~/.claude/.credentials.json exists");
  }
  claudeSdkAuthScrubDepth += 1;
  try {
    return await fn();
  } finally {
    claudeSdkAuthScrubDepth = Math.max(0, claudeSdkAuthScrubDepth - 1);
    if (claudeSdkAuthScrubDepth === 0) {
      if (savedAnthropicApiKey) {
        process.env.ANTHROPIC_API_KEY = savedAnthropicApiKey;
      } else {
        delete process.env.ANTHROPIC_API_KEY;
      }
      savedAnthropicApiKey = void 0;
    }
  }
}
var MessageStream = class {
  queue = [];
  resolve = null;
  done = false;
  push(text, sessionId) {
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
      session_id: sessionId
    };
    this.queue.push(msg);
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }
  end() {
    this.done = true;
    if (this.resolve) {
      this.resolve();
      this.resolve = null;
    }
  }
  async *[Symbol.asyncIterator]() {
    while (true) {
      while (this.queue.length > 0) {
        yield this.queue.shift();
      }
      if (this.done) return;
      await new Promise((r) => {
        this.resolve = r;
      });
    }
  }
};
var Session = class _Session {
  id;
  name;
  claudeSessionId;
  // Config
  prompt;
  workdir;
  model;
  maxBudgetUsd;
  internal;
  systemPrompt;
  allowedTools;
  permissionMode;
  // Resume/fork config (Task 16)
  resumeSessionId;
  forkSession;
  // Multi-turn config (Task 15)
  multiTurn;
  messageStream;
  queryHandle;
  idleTimer;
  // Safety-net idle timer: fires only if NO messages (text, tool_use, result) arrive
  // for 15 seconds. The primary "waiting for input" signal is the multi-turn
  // end-of-turn result handler — this timer is a rare fallback for edge cases
  // (e.g. Claude stuck waiting for permission/clarification without a result event).
  safetyNetTimer;
  static SAFETY_NET_IDLE_MS = 15e3;
  // State
  status = "starting";
  error;
  startedAt;
  completedAt;
  // SDK handles
  abortController;
  // Output
  outputBuffer = [];
  // Result — authoritative terminal result record.
  // Set on every SDK result event. The LAST write wins (multi-turn keeps updating).
  // Once status becomes terminal (completed/failed/killed), this is frozen.
  result;
  // Terminal result snapshot — set exactly once when the session transitions to
  // a terminal state (completed/failed/killed). This is the authoritative record.
  // Unlike `result` (which is overwritten on every SDK result event including
  // multi-turn end-of-turn), `terminalResult` is immutable after first write.
  terminalResult;
  // Cost
  costUsd = 0;
  // Foreground
  foregroundChannels = /* @__PURE__ */ new Set();
  // Per-channel output offset: tracks the outputBuffer index last seen while foregrounded.
  // Used by claude_fg to send "catchup" of missed output when re-foregrounding.
  fgOutputOffsets = /* @__PURE__ */ new Map();
  // Origin channel -- the channel that launched this session (for background notifications)
  originChannel;
  // Deliver channel -- the agent's own channel for --deliver args in wakeAgent()
  deliverChannel;
  // Origin agent ID -- the agent that launched this session (for targeted wake events)
  originAgentId;
  // Flags
  budgetExhausted = false;
  waitingForInputFired = false;
  // Auto-respond safety cap: tracks consecutive agent-initiated responds
  autoRespondCount = 0;
  // Event callbacks
  onOutput;
  onToolUse;
  onBudgetExhausted;
  onComplete;
  onWaitingForInput;
  /**
   * Freeze the terminal result record. Called exactly once when the session
   * transitions to a terminal state. Subsequent calls are no-ops (idempotent).
   * Logs a diagnostic warning if the session reaches terminal state without
   * a usable result payload.
   */
  freezeTerminalState(terminalStatus) {
    if (this.terminalResult) {
      console.warn(
        `[Session] ${this.id} freezeTerminalState called again (current=${this.terminalResult.status}, new=${terminalStatus}) \u2014 ignoring`
      );
      return;
    }
    const now = Date.now();
    const hasResult = !!this.result;
    const hasOutput = this.outputBuffer.length > 0;
    const hasResultText = !!this.result?.result;
    const hasUsableOutput = hasOutput || hasResultText;
    this.terminalResult = {
      status: terminalStatus,
      subtype: this.result?.subtype ?? "unknown",
      result: this.result?.result,
      is_error: this.result?.is_error ?? terminalStatus !== "completed",
      costUsd: this.costUsd,
      num_turns: this.result?.num_turns ?? 0,
      duration_ms: this.result?.duration_ms ?? now - this.startedAt,
      completedAt: now,
      hasUsableOutput
    };
    if (!hasUsableOutput) {
      console.warn(
        `[Session] ${this.id} reached terminal state="${terminalStatus}" without usable output. hasResult=${hasResult}, hasOutput=${hasOutput}, hasResultText=${hasResultText}, subtype=${this.result?.subtype ?? "none"}, error=${this.error ?? "none"}`
      );
    } else {
      console.log(
        `[Session] ${this.id} terminal state frozen: status=${terminalStatus}, subtype=${this.result?.subtype ?? "none"}, cost=$${this.costUsd.toFixed(4)}, turns=${this.result?.num_turns ?? 0}, outputLines=${this.outputBuffer.length}`
      );
    }
  }
  constructor(config, name) {
    this.id = nanoid(8);
    this.name = name;
    this.prompt = config.prompt;
    this.workdir = config.workdir;
    this.model = resolveModelAlias(config.model);
    this.maxBudgetUsd = config.maxBudgetUsd;
    this.internal = config.internal ?? false;
    this.systemPrompt = config.systemPrompt;
    this.allowedTools = config.allowedTools;
    this.permissionMode = config.permissionMode ?? pluginConfig.permissionMode ?? "bypassPermissions";
    this.originChannel = config.originChannel;
    this.deliverChannel = config.deliverChannel;
    this.originAgentId = config.originAgentId;
    this.resumeSessionId = config.resumeSessionId;
    this.forkSession = config.forkSession;
    this.multiTurn = config.multiTurn ?? true;
    this.startedAt = Date.now();
    this.abortController = new AbortController();
  }
  async start() {
    void this.runSession(0).catch((err) => {
      if (this.status === "starting" || this.status === "running") {
        this.status = "failed";
        this.error = err?.message ?? String(err);
        this.completedAt = Date.now();
        this.freezeTerminalState("failed");
        this.clearSafetyNetTimer();
        if (this.idleTimer) clearTimeout(this.idleTimer);
      }
    });
  }
  async runSession(retryCount) {
    let q;
    try {
      const options = {
        cwd: this.workdir,
        model: this.model,
        maxBudgetUsd: this.maxBudgetUsd,
        permissionMode: this.permissionMode,
        allowDangerouslySkipPermissions: this.permissionMode === "bypassPermissions",
        allowedTools: this.allowedTools,
        includePartialMessages: true,
        abortController: this.abortController,
        ...this.systemPrompt ? { systemPrompt: this.systemPrompt } : {}
      };
      if (this.resumeSessionId) {
        options.resume = this.resumeSessionId;
        if (this.forkSession) {
          options.forkSession = true;
        }
      }
      let prompt;
      if (this.multiTurn) {
        this.messageStream = new MessageStream();
        this.messageStream.push(this.prompt, "");
        prompt = this.messageStream;
      } else {
        prompt = this.prompt;
      }
      await withClaudeSdkAuthEnv(async () => {
        q = (0, import_claude_agent_sdk.query)({
          prompt,
          options
        });
        this.queryHandle = q;
        await this.consumeMessages(q);
      });
    } catch (err) {
      const errorMessage = err?.message ?? String(err);
      let recovery = null;
      if (!this.multiTurn && retryCount === 0) {
        try {
          recovery = tryRecoverRealtimeSyncConflict(this.workdir, errorMessage);
        } catch (recoveryError) {
          console.warn(
            `[Session] ${this.id} realtime sync recovery failed: ${recoveryError?.message ?? String(recoveryError)}`
          );
        }
      }
      if (recovery) {
        console.warn(
          `[Session] ${this.id} recovered realtime sync conflict by moving ${recovery.moved.length} untracked path(s) to ${recovery.backupRoot}; retrying once`
        );
        this.error = void 0;
        this.status = "starting";
        this.completedAt = void 0;
        this.claudeSessionId = void 0;
        this.result = void 0;
        this.queryHandle = void 0;
        this.clearSafetyNetTimer();
        if (this.idleTimer) {
          clearTimeout(this.idleTimer);
          this.idleTimer = void 0;
        }
        await this.runSession(retryCount + 1);
        return;
      }
      if (this.status === "starting" || this.status === "running") {
        this.status = "failed";
        this.error = errorMessage;
        this.completedAt = Date.now();
        this.freezeTerminalState("failed");
        this.clearSafetyNetTimer();
        if (this.idleTimer) clearTimeout(this.idleTimer);
      }
    }
  }
  /**
   * Reset the safety-net idle timer. Called on EVERY incoming message
   * (text, tool_use, result). If no message of any kind arrives for
   * SAFETY_NET_IDLE_MS (15s), we assume the session is stuck waiting
   * for user input (e.g. a permission prompt without a result event).
   *
   * The primary "waiting for input" signal is the multi-turn end-of-turn
   * result handler — this timer is a rare fallback for edge cases only.
   */
  resetSafetyNetTimer() {
    this.clearSafetyNetTimer();
    this.safetyNetTimer = setTimeout(() => {
      this.safetyNetTimer = void 0;
      if (this.status === "running" && this.onWaitingForInput && !this.waitingForInputFired) {
        console.log(`[Session] ${this.id} no messages for ${_Session.SAFETY_NET_IDLE_MS / 1e3}s \u2014 firing onWaitingForInput (safety-net)`);
        this.waitingForInputFired = true;
        this.onWaitingForInput(this);
      }
    }, _Session.SAFETY_NET_IDLE_MS);
  }
  /**
   * Cancel the safety-net idle timer.
   */
  clearSafetyNetTimer() {
    if (this.safetyNetTimer) {
      clearTimeout(this.safetyNetTimer);
      this.safetyNetTimer = void 0;
    }
  }
  /**
   * Reset (or start) the idle timer for multi-turn sessions.
   * If no sendMessage() call arrives within the configured idle timeout, the
   * session is automatically killed to avoid zombie sessions stuck in "running"
   * forever. Timeout is read from pluginConfig.idleTimeoutMinutes (default 30).
   */
  resetIdleTimer() {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    if (!this.multiTurn) return;
    const idleTimeoutMs = (pluginConfig.idleTimeoutMinutes ?? 30) * 60 * 1e3;
    this.idleTimer = setTimeout(() => {
      if (this.status === "running") {
        console.log(`[Session] ${this.id} idle timeout reached (${pluginConfig.idleTimeoutMinutes ?? 30}min), auto-killing`);
        this.kill();
      }
    }, idleTimeoutMs);
  }
  /**
   * Send a follow-up message to a running multi-turn session.
   * Uses the SDK's streamInput() method to push a new user message.
   */
  async sendMessage(text) {
    if (this.status !== "running") {
      throw new Error(`Session is not running (status: ${this.status})`);
    }
    this.resetIdleTimer();
    this.waitingForInputFired = false;
    if (this.multiTurn && this.messageStream) {
      this.messageStream.push(text, this.claudeSessionId ?? "");
    } else if (this.queryHandle && typeof this.queryHandle.streamInput === "function") {
      const userMsg = {
        type: "user",
        message: { role: "user", content: text },
        parent_tool_use_id: null,
        session_id: this.claudeSessionId ?? ""
      };
      async function* oneMessage() {
        yield userMsg;
      }
      await this.queryHandle.streamInput(oneMessage());
    } else {
      throw new Error("Session does not support multi-turn messaging. Launch with multiTurn: true or use the SDK streamInput.");
    }
  }
  /**
   * Interrupt the current turn (e.g. to send a new message mid-response).
   */
  async interrupt() {
    if (this.queryHandle && typeof this.queryHandle.interrupt === "function") {
      await this.queryHandle.interrupt();
    }
  }
  async consumeMessages(q) {
    for await (const msg of q) {
      this.resetSafetyNetTimer();
      if (msg.type === "system" && msg.subtype === "init") {
        this.claudeSessionId = msg.session_id;
        this.status = "running";
        this.resetIdleTimer();
      } else if (msg.type === "assistant") {
        this.waitingForInputFired = false;
        const contentBlocks = msg.message?.content ?? [];
        console.log(`[Session] ${this.id} assistant message received, blocks=${contentBlocks.length}, fgChannels=${JSON.stringify([...this.foregroundChannels])}`);
        for (const block of contentBlocks) {
          if (block.type === "text") {
            const text = block.text;
            this.outputBuffer.push(text);
            if (this.outputBuffer.length > OUTPUT_BUFFER_MAX) {
              this.outputBuffer.splice(
                0,
                this.outputBuffer.length - OUTPUT_BUFFER_MAX
              );
            }
            if (this.onOutput) {
              console.log(`[Session] ${this.id} calling onOutput, textLen=${text.length}`);
              this.onOutput(text);
            } else {
              console.log(`[Session] ${this.id} onOutput callback NOT set`);
            }
          } else if (block.type === "tool_use") {
            if (this.onToolUse) {
              console.log(`[Session] ${this.id} calling onToolUse, tool=${block.name}`);
              this.onToolUse(block.name, block.input);
            } else {
              console.log(`[Session] ${this.id} onToolUse callback NOT set`);
            }
          }
        }
      } else if (msg.type === "result") {
        this.result = {
          subtype: msg.subtype,
          duration_ms: msg.duration_ms,
          total_cost_usd: msg.total_cost_usd,
          num_turns: msg.num_turns,
          result: msg.result,
          is_error: msg.is_error,
          session_id: msg.session_id
        };
        this.costUsd = msg.total_cost_usd;
        const isMultiTurnEndOfTurn = this.multiTurn && this.messageStream && msg.subtype === "success";
        if (isMultiTurnEndOfTurn) {
          console.log(`[Session] ${this.id} multi-turn end-of-turn (turn ${msg.num_turns}), staying open`);
          this.clearSafetyNetTimer();
          this.resetIdleTimer();
          if (this.onWaitingForInput && !this.waitingForInputFired) {
            console.log(`[Session] ${this.id} calling onWaitingForInput`);
            this.waitingForInputFired = true;
            this.onWaitingForInput(this);
          }
        } else {
          this.clearSafetyNetTimer();
          if (this.idleTimer) clearTimeout(this.idleTimer);
          const terminalStatus = msg.subtype === "success" ? "completed" : "failed";
          this.status = terminalStatus;
          this.completedAt = Date.now();
          this.freezeTerminalState(terminalStatus);
          if (this.messageStream) {
            this.messageStream.end();
          }
          if (msg.subtype === "error_max_budget_usd") {
            this.budgetExhausted = true;
            if (this.onBudgetExhausted) {
              this.onBudgetExhausted(this);
            }
          }
          if (this.onComplete) {
            console.log(`[Session] ${this.id} calling onComplete, status=${this.status}`);
            this.onComplete(this);
          } else {
            console.log(`[Session] ${this.id} onComplete callback NOT set`);
          }
        }
      }
    }
  }
  kill() {
    if (this.status !== "starting" && this.status !== "running") return;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.clearSafetyNetTimer();
    this.status = "killed";
    this.completedAt = Date.now();
    this.freezeTerminalState("killed");
    if (this.messageStream) {
      this.messageStream.end();
    }
    this.abortController.abort();
  }
  getOutput(lines) {
    if (lines === void 0) {
      return this.outputBuffer.slice();
    }
    return this.outputBuffer.slice(-lines);
  }
  /**
   * Get all output produced since this channel was last foregrounded (or since launch).
   * Returns the missed output lines. If this is the first time foregrounding,
   * returns the full buffer (same as getOutput()).
   */
  getCatchupOutput(channelId) {
    const lastOffset = this.fgOutputOffsets.get(channelId) ?? 0;
    const available = this.outputBuffer.length;
    if (lastOffset >= available) {
      return [];
    }
    return this.outputBuffer.slice(lastOffset);
  }
  /**
   * Record that this channel has seen all current output (call when foregrounding).
   * Sets the offset to the current end of the buffer.
   */
  markFgOutputSeen(channelId) {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }
  /**
   * Save the current output position for a channel (call when backgrounding).
   * This records where they left off so catchup can resume from here.
   */
  saveFgOutputOffset(channelId) {
    this.fgOutputOffsets.set(channelId, this.outputBuffer.length);
  }
  /**
   * Increment the auto-respond counter (called on each agent-initiated claude_respond tool call).
   */
  incrementAutoRespond() {
    this.autoRespondCount++;
  }
  /**
   * Reset the auto-respond counter (called when the user sends a message via /claude_respond command).
   */
  resetAutoRespond() {
    this.autoRespondCount = 0;
  }
  get duration() {
    return (this.completedAt ?? Date.now()) - this.startedAt;
  }
};

// src/session-manager.ts
var CLEANUP_MAX_AGE_MS = 60 * 60 * 1e3;
var WAITING_EVENT_DEBOUNCE_MS = 5e3;
var WAKE_CLI_TIMEOUT_MS = 3e4;
var WAKE_RETRY_DELAY_MS = 5e3;
var SessionManager = class {
  sessions = /* @__PURE__ */ new Map();
  maxSessions;
  maxPersistedSessions;
  notificationRouter = null;
  /** Debounce tracker: session ID → last waiting-for-input event timestamp */
  lastWaitingEventTimestamps = /* @__PURE__ */ new Map();
  /** Pending retry timer IDs from fireSystemEventWithRetry, cleared on shutdown */
  pendingRetryTimers = /* @__PURE__ */ new Set();
  /**
   * Persisted Claude session IDs — survives session cleanup/GC.
   * Key: our internal session ID (nanoid) or session name.
   * Allows resume even after the Session object has been garbage-collected.
   */
  persistedSessions = /* @__PURE__ */ new Map();
  /** Aggregated metrics (Task 18) */
  _metrics = {
    totalCostUsd: 0,
    costPerDay: /* @__PURE__ */ new Map(),
    sessionsByStatus: { completed: 0, failed: 0, killed: 0 },
    totalLaunched: 0,
    totalDurationMs: 0,
    sessionsWithDuration: 0,
    mostExpensive: null
  };
  constructor(maxSessions = 5, maxPersistedSessions = 50) {
    this.maxSessions = maxSessions;
    this.maxPersistedSessions = maxPersistedSessions;
  }
  /**
   * Ensure name is unique among existing sessions.
   * If collision, append -2, -3, etc.
   */
  uniqueName(baseName) {
    const existing = new Set(
      [...this.sessions.values()].map((s) => s.name)
    );
    if (!existing.has(baseName)) return baseName;
    let i = 2;
    while (existing.has(`${baseName}-${i}`)) i++;
    return `${baseName}-${i}`;
  }
  /**
   * Number of currently available session slots.
   */
  availableSlots() {
    const activeCount = [...this.sessions.values()].filter(
      (s) => s.status === "starting" || s.status === "running"
    ).length;
    return Math.max(0, this.maxSessions - activeCount);
  }
  /**
   * Wait until at least one session slot is available.
   * Polls every 2 seconds, times out after 5 minutes.
   */
  async waitForSlot() {
    const maxWaitMs = 5 * 60 * 1e3;
    const pollMs = 2e3;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      if (this.availableSlots() > 0) return true;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return false;
  }
  spawn(config) {
    const activeCount = [...this.sessions.values()].filter(
      (s) => s.status === "starting" || s.status === "running"
    ).length;
    if (activeCount >= this.maxSessions) {
      throw new Error(
        `Max sessions reached (${this.maxSessions}). Kill a session first.`
      );
    }
    const baseName = config.name || generateSessionName(config.prompt);
    const name = this.uniqueName(baseName);
    const session = new Session(config, name);
    this.sessions.set(session.id, session);
    this._metrics.totalLaunched++;
    if (config.internal) {
      session.onComplete = () => {
        console.log(`[SessionManager] Internal session completed: session=${session.id} (${session.name})`);
        this.persistSession(session);
      };
    } else if (this.notificationRouter) {
      const nr = this.notificationRouter;
      console.log(`[SessionManager] Wiring notification callbacks for session=${session.id} (${session.name}), originChannel=${session.originChannel}`);
      session.onOutput = (text) => {
        console.log(`[SessionManager] session.onOutput fired for session=${session.id}, textLen=${text.length}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
        nr.onAssistantText(session, text);
        for (const ch of session.foregroundChannels) {
          session.markFgOutputSeen(ch);
        }
      };
      session.onToolUse = (toolName, toolInput) => {
        console.log(`[SessionManager] session.onToolUse fired for session=${session.id}, tool=${toolName}`);
        nr.onToolUse(session, toolName, toolInput);
      };
      session.onBudgetExhausted = () => {
        console.log(`[SessionManager] session.onBudgetExhausted fired for session=${session.id}`);
        nr.onBudgetExhausted(session);
      };
      session.onWaitingForInput = () => {
        console.log(`[SessionManager] session.onWaitingForInput fired for session=${session.id}`);
        nr.onWaitingForInput(session);
        this.triggerWaitingForInputEvent(session);
      };
      session.onComplete = () => {
        console.log(`[SessionManager] session.onComplete fired for session=${session.id}, budgetExhausted=${session.budgetExhausted}`);
        this.persistSession(session);
        if (!session.budgetExhausted) {
          nr.onSessionComplete(session);
        }
        this.triggerAgentEvent(session);
      };
    } else {
      console.warn(`[SessionManager] No NotificationRouter available when spawning session=${session.id} (${session.name})`);
    }
    session.start();
    if (!config.internal) {
      const promptSummary = session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt;
      this.deliverToTelegram(
        session,
        `\u21A9\uFE0F [${session.name}] Launched:
${promptSummary}`,
        "launched"
      );
    }
    return session;
  }
  /**
   * Persist a session's Claude session ID for future resume.
   * Called when a session completes so its ID is available after GC.
   */
  persistSession(session) {
    const alreadyPersisted = this.persistedSessions.has(session.id);
    if (!alreadyPersisted) {
      this.recordSessionMetrics(session);
    }
    if (!session.claudeSessionId) return;
    const info = {
      claudeSessionId: session.claudeSessionId,
      name: session.name,
      prompt: session.prompt,
      workdir: session.workdir,
      model: session.model,
      completedAt: session.completedAt,
      status: session.status,
      costUsd: session.costUsd,
      originAgentId: session.originAgentId,
      originChannel: session.originChannel,
      deliverChannel: session.deliverChannel
    };
    this.persistedSessions.set(session.id, info);
    this.persistedSessions.set(session.name, info);
    this.persistedSessions.set(session.claudeSessionId, info);
    console.log(`[SessionManager] Persisted session ${session.name} [${session.id}] -> claudeSessionId=${session.claudeSessionId}`);
  }
  /**
   * Record metrics for a completed session (Task 18).
   * Called once per session when it finishes (completed/failed/killed).
   */
  recordSessionMetrics(session) {
    const cost = session.costUsd ?? 0;
    const status = session.status;
    this._metrics.totalCostUsd += cost;
    const dateKey = new Date(session.completedAt ?? session.startedAt).toISOString().slice(0, 10);
    this._metrics.costPerDay.set(
      dateKey,
      (this._metrics.costPerDay.get(dateKey) ?? 0) + cost
    );
    if (status === "completed" || status === "failed" || status === "killed") {
      this._metrics.sessionsByStatus[status]++;
    }
    if (session.completedAt) {
      const durationMs = session.completedAt - session.startedAt;
      this._metrics.totalDurationMs += durationMs;
      this._metrics.sessionsWithDuration++;
    }
    if (!this._metrics.mostExpensive || cost > this._metrics.mostExpensive.costUsd) {
      this._metrics.mostExpensive = {
        id: session.id,
        name: session.name,
        costUsd: cost,
        prompt: session.prompt.length > 80 ? session.prompt.slice(0, 80) + "..." : session.prompt
      };
    }
  }
  /**
   * Public accessor for aggregated metrics (Task 18).
   * Returns a snapshot of the current metrics.
   */
  getMetrics() {
    return this._metrics;
  }
  /**
   * Send a Telegram notification AND wake the agent via detached subprocess.
   *
   * Used for notifications that REQUIRE agent reaction:
   *   🔔 Claude asks (waiting for input) — agent must respond or forward to user
   *   ✅ Claude finished (completed)     — agent must summarize the result
   *
   * Strategy:
   *  1. ALWAYS send Telegram notification first via deliverToTelegram()
   *     (fire-and-forget, uses openclaw message send, never blocks on agent).
   *  2. Then spawn a detached `openclaw agent --agent <id> --message` process.
   *     The process runs independently (detached + unref'd) — the plugin does not
   *     wait for it. No error callback, no timeout. Fire-and-forget.
   *  3. If no agentId, fall back to broadcast system event via fireSystemEventWithRetry().
   *
   * Call sites: triggerWaitingForInputEvent() and triggerAgentEvent() (completed branch).
   */
  /**
   * Parse a session's originChannel into --deliver CLI args.
   *
   * originChannel formats:
   *   "telegram|accountId|chatId"  → 3 segments (full)
   *   "telegram|chatId"            → 2 segments (no account)
   *
   * Returns empty array if channel is missing/invalid (safe no-op).
   */
  buildDeliverArgs(originChannel) {
    if (!originChannel || originChannel === "unknown" || originChannel === "gateway") {
      return [];
    }
    const parts = originChannel.split("|");
    if (parts.length < 2) {
      return [];
    }
    if (parts.length >= 3) {
      return ["--deliver", "--reply-channel", parts[0], "--reply-account", parts[1], "--reply-to", parts.slice(2).join("|")];
    }
    return ["--deliver", "--reply-channel", parts[0], "--reply-to", parts[1]];
  }
  wakeAgent(session, eventText, telegramText, label) {
    this.deliverToTelegram(session, telegramText, label);
    const agentId = session.originAgentId?.trim();
    if (!agentId) {
      console.warn(`[SessionManager] No originAgentId for ${label} session=${session.id}, falling back to system event`);
      this.fireSystemEventWithRetry(eventText, label, session.id);
      return;
    }
    const deliverArgs = this.buildDeliverArgs(session.deliverChannel ?? session.originChannel);
    const child = (0, import_child_process6.spawn)("openclaw", ["agent", "--agent", agentId, "--message", eventText, ...deliverArgs], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
    console.log(`[SessionManager] Spawned detached wake for agent=${agentId}, ${label} session=${session.id} (pid=${child.pid}, deliver=${deliverArgs.length > 0})`);
  }
  /**
   * Send an informational notification to Telegram WITHOUT waking the agent.
   *
   * Used for notifications that are user-monitoring only (Level 1 — deliver only):
   *   ↩️ Launched  — session started with initial prompt
   *   ↩️ Responded — user replied to a waiting session
   *   ❌ Failed    — session failed
   *   ⛔ Killed    — session was killed
   *
   * Also called by wakeAgent() to send Telegram notification before IPC wake.
   *
   * Routes through NotificationRouter.emitToChannel() → sendMessage callback →
   * `openclaw message send` CLI. The sendMessage callback handles channel format
   * parsing and fallback channels when originChannel is "unknown".
   *
   * External callers: src/commands/claude-respond.ts, src/tools/claude-respond.ts
   */
  deliverToTelegram(session, notificationText, label) {
    if (!this.notificationRouter) {
      console.warn(`[SessionManager] Cannot deliver ${label} to Telegram for session=${session.id} (no NotificationRouter)`);
      return;
    }
    const channel = session.deliverChannel ?? session.originChannel ?? "unknown";
    console.log(`[SessionManager] Delivering ${label} to Telegram for session=${session.id} via channel=${channel}`);
    this.notificationRouter.emitToChannel(channel, notificationText);
  }
  /**
   * Fire a broadcast system event with a single retry after WAKE_RETRY_DELAY_MS.
   * Ensures transient CLI/gateway failures don't cause a permanent 60min notification gap.
   */
  fireSystemEventWithRetry(eventText, label, sessionId) {
    const args = ["system", "event", "--text", eventText, "--mode", "now"];
    (0, import_child_process6.execFile)("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (err, _stdout, stderr) => {
      if (err) {
        console.error(`[SessionManager] System event failed for ${label} session=${sessionId}: ${err.message}`);
        if (stderr) console.error(`[SessionManager] stderr: ${stderr}`);
        console.warn(`[SessionManager] Scheduling retry in ${WAKE_RETRY_DELAY_MS}ms for ${label} session=${sessionId}`);
        const timer = setTimeout(() => {
          this.pendingRetryTimers.delete(timer);
          (0, import_child_process6.execFile)("openclaw", args, { timeout: WAKE_CLI_TIMEOUT_MS }, (retryErr, _retryStdout, retryStderr) => {
            if (retryErr) {
              console.error(`[SessionManager] System event retry also failed for ${label} session=${sessionId}: ${retryErr.message}`);
              if (retryStderr) console.error(`[SessionManager] retry stderr: ${retryStderr}`);
            } else {
              console.log(`[SessionManager] System event retry succeeded for ${label} session=${sessionId}`);
            }
          });
        }, WAKE_RETRY_DELAY_MS);
        this.pendingRetryTimers.add(timer);
      } else {
        console.log(`[SessionManager] System event sent for ${label} session=${sessionId}`);
      }
    });
  }
  /**
   * Trigger an OpenClaw agent event when a Claude Code session completes.
   *
   * For ✅ completed sessions: uses wakeAgent() (Telegram notification + IPC wake)
   *   because the agent must summarize the result. Telegram is sent first, then IPC.
   * For ❌ failed / ⛔ killed sessions: uses deliverToTelegram() (Telegram only)
   *   because these are informational — no agent reaction needed.
   */
  triggerAgentEvent(session) {
    const status = session.status;
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) {
      preview = preview.slice(-500);
    }
    if (status === "completed") {
      const eventText = [
        `Claude Code session completed.`,
        `Name: ${session.name} | ID: ${session.id}`,
        `Status: ${status}`,
        ``,
        `Output preview:`,
        preview,
        ``,
        `Use claude_output(session='${session.id}', full=true) to get the full result and transmit the analysis to the user.`
      ].join("\n");
      const cleanPreview = preview.replace(/[*`_~]/g, "");
      const telegramLines = [
        `\u2705 [${session.name}] Completed`,
        `   \u{1F4C1} ${session.workdir}`,
        `   \u{1F4B0} $${(session.costUsd ?? 0).toFixed(4)}`
      ];
      if (cleanPreview.trim()) {
        telegramLines.push(``, cleanPreview);
      }
      const telegramText = telegramLines.join("\n");
      console.log(`[SessionManager] Triggering agent wake for completed session=${session.id}`);
      this.wakeAgent(session, eventText, telegramText, "completed");
    } else {
      const emoji = status === "killed" ? "\u26D4" : "\u274C";
      const promptSummary = session.prompt.length > 60 ? session.prompt.slice(0, 60) + "..." : session.prompt;
      const notificationText = [
        `${emoji} [${session.name}] ${status === "killed" ? "Killed" : "Failed"}`,
        `   \u{1F4C1} ${session.workdir}`,
        `   \u{1F4DD} "${promptSummary}"`,
        ...session.error ? [`   \u26A0\uFE0F ${session.error}`] : []
      ].join("\n");
      console.log(`[SessionManager] Delivering ${status} notification for session=${session.id}`);
      this.deliverToTelegram(session, notificationText, status);
    }
    this.lastWaitingEventTimestamps.delete(session.id);
  }
  /**
   * Trigger an OpenClaw event when a session is waiting for user input.
   * Works for ALL session types (single-turn and multi-turn).
   *
   * Telegram notification is sent UNCONDITIONALLY (no debounce) so the user
   * always sees it. The IPC wake is debounced (5s) to avoid spamming the agent.
   */
  triggerWaitingForInputEvent(session) {
    const lastLines = session.getOutput(5);
    let preview = lastLines.join("\n");
    if (preview.length > 500) {
      preview = preview.slice(-500);
    }
    const telegramText = `\u{1F514} [${session.name}] Claude asks:
${preview.length > 200 ? preview.slice(-200) : preview}`;
    const now = Date.now();
    const lastTs = this.lastWaitingEventTimestamps.get(session.id);
    if (lastTs && now - lastTs < WAITING_EVENT_DEBOUNCE_MS) {
      console.log(`[SessionManager] Debounced wake for session=${session.id} (last sent ${now - lastTs}ms ago), sending Telegram only`);
      this.deliverToTelegram(session, telegramText, "waiting");
      return;
    }
    this.lastWaitingEventTimestamps.set(session.id, now);
    const sessionType = session.multiTurn ? "Multi-turn session" : "Session";
    const eventText = [
      `${sessionType} is waiting for input.`,
      `Name: ${session.name} | ID: ${session.id}`,
      ``,
      `Last output:`,
      preview,
      ``,
      `Use claude_respond(session='${session.id}', message='...') to send a reply, or claude_output(session='${session.id}') to see full context.`
    ].join("\n");
    this.wakeAgent(session, eventText, telegramText, "waiting");
  }
  /**
   * Resolve a Claude session ID from our internal ID, name, or Claude session ID.
   * Looks in both active sessions and persisted (completed/GC'd) sessions.
   */
  resolveClaudeSessionId(ref, agentId) {
    const active = this.resolve(ref, agentId);
    if (active?.claudeSessionId) return active.claudeSessionId;
    const persisted = this.persistedSessions.get(ref);
    if (persisted?.claudeSessionId) return persisted.claudeSessionId;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(ref)) return ref;
    return void 0;
  }
  /**
   * Get persisted session info by any identifier.
   */
  getPersistedSession(ref) {
    return this.persistedSessions.get(ref);
  }
  /**
   * List all persisted sessions (for /claude_resume listing).
   */
  listPersistedSessions() {
    const seen = /* @__PURE__ */ new Set();
    const result = [];
    for (const info of this.persistedSessions.values()) {
      if (!seen.has(info.claudeSessionId)) {
        seen.add(info.claudeSessionId);
        result.push(info);
      }
    }
    return result.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0));
  }
  /**
   * Resolve a session by ID or name.
   * When agentId is provided, only returns the session if it was launched by that agent.
   * When agentId is undefined (commands, gateway), no ownership filtering is applied.
   */
  resolve(idOrName, agentId) {
    let session = this.sessions.get(idOrName);
    if (!session) {
      for (const s of this.sessions.values()) {
        if (s.name === idOrName) {
          session = s;
          break;
        }
      }
    }
    if (!session) return void 0;
    if (agentId && session.originAgentId !== agentId) return void 0;
    return session;
  }
  get(id) {
    return this.sessions.get(id);
  }
  list(filter) {
    let result = [...this.sessions.values()];
    if (filter && filter !== "all") {
      result = result.filter((s) => s.status === filter);
    }
    return result.sort((a, b) => b.startedAt - a.startedAt);
  }
  kill(id) {
    const session = this.sessions.get(id);
    if (!session) {
      return false;
    }
    session.kill();
    if (!this.persistedSessions.has(session.id)) {
      this.recordSessionMetrics(session);
    }
    this.persistSession(session);
    if (session.internal) {
      return true;
    }
    if (this.notificationRouter) {
      this.notificationRouter.onSessionComplete(session);
    }
    this.triggerAgentEvent(session);
    return true;
  }
  killAll() {
    for (const session of this.sessions.values()) {
      if (session.status === "starting" || session.status === "running") {
        this.kill(session.id);
      }
    }
    for (const timer of this.pendingRetryTimers) {
      clearTimeout(timer);
    }
    this.pendingRetryTimers.clear();
  }
  cleanup() {
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.completedAt && (session.status === "completed" || session.status === "failed" || session.status === "killed") && now - session.completedAt > CLEANUP_MAX_AGE_MS) {
        this.persistSession(session);
        this.sessions.delete(id);
        this.lastWaitingEventTimestamps.delete(id);
      }
    }
    const unique2 = this.listPersistedSessions();
    if (unique2.length > this.maxPersistedSessions) {
      const toEvict = unique2.slice(this.maxPersistedSessions);
      for (const info of toEvict) {
        for (const [key, val] of this.persistedSessions) {
          if (val.claudeSessionId === info.claudeSessionId) {
            this.persistedSessions.delete(key);
          }
        }
      }
      console.log(`[SessionManager] Evicted ${toEvict.length} oldest persisted sessions (cap=${this.maxPersistedSessions})`);
    }
  }
};

// src/notifications.ts
var DEBOUNCE_MS = 500;
var LONG_RUNNING_THRESHOLD_MS = parseInt(process.env.OPENCLAW_HARNESS_LONG_RUNNING_THRESHOLD_MS ?? "", 10) || 2 * 60 * 1e3;
var NotificationRouter = class {
  sendMessage;
  // Track debounced foreground streaming: key = `${sessionId}|${channelId}`
  debounceMap = /* @__PURE__ */ new Map();
  // Track which sessions have already sent the 10min reminder
  longRunningReminded = /* @__PURE__ */ new Set();
  // Interval for checking long-running sessions
  reminderInterval = null;
  // Reference to get all sessions for reminder checks
  getActiveSessions = null;
  constructor(sendMessage) {
    this.sendMessage = (channelId, text) => {
      console.log(`[NotificationRouter] sendMessage -> channel=${channelId}, textLen=${text.length}, preview=${text.slice(0, 120)}`);
      sendMessage(channelId, text);
    };
    console.log("[NotificationRouter] Initialized");
  }
  /**
   * Start the reminder check interval.
   * Pass a function that returns currently active sessions.
   */
  startReminderCheck(getActiveSessions) {
    this.getActiveSessions = getActiveSessions;
    this.reminderInterval = setInterval(() => this.checkLongRunning(), 6e4);
  }
  /**
   * Stop the reminder check interval and flush all debounce timers.
   */
  stop() {
    if (this.reminderInterval) {
      clearInterval(this.reminderInterval);
      this.reminderInterval = null;
    }
    for (const [key, entry] of this.debounceMap) {
      clearTimeout(entry.timer);
      if (entry.buffer) {
        const [_sessionId, channelId] = key.split("|", 2);
        this.sendMessage(channelId, entry.buffer);
      }
    }
    this.debounceMap.clear();
    this.longRunningReminded.clear();
  }
  // ─── Foreground streaming ──────────────────────────────────────────
  /**
   * Called when an assistant text block arrives on a session.
   * If the session has foreground channels, debounce and stream to them.
   */
  onAssistantText(session, text) {
    console.log(`[NotificationRouter] onAssistantText session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}, textLen=${text.length}`);
    if (session.foregroundChannels.size === 0) {
      console.log(`[NotificationRouter] onAssistantText SKIPPED \u2014 no foreground channels`);
      return;
    }
    for (const channelId of session.foregroundChannels) {
      console.log(`[NotificationRouter] appendDebounced -> session=${session.id}, channel=${channelId}`);
      this.appendDebounced(session.id, channelId, text);
    }
  }
  /**
   * Called when a tool_use block arrives on an assistant message.
   * Shows a compact one-line indicator on foreground channels.
   */
  onToolUse(session, toolName, toolInput) {
    console.log(`[NotificationRouter] onToolUse session=${session.id}, tool=${toolName}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    if (session.foregroundChannels.size === 0) return;
    const inputSummary = summarizeToolInput(toolInput);
    const line = `\u{1F527} ${toolName}${inputSummary ? ` \u2014 ${inputSummary}` : ""}`;
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
      this.sendMessage(channelId, line);
    }
  }
  // ─── Completion notifications ──────────────────────────────────────
  /**
   * Called when a session completes (success or failure).
   * Notifies ALL channels that have ever been associated with this session:
   * - Foreground channels get a notification
   * - If no foreground channels, notify via a "last known" channel if available
   *
   * For background sessions, we store the originating channel in session metadata.
   */
  onSessionComplete(session) {
    console.log(`[NotificationRouter] onSessionComplete session=${session.id} (${session.name}), status=${session.status}, fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    const msg = formatCompletionNotification(session);
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }
    this.cleanupSession(session.id);
  }
  /**
   * Called when budget is exhausted (subtype: "error_max_budget_usd").
   * This is effectively handled by onSessionComplete since it's a result event,
   * but we expose it separately for clarity and custom formatting.
   */
  onBudgetExhausted(session) {
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    const duration = formatDuration(session.duration);
    const msg = [
      `\u26D4 Session limit reached \u2014 ${session.name} [${session.id}] (${duration})`,
      `   \u{1F4C1} ${session.workdir}`
    ].join("\n");
    for (const channelId of session.foregroundChannels) {
      this.sendMessage(channelId, msg);
    }
    this.cleanupSession(session.id);
  }
  // ─── Waiting for input (all session types) ─────────────────────────
  /**
   * Called when any session is waiting for user input (e.g. Claude asked a question,
   * needs a permission decision, or finished a turn in multi-turn mode).
   * Notifies foreground and origin channels so the user knows Claude needs a response.
   */
  onWaitingForInput(session) {
    console.log(`[NotificationRouter] onWaitingForInput session=${session.id} (${session.name}), fgChannels=${JSON.stringify([...session.foregroundChannels])}`);
    for (const channelId of session.foregroundChannels) {
      this.flushDebounced(session.id, channelId);
    }
    for (const channelId of session.foregroundChannels) {
      const duration = formatDuration(session.duration);
      const msg = [
        `\u{1F4AC} Session ${session.name} [${session.id}] is waiting for input (${duration})`,
        `   Use claude_respond to reply.`
      ].join("\n");
      this.sendMessage(channelId, msg);
    }
  }
  // ─── Public message passthrough ─────────────────────────────────────
  /**
   * Emit a message to a specific channel. Used by tools (e.g. claude_respond)
   * to display messages in the conversation thread without going through
   * the foreground streaming / debounce logic.
   */
  emitToChannel(channelId, text) {
    this.sendMessage(channelId, text);
  }
  // ─── Long-running reminder ─────────────────────────────────────────
  /**
   * Periodic check: notify if a background session (no foreground channels)
   * has been running for more than 10 minutes. Only once per session.
   */
  checkLongRunning() {
    if (!this.getActiveSessions) return;
    const sessions = this.getActiveSessions();
    const now = Date.now();
    for (const session of sessions) {
      if ((session.status === "running" || session.status === "starting") && session.foregroundChannels.size === 0 && !this.longRunningReminded.has(session.id) && now - session.startedAt > LONG_RUNNING_THRESHOLD_MS) {
        this.longRunningReminded.add(session.id);
        const duration = formatDuration(now - session.startedAt);
        const msg = [
          `\u23F1\uFE0F Session ${session.name} [${session.id}] running for ${duration}`,
          `   \u{1F4C1} ${session.workdir}`,
          `   Use claude_fg to check on it, or claude_kill to stop it.`
        ].join("\n");
        const notifyChannel = session.deliverChannel ?? session.originChannel;
        if (notifyChannel) {
          this.sendMessage(notifyChannel, msg);
        }
      }
    }
  }
  // ─── Debounce internals ────────────────────────────────────────────
  debounceKey(sessionId, channelId) {
    return `${sessionId}|${channelId}`;
  }
  appendDebounced(sessionId, channelId, text) {
    const key = this.debounceKey(sessionId, channelId);
    const existing = this.debounceMap.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      existing.buffer += text;
      existing.timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
    } else {
      const timer = setTimeout(() => {
        this.flushDebounced(sessionId, channelId);
      }, DEBOUNCE_MS);
      this.debounceMap.set(key, { buffer: text, timer });
    }
  }
  flushDebounced(sessionId, channelId) {
    const key = this.debounceKey(sessionId, channelId);
    const entry = this.debounceMap.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    if (entry.buffer) {
      console.log(`[NotificationRouter] flushDebounced -> session=${sessionId}, channel=${channelId}, bufferLen=${entry.buffer.length}`);
      this.sendMessage(channelId, entry.buffer);
    }
    this.debounceMap.delete(key);
  }
  cleanupSession(sessionId) {
    for (const key of this.debounceMap.keys()) {
      if (key.startsWith(`${sessionId}|`)) {
        const entry = this.debounceMap.get(key);
        clearTimeout(entry.timer);
        this.debounceMap.delete(key);
      }
    }
    this.longRunningReminded.delete(sessionId);
  }
};
function formatCompletionNotification(session) {
  const duration = formatDuration(session.duration);
  const promptSummary = session.prompt.length > 60 ? session.prompt.slice(0, 60) + "..." : session.prompt;
  if (session.status === "completed") {
    return [
      `\u2705 Claude Code [${session.id}] completed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`
    ].join("\n");
  }
  if (session.status === "failed") {
    const errorDetail = session.error ? `   \u26A0\uFE0F ${session.error}` : session.result?.subtype ? `   \u26A0\uFE0F ${session.result.subtype}` : "";
    return [
      `\u274C Claude Code [${session.id}] failed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`,
      ...errorDetail ? [errorDetail] : []
    ].join("\n");
  }
  if (session.status === "killed") {
    return [
      `\u26D4 Claude Code [${session.id}] killed (${duration})`,
      `   \u{1F4C1} ${session.workdir}`,
      `   \u{1F4DD} "${promptSummary}"`
    ].join("\n");
  }
  return `Session [${session.id}] finished with status: ${session.status}`;
}
function summarizeToolInput(input) {
  if (!input || typeof input !== "object") return "";
  if (input.file_path) return truncate(input.file_path, 60);
  if (input.path) return truncate(input.path, 60);
  if (input.command) return truncate(input.command, 80);
  if (input.pattern) return truncate(input.pattern, 60);
  if (input.glob) return truncate(input.glob, 60);
  const firstValue = Object.values(input).find(
    (v) => typeof v === "string" && v.length > 0
  );
  if (firstValue) return truncate(String(firstValue), 60);
  return "";
}
function truncate(s, maxLen) {
  if (s.length <= maxLen) return s;
  return s.slice(0, maxLen - 3) + "...";
}

// index.ts
var import_child_process7 = require("child_process");
function register(api) {
  let sm = null;
  let nr = null;
  let cleanupInterval = null;
  const toolCache = /* @__PURE__ */ new Map();
  const cacheKey = (name, ctx) => `${name}:${ctx?.agentId ?? ""}:${ctx?.workspaceDir ?? ""}:${ctx?.messageChannel ?? ""}`;
  const cachedFactory = (name, make) => (ctx) => {
    const key = cacheKey(name, ctx);
    const cached = toolCache.get(key);
    if (cached) return cached;
    console.log(`[harness] registerTool factory: ${name}, agentId=${ctx?.agentId}, workspace=${ctx?.workspaceDir}`);
    const tool = make(ctx);
    toolCache.set(key, tool);
    return tool;
  };
  api.registerTool(cachedFactory("harness_launch", makeClaudeLaunchTool), { optional: false });
  api.registerTool(cachedFactory("harness_sessions", makeClaudeSessionsTool), { optional: false });
  api.registerTool(cachedFactory("harness_kill", makeClaudeKillTool), { optional: false });
  api.registerTool(cachedFactory("harness_output", makeClaudeOutputTool), { optional: false });
  api.registerTool(cachedFactory("harness_fg", makeClaudeFgTool), { optional: false });
  api.registerTool(cachedFactory("harness_bg", makeClaudeBgTool), { optional: false });
  api.registerTool(cachedFactory("harness_respond", makeClaudeRespondTool), { optional: false });
  api.registerTool(cachedFactory("harness_stats", makeClaudeStatsTool), { optional: false });
  api.registerTool(cachedFactory("harness_execute", makeHarnessExecuteTool), { optional: false });
  registerClaudeCommand(api);
  registerClaudeSessionsCommand(api);
  registerClaudeKillCommand(api);
  registerClaudeFgCommand(api);
  registerClaudeBgCommand(api);
  registerClaudeResumeCommand(api);
  registerClaudeRespondCommand(api);
  registerClaudeStatsCommand(api);
  registerGatewayMethods(api);
  setHarnessExecuteFactory(cachedFactory("harness_execute", makeHarnessExecuteTool));
  api.registerService({
    id: "openclaw-harness",
    start: () => {
      const config = api.pluginConfig ?? api.getConfig?.() ?? {};
      console.log("[claude-code-plugin] Raw config from getConfig():", JSON.stringify(config));
      setPluginConfig(config);
      if (api.runtime) {
        setPluginRuntime(api.runtime);
        console.log("[harness] api.runtime stored \u2014 subagent.run() available");
      } else {
        console.warn("[harness] api.runtime not available \u2014 falling back to sessionManager.spawn()");
      }
      sm = new SessionManager(
        pluginConfig.maxSessions,
        pluginConfig.maxPersistedSessions
      );
      setSessionManager(sm);
      const sendMessage = (channelId, text) => {
        let fallbackChannel = "telegram";
        let fallbackTarget = "";
        let fallbackAccount;
        if (pluginConfig.fallbackChannel?.includes("|")) {
          const fbParts = pluginConfig.fallbackChannel.split("|");
          if (fbParts.length >= 3 && fbParts[0] && fbParts[1]) {
            fallbackChannel = fbParts[0];
            fallbackAccount = fbParts[1];
            fallbackTarget = fbParts.slice(2).join("|");
          } else if (fbParts[0] && fbParts[1]) {
            fallbackChannel = fbParts[0];
            fallbackTarget = fbParts[1];
          }
        }
        let channel = fallbackChannel;
        let target = fallbackTarget;
        let account = fallbackAccount;
        if (channelId === "unknown" || !channelId) {
          if (fallbackTarget) {
            console.log(`[claude-code] sendMessage: channelId="${channelId}", using fallback ${fallbackChannel}|${fallbackTarget}${fallbackAccount ? ` (account=${fallbackAccount})` : ""}`);
          } else {
            console.warn(`[claude-code] sendMessage: channelId="${channelId}" and no fallbackChannel configured \u2014 message will not be sent`);
            return;
          }
        } else if (channelId.includes("|")) {
          const parts = channelId.split("|");
          if (parts.length >= 3) {
            channel = parts[0];
            account = parts[1];
            target = parts.slice(2).join("|");
          } else if (parts[0] && parts[1]) {
            channel = parts[0];
            target = parts[1];
          }
        } else if (/^-?\d+$/.test(channelId)) {
          channel = "telegram";
          target = channelId;
        } else if (fallbackTarget) {
          console.log(`[claude-code] sendMessage: unrecognized channelId="${channelId}", using fallback ${fallbackChannel}|${fallbackTarget}`);
        } else {
          console.warn(`[claude-code] sendMessage: unrecognized channelId="${channelId}" and no fallbackChannel configured \u2014 message will not be sent`);
          return;
        }
        console.log(`[claude-code] sendMessage -> channel=${channel}, target=${target}${account ? `, account=${account}` : ""}, textLen=${text.length}`);
        const cliArgs = ["message", "send", "--channel", channel];
        if (account) {
          cliArgs.push("--account", account);
        }
        cliArgs.push("--target", target, "-m", text);
        (0, import_child_process7.execFile)("openclaw", cliArgs, { timeout: 15e3 }, (err, stdout, stderr) => {
          if (err) {
            console.error(`[claude-code] sendMessage CLI ERROR: ${err.message}`);
            if (stderr) console.error(`[claude-code] sendMessage CLI STDERR: ${stderr}`);
          } else {
            console.log(`[claude-code] sendMessage CLI OK -> channel=${channel}, target=${target}${account ? `, account=${account}` : ""}`);
            if (stdout.trim()) console.log(`[claude-code] sendMessage CLI STDOUT: ${stdout.trim()}`);
          }
        });
      };
      nr = new NotificationRouter(sendMessage);
      setNotificationRouter(nr);
      sm.notificationRouter = nr;
      nr.startReminderCheck(() => sm?.list("running") ?? []);
      cleanupInterval = setInterval(() => {
        sm.cleanup();
        try {
          const { cleanupStaleCheckpoints: cleanupStaleCheckpoints2 } = (init_checkpoint(), __toCommonJS(checkpoint_exports));
          cleanupStaleCheckpoints2();
        } catch {
        }
      }, 5 * 60 * 1e3);
    },
    stop: () => {
      if (nr) nr.stop();
      if (sm) sm.killAll();
      if (cleanupInterval) clearInterval(cleanupInterval);
      cleanupInterval = null;
      sm = null;
      nr = null;
      setSessionManager(null);
      setNotificationRouter(null);
    }
  });
}
var index_default = {
  id: "openclaw-harness",
  name: "OpenClaw Harness",
  description: "Plan-Work-Review loop for coding tasks. Routes requests by complexity, dispatches workers, cross-model review with gap detection.",
  register
};
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  register
});
