import type { TestConfect } from "../../../../test/src";
import schema from "../../../../cli/test/fixtures/authored-component/convex/schema";

const modules = {
  "_generated/server.ts": () => Promise.resolve({}),
  "counter.ts": () =>
    import("../../../../cli/test/fixtures/authored-component/convex/counter"),
};

export const register = (
  registerComponent: TestConfect.RegisterComponent,
  name: string,
) => registerComponent(name, schema, modules);
