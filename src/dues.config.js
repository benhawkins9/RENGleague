// ── League dues / payment config ────────────────────────────────────────────
// Fill in the commissioner's real handles below, then re-run `npm run build`.
// Leave a handle as "" to hide that payment method until it's ready.
export const dues = {
  amount: 200, //  $ per team
  dueBy: "before Week 1 kickoff",
  season: "2026",
  note: "RENG League Dues 2026", //  memo shown on the payment
  collector: "Ben", //  who's collecting

  venmo: "hawkman", //  Venmo username WITHOUT the @
  cashapp: "henbawkins", //  Cash App $cashtag WITHOUT the $

  // managerIds who've paid this season — add an id here as each team pays.
  paid: [
    "470070299694460928", // OceanGate Titans  (@OldManHawk)
    "470303912964911104", // For a Few Injuries More  (@recklesshubbard)
    "945131126778085376", // MewtwoJigglypuff  (Dylan)
    "418929704997761024", // gwok  (Gary Walker)
    "459424661491412992", // bwood012  (Brian Wood)
    "470415514527592448", // JMoneyz
    "458442701419835392", // jstrick46
    "470083698897711104", // Big Monkey  (alleniverson)
    "860388533259595776", // IgotabigChubba  (StroudBoy4life)
    "470777609840488448", // The Woodies  (TheWood1)
  ],
};
