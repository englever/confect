import { Http } from "@confect/core";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import { ExecutionMetadata, RequestMetadata } from "./_generated/services";

const HostApi = HttpApi.make("host").add(
  HttpApiGroup.make("metadata").add(
    HttpApiEndpoint.get("contextMetadata", "/context-metadata", {
      success: Schema.Struct({
        functionName: Schema.String,
        deploymentName: Schema.String,
        requestId: Schema.String,
      }),
    }),
  ),
);

const handlers = HttpApiBuilder.group(HostApi, "metadata", (handle) =>
  handle.handle("contextMetadata", () =>
    Effect.gen(function* () {
      const execution = yield* ExecutionMetadata;
      const request = yield* RequestMetadata;
      const fn = yield* execution.getFunction();
      const deployment = yield* execution.getDeployment();
      const metadata = yield* request.get();
      return {
        functionName: fn.name,
        deploymentName: deployment.name,
        requestId: metadata.requestId,
      };
    }).pipe(Effect.orDie),
  ),
);

export default Http.make({ api: HostApi, handlers });
