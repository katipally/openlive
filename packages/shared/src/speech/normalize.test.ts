// The golden set: what each voice is handed for text as the model writes it.
// Every row was checked against how a person says it; a row that changes is
// a change in how the app speaks, so read the diff before updating it.
import { expect, test } from "vitest";
import { normalizeAligned, normalizeSpeech } from "./normalize";
import { compileLexicon } from "./lexicon";

const EN_GOLDEN: [string, string][] = [
  ["I have 3 cats.", "I have three cats."],
  ["There are 12 of them.", "There are twelve of them."],
  ["It took 45 minutes.", "It took forty-five minutes."],
  ["About 100 people came.", "About one hundred people came."],
  ["We sold 101 units.", "We sold one hundred one units."],
  ["The file has 999 lines.", "The file has nine hundred ninety-nine lines."],
  ["Roughly 1,000 users.", "Roughly one thousand users."],
  ["It has 1,234 stars.", "It has one thousand two hundred thirty-four stars."],
  ["Over 10,000 downloads.", "Over ten thousand downloads."],
  ["Nearly 250,000 views.", "Nearly two hundred fifty thousand views."],
  ["1,000,000 people", "one million people"],
  ["3,500,000,000 years", "three billion five hundred million years"],
  ["0 errors", "zero errors"],
  ["Only 1 left.", "Only one left."],
  ["007 is a spy.", "zero zero seven is a spy."],
  ["Order 12345678901 shipped.", "Order one two three four five six seven eight nine zero one shipped."],
  ["Room 42", "Room forty-two"],
  ["Page 7 of 12", "Page seven of twelve"],
  ["pi is 3.14159", "pi is three point one four one five nine"],
  ["It's 0.5 now.", "It's zero point five now."],
  ["Use .5 instead.", "Use point five instead."],
  ["Version 2.0 is out.", "Version two point zero is out."],
  ["It scored 9.75.", "It scored nine point seven five."],
  ["Take 1.5 tablets.", "Take one point five tablets."],
  ["It's -5 outside.", "It's minus five outside."],
  ["The balance is -12.50 now.", "The balance is minus twelve point five zero now."],
  ["Set it to +3.", "Set it to plus three."],
  ["(-2) is negative.", "(minus two) is negative."],
  ["It costs $5.", "It costs five dollars."],
  ["It costs $1.", "It costs one dollar."],
  ["It costs $0.99.", "It costs ninety-nine cents."],
  ["It costs $1,200.50.", "It costs one thousand two hundred dollars and fifty cents."],
  ["It's $3.01.", "It's three dollars and one cent."],
  ["$1.5 a piece", "one dollar and fifty cents a piece"],
  ["$2.5M raised", "two million five hundred thousand dollars raised"],
  ["$10K budget", "ten thousand dollars budget"],
  ["$3B deal", "three billion dollars deal"],
  ["$2 million", "two million dollars"],
  ["£20 note", "twenty pounds note"],
  ["£3.01 total", "three pounds and one penny total"],
  ["€50 fee", "fifty euros fee"],
  ["€1 coin", "one euro coin"],
  ["¥500", "five hundred yen"],
  ["₹1,000", "one thousand rupees"],
  ["₩5000", "five thousand won"],
  ["costs 50 USD", "costs fifty dollars"],
  ["USD 20", "twenty dollars"],
  ["12,50 €", "twelve euros and fifty cents"],
  ["C$15", "fifteen Canadian dollars"],
  ["A$9.99", "nine Australian dollars and ninety-nine cents"],
  ["R$12,50", "twelve reais and fifty centavos"],
  ["Prices range $5-$10.", "Prices range five dollars to ten dollars."],
  ["It's $5-10.", "It's five dollars to ten."],
  ["It's 15% off.", "It's fifteen percent off."],
  ["Up 12.5% this year.", "Up twelve point five percent this year."],
  ["100% sure", "one hundred percent sure"],
  ["0.1% chance", "zero point one percent chance"],
  ["-3% change", "minus three percent change"],
  ["5 % tax", "five percent tax"],
  ["the 1st place", "the first place"],
  ["the 2nd time", "the second time"],
  ["the 3rd try", "the third try"],
  ["the 4th of July", "the fourth of July"],
  ["the 21st century", "the twenty-first century"],
  ["the 22nd floor", "the twenty-second floor"],
  ["the 100th visitor", "the one hundredth visitor"],
  ["the 11th hour", "the eleventh hour"],
  ["the 12th man", "the twelfth man"],
  ["the 13th step", "the thirteenth step"],
  ["On 2026-09-25 we ship.", "On September twenty-fifth, twenty twenty-six we ship."],
  ["Due 2026-01-01.", "Due January first, twenty twenty-six."],
  ["Born 1999-12-31.", "Born December thirty-first, nineteen ninety-nine."],
  ["on 9/25/2026", "on September twenty-fifth, twenty twenty-six"],
  ["on 12/31/1999", "on December thirty-first, nineteen ninety-nine"],
  ["on 25/12/2026", "on December twenty-fifth, twenty twenty-six"],
  ["September 25, 2026", "September twenty-fifth, twenty twenty-six"],
  ["Sept. 3rd", "September third"],
  ["Jan 1", "January first"],
  ["May 5th, 2020", "May fifth, twenty twenty"],
  ["on 3 March 2025", "on the third of March twenty twenty-five"],
  ["2026-02-30 is not a date", "twenty twenty-six-zero two-thirty is not a date"],
  ["In 1984 it rained.", "In nineteen eighty-four it rained."],
  ["Back in 2005.", "Back in two thousand five."],
  ["Since 2000.", "Since two thousand."],
  ["In 2010.", "In twenty ten."],
  ["By 2026.", "By twenty twenty-six."],
  ["In 1900.", "In nineteen hundred."],
  ["In 1905.", "In nineteen oh five."],
  ["the 1990s", "the nineteen nineties"],
  ["the 80s", "the eighties"],
  ["in the '70s", "in the seventies"],
  ["the 2000s", "the two thousands"],
  ["from 2020-2024", "from twenty twenty to twenty twenty-four"],
  ["Meet at 3:30 PM.", "Meet at three thirty P M"],
  ["at 5 p.m. sharp", "at five P M sharp"],
  ["at 9am", "at nine A M"],
  ["It's 15:00.", "It's fifteen hundred."],
  ["at 10:05", "at ten oh five"],
  ["at 12:00", "at twelve o'clock"],
  ["at 7:45 a.m.", "at seven forty-five A M"],
  ["at 0:30", "at zero thirty"],
  ["at 23:59", "at twenty-three fifty-nine"],
  ["John 3:16", "John three sixteen"],
  ["It ran 1:02:03.", "It ran one oh two oh three."],
  ["5-10 people", "five to ten people"],
  ["pages 10–12", "pages ten to twelve"],
  ["ages 3 to 5", "ages three to five"],
  ["a 3-2 win", "a three to two win"],
  ["2-3 days", "two to three days"],
  ["Call 555-123-4567 now", "Call five five five, one two three, four five six seven now"],
  ["Call (555) 123-4567.", "Call five five five, one two three, four five six seven."],
  ["Call 1-800-555-1234.", "Call one, eight zero zero, five five five, one two three four."],
  ["Dial +44 20 7946 0958.", "Dial plus four four, two zero, seven nine four six, zero nine five eight."],
  ["Dial +1 415 555 2671.", "Dial plus one, four one five, five five five, two six seven one."],
  ["mail me at john.doe@example.com", "mail me at john dot doe at example dot com"],
  ["write to support@openlive.dev", "write to support at openlive dot dev"],
  ["see https://www.github.com/foo/bar?x=1", "see github dot com"],
  ["go to http://example.org", "go to example dot org"],
  ["visit www.example.com", "visit example dot com"],
  ["open src/components/App.tsx", "open App dot T S X"],
  ["check ~/projects/app/package.json", "check package dot json"],
  ["edit C:\\Users\\me\\notes.txt", "edit notes dot T X T"],
  ["open README.md", "open README dot M D"],
  ["the file config.yaml", "the file config dot yaml"],
  ["run main.py", "run main dot P Y"],
  ["edit .env", "edit dot env"],
  ["see .gitignore", "see dot gitignore"],
  ["Node.js is fast", "Node dot J S is fast"],
  ["try example.io", "try example dot I O"],
  ["localhost:3000 is up", "localhost three thousand is up"],
  ["docs.example.co.uk", "docs dot example dot co dot U K"],
  ["v1.2.3 is out", "version one point two point three is out"],
  ["update to v2", "update to version two"],
  ["running 1.2.3", "running one point two point three"],
  ["IP 192.168.1.1", "I P one hundred ninety-two dot one hundred sixty-eight dot one dot one"],
  ["the 10.0.0.1 gateway", "the ten dot zero dot zero dot one gateway"],
  ["Python 3.12", "Python three point one two"],
  ["call useState()", "call use State"],
  ["use console.log()", "use console dot log"],
  ["my_file_name is long", "my file name is long"],
  ["getElementById works", "get Element By Id works"],
  ["run it with --verbose", "run it with dash dash verbose"],
  ["add -v for more", "add dash v for more"],
  ["the macOS app", "the mac O S app"],
  ["try C++", "try C plus plus"],
  ["try C# too", "try C sharp too"],
  ["use the API", "use the A P I"],
  ["the GPU is hot", "the G P U is hot"],
  ["send JSON over HTTPS", "send JSON over H T T P S"],
  ["APIs and URLs", "A P I's and U R L's"],
  ["a PDF file", "a P D F file"],
  ["the CEO said", "the C E O said"],
  ["NASA launched it", "NASA launched it"],
  ["the USB port", "the U S B port"],
  ["an SQL query", "an S Q L query"],
  ["LLM output", "L L M output"],
  ["OK then", "OK then"],
  ["WHAT IS THIS", "WHAT IS THIS"],
  ["R&D team", "R and D team"],
  ["salt & pepper", "salt and pepper"],
  ["2 + 2 = 4", "two plus two equals four"],
  ["~5 minutes", "about five minutes"],
  ["< 10 ms", "less than ten milliseconds"],
  ["> 100 users", "more than one hundred users"],
  ["±2 degrees", "plus or minus two degrees"],
  ["A → B", "A to B"],
  ["and/or", "and or"],
  ["#1 pick", "number one pick"],
  ["@openlive on X", "at openlive on X"],
  ["#hashtag", "hashtag"],
  ["-5°C outside", "minus five degrees Celsius outside"],
  ["72°F", "seventy-two degrees Fahrenheit"],
  ["90° turn", "ninety degrees turn"],
  ["60 mph", "sixty miles per hour"],
  ["100 km/h", "one hundred kilometers per hour"],
  ["5 km", "five kilometers"],
  ["1 km", "one kilometer"],
  ["2.5 kg", "two point five kilograms"],
  ["8 oz", "eight ounces"],
  ["3 ft", "three feet"],
  ["a 2 GB file", "a two gigabytes file"],
  ["16GB of memory", "sixteen gigabytes of memory"],
  ["1 TB", "one terabyte"],
  ["3.2 GHz", "three point two gigahertz"],
  ["500 mAh", "five hundred milliamp hours"],
  ["60 fps", "sixty frames per second"],
  ["20 ms", "twenty milliseconds"],
  ["5 min", "five minutes"],
  ["2 h", "two hours"],
  ["30 sec", "thirty seconds"],
  ["1 L", "one liter"],
  ["250 ml", "two hundred fifty milliliters"],
  ["3x faster", "three times faster"],
  ["1920x1080", "nineteen twenty by one thousand eighty"],
  ["3 x 4", "three times four"],
  ["10k users", "ten thousand users"],
  ["a 4K screen", "a four K screen"],
  ["8B model", "eight billion model"],
  ["1080p video", "ten eighty p video"],
  ["mp3 file", "mp three file"],
  ["H2O", "H two O"],
  ["GPT-4o", "G P T-four o"],
  ["COVID-19", "COVID-nineteen"],
  ["1/2 cup", "one half cup"],
  ["3/4 inch", "three quarters inch"],
  ["2/3 done", "two thirds done"],
  ["24/7 support", "twenty-four seven support"],
  ["$1,200.50 | 2026-09-25 | openlive.dev", "one thousand two hundred dollars and fifty cents, September twenty-fifth, twenty twenty-six, openlive dot dev"],
  ["| Plan | Price |", "Plan, Price"],
  ["Fast • cheap • local", "Fast, cheap, local"],
  ["wait --- no", "wait, no"],
  ["Home · About · la col·lecció", "Home, About, la col·lecció"],
  ["½ price", "one half price"],
  ["e.g. this one", "for example this one"],
  ["i.e. that one", "that is that one"],
  ["apples, pears, etc.", "apples, pears, et cetera"],
  ["cats vs. dogs", "cats versus dogs"],
  ["Dr. Smith", "Doctor Smith"],
  ["Mr. Jones", "Mister Jones"],
  ["Mrs. Lee", "Missus Lee"],
  ["No. 5", "number five"],
  ["approx. 3", "approximately three"],
  ["a.k.a. Bob", "also known as Bob"],
  ["w/ cheese", "with cheese"],
  ["Great job 🎉", "Great job"],
  ["Flags 🇺🇸 here", "Flags here"],
  ["1️⃣ first", "one first"],
  ["Hello there, how are you?", "Hello there, how are you?"],
  ["It's a lovely day.", "It's a lovely day."],
];

const OTHER_GOLDEN: [lang: string, text: string, said: string][] = [
  ["es", "Tengo 3 gatos.", "Tengo tres gatos."],
  ["es", "Cuesta 12,50 €.", "Cuesta doce euros con cincuenta céntimos."],
  ["es", "1.500 personas", "mil quinientos personas"],
  ["es", "el 25 de septiembre", "el veinticinco de septiembre"],
  ["es", "a las 15:30", "a las quince y treinta"],
  ["es", "el 1º y la 2ª", "el primero y la segunda"],
  ["es", "3,5 km", "tres coma cinco kilómetros"],
  ["es", "1 km", "un kilómetro"],
  ["es", "50%", "cincuenta por ciento"],
  ["es", "$20", "veinte dólares"],
  ["es", "2026-09-25", "veinticinco de septiembre de dos mil veintiséis"],
  ["es", "-5 grados", "menos cinco grados"],
  ["es", "v1.2", "versión uno punto dos"],
  ["es", "5-10 días", "cinco a diez días"],
  ["es", "p. ej. esto", "por ejemplo esto"],
  ["fr", "J'ai 3 chats.", "J'ai trois chats."],
  ["fr", "1er mai", "premier mai"],
  ["fr", "la 2e fois", "la deuxième fois"],
  ["fr", "à 15h30", "à quinze heures trente"],
  ["fr", "12,50 €", "douze euros et cinquante centimes"],
  ["fr", "1 234,5", "mille deux cent trente-quatre virgule cinq"],
  ["fr", "2026-09-25", "vingt-cinq septembre deux mille vingt-six"],
  ["fr", "2026-09-01", "premier septembre deux mille vingt-six"],
  ["fr", "50 %", "cinquante pour cent"],
  ["fr", "3,5 km", "trois virgule cinq kilomètres"],
  ["fr", "à 15:30", "à quinze heures trente"],
  ["de", "Ich habe 3 Katzen.", "Ich habe drei Katzen."],
  ["de", "am 3. Oktober 1990", "am dritten Oktober neunzehnhundertneunzig"],
  ["de", "um 15:30 Uhr", "um fünfzehn Uhr dreißig"],
  ["de", "1 Uhr", "ein Uhr"],
  ["de", "1.500 Leute", "eintausendfünfhundert Leute"],
  ["de", "3,5 km", "drei Komma fünf Kilometer"],
  ["de", "1 km", "ein Kilometer"],
  ["de", "2026-09-01", "erste September zweitausendsechsundzwanzig"],
  ["de", "25.12.2026", "fünfundzwanzigste Dezember zweitausendsechsundzwanzig"],
  ["de", "50 %", "fünfzig Prozent"],
  ["de", "12,50 €", "zwölf Euro und fünfzig Cent"],
  ["de", "z. B. das", "zum Beispiel das"],
  ["de", "im Jahr 1984", "im Jahr neunzehnhundertvierundachtzig"],
  ["it", "Ho 3 gatti.", "Ho tre gatti."],
  ["it", "alle 15:30", "alle quindici e trenta"],
  ["it", "il 1º posto", "il primo posto"],
  ["it", "12,50 €", "dodici euro e cinquanta centesimi"],
  ["it", "2026-09-25", "venticinque settembre duemilaventisei"],
  ["it", "50%", "cinquanta per cento"],
  ["it", "1 km", "un chilometro"],
  ["pt", "Tenho 3 gatos.", "Tenho três gatos."],
  ["pt", "R$ 12,50", "doze reais e cinquenta centavos"],
  ["pt", "a 3ª vez", "a terceira vez"],
  ["pt", "2026-09-25", "vinte e cinco de setembro de dois mil e vinte e seis"],
  ["pt", "às 15:30", "às quinze e trinta"],
  ["pt", "50%", "cinquenta por cento"],
  ["hi", "मेरे पास 3 बिल्लियाँ हैं।", "मेरे पास तीन बिल्लियाँ हैं।"],
  ["hi", "1,23,456 रुपये", "एक लाख तेईस हज़ार चार सौ छप्पन रुपये"],
  ["hi", "3:30 बजे", "तीन बजकर तीस मिनट"],
  ["hi", "₹500", "पाँच सौ रुपये"],
  ["hi", "50%", "पचास प्रतिशत"],
  ["hi", "2026-09-25", "पच्चीस सितंबर दो हज़ार छब्बीस"],
  ["zh", "我有3个苹果。", "我有三个苹果。"],
  ["zh", "2026年9月25日", "二零二六年九月二十五日"],
  ["zh", "2026-09-25", "二零二六年九月二十五日"],
  ["zh", "15%", "百分之十五"],
  ["zh", "3:05", "三点零五分"],
  ["zh", "2点", "两点"],
  ["zh", "¥12.5", "十二元五角"],
  ["zh", "10个", "十个"],
  ["zh", "3.5公里", "三点五公里"],
  ["ja", "猫が3匹います。", "猫が三匹います。"],
  ["ja", "2026年9月25日", "二千二十六年九月二十五日"],
  ["ja", "15%", "十五パーセント"],
  ["ja", "3:30", "三時三十分"],
  ["ja", "¥500", "五百円"],
  ["ja", "2026-09-25", "二千二十六年九月二十五日"],
  ["ko", "3개", "세 개"],
  ["ko", "6월", "유월"],
  ["ko", "10월", "시월"],
  ["ko", "3:30", "세 시 삼십 분"],
  ["ko", "15%", "십오 퍼센트"],
  ["ko", "₩5000", "오천원"],
  ["ko", "2026-06-10", "이천이십육년 유월 십일"],
  ["ko", "20살", "스무 살"],
  ["de", "am 01.09.2026", "am ersten September zweitausendsechsundzwanzig"],
];

test("English golden set", () => {
  expect(EN_GOLDEN.length).toBeGreaterThanOrEqual(150);
  for (const [text, said] of EN_GOLDEN) expect(normalizeSpeech(text, "en"), text).toBe(said);
});

test("golden sets for the other session languages", () => {
  for (const [lang, text, said] of OTHER_GOLDEN) expect(normalizeSpeech(text, lang), `${lang}: ${text}`).toBe(said);
  // Every language the app runs in has cases.
  expect(new Set(OTHER_GOLDEN.map(([l]) => l))).toEqual(new Set(["es", "fr", "de", "it", "pt", "hi", "zh", "ja", "ko"]));
});

test("no digit reaches a voice, and a second pass changes nothing", () => {
  for (const [text, said] of EN_GOLDEN) {
    if (text !== "2026-02-30 is not a date") expect(said, text).not.toMatch(/\d/);
    expect(normalizeSpeech(said, "en"), text).toBe(said);
  }
});

test("zero data, unknown languages and prose", () => {
  expect(normalizeSpeech("", "en")).toBe("");
  expect(normalizeSpeech("   ", "ja")).toBe("");
  expect(normalizeSpeech("I have 3 cats.", "xx")).toBe("I have three cats.");
  const prose = "Honestly, I think the second option is better, because it keeps the data in one place.";
  expect(normalizeSpeech(prose, "en")).toBe(prose);
});

test("tables, rules, box drawing and bullets: a pause between words, nothing at an edge", () => {
  const table = "| Plan | Price |\n|:---|---:|\n| Pro | $20 |\n| Team | $50 |";
  expect(normalizeSpeech(table, "en")).toBe("Plan, Price, Pro, twenty dollars, Team, fifty dollars");
  expect(normalizeSpeech("┌──────┐\n│ Done │\n└──────┘", "en")).toBe("Done");
  expect(normalizeSpeech("|---|---|", "en")).toBe("");
  expect(normalizeSpeech("Plan: | Pro |.", "en")).toBe("Plan: Pro.");
  expect(normalizeSpeech("价格 | 20元", "zh")).toBe("价格，二十元");
  expect(normalizeSpeech("料金 | 3杯", "ja")).toBe("料金、三杯");
  expect(normalizeSpeech("योजना | कीमत", "hi")).toBe("योजना, कीमत");
  expect(normalizeSpeech("Plan | Preis", "de")).toBe("Plan, Preis");
  // Linear on an enormous table.
  const big = "| a | b |\n".repeat(20000);
  const t0 = performance.now();
  expect(normalizeSpeech(big, "en")).toBe(Array.from({ length: 40000 }, (_, i) => (i % 2 ? "b" : "a")).join(", "));
  expect(performance.now() - t0).toBeLessThan(3000);
});

test("very long text stays linear and loses nothing", () => {
  const line = "On 2026-09-25 at 3:30 PM, 1,200 users paid $4.99 (15% off) at example.com. ";
  const long = line.repeat(1500); // ~110k characters
  const t0 = performance.now();
  const said = normalizeSpeech(long, "en");
  expect(performance.now() - t0).toBeLessThan(3000);
  expect(said).not.toMatch(/\d/);
  expect(said.split("fifteen percent off").length - 1).toBe(1500);
});

/** Each said word with the text it was read from. */
const readFrom = (text: string, lang = "en", lexicon?: Parameters<typeof normalizeAligned>[2]) => {
  const { said, from } = normalizeAligned(text, lang, lexicon);
  let at = 0;
  return said.split(" ").map((w) => { const r = [w, text.slice(from[at]!, from[at + w.length]!)]; at += w.length + 1; return r; });
};

test("normalizeAligned: every said character points into the text, in order", () => {
  for (const [lang, text] of [...EN_GOLDEN.map(([t]) => ["en", t] as const), ...OTHER_GOLDEN.map(([l, t]) => [l, t] as const)]) {
    const { said, from } = normalizeAligned(text, lang);
    expect(said).toBe(normalizeSpeech(text, lang));
    expect(from, text).toHaveLength(said.length + 1);
    for (let i = 1; i < from.length; i++) expect(from[i]!, text).toBeGreaterThanOrEqual(from[i - 1]!);
    expect(from.every((f) => f >= 0 && f <= text.length), text).toBe(true);
  }
});

test("normalizeAligned: a spelled-out form reads from what it replaced", () => {
  const words = readFrom("It costs $1,200 today.");
  expect(words.slice(0, 2)).toEqual([["It", "It"], ["costs", "costs"]]);
  // "one thousand two hundred dollars" spans "$1,200", start to end
  expect(words.slice(2, 7).map(([, t]) => t).join("")).toBe("$1,200");
  expect(words.at(-1)).toEqual(["today.", "today."]);
  // Unspaced: each character of 三匹 reads from 3 or 匹.
  const { said, from } = normalizeAligned("猫が3匹います。", "ja");
  expect(said).toBe("猫が三匹います。");
  expect("猫が3匹います。"[from[said.indexOf("三")]!]).toBe("3");
  expect("猫が3匹います。"[from[said.indexOf("匹")]!]).toBe("匹");
});

test("normalizeAligned: a pronunciation reads from the word it respells", () => {
  const lex = compileLexicon([{ from: "Nginx", to: "engine x", lang: "", matchCase: false, wholeWord: true }], "en");
  expect(readFrom("Restart Nginx on 3 hosts.", "en", lex)).toEqual([
    ["Restart", "Restart"], ["engine", "Ngi"], ["x", "x"], ["on", "on"], ["three", "3"], ["hosts.", "hosts."],
  ]);
});
