import { expect, test } from "vitest";
import { preprocess } from "./supertonic";

test("every apostrophe the indexer lacks folds to the ASCII one, Ukrainian's modifier letter included", () => {
  expect(preprocess("пʼять, п’ять, п‘ять", "uk")).toBe("<uk>п'ять, п'ять, п'ять.</uk>");
});
