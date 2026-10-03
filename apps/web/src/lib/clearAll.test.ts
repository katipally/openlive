import { expect, test } from "vitest";
import { clearAllRow } from "./clearAll";

test("Clear all shows only with something kept, and is disabled when the one in use is all there is", () => {
  expect(clearAllRow(undefined, "conversations")).toBeNull();
  expect(clearAllRow(0, "dictations")).toBeNull();
  expect(clearAllRow(1, "dictations")).toEqual({ detail: "Deletes every kept dictation", confirm: "Delete it", disabled: false });
  expect(clearAllRow(3, "dictations")).toMatchObject({ confirm: "Delete all 3", disabled: false });
  expect(clearAllRow(1, "conversations", "open")).toEqual({ detail: "Only the open conversation is left, and it stays", confirm: "", disabled: true });
  expect(clearAllRow(1, "sessions", "running")).toMatchObject({ disabled: true });
  expect(clearAllRow(2, "sessions", "running")).toEqual({ detail: "Deletes every kept session but the running one", confirm: "Delete it", disabled: false });
  expect(clearAllRow(5, "conversations", "open")).toMatchObject({ confirm: "Delete all 4" });
});
