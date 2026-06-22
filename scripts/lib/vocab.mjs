// Controlled vocabularies for the importer, mirrored from lib/vocab.ts (which is
// in turn mirrored from the "Cookbook catalogue" sheet's legend). Node scripts
// are .mjs and can't import the .ts module, so we keep a runtime copy here.
// KEEP IN SYNC with lib/vocab.ts if you add categories/ingredients.

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
];

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
];

// Guidance handed to the model so it maps everyday recipe names onto the
// controlled vocabularies correctly (the sheet's own legend, condensed).
export const VOCAB_GUIDE = `CATEGORY (the dish type) — choose exactly one of:
${CATEGORIES.map((c) => `- ${c}`).join("\n")}
Notes: "Main or entree" includes sandwiches and breakfast. Salads, soups, and stews
have their own categories. "Core ingredient" = spice mixes, broths/stocks, pastes,
homemade cheeses, flavored syrups (a component, not a standalone dish). "Bread" =
bagels, sourdough, focaccia, tortillas, pie crust, pasta dough (sweet baked goods
go under Dessert). Use "I don't know" only if truly unclassifiable.

MAIN INGREDIENT (usually the protein) — choose one or more of:
${INGREDIENTS.map((i) => `- ${i}`).join("\n")}
Notes: "Poultry" = chicken, turkey, duck, goose. "Pork" = bacon, pancetta, chorizo,
ham, prosciutto, veal. "Beef or lamb" = steak, lamb, bison, chuck. "Fish" = all
seafood and shellfish. "Pasta grain or bread" = rice, noodles, couscous, polenta,
quinoa, tortillas, dumplings, pizza, gnocchi; categorize tarts/pies/dumplings by
their main filler. "Fruit or vegetable" = any produce. "Cheese or dairy" should be
rare — mainly dips, sauces, or homemade cheeses (mac and cheese is "Pasta grain or
bread"). "Sugar" = desserts where fruit isn't the star (cake, cookies, chocolate).
"Alcohol" = only for alcoholic beverages. "N/A" = bread, non-alcoholic beverages,
and some core ingredients (e.g. spice mixes). Prefer the PROTEIN when present: a
chicken-and-rice soup is usually just "Poultry". Most recipes have ONE main
ingredient; only add a second when both are clearly central.`;
