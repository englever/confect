import { mutationGeneric, queryGeneric } from "convex/server";
import { v } from "convex/values";

export const add = mutationGeneric({
  args: { text: v.string() },
  handler: async (ctx, { text }) => {
    await ctx.db.insert("notes", { text });
  },
});

export const list = queryGeneric({
  args: {},
  handler: async (ctx) =>
    (await ctx.db.query("notes").collect()).map((note) => note.text),
});
