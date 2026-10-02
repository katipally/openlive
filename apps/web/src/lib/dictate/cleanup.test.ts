import { describe, expect, it } from "vitest";
import { cleanup, countWords, type CleanupRules } from "./cleanup";

const ALL: CleanupRules = { punctuation: true, fillers: true, backtrack: true, lists: true, numbers: true };
const NONE: CleanupRules = { punctuation: false, fillers: false, backtrack: false, lists: false, numbers: false };
const only = (rule: keyof CleanupRules) => ({ ...NONE, [rule]: true });
const cases = (rules: CleanupRules, table: [string, string][]) => {
  for (const [said, typed] of table) expect(cleanup(said, rules), said).toBe(typed);
};

describe("cleanup, all rules on", () => {
  it("turns the settings page's example into what it promises", () => {
    expect(cleanup("um so send twenty five copies to uh Priya, actually Maya, by friday", ALL)).toBe("So send 25 copies to Maya by Friday.");
  });

  it("leaves text that needs nothing exactly as it was", () => {
    cases(ALL, [
      ["I actually like it.", "I actually like it."],
      ["Send it by Friday.", "Send it by Friday."],
      ["Do you know him?", "Do you know him?"],
      ["I like it a lot.", "I like it a lot."],
    ]);
  });

  it("is empty for nothing but filler", () => {
    expect(cleanup("  um  ", ALL)).toBe("");
    expect(cleanup("", ALL)).toBe("");
  });

  it("gives another language only a capital and its own full stop", () => {
    // The English rules stay out: "um" is German for "around".
    expect(cleanup(" um bonjour, en fait, salut ", ALL, "fr")).toBe("Um bonjour, en fait, salut.");
    expect(cleanup("wir treffen uns um acht", ALL, "de")).toBe("Wir treffen uns um acht.");
    expect(cleanup("我今天要去商店买东西", ALL, "zh")).toBe("我今天要去商店买东西。");
    expect(cleanup("मैं कल दफ्तर आऊंगा", ALL, "hi")).toBe("मैं कल दफ्तर आऊंगा।");
    expect(cleanup("명일 회의는 오후 세 시입니다", ALL, "ko")).toBe("명일 회의는 오후 세 시입니다.");
  });

  it("never doubles a sentence end, and leaves a short one or a switched-off rule alone", () => {
    expect(cleanup("¿qué tal estás?", ALL, "es")).toBe("¿Qué tal estás?");
    expect(cleanup("明日は会議があります。", ALL, "ja")).toBe("明日は会議があります。");
    expect(cleanup("hola", ALL, "es")).toBe("Hola");
    expect(cleanup(" ciao a tutti voi ", NONE, "it")).toBe("ciao a tutti voi");
    expect(cleanup("   ", ALL, "pt")).toBe("");
  });

  it("counts words as each script does", () => {
    expect(countWords("send it to Maya, now")).toBe(5);
    expect(countWords("我今天要去商店买东西")).toBeGreaterThan(3);
    expect(countWords("明日は会議があります。")).toBeGreaterThan(2);
    expect(countWords("")).toBe(0);
  });

  it("keeps every word of a long dictation and stays linear", () => {
    const said = "we should ship the dictate mode on friday, actually monday, and then talk to the team ".repeat(4000);
    const started = performance.now();
    const typed = cleanup(said, ALL);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(typed.startsWith("We should ship the dictate mode on Monday and then")).toBe(true);
  });
});

describe("fillers", () => {
  it("drops the sounds, and the commas around them", () => {
    cases(only("fillers"), [
      ["um, so we go", "so we go"],
      ["send it to uh Priya", "send it to Priya"],
      ["I think, um, we should", "I think we should"],
      ["that is it, uh.", "that is it."],
      ["Hmm, erm, okay", "okay"],
    ]);
  });

  it("drops \"you know\" and \"like\" only when they are set off", () => {
    cases(only("fillers"), [
      ["I told you, you know, yesterday", "I told you yesterday"],
      ["You know, the meeting moved", "the meeting moved"],
      ["it was, like, huge", "it was huge"],
      ["do you know him", "do you know him"],
      ["You know what I mean", "You know what I mean"],
      ["it's hard, you know?", "it's hard, you know?"],
      ["I like it", "I like it"],
      ["it looks like rain", "it looks like rain"],
      ["it was, like the old one", "it was, like the old one"],
    ]);
  });

  it("keeps words that only sound like fillers", () => {
    cases(only("fillers"), [["the umbrella is under the err table", "the umbrella is under the err table"]]);
  });
});

describe("backtrack", () => {
  it("swaps the words a short correction replaces", () => {
    cases(only("backtrack"), [
      ["send it to Priya, actually Maya, by friday", "send it to Maya by friday"],
      ["I'll take two, actually three.", "I'll take three."],
      ["meet at five, no wait, six", "meet at six"],
      ["meet at five, wait no, six", "meet at six"],
      ["book the office, actually the cafe", "book the cafe"],
      ["call at 3 pm, actually 4 pm", "call at 4 pm"],
      ["The meeting is on Monday, actually, Tuesday.", "The meeting is on Tuesday."],
      ["Send the file to Priya. Actually Maya.", "Send the file to Maya."],
    ]);
  });

  it("leaves \"actually\" alone when it is not correcting anything", () => {
    cases(only("backtrack"), [
      ["I actually like it", "I actually like it"],
      ["Actually, I think so", "Actually, I think so"],
      ["It's fine, actually.", "It's fine, actually."],
      ["I like it, actually it's great", "I like it, actually it's great"],
      ["She said, actually, we're fine", "She said, actually, we're fine"],
      ["Call him, actually, no.", "Call him, actually, no."],
      ["I think, actually, that it is fine", "I think, actually, that it is fine"],
      ["there was no wait at all", "there was no wait at all"],
      ["Fine. Actually Maya.", "Fine. Actually Maya."],
      ["It went well. Actually everyone came.", "It went well. Actually everyone came."],
    ]);
  });

  it("takes back the sentence before \"scratch that\", or the one before it", () => {
    cases(only("backtrack"), [
      ["Let's meet Monday. Scratch that. Let's meet Tuesday.", "Let's meet Tuesday."],
      ["Let's meet Monday scratch that, Tuesday works", "Tuesday works"],
      ["Hi team. Let's meet Monday, scratch that. See you Tuesday.", "Hi team. See you Tuesday."],
      ["one thing, scratch that", ""],
      ["I need to scratch that itch", "I need to scratch that itch"],
    ]);
  });
});

describe("lists", () => {
  it("numbers spoken items, one per line", () => {
    cases(only("lists"), [
      ["Things to buy: one, milk. Two, eggs. Three, bread.", "Things to buy:\n1. milk\n2. eggs\n3. bread"],
      ["Steps. First, open the app. Second, sign in.", "Steps:\n1. open the app\n2. sign in"],
      ["number one milk, number two eggs", "1. milk\n2. eggs"],
    ]);
  });

  it("leaves counting that is part of a sentence alone", () => {
    cases(only("lists"), [
      ["I have one apple and two oranges", "I have one apple and two oranges"],
      ["One, milk.", "One, milk."],
      ["First, open the app. Third, sign in.", "First, open the app. Third, sign in."],
      ["one of them, two of us", "one of them, two of us"],
    ]);
  });

  it("capitalizes each item with punctuation on, and adds no period after a list", () => {
    expect(cleanup("Things to buy: one, milk. Two, eggs.", ALL)).toBe("Things to buy:\n1. Milk\n2. Eggs");
  });
});

describe("numbers", () => {
  it("writes numbers from ten up as digits", () => {
    cases(only("numbers"), [
      ["twenty five copies", "25 copies"],
      ["twenty-five copies", "25 copies"],
      ["one hundred and five people", "105 people"],
      ["two thousand twenty", "2020"],
      ["ten minutes", "10 minutes"],
      ["three million users", "3,000,000 users"],
      ["two hundred thousand", "200,000"],
      ["about fifty, maybe sixty", "about 50, maybe 60"],
    ]);
  });

  it("keeps one to nine, and anything that is not one number, as words", () => {
    cases(only("numbers"), [
      ["I have two kids", "I have two kids"],
      ["one of them", "one of them"],
      ["twenty twenty six", "twenty twenty six"],
      ["five five five one two", "five five five one two"],
      ["nineteen ninety", "nineteen ninety"],
      ["hundred", "hundred"],
      ["bread and butter", "bread and butter"],
      ["call the constructor", "call the constructor"],
      ["two hundred and", "200 and"],
    ]);
  });
});

describe("punctuation", () => {
  it("capitalizes and closes what the engine left bare", () => {
    cases(only("punctuation"), [
      ["send it by friday", "Send it by Friday."],
      ["i think i'm late. see you", "I think I'm late. See you."],
      ["see you in january okay", "See you in January okay."],
      ["you may march on", "You may march on."],
      ["hello there,", "Hello there"],
    ]);
  });

  it("adds no period to a word or two, which may be a name or a search", () => {
    cases(only("punctuation"), [["maya", "Maya"], ["hello there", "Hello there"]]);
  });

  it("changes nothing the engine already punctuated", () => {
    cases(only("punctuation"), [["Is it done? Yes.", "Is it done? Yes."]]);
  });
});
