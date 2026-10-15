import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import { createServer, type Server } from "node:net";
import {
  backendVersion,
  boot,
  LocalBackendError,
} from "../src/internal/LocalBackend";
import { fakeBackend } from "./fixtures/LocalBackend";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const name = "confect-deployment-0123456789abcdef01234567";

const occupy = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<Server>((resume) => {
      const server = createServer();
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

const harness = (fake: ReturnType<typeof fakeBackend>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-local-backend-",
    });
    const home = path.join(root, "home");
    const directory = path.join(root, "data", name);
    const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(
          Layer.mergeAll(
            fake.layer,
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                HOME: home,
                LOCALAPPDATA: home,
                CONFECT_LOCAL_BACKEND_PORTS: "3350-3359",
              }),
            ),
          ),
        ),
      );
    return { directory, run };
  });

const port = (url: string) => Number(new URL(url).port);

describe("LocalBackend", () => {
  it.live(
    "installs the pinned release, creates an identity, and reports URLs once the backend answers its name",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const backend = yield* run(boot(name, directory));
        expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:335\d$/);
        expect(backend.siteUrl).toMatch(/^http:\/\/127\.0\.0\.1:335\d$/);
        expect(backend.siteUrl).not.toBe(backend.url);
        expect(Redacted.value(backend.adminKey)).toBe(`${name}|0a1b2c1`);
        expect(fake.downloads).toHaveLength(1);
        expect(fake.downloads[0]).toMatch(
          /^https:\/\/github\.com\/get-convex\/convex-backend\/releases\/download\/precompiled-2026-10-06-a3538c6\/convex-local-backend-[a-z0-9_-]+\.zip$/,
        );
        const [served] = fake.served;
        expect(served?.args).toEqual([
          "--interface",
          "127.0.0.1",
          "--port",
          String(port(backend.url)),
          "--site-proxy-port",
          String(port(backend.siteUrl)),
          "--instance-name",
          name,
          "--instance-secret",
          expect.stringMatching(/^[0-9a-f]{64}$/),
          "--convex-origin",
          backend.url,
          "--convex-site",
          backend.siteUrl,
          "--local-storage",
          path.join(directory, "convex_local_storage"),
          "--disable-beacon",
          path.join(directory, "convex_local_backend.sqlite3"),
        ]);
        expect(serialize(backend)).not.toContain("0a1b2c1");
        if (process.platform !== "win32")
          expect(
            (yield* fs.stat(path.join(directory, "identity.json"))).mode &
              0o777,
          ).toBe(0o600);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "restarts on its saved identity and ports without new credentials or downloads",
    () =>
      Effect.gen(function* () {
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
        expect(fake.served[0]?.running()).toBe(false);
        const second = yield* run(boot(name, directory));
        expect(second.url).toBe(first.url);
        expect(second.siteUrl).toBe(first.siteUrl);
        expect(Redacted.value(second.adminKey)).toBe(
          Redacted.value(first.adminKey),
        );
        expect(fake.served[1]?.args[9]).toBe(fake.served[0]?.args[9]);
        expect(fake.downloads).toHaveLength(1);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("keeps running the release that created its data directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const fake = fakeBackend();
      const { directory, run } = yield* harness(fake);
      const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
      const identity = path.join(directory, "identity.json");
      yield* fs.writeFileString(
        identity,
        (yield* fs.readFileString(identity)).replace(
          backendVersion,
          "precompiled-2020-01-01-0000000",
        ),
      );
      const restarted = yield* run(boot(name, directory));
      expect(restarted.url).toBe(first.url);
      expect(fake.downloads.at(-1)).toMatch(
        /\/download\/precompiled-2020-01-01-0000000\/convex-local-backend-/,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails typed when the backend exits before it answers", () =>
    Effect.gen(function* () {
      const { directory, run } = yield* harness(fakeBackend({ exitCode: 3 }));
      expect(
        yield* run(boot(name, directory)).pipe(Effect.scoped, Effect.result),
      ).toEqual(
        Result.fail(
          new LocalBackendError({
            deploymentName: name,
            reason: "exit",
            exitCode: 3,
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "keeps its saved ports, failing typed when another program or an orphaned backend holds one",
    () =>
      Effect.gen(function* () {
        const fake = fakeBackend();
        const { directory, run } = yield* harness(fake);
        const first = yield* run(boot(name, directory)).pipe(Effect.scoped);
        const scope = yield* Scope.make();
        yield* occupy(port(first.url)).pipe(Scope.provide(scope));
        fake.answers.set(first.url, "someone-else");
        expect(
          yield* run(boot(name, directory)).pipe(Effect.scoped, Effect.result),
        ).toEqual(
          Result.fail(
            new LocalBackendError({ deploymentName: name, reason: "ports" }),
          ),
        );
        fake.answers.set(first.url, name);
        expect(
          yield* run(boot(name, directory)).pipe(Effect.scoped, Effect.result),
        ).toEqual(
          Result.fail(
            new LocalBackendError({ deploymentName: name, reason: "running" }),
          ),
        );
        yield* Scope.close(scope, Exit.void);
        fake.answers.delete(first.url);
        const restarted = yield* run(boot(name, directory)).pipe(Effect.scoped);
        expect(restarted.url).toBe(first.url);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("refuses a second backend over data another one is serving", () =>
    Effect.gen(function* () {
      const fake = fakeBackend();
      const { directory, run } = yield* harness(fake);
      yield* run(boot(name, directory));
      expect(
        yield* run(boot(name, directory)).pipe(Effect.scoped, Effect.result),
      ).toEqual(
        Result.fail(
          new LocalBackendError({ deploymentName: name, reason: "running" }),
        ),
      );
      expect(fake.served).toHaveLength(1);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("says why a backend could not start", () => {
    expect(
      new LocalBackendError({ deploymentName: name, reason: "running" })
        .message,
    ).toBe(
      `Local backend for ${name} is already running in another session over its data directory`,
    );
    expect(
      new LocalBackendError({
        deploymentName: name,
        reason: "exit",
        exitCode: 3,
      }).message,
    ).toBe(`Local backend for ${name} exited with code 3 before it was ready`);
  });

  it.live("stops a backend that never answers with its own name", () =>
    Effect.gen(function* () {
      const fake = fakeBackend({ answerAs: "someone-else" });
      const { directory, run } = yield* harness(fake);
      expect(yield* run(boot(name, directory)).pipe(Effect.result)).toEqual(
        Result.fail(
          new LocalBackendError({ deploymentName: name, reason: "ports" }),
        ),
      );
      expect(fake.served[0]?.running()).toBe(false);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live.each(["65536-65537", "3399-3300", "0-10", "3300"])(
    "rejects the port range %s with a configuration error",
    (range) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fs.makeTempDirectoryScoped({
          prefix: "confect-local-backend-",
        });
        expect(
          yield* boot(name, path.join(home, name)).pipe(
            Effect.provide(
              Layer.mergeAll(
                fakeBackend().layer,
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    HOME: home,
                    LOCALAPPDATA: home,
                    CONFECT_LOCAL_BACKEND_PORTS: range,
                  }),
                ),
              ),
            ),
            Effect.scoped,
            Effect.result,
          ),
        ).toEqual(
          Result.fail(
            new LocalBackendError({
              deploymentName: name,
              reason: "configuration",
            }),
          ),
        );
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live("fails typed instead of installing without a home directory", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({
        prefix: "confect-local-backend-",
      });
      expect(
        yield* boot(name, path.join(root, name)).pipe(
          Effect.provide(
            Layer.mergeAll(
              fakeBackend().layer,
              ConfigProvider.layer(ConfigProvider.fromUnknown({})),
            ),
          ),
          Effect.scoped,
          Effect.result,
        ),
      ).toEqual(
        Result.fail(
          new LocalBackendError({
            deploymentName: name,
            reason: "configuration",
          }),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
