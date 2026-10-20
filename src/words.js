// =============================================================================
// words.js: the list of possible passwords
// =============================================================================
//
// Each day, each level picks one word from this list (see derivePassword in
// security.js). The pick is based on a secret, so knowing this list does not
// tell anyone which word is today's password for a given level.
//
// Why it's fine for this list to be public:
//   - The secret (GAME_SECRET) decides which word is picked. The secret is only
//     stored in Cloudflare, never in this repo.
//   - The server limits how many guesses each visitor gets per level per day
//     (MAX_GUESSES_PER_LEVEL in wrangler.jsonc). With 120 words and 10 guesses,
//     random guessing wins about 8% of the time. If that ever feels too easy,
//     add more words here or lower the guess limit.
//
// Rules for words in this list:
//   - Letters only, all uppercase. The guess checker strips everything except
//     letters, so spaces or punctuation in a word would break matching.
//   - 6 to 10 letters. Short words show up by accident in normal replies, which
//     makes the output filter on level 3 block innocent answers.
//   - Not words the AI is likely to say on its own (avoid words like ANSWER,
//     SECRET or PASSWORD).

export const WORDS = [
  'ALMANAC', 'AMETHYST', 'ANCHOVY', 'APRICOT', 'ARMADILLO', 'AVALANCHE',
  'BACKPACK', 'BAGPIPE', 'BALLERINA', 'BAMBOO', 'BANDSTAND', 'BAROMETER',
  'BEACHBALL', 'BLIZZARD', 'BOOMERANG', 'BOUQUET', 'BUTTERCUP', 'CACTUS',
  'CALLIOPE', 'CANTEEN', 'CARDIGAN', 'CAROUSEL', 'CASHMERE', 'CATAPULT',
  'CELLOPHANE', 'CHAMELEON', 'CHESTNUT', 'CINNAMON', 'CLOCKWORK', 'COMPASS',
  'CONFETTI', 'CORDUROY', 'CRESCENT', 'CROISSANT', 'CROWBAR', 'DAFFODIL',
  'DOORBELL', 'DRAGONFLY', 'DUMPLING', 'EGGPLANT', 'EMERALD', 'ESPRESSO',
  'FIREFLY', 'FLAMINGO', 'FOGHORN', 'GARGOYLE', 'GAZEBO', 'GERANIUM',
  'GINGERSNAP', 'GLACIER', 'GONDOLA', 'GRANOLA', 'HAMMOCK', 'HARMONICA',
  'HEDGEHOG', 'HONEYCOMB', 'HOURGLASS', 'IGUANA', 'JAMBOREE', 'JELLYBEAN',
  'JUNIPER', 'KEYSTONE', 'KANGAROO', 'KETTLE', 'LANTERN',
  'LAVENDER', 'LIGHTHOUSE', 'LIMERICK', 'MACARONI', 'MAGNOLIA', 'MARMALADE',
  'MEADOWLARK', 'MONSOON', 'MOONBEAM', 'MUSHROOM', 'NARWHAL', 'NECTARINE',
  'NUTMEG', 'OCTOPUS', 'ORIGAMI', 'OVERCOAT', 'PADDLEBOAT', 'PANCAKE',
  'PAPRIKA', 'PARSNIP', 'PELICAN', 'PEPPERMINT', 'PINECONE', 'PISTACHIO',
  'PLATYPUS', 'PORCUPINE', 'PRETZEL', 'PERISCOPE', 'QUICKSAND',
  'RADISH', 'RAINCOAT', 'RASPBERRY', 'SADDLEBAG', 'SAXOPHONE', 'SCARECROW',
  'SEASHELL', 'SNOWGLOBE', 'SPAGHETTI', 'SPARROW', 'SPRINKLER', 'STARFISH',
  'SUNFLOWER', 'TAMBOURINE', 'TELESCOPE', 'THIMBLE', 'TOBOGGAN', 'TORNADO',
  'TRAMPOLINE', 'TRUFFLE', 'TUMBLEWEED', 'UKULELE', 'VELVET', 'WALRUS',
  'WATERMELON', 'WINDMILL', 'WOODPECKER', 'XYLOPHONE', 'ZEPPELIN', 'ZUCCHINI',
];
