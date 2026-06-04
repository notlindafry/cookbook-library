// Controlled vocabularies, mirrored from the "Cookbook catalogue" sheet's legend.
// Keep these in sync if you add new categories/ingredients/tags to the sheet.

export const CATEGORIES = [
  "Appetizer or snack",
  "Beverage",
  "Bread",
  "Core ingredient",
  "Dessert",
  "Main or entree",
  "Marinade or sauce",
  "Salad",
  "Side dish",
  "Soup or stew",
  "Other",
  "I don't know",
] as const;

export const INGREDIENTS = [
  "Alcohol",
  "Bean or legume",
  "Egg",
  "Beef or lamb",
  "Cheese or dairy",
  "Fish",
  "Fruit or vegetable",
  "Pasta grain or bread",
  "Pork",
  "Poultry",
  "Sugar",
  "Tofu seitan or meat substitute",
  "Other",
  "N/A",
  "I don't know",
] as const;

export const TRIED_TAGS = [
  "Almost healthy",
  "Cheat day",
  "Diet friendly",
  "Don't make again",
  "Guest-worthy",
  "No remarks but worth repeating",
  "Project",
  "I really want to make this",
] as const;

// Guidance handed to the model so it maps everyday language onto the controlled
// vocabularies correctly (the sheet's own legend, condensed).
export const VOCAB_GUIDE = `CATEGORY (the dish type) — one of:
${CATEGORIES.map((c) => `- ${c}`).join("\n")}
Notes: "Main or entree" includes sandwiches and breakfast. Salads, soups, and stews
have their own categories. "Core ingredient" = spice mixes, broths/stocks, pastes.

MAIN INGREDIENT (usually the protein) — one or more of:
${INGREDIENTS.map((i) => `- ${i}`).join("\n")}
Notes: "Poultry" = chicken, turkey, duck. "Pork" = bacon, pancetta, chorizo, ham,
veal. "Beef or lamb" = steak, lamb, bison. "Fish" = all seafood/shellfish.
"Pasta grain or bread" = rice, noodles, couscous, polenta, tortillas, dumplings,
pizza, gnocchi. "Fruit or vegetable" = any produce. "Sugar" = desserts where fruit
isn't the star. IMPORTANT: this column usually only records the PROTEIN, so a
chicken-and-pasta soup may be tagged only "Poultry". When a query names a food that
isn't a protein (e.g. eggplant, pasta, mushroom), also put that word in "keywords".

TRIED TAG (the user's personal verdict) — one of:
${TRIED_TAGS.map((t) => `- ${t}`).join("\n")}`;
