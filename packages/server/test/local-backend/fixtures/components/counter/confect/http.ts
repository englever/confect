import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import { ActionCtx } from "./_generated/services";
import { CounterApi } from "./api";

const handlers = HttpApiBuilder.group(CounterApi, "health", (handle) =>
  handle
    .handle("health", () =>
      Effect.map(ActionCtx, (ctx) =>
        Predicate.hasProperty(ctx, "auth")
          ? "unexpected-auth"
          : "component-ready",
      ),
    )
    .handle("echo", ({ payload }) => Effect.succeed(payload)),
);

export default Http.make({ api: CounterApi, handlers });
