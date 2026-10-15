import { DatabaseSchema as $DatabaseSchema } from "@confect/server";

import counters from "./tables/counters";
import deliveries from "./tables/deliveries";

import { target as $target } from "./id";
const databaseSchema: $DatabaseSchema.DatabaseSchema<{
  readonly counters: typeof counters;
  readonly deliveries: typeof deliveries;
}, typeof $target> = $DatabaseSchema.make({
  counters,
  deliveries,
}, $target);

export default databaseSchema;
