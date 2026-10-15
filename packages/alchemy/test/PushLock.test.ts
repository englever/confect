import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { AlchemyContext } from "alchemy/AlchemyContext";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import {
  PushLock,
  PushLockError,
  layer as lockLayer,
} from "../src/internal/PushLock";

const serialize = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const withDotAlchemy = <A, E, R>(
  effect: (paths: {
    readonly dotAlchemy: string;
    readonly lockFile: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dotAlchemy = yield* fs.makeTempDirectoryScoped({
      prefix: "confect-lock-test-",
    });
    const lockFile = path.join(
      dotAlchemy,
      "convex",
      "locks",
      "happy-otter-123.lock",
    );
    yield* fs.makeDirectory(path.dirname(lockFile), { recursive: true });
    return yield* effect({ dotAlchemy, lockFile }).pipe(
      Effect.provideService(AlchemyContext, {
        dotAlchemy,
        dev: false,
        adopt: false,
      }),
    );
  });

const deadPid = Effect.gen(function* () {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const handle = yield* spawner.spawn(
    ChildProcess.make(process.execPath, ["-e", ""], {
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    }),
  );
  yield* handle.exitCode;
  return Number(handle.pid);
}).pipe(Effect.scoped);

const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provide(
      lockLayer({ timeout: "2 seconds" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("PushLock", () => {
  it.live("waits while another live process holds the deployment lock", () =>
    withDotAlchemy(({ lockFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = yield* PushLock;
        yield* fs.writeFileString(
          lockFile,
          serialize({ pid: process.pid, token: "other-process" }),
        );
        let entered = false;
        const fiber = yield* lock
          .withLock(
            "happy-otter-123",
            Effect.sync(() => {
              entered = true;
            }),
          )
          .pipe(Effect.forkScoped);
        yield* Effect.sleep("400 millis");
        expect(entered).toBe(false);
        yield* fs.remove(lockFile);
        yield* Fiber.join(fiber);
        expect(entered).toBe(true);
      }),
    ).pipe(provide),
  );

  it.live("breaks a lock left behind by a process that has exited", () =>
    withDotAlchemy(({ lockFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = yield* PushLock;
        yield* fs.writeFileString(
          lockFile,
          serialize({ pid: yield* deadPid, token: "crashed" }),
        );
        expect(
          yield* lock.withLock("happy-otter-123", Effect.succeed("pushed")),
        ).toBe("pushed");
        expect(yield* fs.exists(lockFile)).toBe(false);
      }),
    ).pipe(provide),
  );

  it.live("fails with a typed timeout when the holder never releases", () =>
    withDotAlchemy(({ lockFile }) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const lock = yield* PushLock;
        yield* fs.writeFileString(
          lockFile,
          serialize({ pid: process.pid, token: "other-process" }),
        );
        const result = yield* lock
          .withLock("happy-otter-123", Effect.void)
          .pipe(Effect.result);
        expect(result).toEqual(
          Result.fail(
            new PushLockError({
              deploymentName: "happy-otter-123",
              reason: "timeout",
            }),
          ),
        );
      }),
    ).pipe(provide),
  );

  it.live(
    "releases the lock when the locked work fails or is interrupted",
    () =>
      withDotAlchemy(({ lockFile }) =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const lock = yield* PushLock;
          const failed = yield* lock
            .withLock("happy-otter-123", Effect.fail("push failed"))
            .pipe(Effect.result);
          expect(failed).toEqual(Result.fail("push failed"));
          expect(yield* fs.exists(lockFile)).toBe(false);
          const held = yield* lock
            .withLock("happy-otter-123", Effect.never)
            .pipe(Effect.forkScoped);
          yield* Effect.sleep("200 millis");
          expect(yield* fs.exists(lockFile)).toBe(true);
          yield* Fiber.interrupt(held);
          expect(yield* fs.readDirectory(path.dirname(lockFile))).toEqual([]);
        }),
      ).pipe(provide),
  );
});
