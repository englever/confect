import { HttpRouter as ConfectHttpRouter } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { ExecutionMetadata, RequestMetadata } from "./_generated/services";

const api = HttpApi.make("users").add(
  HttpApiGroup.make("users").add(
    HttpApiEndpoint.get("get", "/users/:id", {
      params: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
    }),
  ),
);
const apiRoutes = HttpApiBuilder.layer(api).pipe(
  Layer.provide(
    HttpApiBuilder.group(api, "users", (handlers) =>
      handlers.handle("get", ({ params }) => Effect.succeed(params.id)),
    ),
  ),
);

export default ConfectHttpRouter.make(
  Layer.mergeAll(
    apiRoutes,
    HttpRouter.add(
      "GET",
      "/context-metadata",
      Effect.gen(function* () {
        const execution = yield* ExecutionMetadata;
        const request = yield* RequestMetadata;
        const fn = yield* execution.getFunction();
        const deployment = yield* execution.getDeployment();
        const metadata = yield* request.get();
        return yield* HttpServerResponse.json({
          functionName: fn.name,
          deploymentName: deployment.name,
          requestId: metadata.requestId,
        });
      }),
    ),
  ),
);
