import { ModelCatalogSnapshotSchema } from "@enduragent/coach-contract/model-catalog";
import { GENERATED_MODEL_CATALOG_SEED } from "./model-catalog-seed.generated.js";

export const BUNDLED_MODEL_CATALOG = ModelCatalogSnapshotSchema.parse(GENERATED_MODEL_CATALOG_SEED);
