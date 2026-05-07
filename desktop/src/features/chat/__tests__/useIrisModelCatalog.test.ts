import { describe, expect, it } from "vitest";
import type { HermesModelCatalog } from "../../../types/hermes";
import {
  modelSelectionLabel,
  resolveDraftSelection,
  selectionExistsInCatalog,
} from "../useIrisModelCatalog";

const catalog: HermesModelCatalog = {
  ok: true,
  profile: "default",
  current: { provider: "openai-codex", model: "gpt-5.5", providerName: "OpenAI Codex" },
  providers: [
    {
      slug: "openai-codex",
      name: "OpenAI Codex",
      isCurrent: true,
      isUserDefined: false,
      models: ["gpt-5.5", "gpt-5.4"],
      totalModels: 2,
      source: "built-in",
    },
  ],
  generatedAt: 1,
};

describe("Hermes model catalog selection", () => {
  it("uses a saved profile draft only when it still exists in the catalog", () => {
    expect(
      resolveDraftSelection(
        { provider: "openai-codex", model: "gpt-5.4" },
        catalog,
        { provider: "fallback", model: "fallback-model" },
      ),
    ).toEqual({ provider: "openai-codex", model: "gpt-5.4" });
    expect(
      resolveDraftSelection(
        { provider: "missing", model: "gone" },
        catalog,
        { provider: "fallback", model: "fallback-model" },
      ),
    ).toEqual(catalog.current);
  });

  it("falls back to the profile model when catalog discovery is unavailable", () => {
    expect(resolveDraftSelection(undefined, null, { provider: "openrouter", model: "current" })).toEqual({
      provider: "openrouter",
      model: "current",
    });
  });

  it("checks model availability by provider and model id", () => {
    expect(selectionExistsInCatalog({ provider: "openai-codex", model: "gpt-5.5" }, catalog)).toBe(true);
    expect(selectionExistsInCatalog({ provider: "openai-codex", model: "missing" }, catalog)).toBe(false);
    expect(selectionExistsInCatalog({ provider: "other", model: "gpt-5.5" }, catalog)).toBe(false);
  });

  it("keeps the visible picker label compact", () => {
    expect(modelSelectionLabel({ provider: "openai-codex", model: "gpt-5.5" })).toBe("gpt-5.5");
    expect(modelSelectionLabel(null)).toBe("Model");
  });
});
