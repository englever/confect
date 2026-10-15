import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

const Text = Schema.String.pipe(HttpApiSchema.asText());

export const CounterApi = HttpApi.make("counter").add(
  HttpApiGroup.make("health").add(
    HttpApiEndpoint.get("health", "/health", { success: Text }),
    HttpApiEndpoint.post("echo", "/echo", { payload: Text, success: Text }),
  ),
);
