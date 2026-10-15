import { GroupSpec, Spec } from "@confect/core";
import parent from "../parent.spec";

const spec: Spec.Spec<{
  readonly parent: GroupSpec.NamedAt<typeof parent, "parent">;
}> = (Spec.make() as any).addAt("parent", (parent as any));

export default spec;
