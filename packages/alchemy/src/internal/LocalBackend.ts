import { createServer, type AddressInfo, type Server } from "node:net";
import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import { Stack } from "alchemy/Stack";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/http/HttpClient";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { processEnvironment } from "./CommandRunner";
import { extract } from "./Zip";

/**
 * The backend release every local deployment runs. A data directory records the
 * release that created it and is never upgraded in place.
 */
export const backendVersion = "precompiled-2026-10-06-a3538c6";

export class LocalBackendError extends Schema.TaggedError<LocalBackendError>()(
  "LocalBackendError",
  {
    deploymentName: Schema.String,
    reason: Schema.Literals([
      "configuration",
      "filesystem",
      "install",
      "identity",
      "ports",
      "running",
      "spawn",
      "exit",
      "timeout",
    ]),
    exitCode: Schema.optionalKey(Schema.Finite),
  },
) {}

export class LocalBackendVersionChange extends Schema.TaggedError<LocalBackendVersionChange>()(
  "LocalBackendVersionChange",
  {
    deploymentName: Schema.String,
    current: Schema.String,
    requested: Schema.String,
  },
) {}

export interface LocalBackend {
  readonly url: string;
  readonly siteUrl: string;
  readonly adminKey: Redacted.Redacted<string>;
  /**
   * Completes when the backend process exits.
   */
  readonly exited: Effect.Effect<void>;
}

const Identity = Schema.fromJsonString(
  Schema.Struct({
    name: Schema.String,
    version: Schema.String,
    instanceSecret: Schema.String,
    adminKey: Schema.String,
    port: Schema.Int,
    sitePort: Schema.Int,
  }),
);
type Identity = typeof Identity.Type;

// The release archive per platform, as the Convex CLI maps it
// (convex-js src/cli/lib/localDeployment/download.ts getDownloadPath).
const artifacts: Readonly<Record<string, string>> = {
  "darwin-arm64": "convex-local-backend-aarch64-apple-darwin.zip",
  "darwin-x64": "convex-local-backend-x86_64-apple-darwin.zip",
  "linux-arm64": "convex-local-backend-aarch64-unknown-linux-gnu.zip",
  "linux-x64": "convex-local-backend-x86_64-unknown-linux-gnu.zip",
  "win32-arm64": "convex-local-backend-x86_64-pc-windows-msvc.zip",
  "win32-x64": "convex-local-backend-x86_64-pc-windows-msvc.zip",
};
const executable =
  process.platform === "win32"
    ? "convex-local-backend.exe"
    : "convex-local-backend";

const loopback = (port: number) => `http://127.0.0.1:${port}`;

const listen = (port: number) =>
  Effect.callback<Server | undefined>((resume) => {
    const server = createServer();
    server.once("error", () => resume(Effect.undefined));
    server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
  });

const close = (server: Server) =>
  Effect.callback<void>((resume) => {
    server.close(() => resume(Effect.void));
  });

const isFree = (port: number) =>
  listen(port).pipe(
    Effect.flatMap((server) =>
      server ? close(server).pipe(Effect.as(true)) : Effect.succeed(false),
    ),
  );

/**
 * Resolves the directory that holds one local deployment's identity, database,
 * and file storage: `.alchemy/convex/<stack>/<stage>/<deployment>`. Keyed by
 * the deployment name because a deploy key resource only knows that name.
 */
export const dataDirectories = Effect.gen(function* () {
  const path = yield* Path.Path;
  const stack = yield* Stack;
  const root = path.resolve(
    yield* dotAlchemyDirectory,
    "convex",
    stack.name,
    stack.stage,
  );
  return (deploymentName: string) => path.join(root, deploymentName);
});

const readIdentity = Effect.fn("LocalBackend.readIdentity")(function* (
  deploymentName: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const file = path.join(directory, "identity.json");
  const invalid = () =>
    new LocalBackendError({ deploymentName, reason: "identity" });
  if (!(yield* fs.exists(file).pipe(Effect.mapError(invalid))))
    return Option.none<Identity>();
  const identity = yield* fs
    .readFileString(file)
    .pipe(
      Effect.flatMap(Schema.decodeEffect(Identity)),
      Effect.mapError(invalid),
    );
  if (identity.name !== deploymentName) return yield* invalid();
  return Option.some(identity);
});

/**
 * The admin key of a local deployment, for its deploy key resource.
 */
export const adminKey = Effect.fn("LocalBackend.adminKey")(function* (
  deploymentName: string,
  directory: string,
) {
  const identity = yield* readIdentity(deploymentName, directory);
  if (Option.isNone(identity))
    return yield* new LocalBackendError({ deploymentName, reason: "identity" });
  return Redacted.make(identity.value.adminKey);
});

export const remove = Effect.fn("LocalBackend.remove")(function* (
  deploymentName: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  yield* fs
    .remove(directory, { recursive: true, force: true })
    .pipe(
      Effect.mapError(
        () => new LocalBackendError({ deploymentName, reason: "filesystem" }),
      ),
    );
});

/**
 * Boot the local backend for one deployment and keep it running for the ambient
 * scope. The first boot installs the pinned release, generates an instance
 * secret and admin key, and picks two free loopback ports; later boots reuse
 * all of them so stored credentials and URLs stay valid.
 */
export const boot = Effect.fn("LocalBackend.boot")(function* (
  deploymentName: string,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const http = yield* HttpClient.HttpClient;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const crypto = yield* Crypto.Crypto;
  const fail = (reason: LocalBackendError["reason"], exitCode?: number) =>
    new LocalBackendError({
      deploymentName,
      reason,
      ...(exitCode === undefined ? {} : { exitCode }),
    });
  const settings = yield* Config.all({
    environment: processEnvironment,
    LOCALAPPDATA: Config.String("LOCALAPPDATA").pipe(Config.withDefault("")),
    ports: Config.String("CONFECT_LOCAL_BACKEND_PORTS").pipe(Config.option),
  }).pipe(Effect.mapError(() => fail("configuration")));
  const env = {
    ...settings.environment,
    DISABLE_BEACON: "1",
    DO_NOT_TRACK: "1",
  };

  const answer = (url: string) =>
    http.get(`${url}/instance_name`).pipe(
      Effect.flatMap((response) =>
        response.status === 200 ? response.text : Effect.undefined,
      ),
      Effect.orElseSucceed(() => undefined),
    );

  const install = Effect.gen(function* () {
    const cache =
      process.platform === "win32"
        ? settings.LOCALAPPDATA ||
          path.join(settings.environment.USERPROFILE, "AppData", "Local")
        : path.join(settings.environment.HOME, ".cache");
    const binaries = path.join(cache, "convex", "binaries");
    const binary = path.join(binaries, backendVersion, executable);
    if (yield* fs.exists(binary)) return binary;
    const artifact = artifacts[`${process.platform}-${process.arch}`];
    if (artifact === undefined) return yield* fail("install");
    yield* fs.makeDirectory(binaries, { recursive: true });
    yield* Effect.scoped(
      Effect.gen(function* () {
        const temp = yield* fs.makeTempDirectoryScoped({
          directory: binaries,
          prefix: ".download-",
        });
        const archive = path.join(temp, artifact);
        const response = yield* http.get(
          `https://github.com/get-convex/convex-backend/releases/download/${backendVersion}/${artifact}`,
        );
        if (response.status !== 200) return yield* fail("install");
        yield* response.stream.pipe(Stream.run(fs.sink(archive)));
        const extracted = path.join(temp, executable);
        yield* extract(archive, executable, extracted);
        yield* fs.chmod(extracted, 0o755);
        yield* fs.makeDirectory(path.dirname(binary), { recursive: true });
        yield* fs.rename(extracted, binary);
      }),
    );
    return binary;
  }).pipe(Effect.mapError(() => fail("install")));

  const allocate = Effect.gen(function* () {
    if (Option.isNone(settings.ports)) {
      const servers = [yield* listen(0), yield* listen(0)];
      const ports = servers.map(
        (server) => (server?.address() as AddressInfo | null)?.port,
      );
      yield* Effect.forEach(servers, (server) =>
        server ? close(server) : Effect.void,
      );
      const [port, sitePort] = ports;
      if (port === undefined || sitePort === undefined)
        return yield* fail("ports");
      return { port, sitePort };
    }
    const range = /^([0-9]+)-([0-9]+)$/.exec(settings.ports.value);
    if (!range) return yield* fail("configuration");
    const free: number[] = [];
    for (
      let port = Number(range[1]);
      port <= Number(range[2]) && free.length < 2;
      port++
    ) {
      if (yield* isFree(port)) free.push(port);
    }
    const [port, sitePort] = free;
    if (port === undefined || sitePort === undefined)
      return yield* fail("ports");
    return { port, sitePort };
  });

  const binary = yield* install;
  const saved = yield* readIdentity(deploymentName, directory);
  if (Option.isSome(saved) && saved.value.version !== backendVersion)
    return yield* new LocalBackendVersionChange({
      deploymentName,
      current: saved.value.version,
      requested: backendVersion,
    });

  let ports: { readonly port: number; readonly sitePort: number } | undefined;
  if (Option.isSome(saved)) {
    if (
      (yield* isFree(saved.value.port)) &&
      (yield* isFree(saved.value.sitePort))
    )
      ports = saved.value;
    else if ((yield* answer(loopback(saved.value.port))) === deploymentName)
      return yield* fail("running");
  }
  ports ??= yield* allocate;

  const credentials = Option.isSome(saved)
    ? saved.value
    : yield* Effect.gen(function* () {
        const instanceSecret = Buffer.from(
          yield* crypto.randomBytes(32),
        ).toString("hex");
        const output = yield* spawner.string(
          ChildProcess.make(
            binary,
            [
              "keygen",
              "admin-key",
              "--instance-name",
              deploymentName,
              "--instance-secret",
              instanceSecret,
            ],
            { env, extendEnv: false, stdin: "ignore", stderr: "ignore" },
          ),
        );
        const key = output.trim();
        if (!key.startsWith(`${deploymentName}|`))
          return yield* fail("identity");
        return { instanceSecret, adminKey: key };
      }).pipe(
        Effect.catchTag("PlatformError", () => Effect.fail(fail("identity"))),
      );

  const identity: Identity = {
    name: deploymentName,
    version: backendVersion,
    instanceSecret: credentials.instanceSecret,
    adminKey: credentials.adminKey,
    port: ports.port,
    sitePort: ports.sitePort,
  };
  yield* Effect.gen(function* () {
    yield* fs.makeDirectory(directory, { recursive: true });
    const file = path.join(directory, "identity.json");
    const temp = `${file}.${process.pid}.tmp`;
    yield* fs.writeFileString(
      temp,
      yield* Schema.encodeEffect(Identity)(identity),
      { mode: 0o600 },
    );
    yield* fs.rename(temp, file);
  }).pipe(Effect.mapError(() => fail("identity")));

  const url = loopback(identity.port);
  const siteUrl = loopback(identity.sitePort);
  const handle = yield* spawner
    .spawn(
      ChildProcess.make(
        binary,
        [
          "--interface",
          "127.0.0.1",
          "--port",
          String(identity.port),
          "--site-proxy-port",
          String(identity.sitePort),
          "--instance-name",
          deploymentName,
          "--instance-secret",
          identity.instanceSecret,
          "--convex-origin",
          url,
          "--convex-site",
          siteUrl,
          "--local-storage",
          path.join(directory, "convex_local_storage"),
          "--disable-beacon",
          path.join(directory, "convex_local_backend.sqlite3"),
        ],
        {
          cwd: directory,
          env,
          extendEnv: false,
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        },
      ),
    )
    .pipe(Effect.mapError(() => fail("spawn")));

  const ready = answer(url).pipe(
    Effect.flatMap((name) =>
      name === undefined || name === deploymentName
        ? Effect.succeed(name === deploymentName)
        : Effect.fail(fail("ports")),
    ),
    Effect.repeat({
      until: (isReady) => isReady,
      schedule: Schedule.spaced("100 millis"),
    }),
  );
  const exit = handle.exitCode.pipe(
    Effect.mapError(() => fail("exit")),
    Effect.flatMap((code) => Effect.fail(fail("exit", Number(code)))),
  );
  yield* Effect.raceFirst(ready, exit).pipe(
    Effect.timeoutOrElse({
      duration: "60 seconds",
      orElse: () => Effect.fail(fail("timeout")),
    }),
  );
  return {
    url,
    siteUrl,
    adminKey: Redacted.make(identity.adminKey),
    exited: handle.exitCode.pipe(Effect.ignore),
  } satisfies LocalBackend;
});
