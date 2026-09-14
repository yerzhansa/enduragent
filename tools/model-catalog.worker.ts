import {
  handleModelCatalogRequest,
  type ModelCatalogWorkerEnvironment,
} from "./model-catalog-worker.js";

export default {
  fetch(request: Request, environment: ModelCatalogWorkerEnvironment): Promise<Response> {
    return handleModelCatalogRequest(request, environment);
  },
};
