// Generate the OpenTelemetry Collector config that reports host + agentd
// process health from a machine running agentd (ELL-21).
//
// Topology: a *bundled local collector* (`otelcol-contrib`) per agentd host,
// scraping with the upstream `hostmetrics` receiver and exporting OTLP/HTTP.
// agentd itself is NOT modified — it keeps its hand-rolled OTLP *log* exporter
// for `codetel.*` events. Host metrics are a separate, orthogonal signal that a
// stock collector already knows how to produce, which is the whole point of the
// issue: use an existing host-metrics path, not a bespoke monitoring agent.
// See docs/otel/agentd-host-metrics.md for the topology decision record.
//
// Two export modes:
//   direct  → straight to https://ingest.codetelemetry.com (per-tenant key)
//   gateway → to a user-managed collector, which fans out to CodeTelemetry
//
// Three properties this file is responsible for, because nothing downstream
// enforces them:
//   1. The ingest key is NEVER inlined. The config references `${env:VAR}` so
//      the secret lives in the service environment, not a world-readable YAML.
//   2. Cardinality is bounded by an explicit metric allowlist (HOST_METRIC_CONTRACT)
//      rather than by whatever the collector happens to enable by default — a
//      collector upgrade must not silently widen the contract.
//   3. Sensitive attributes are dropped client-side. The production metrics
//      pipeline deliberately skips `transform/scrub_secrets` (only logs and
//      traces get it — see iac/cdk/config/collector/collector-config.aws.yaml),
//      so anything we ship here is what gets stored.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { renderYaml, type YamlValue } from "./yaml.ts";

/** Env var the collector service reads the CodeTelemetry ingest key from. */
export const DEFAULT_KEY_ENV = "CODETELEMETRY_INGEST_KEY";

/** `service.name` for host telemetry. Deliberately distinct from agentd's own
 *  `agentd` service so host metrics never get mistaken for agent activity. */
export const DEFAULT_SERVICE_NAME = "agentd-host";
export const SERVICE_NAMESPACE = "codetelemetry";

/**
 * The metric contract. This is the complete set of metric names the host
 * pipeline is allowed to emit — enforced at runtime by `filter/contract` and
 * documented in docs/otel/agentd-host-metrics.md. Portable across Windows,
 * macOS and Linux: every name here is produced by the upstream `hostmetrics`
 * receiver on all three (per-platform gaps are listed in the doc, and a missing
 * metric is simply absent rather than an error).
 */
export const HOST_METRIC_CONTRACT: readonly string[] = [
  // cpu + load
  "system.cpu.utilization",
  "system.cpu.load_average.1m",
  "system.cpu.load_average.5m",
  "system.cpu.load_average.15m",
  // memory
  "system.memory.usage",
  "system.memory.utilization",
  // swap / paging
  "system.paging.usage",
  "system.paging.utilization",
  "system.paging.operations",
  // network
  "system.network.io",
  "system.network.errors",
  "system.network.dropped",
  "system.network.packets",
  "system.network.connections",
  // filesystem
  "system.filesystem.usage",
  "system.filesystem.utilization",
  // disk i/o
  "system.disk.io",
  "system.disk.operations",
  "system.disk.io_time",
  "system.disk.operation_time",
  "system.disk.pending_operations",
  // uptime
  "system.uptime",
  // agentd process health
  "process.cpu.utilization",
  "process.cpu.time",
  "process.memory.usage",
  "process.memory.virtual",
  "process.memory.utilization",
  "process.threads",
  "process.open_file_descriptors",
  "process.handles",
  "process.disk.io",
];

/**
 * Resource attributes we drop before export. `process.*` identity attributes
 * are resource-level on the process scraper (each process is its own resource),
 * so they are removed here rather than in the datapoint transform.
 *
 * `process.command_line` is the sharp one: an agentd worker's command line
 * carries repo paths, branch names and sometimes flags with tokens in them.
 */
/** Pseudo/virtual filesystems — no capacity worth reporting. */
export const PSEUDO_FS_TYPES: readonly string[] = [
  "autofs", "binfmt_misc", "cgroup", "cgroup2", "configfs", "debugfs",
  "devpts", "devtmpfs", "fusectl", "hugetlbfs", "mqueue", "overlay",
  "proc", "procfs", "pstore", "ramfs", "securityfs", "selinuxfs",
  "squashfs", "sysfs", "tracefs",
];

/**
 * Filesystem health has to be per-volume — summing the bytes of every volume of
 * one type lets a large empty disk hide a nearly-full one — so a per-volume key
 * must survive collection. `device` is that key, but its raw value is often
 * identifying: `server:/export/project` on NFS, `//server/share` on CIFS,
 * `tank/home/alice/project` on ZFS.
 *
 * Filtering by filesystem TYPE cannot fix that. A denylist of remote types is
 * inherently incomplete (Lustre, fuse.rclone, BeeGFS, …), and an allowlist of
 * local types fails on mixed hosts: a ZFS root beside a vfat EFI partition
 * still reported the EFI volume, so the filesystem signal looked present and
 * healthy while the volume that actually holds the work was suppressed.
 *
 * So the value is anonymised instead of the metric being dropped. `device` is
 * replaced with its SHA-256 before export: distinct volumes stay distinct (the
 * only thing the health read uses it for — it groups on the key and never
 * emits it), while the server, share, dataset and project names do not leave
 * the host. Every real filesystem can then be collected, whatever its type.
 *
 * Caveat worth stating: a digest of a low-entropy name is confirmable by
 * guessing. This is a meaningful reduction, not a secret. `mountpoint` — the
 * attribute that carries usernames and repo paths most directly — is still
 * aggregated away entirely rather than hashed.
 */
export const VOLUME_KEY_STATEMENT =
  'set(attributes["device"], SHA256(attributes["device"])) ' +
  'where (metric.name == "system.filesystem.usage" ' +
  'or metric.name == "system.filesystem.utilization") ' +
  'and attributes["device"] != nil';

export const REDACTED_RESOURCE_ATTRIBUTES: readonly string[] = [
  "process.command_line",
  "process.command",
  "process.owner",
  "process.executable.path",
  "process.parent_pid",
];

/** Processes we consider "agentd process health". Matched on executable name. */
export const DEFAULT_PROCESS_NAMES: readonly string[] = [
  "agentd",
  "agentd.exe",
  "node",
  "node.exe",
  "claude",
  "claude.exe",
  "codex",
  "codex.exe",
];

export type HostMetricsMode = "direct" | "gateway";

export type HostMetricsOptions = {
  /** direct → CodeTelemetry ingest; gateway → a user-managed collector. */
  mode?: HostMetricsMode;
  /** OTLP/HTTP base URL. The exporter appends `/v1/metrics`. */
  endpoint: string;
  /** Env var name holding the ingest key. Never the key itself. */
  keyEnvVar?: string;
  /** Omit the Authorization header entirely (gateway on a trusted network). */
  noAuth?: boolean;
  serviceName?: string;
  /** `service.instance.id` — stable per agentd installation. */
  instanceId: string;
  /** `deployment.environment` / `deployment.environment.name`. */
  environment?: string;
  /** Scrape interval in seconds (default 60). */
  intervalSec?: number;
  /** Executable names counted as agentd process health. Empty ⇒ no process scraper. */
  processNames?: readonly string[];
  /** Keep per-interface network breakdown (default false — interface names can
   *  identify VPNs, tunnels and internal network topology). */
  includeInterfaceNames?: boolean;
  /** Keep per-mount filesystem breakdown (default false — mount paths leak
   *  usernames and repo/project names). */
  includeMountPoints?: boolean;
  /** Directory for the on-disk sending queue. Omit for an in-memory queue
   *  (bounded, but drops on restart). */
  queueDir?: string;
  /** Max batches held in the sending queue before backpressure (default 1000). */
  queueSize?: number;
  /** Allow a plaintext http:// endpoint. Off by default. */
  allowInsecure?: boolean;
  /** Collector memory ceiling in MiB (default 128). */
  memoryLimitMib?: number;
};

type Resolved = Required<
  Omit<HostMetricsOptions, "queueDir" | "processNames">
> & { queueDir: string | null; processNames: readonly string[] };

function resolve(opts: HostMetricsOptions): Resolved {
  const endpoint = opts.endpoint?.trim().replace(/\/$/, "");
  if (!endpoint) throw new Error("endpoint is required");
  if (!/^https?:\/\//.test(endpoint)) {
    throw new Error(`endpoint must be an http(s) URL, got: ${endpoint}`);
  }
  const allowInsecure = !!opts.allowInsecure;
  if (endpoint.startsWith("http://") && !allowInsecure) {
    throw new Error(
      `refusing to configure a plaintext endpoint (${endpoint}): the ingest key ` +
        `travels on every request. Use https, or pass allowInsecure for a loopback gateway.`,
    );
  }
  const instanceId = opts.instanceId?.trim();
  if (!instanceId) throw new Error("instanceId is required (it becomes service.instance.id)");

  const intervalSec = opts.intervalSec ?? 60;
  if (!Number.isInteger(intervalSec) || intervalSec < 10 || intervalSec > 3600) {
    // Below 10s the process scraper alone can dominate a small host's CPU; above
    // an hour the series are too sparse to alert on.
    throw new Error(`intervalSec must be an integer between 10 and 3600, got: ${intervalSec}`);
  }
  const queueSize = opts.queueSize ?? 1000;
  if (!Number.isInteger(queueSize) || queueSize < 1) {
    throw new Error(`queueSize must be a positive integer, got: ${queueSize}`);
  }
  const memoryLimitMib = opts.memoryLimitMib ?? 128;
  if (!Number.isInteger(memoryLimitMib) || memoryLimitMib < 32) {
    throw new Error(`memoryLimitMib must be an integer >= 32, got: ${memoryLimitMib}`);
  }

  return {
    mode: opts.mode ?? "direct",
    endpoint,
    keyEnvVar: opts.keyEnvVar ?? DEFAULT_KEY_ENV,
    noAuth: !!opts.noAuth,
    serviceName: opts.serviceName ?? DEFAULT_SERVICE_NAME,
    instanceId,
    environment: opts.environment ?? "production",
    intervalSec,
    processNames: opts.processNames ?? DEFAULT_PROCESS_NAMES,
    includeInterfaceNames: !!opts.includeInterfaceNames,
    includeMountPoints: !!opts.includeMountPoints,
    queueDir: opts.queueDir?.trim() || null,
    queueSize,
    allowInsecure,
    memoryLimitMib,
  };
}

function enabled(...names: string[]): Record<string, YamlValue> {
  return Object.fromEntries(names.map((n) => [n, { enabled: true }]));
}
function disabled(...names: string[]): Record<string, YamlValue> {
  return Object.fromEntries(names.map((n) => [n, { enabled: false }]));
}

function scrapers(r: Resolved): Record<string, YamlValue> {
  const out: Record<string, YamlValue> = {
    cpu: {
      metrics: {
        // system.cpu.time is per-core × per-state — the single biggest
        // cardinality source in the receiver. Utilization carries the same
        // signal at a fraction of the series count.
        ...disabled("system.cpu.time"),
        ...enabled("system.cpu.utilization"),
      },
    },
    load: {},
    memory: { metrics: enabled("system.memory.usage", "system.memory.utilization") },
    paging: {
      metrics: enabled("system.paging.usage", "system.paging.utilization", "system.paging.operations"),
    },
    network: {
      // Loopback and Windows pseudo-adapters produce traffic nobody alerts on.
      // match_type is regexp: the scraper's filter set accepts only `regexp`
      // and `strict` — a `glob` here builds fine at unmarshal time and then
      // fails when the pipeline starts.
      exclude: {
        interfaces: ["^lo\\d*$", "^Loopback", "^isatap", "^Teredo", "^veth", "^docker", "^br-"],
        match_type: "regexp",
      },
      metrics: enabled(
        "system.network.io",
        "system.network.errors",
        "system.network.dropped",
        "system.network.packets",
        "system.network.connections",
      ),
    },
    filesystem: {
      include_virtual_filesystems: false,
      // Every real filesystem is collected. Filtering by TYPE was tried and is
      // the wrong tool: allowlisting local types suppressed the volume that
      // actually matters on a mixed host (a ZFS root beside an allowlisted vfat
      // EFI partition still reported the EFI volume, so `fsUtil` looked healthy
      // while the full work volume was invisible). `device` is anonymised
      // instead — see `transform/volume_key` — which makes the type irrelevant
      // to privacy and restores complete coverage.
      exclude_fs_types: {
        fs_types: [...PSEUDO_FS_TYPES],
        match_type: "strict",
      },
      exclude_mount_points: {
        mount_points: ["^/dev/", "^/proc/", "^/sys/", "^/run/", "^/var/lib/docker/", "^/snap/"],
        match_type: "regexp",
      },
      metrics: enabled("system.filesystem.usage", "system.filesystem.utilization"),
    },
    disk: {
      metrics: enabled(
        "system.disk.io",
        "system.disk.operations",
        "system.disk.io_time",
        "system.disk.operation_time",
        "system.disk.pending_operations",
      ),
    },
    system: { metrics: enabled("system.uptime") },
  };

  if (r.processNames.length > 0) {
    out.process = {
      include: { names: [...r.processNames], match_type: "strict" },
      // On Windows the scraper cannot read other users' processes without
      // elevation; on macOS the same is true for root-owned ones. Unmuted, each
      // denial is logged every scrape and drowns the collector's own logs.
      mute_process_name_error: true,
      mute_process_exe_error: true,
      mute_process_io_error: true,
      mute_process_user_error: true,
      metrics: enabled(
        "process.cpu.utilization",
        "process.memory.utilization",
        "process.threads",
        "process.open_file_descriptors",
        "process.handles",
        "process.disk.io",
      ),
    };
  }
  return out;
}

function processors(r: Resolved): Record<string, YamlValue> {
  // Aggregate away the attributes we don't ship, so the remaining series are
  // well-formed sums/means rather than N duplicate series with a deleted key.
  const aggregations: YamlValue[] = [];
  if (!r.includeInterfaceNames) {
    aggregations.push({
      include: "^system\\.network\\.",
      match_type: "regexp",
      action: "update",
      operations: [{ action: "aggregate_labels", label_set: ["direction"], aggregation_type: "sum" }],
    });
  }
  if (!r.includeMountPoints) {
    aggregations.push(
      {
        // The paging scraper's `device` is a path to the swap file — observed as
        // `C:\pagefile.sys` on Windows, a device or file path on Linux. Same
        // class of attribute as a mount point, so it follows the same flag.
        // Bytes sum; the ratio (below) must not — see filesystem for the reason.
        include: "^system\\.paging\\.usage$",
        match_type: "regexp",
        action: "update",
        operations: [{ action: "aggregate_labels", label_set: ["state"], aggregation_type: "sum" }],
      },
      {
        // Mean, not sum: on a host with more than one pagefile, summing per-device
        // utilization ratios can exceed 1.0 and corrupt the signal.
        include: "^system\\.paging\\.utilization$",
        match_type: "regexp",
        action: "update",
        operations: [{ action: "aggregate_labels", label_set: ["state"], aggregation_type: "mean" }],
      },
      {
        // `device` is RETAINED, `mountpoint` is not. Health has to be per-volume:
        // summing bytes across every volume of one filesystem type lets a large
        // empty disk dilute a nearly-full one, so an exhausted volume reads as
        // low utilization and a host can be admitted with no space to work in.
        // Keeping the device costs a handful of series and does not reintroduce
        // the privacy problem this aggregation exists for — that is the mount
        // PATH (which leaks usernames and repo/project names), still dropped.
        include: "^system\\.filesystem\\.usage$",
        match_type: "regexp",
        action: "update",
        operations: [{
          action: "aggregate_labels",
          label_set: ["state", "type", "device"],
          aggregation_type: "sum",
        }],
      },
      {
        // Mean, not sum: summing utilization ratios across mounts is meaningless.
        include: "^system\\.filesystem\\.utilization$",
        match_type: "regexp",
        action: "update",
        operations: [{ action: "aggregate_labels", label_set: ["type"], aggregation_type: "mean" }],
      },
    );
  }
  // CPU utilization is always collapsed across cores: the per-core breakdown is
  // 2×cores×states series for a signal ("is this box busy") that one mean answers.
  aggregations.push({
    include: "^system\\.cpu\\.utilization$",
    match_type: "regexp",
    action: "update",
    operations: [{ action: "aggregate_labels", label_set: ["state"], aggregation_type: "mean" }],
  });

  const resourceAttrs: YamlValue[] = [
    { key: "service.name", value: r.serviceName, action: "upsert" },
    { key: "service.namespace", value: SERVICE_NAMESPACE, action: "upsert" },
    { key: "service.instance.id", value: r.instanceId, action: "upsert" },
    // Both spellings: `deployment.environment` is what the existing launch
    // wrappers in this repo emit; `deployment.environment.name` is the current
    // semconv name. Emitting both keeps old and new queries working.
    { key: "deployment.environment", value: r.environment, action: "upsert" },
    { key: "deployment.environment.name", value: r.environment, action: "upsert" },
    { key: "telemetry.source", value: "agentd-host-metrics", action: "upsert" },
  ];

  return {
    // First in the pipeline: refuses new scrapes when the collector is near its
    // ceiling, which is what turns a stalled exporter into backpressure instead
    // of an OOM.
    memory_limiter: {
      check_interval: "1s",
      limit_mib: r.memoryLimitMib,
      spike_limit_mib: Math.max(16, Math.floor(r.memoryLimitMib / 4)),
    },
    "resourcedetection/system": {
      detectors: ["env", "system"],
      timeout: "5s",
      // Never clobber an operator-set OTEL_RESOURCE_ATTRIBUTES value.
      override: false,
      system: {
        hostname_sources: ["os"],
        resource_attributes: {
          ...enabled("host.name", "host.arch", "os.type"),
          // Omitted by default: host.id is a machine fingerprint, os.description
          // and the host.cpu.* family carry exact build/hardware detail that is
          // useless for alerting and identifying in aggregate.
          ...disabled(
            "host.id",
            "host.ip",
            "host.mac",
            "os.description",
            "host.cpu.vendor.id",
            "host.cpu.family",
            "host.cpu.model.id",
            "host.cpu.model.name",
            "host.cpu.stepping",
            "host.cpu.cache.l2.size",
          ),
        },
      },
    },
    "resource/identity": { attributes: resourceAttrs },
    "resource/redact": {
      attributes: REDACTED_RESOURCE_ATTRIBUTES.map((key) => ({ key, action: "delete" })),
    },
    // The cardinality backstop: anything not in the contract is dropped, so a
    // collector upgrade that enables a new metric by default cannot widen what
    // we store without a corresponding change here.
    "filter/contract": {
      error_mode: "ignore",
      metrics: {
        metric: [`not (${HOST_METRIC_CONTRACT.map((n) => `name == "${n}"`).join(" or ")})`],
      },
    },
    // Anonymise the per-volume key before anything aggregates on it. Runs ahead
    // of metricstransform/cardinality so the grouping happens on the digest —
    // volumes stay distinct, their names never leave the host. Only applied
    // when mount detail has NOT been opted into: `--mounts` means the operator
    // has accepted raw paths, and hashing the device while shipping the mount
    // point next to it would be theatre.
    ...(r.includeMountPoints ? {} : {
      "transform/volume_key": {
        error_mode: "ignore",
        metric_statements: [
          { context: "datapoint", statements: [VOLUME_KEY_STATEMENT] },
        ],
      },
    }),
    "metricstransform/cardinality": { transforms: aggregations },
    batch: {
      timeout: "10s",
      send_batch_size: 512,
      send_batch_max_size: 1024,
    },
  };
}

function exporters(r: Resolved): Record<string, YamlValue> {
  const otlp: Record<string, YamlValue> = {
    endpoint: r.endpoint,
    compression: "gzip",
    timeout: "30s",
    tls: { insecure: r.endpoint.startsWith("http://"), min_version: "1.2" },
    retry_on_failure: {
      enabled: true,
      initial_interval: "5s",
      max_interval: "5m",
      // Give up on a batch after 30 minutes rather than retrying forever and
      // starving fresh data behind a permanently-poisoned one.
      max_elapsed_time: "30m",
    },
    sending_queue: {
      enabled: true,
      num_consumers: 2,
      queue_size: r.queueSize,
      ...(r.queueDir ? { storage: "file_storage/otlp_queue" } : {}),
    },
  };
  if (!r.noAuth) {
    otlp.headers = { authorization: `Bearer \${env:${r.keyEnvVar}}` };
  }
  return { "otlphttp/codetelemetry": otlp };
}

/** Build the collector config as a plain object (the testable surface). */
export function buildHostMetricsConfig(opts: HostMetricsOptions): Record<string, YamlValue> {
  const r = resolve(opts);

  const extensions: Record<string, YamlValue> = {
    health_check: { endpoint: "127.0.0.1:13133" },
  };
  if (r.queueDir) {
    extensions["file_storage/otlp_queue"] = {
      directory: r.queueDir,
      // Without this the collector refuses to start when the directory is
      // missing — which is every fresh install that didn't run our installer.
      create_directory: true,
      timeout: "10s",
      compaction: { on_start: true, directory: r.queueDir, max_transaction_size: 65536 },
    };
  }

  return {
    extensions,
    receivers: {
      hostmetrics: {
        collection_interval: `${r.intervalSec}s`,
        scrapers: scrapers(r),
      },
    },
    processors: processors(r),
    exporters: exporters(r),
    service: {
      extensions: Object.keys(extensions),
      telemetry: {
        logs: { level: "warn" },
        // The collector's own self-metrics stay on its internal endpoint; they
        // are never exported to CodeTelemetry (no pipeline consumes them).
        metrics: { level: "basic" },
      },
      pipelines: {
        "metrics/host": {
          receivers: ["hostmetrics"],
          processors: [
            "memory_limiter",
            "resourcedetection/system",
            "resource/identity",
            "resource/redact",
            "filter/contract",
            ...(r.includeMountPoints ? [] : ["transform/volume_key"]),
            "metricstransform/cardinality",
            "batch",
          ],
          exporters: ["otlphttp/codetelemetry"],
        },
      },
    },
  };
}

/** Render the collector config as YAML text. */
export function renderHostMetricsConfig(opts: HostMetricsOptions): string {
  const header = [
    "# CodeTelemetry agentd host metrics — generated by `codetelemetry-connect host-metrics`.",
    "# Docs: docs/otel/agentd-host-metrics.md",
    "#",
    `# The ingest key is NOT in this file. Set the env var below on the collector`,
    "# service before starting it.",
    "",
  ].join("\n");
  return header + renderYaml(buildHostMetricsConfig(opts));
}

export type CliFlags = Record<string, string | boolean>;

function str(flags: CliFlags, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}

function int(flags: CliFlags, name: string): number | undefined {
  const v = str(flags, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  // Number("") is 0 and Number("12abc") is NaN — reject both loudly rather than
  // silently configuring a 0-second scrape interval.
  if (!v.trim() || !Number.isFinite(n)) throw new Error(`--${name} must be a number, got: ${v}`);
  return n;
}

/**
 * Map parsed CLI flags onto builder options. Split out from the CLI so the flag
 * contract is testable without spawning a process.
 */
export function hostMetricsOptionsFromFlags(
  flags: CliFlags,
  defaults: { ingestEndpoint: string; paths: HostMetricsPaths; instanceId: string },
): HostMetricsOptions & { configPath: string } {
  const gateway = str(flags, "gateway");
  // Distinguish an absent flag (undefined → builder default) from a present but
  // empty one (`--processes=` → []). An empty string is the documented way to
  // disable the process scraper, and it must not fall back to the defaults.
  const processes = str(flags, "processes");
  const processNames = processes === undefined
    ? undefined
    : processes.split(",").map((s) => s.trim()).filter(Boolean);
  // `--no-queue-dir` parses to false; an explicit path wins over the default.
  const queueDir =
    flags["queue-dir"] === false ? undefined : str(flags, "queue-dir") ?? defaults.paths.queueDir;

  return {
    mode: gateway ? "gateway" : "direct",
    endpoint: gateway ?? str(flags, "endpoint") ?? defaults.ingestEndpoint,
    configPath: str(flags, "out") ?? defaults.paths.configPath,
    keyEnvVar: str(flags, "key-env"),
    noAuth: flags.auth === false,
    instanceId: str(flags, "instance") ?? defaults.instanceId,
    environment: str(flags, "env"),
    intervalSec: int(flags, "interval"),
    processNames,
    includeInterfaceNames: flags.interfaces === true,
    includeMountPoints: flags.mounts === true,
    queueDir,
    queueSize: int(flags, "queue-size"),
    memoryLimitMib: int(flags, "memory-limit"),
    allowInsecure: flags["allow-insecure"] === true,
  };
}

export type HostMetricsPaths = {
  /** Where the generated collector config goes. */
  configPath: string;
  /** Where the persistent sending queue lives. */
  queueDir: string;
};

/**
 * Per-platform defaults for the bundled collector. Windows first (the current
 * agentd host), with the conventional otelcol-contrib locations on the other
 * two so the same command works there unchanged.
 */
export function defaultHostMetricsPaths(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HostMetricsPaths {
  // Explicit path flavours, not `path.join`: the target platform is an argument
  // here, so the separators must not depend on where this code happens to run
  // (config can legitimately be generated on one OS for another).
  if (platform === "win32") {
    const base = path.win32.join(env.ProgramData || "C:\\ProgramData", "CodeTelemetry");
    return {
      configPath: path.win32.join(base, "otelcol-hostmetrics.yaml"),
      queueDir: path.win32.join(base, "queue"),
    };
  }
  const etc = platform === "darwin" ? "/usr/local/etc/otelcol-contrib" : "/etc/otelcol-contrib";
  const varlib = platform === "darwin" ? "/usr/local/var/lib/otelcol-contrib" : "/var/lib/otelcol-contrib";
  return {
    configPath: path.posix.join(etc, "codetelemetry-hostmetrics.yaml"),
    queueDir: path.posix.join(varlib, "codetelemetry-queue"),
  };
}

/** Stable-per-machine default for `service.instance.id`. */
export function defaultInstanceId(hostname: string = os.hostname()): string {
  const cleaned = hostname.trim().toLowerCase().replace(/[^a-z0-9._-]/g, "-").replace(/^-+|-+$/g, "");
  return cleaned || "unknown-host";
}

export type HostMetricsWriteResult = {
  path: string;
  created: boolean;
  backupPath: string | null;
  /** Env vars the collector service must have set. */
  requiredEnv: string[];
};

export type HostMetricsWriteOptions = HostMetricsOptions & {
  configPath: string;
  backup?: boolean;
};

/** Write the config to disk (0600 — it names the queue dir and endpoint). */
export function writeHostMetricsConfig(opts: HostMetricsWriteOptions): HostMetricsWriteResult {
  const yaml = renderHostMetricsConfig(opts);
  const filePath = path.resolve(opts.configPath);
  const existed = fs.existsSync(filePath);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  let backupPath: string | null = null;
  if (existed && opts.backup !== false) {
    backupPath = `${filePath}.bak`;
    fs.copyFileSync(filePath, backupPath);
  }
  fs.writeFileSync(filePath, yaml, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* best effort (non-POSIX fs) */
  }

  return {
    path: filePath,
    created: !existed,
    backupPath,
    requiredEnv: opts.noAuth ? [] : [opts.keyEnvVar ?? DEFAULT_KEY_ENV],
  };
}
