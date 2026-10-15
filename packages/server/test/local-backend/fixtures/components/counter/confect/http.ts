import { HttpRouter as ConfectHttpRouter } from "@confect/server";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import schema from "./_generated/schema";
import { ActionCtx } from "./_generated/services";

const api = HttpApi.make("users").add(
  HttpApiGroup.make("users").add(
    HttpApiEndpoint.get("get", "/members/:id", {
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

export default ConfectHttpRouter.forSchema(schema)(
  Layer.mergeAll(
    apiRoutes,
    HttpRouter.add(
      "GET",
      "/health",
      Effect.map(ActionCtx, (ctx) =>
        HttpServerResponse.text(
          Predicate.hasProperty(ctx, "auth")
            ? "unexpected-auth"
            : "component-ready",
        ),
      ),
    ),
    HttpRouter.add(
      "POST",
      "/echo",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return HttpServerResponse.text(yield* request.text);
      }),
    ),
  ),
);
