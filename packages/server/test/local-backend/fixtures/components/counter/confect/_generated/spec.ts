import { GroupSpec, Spec } from "@confect/core";
import authoring from "../authoring.spec";
import counter from "../counter.spec";

const spec: Spec.Spec<{
  readonly authoring: GroupSpec.NamedAt<typeof authoring, "authoring">;
  readonly counter: GroupSpec.NamedAt<typeof counter, "counter">;
}> = (Spec.make() as any).addAt("authoring", (authoring as any)).addAt("counter", (counter as any));

export default spec;
