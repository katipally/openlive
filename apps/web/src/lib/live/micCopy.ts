// One way to say the microphone failed, in Chat's call, Flow's orb and
// Dictate's orb alike.

export const MIC_COPY = {
  /** It could not be opened: its access is off, or another app holds it. */
  noOpen: "Couldn't open the microphone",
  noOpenDetail: "Its access may be off, or another app may be holding it. Nothing was lost. Try again in a moment.",
  /** It went away mid-session: unplugged, or its access turned off. */
  lost: "The microphone went away",
  lostDetail: "It was unplugged or its access was turned off. Nothing was lost. Try again once it's back.",
  /** It went away and the default took over. */
  switched: "The microphone went away. Switched to the default mic.",
} as const;
