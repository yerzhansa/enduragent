import { describe, expect, it } from "vitest";
import {
  modelCatalogR2ClientConfig,
  modelCatalogR2ConfigFromEnvironment,
  type ModelCatalogR2StoreConfig,
} from "./model-catalog-r2-store.js";

const STORE_CONFIG: ModelCatalogR2StoreConfig = {
  accountId: "0123456789abcdef0123456789abcdef",
  accessKeyId: "synthetic-access-key",
  secretAccessKey: "synthetic-secret-key",
  bucket: "enduragent-model-catalog-staging",
};

describe("model catalog R2 store configuration", () => {
  it("requires the isolated catalog environment settings", () => {
    expect(
      modelCatalogR2ConfigFromEnvironment({
        ENDURAGENT_MODEL_CATALOG_ACCOUNT_ID: STORE_CONFIG.accountId,
        ENDURAGENT_MODEL_CATALOG_ACCESS_KEY_ID: STORE_CONFIG.accessKeyId,
        ENDURAGENT_MODEL_CATALOG_SECRET_ACCESS_KEY: STORE_CONFIG.secretAccessKey,
        ENDURAGENT_MODEL_CATALOG_BUCKET: STORE_CONFIG.bucket,
      }),
    ).toEqual(STORE_CONFIG);
    expect(() => modelCatalogR2ConfigFromEnvironment({})).toThrow(
      "ENDURAGENT_MODEL_CATALOG_ACCOUNT_ID",
    );
  });

  it("pins the account endpoint and disables SDK retries", () => {
    const config = modelCatalogR2ClientConfig(STORE_CONFIG, {
      endpoint: "https://untrusted.example",
      maxAttempts: 8,
      region: "untrusted",
    });

    expect(config).toMatchObject({
      endpoint: `https://${STORE_CONFIG.accountId}.r2.cloudflarestorage.com`,
      maxAttempts: 1,
      region: "auto",
      credentials: {
        accessKeyId: STORE_CONFIG.accessKeyId,
        secretAccessKey: STORE_CONFIG.secretAccessKey,
      },
    });
  });
});
