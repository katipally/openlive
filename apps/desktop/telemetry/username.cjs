"use strict";
// A readable name for an install, so its profile can be found on the dashboard: adjective-animal-xxxxxxxx.
// It is made from the install ID and stored nowhere, so a new ID gives a new name. Nobody types it, and
// nothing about the person goes into it.
//   words   two 32-bit slices of sha256(id), each taken modulo its list (bias under 1 in 10 million)
//   suffix  the first 8 hex characters of the ID, so a name can be matched to a profile ID by eye
// Over 46 bits (about 43,000 word pairs times 32 bits of ID): among 100,000 installs the chance that any two share
// a name is about 1 in 37,000. The profile ID itself stays unique either way.
const { createHash } = require("node:crypto");
const { isUuid } = require("./validate.cjs");

const ADJECTIVES = [
  "adept", "adroit", "affable", "agile", "airy", "alert", "alpine", "ample", "ancient", "arctic", "ardent", "artful",
  "astral", "astute", "atomic", "avid", "azure", "balmy", "beaming", "bold", "bouncy", "brainy", "brave", "breezy",
  "bright", "brisk", "bronze", "bubbly", "buoyant", "busy", "calm", "candid", "capable", "casual", "cheery", "chilly",
  "chipper", "civil", "clear", "clever", "coastal", "cobalt", "comfy", "cordial", "cosmic", "cozy", "crafty",
  "crimson", "crisp", "crystal", "curious", "dainty", "dandy", "dapper", "daring", "dashing", "dauntless", "deft",
  "devoted", "diligent", "dreamy", "dusky", "dynamic", "eager", "early", "earthy", "easy", "elated", "electric",
  "elegant", "emerald", "endless", "epic", "even", "exact", "expert", "fabled", "fair", "fancy", "fast", "fearless",
  "fiery", "firm", "fleet", "floral", "fluent", "fluffy", "focused", "fond", "forest", "fresh", "frosty", "frugal",
  "fuzzy", "gallant", "gentle", "giddy", "gifted", "gilded", "glacial", "glad", "gleeful", "glossy", "glowing",
  "golden", "graceful", "grand", "grateful", "groovy", "handy", "happy", "hardy", "hearty", "honest", "humble", "icy",
  "ideal", "indigo", "jaunty", "jazzy", "jolly", "jovial", "joyful", "keen", "kind", "lively", "lofty", "loyal",
  "lucid", "lucky", "lunar", "lush", "magic", "mellow", "merry", "mighty", "mild", "minty", "modest", "mossy",
  "nifty", "nimble", "noble", "novel", "oaken", "open", "orbital", "patient", "peppy", "placid", "plucky", "polite",
  "proud", "pure", "quick", "quiet", "radiant", "rapid", "ready", "regal", "rosy", "round", "royal", "rustic",
  "savvy", "scenic", "serene", "sharp", "shiny", "silent", "silver", "simple", "sleek", "slick", "smart", "smooth",
  "snappy", "snowy", "snug", "solar", "solid", "sonic", "spry", "stable", "steady", "stellar", "sunlit", "swift",
  "tender", "tidy", "timely", "topaz", "tranquil", "trusty", "umber", "upbeat", "valiant", "velvet", "vivid", "warm",
  "wavy", "whimsical", "wild", "windy", "wise", "witty", "woolly", "zany", "zappy", "zesty", "zippy",
];

const ANIMALS = [
  "alpaca", "antelope", "armadillo", "axolotl", "badger", "bat", "bison", "buffalo", "camel", "capybara", "caribou",
  "cat", "chameleon", "cheetah", "chinchilla", "chipmunk", "cicada", "cormorant", "coyote", "crab", "crane",
  "cricket", "crow", "deer", "dingo", "dolphin", "dove", "dragonfly", "duck", "eagle", "egret", "elephant", "elk",
  "emu", "falcon", "ferret", "finch", "firefly", "flamingo", "fox", "frog", "gazelle", "gecko", "gerbil", "giraffe",
  "gopher", "gorilla", "grouse", "hamster", "hare", "hedgehog", "heron", "hippo", "hummingbird", "husky", "ibex",
  "ibis", "impala", "jackrabbit", "kangaroo", "kingfisher", "kiwi", "koala", "koi", "kudu", "ladybug", "lemming",
  "lemur", "leopard", "lion", "lizard", "llama", "lobster", "lynx", "macaw", "magpie", "manatee", "mantis", "marmot",
  "meerkat", "mink", "minnow", "mole", "mongoose", "moose", "moth", "narwhal", "newt", "ocelot", "octopus", "okapi",
  "opossum", "orca", "oryx", "osprey", "otter", "owl", "oyster", "panda", "panther", "parrot", "partridge", "pelican",
  "penguin", "pheasant", "pigeon", "platypus", "plover", "porcupine", "porpoise", "puffin", "quail", "quokka",
  "rabbit", "reindeer", "rhino", "salamander", "salmon", "sandpiper", "seahorse", "seal", "shark", "sheep", "shrimp",
  "skylark", "sloth", "snail", "sparrow", "squid", "squirrel", "starling", "stork", "swallow", "swan", "tapir",
  "tern", "tiger", "toad", "toucan", "trout", "turtle", "vole", "walrus", "warbler", "whale", "wolf", "wombat",
  "woodpecker", "yak", "zebra", "aardvark", "albatross", "angelfish", "anteater", "beluga", "bluebird", "bonobo",
  "budgie", "bullfrog", "canary", "catfish", "chickadee", "clownfish", "condor", "dormouse", "dugong", "echidna",
  "gannet", "gibbon", "goldfish", "guppy", "halibut", "harrier", "hawk", "hoopoe", "jellyfish", "kinkajou",
  "kookaburra", "loris", "mallard", "mockingbird", "muskrat", "oriole", "pangolin", "perch", "pika", "piranha",
  "pony", "ptarmigan", "roadrunner", "sardine", "serval", "shrike", "springbok", "sunbird", "tamarin", "tarsier",
  "tenrec", "thrush", "tortoise", "tuna", "vicuna", "wallaby", "wildebeest",
];

/** The name of an install ID, or "" when there is no ID to name. */
function usernameOf(id) {
  if (!isUuid(id)) return "";
  const lower = id.toLowerCase();
  const hash = createHash("sha256").update(lower).digest();
  return `${ADJECTIVES[hash.readUInt32BE(0) % ADJECTIVES.length]}-${ANIMALS[hash.readUInt32BE(4) % ANIMALS.length]}-${lower.slice(0, 8)}`;
}

module.exports = { usernameOf, ADJECTIVES, ANIMALS };
