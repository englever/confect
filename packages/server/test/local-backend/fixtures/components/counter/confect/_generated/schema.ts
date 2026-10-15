import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import counters from "./tables/counters";
import systemIds from "./tables/systemIds";

import { target as $target } from "./id";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly counters: typeof counters;
  readonly systemIds: typeof systemIds;
}, typeof $target> = $DatabaseSchema.make({
  counters,
  systemIds,
}, $target);

export default databaseSchema;
