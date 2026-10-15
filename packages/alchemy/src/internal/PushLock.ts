import { dotAlchemyDirectory } from "alchemy/AlchemyContext";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";

export class PushLockError extends Schema.TaggedError<PushLockError>()(
  "PushLockError",
  {
    deploymentName: Schema.String,
    reason: Schema.Literals(["timeout", "filesystem"]),
  },
) {}

/**
 * Serialises pushes per deployment. Overlapping `convex deploy` runs against
 * one deployment race on `wait_for_schema`, so every push holds the lock for
 * its whole duration, whether it comes from this process or another stack.
 */
export class PushLock extends Context.Service<
  PushLock,
  {
    readonly withLock: <A, E, R>(
      deploymentName: string,
      effect: Effect.Effect<A, E, R>,
    ) => Effect.Effect<A, E | PushLockError, R>;
  }
>()("@confect/alchemy/internal/PushLock") {}

const Holder = Schema.fromJsonString(
  Schema.Struct({ pid: Schema.Finite, token: Schema.String }),
);

const isAlive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * One lock file per deployment under `<dotAlchemy>/convex/locks/`, created
 * exclusively and naming its holder's pid. A lock whose holder has exited is
 * stale and is broken, so a crashed push never wedges the deployment.
 */
export const layer = (options?: { readonly timeout?: Duration.Input }) =>
  Layer.effect(
    PushLock,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const crypto = yield* Crypto.Crypto;
      const timeout = options?.timeout ?? Duration.minutes(10);
      const encode = Schema.encodeEffect(Holder);
      const decode = Schema.decodeUnknownOption(Holder);
      return PushLock.of({
        withLock: (deploymentName, effect) =>
          Effect.gen(function* () {
            const failed = () =>
              new PushLockError({ deploymentName, reason: "filesystem" });
            const directory = path.resolve(
              yield* dotAlchemyDirectory,
              "convex",
              "locks",
            );
            const file = path.join(directory, `${deploymentName}.lock`);
            const holder = yield* crypto.randomBytes(16).pipe(
              Effect.flatMap((bytes) =>
                encode({
                  pid: process.pid,
                  token: Buffer.from(bytes).toString("hex"),
                }),
              ),
              Effect.mapError(failed),
            );
            yield* fs
              .makeDirectory(directory, { recursive: true })
              .pipe(Effect.mapError(failed));
            const tryAcquire = fs
              .writeFileString(file, holder, { flag: "wx", mode: 0o600 })
              .pipe(
                Effect.as(true),
                Effect.catchReason("PlatformError", "AlreadyExists", () =>
                  fs.readFileString(file).pipe(
                    Effect.map(decode),
                    Effect.catch(() => Effect.succeedNone),
                    Effect.flatMap((current) =>
                      current._tag === "Some" && !isAlive(current.value.pid)
                        ? fs.remove(file, { force: true })
                        : Effect.void,
                    ),
                    Effect.as(false),
                  ),
                ),
                Effect.mapError(failed),
              );
            const acquire = tryAcquire.pipe(
              Effect.repeat({
                until: (acquired) => acquired,
                schedule: Schedule.spaced("100 millis"),
              }),
              Effect.timeoutOrElse({
                duration: timeout,
                orElse: () =>
                  Effect.fail(
                    new PushLockError({ deploymentName, reason: "timeout" }),
                  ),
              }),
            );
            const release = fs.readFileString(file).pipe(
              Effect.flatMap((current) =>
                current === holder ? fs.remove(file) : Effect.void,
              ),
              Effect.ignore,
            );
            return yield* Effect.acquireUseRelease(
              acquire,
              () => effect,
              () => release,
            );
          }),
      });
    }),
  );
