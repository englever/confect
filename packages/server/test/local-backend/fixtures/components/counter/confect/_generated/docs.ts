import type { Document } from "@confect/server";
import type schemaDefinition from "./schema";

export type CountersDoc = Document.Document<typeof schemaDefinition, "counters">;
export type DeliveriesDoc = Document.Document<typeof schemaDefinition, "deliveries">;

export interface Docs {
  counters: CountersDoc;
  deliveries: DeliveriesDoc;
}
