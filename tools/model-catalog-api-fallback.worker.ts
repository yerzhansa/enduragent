import { handleModelCatalogApiFallbackRequest } from "./model-catalog-api-fallback.js";

export default {
  fetch(): Response {
    return handleModelCatalogApiFallbackRequest();
  },
};
