import { queryGeneric } from "convex/server";

// Read at module load, which the backend runs while analysing a push: the
// push fails unless the variable was set before it.
const greeting = process.env.GREETING;
if (greeting === undefined)
  throw new Error("GREETING must be set before the first push");

export const get = queryGeneric({ args: {}, handler: async () => greeting });
