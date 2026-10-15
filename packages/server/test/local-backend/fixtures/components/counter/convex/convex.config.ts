import { defineComponent } from "convex/server";
import { v } from "convex/values";

export default defineComponent("counter", {
  env: {
    COMPONENT_REQUIRED: v.string(),
    COMPONENT_OPTIONAL: v.optional(v.string()),
    COMPONENT_MARKER: v.optional(v.string()),
    COMPONENT_UNBOUND: v.optional(v.string()),
  },
});
