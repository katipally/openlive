import { expect, it } from "vitest";
import { chatStore, useChatState } from "./chatStore";

const msgs = (chatId: string) => useChatState.getState().byChat[chatId] ?? [];
let n = 0;
const chat = () => `c${++n}`;

it("files dropped side talk as an aside, above a reply still coming in", () => {
  const c = chat();
  chatStore.aside(c, "did you feed the dog", "you", "j1");
  expect(msgs(c)).toMatchObject([{ role: "user", text: "did you feed the dog", aside: true, speaker: "you", judged: "j1" }]);
  chatStore.liveUserTurn(c, "what time is it");
  chatStore.aside(c, "hang on");
  const m = msgs(c);
  expect(m.map((x) => x.aside ? `aside:${x.text}` : x.role)).toEqual(["aside:did you feed the dog", "user", "aside:hang on", "assistant"]);
});

it("files an aside last once the reply is done", () => {
  const c = chat();
  const a = chatStore.liveUserTurn(c, "hi");
  chatStore.liveFinish(c, a);
  chatStore.aside(c, "one sec");
  expect(msgs(c).at(-1)).toMatchObject({ text: "one sec", aside: true });
});

it("takes an aside back out, once, and only an aside", () => {
  const c = chat();
  chatStore.liveUserTurn(c, "hi");
  chatStore.aside(c, "one sec");
  const user = msgs(c)[0]!, aside = msgs(c).find((x) => x.aside)!;
  expect(chatStore.takeAside(c, user.id)).toBeUndefined();
  expect(chatStore.takeAside(c, aside.id)).toMatchObject({ text: "one sec" });
  expect(chatStore.takeAside(c, aside.id)).toBeUndefined();
  expect(msgs(c).some((x) => x.aside)).toBe(false);
  expect(chatStore.takeAside("nowhere", aside.id)).toBeUndefined();
});

it("marks a spoken turn not for you, saying whether the reply under way answers it", () => {
  const c = chat();
  chatStore.liveUserTurn(c, "first", [], "you", "j1");
  chatStore.liveUserTurn(c, "second", [], "you", "j2");
  chatStore.aside(c, "an aside after");
  const [first, , second] = msgs(c);
  expect(chatStore.notForYou(c, first!.id)).toEqual({ judged: "j1", last: false });
  expect(chatStore.notForYou(c, second!.id)).toEqual({ judged: "j2", last: true });
  expect(msgs(c).filter((x) => x.notForYou).map((x) => x.text)).toEqual(["first", "second"]);
  const aside = msgs(c).find((x) => x.aside)!;
  expect(chatStore.notForYou(c, aside.id)).toBeUndefined();
  expect(chatStore.notForYou(c, msgs(c)[1]!.id)).toBeUndefined(); // an assistant turn
});
