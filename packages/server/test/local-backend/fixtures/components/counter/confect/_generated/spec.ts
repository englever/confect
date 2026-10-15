import { GroupSpec, Spec } from "@confect/core";
import counter from "../counter.spec";
import deliveries from "../deliveries.spec";

const spec: Spec.Spec<{
  readonly counter: GroupSpec.NamedAt<typeof counter, "counter">;
  readonly deliveries: GroupSpec.NamedAt<typeof deliveries, "deliveries">;
}> = (Spec.make() as any).addAt("counter", (counter as any)).addAt("deliveries", (deliveries as any));

export default spec;
