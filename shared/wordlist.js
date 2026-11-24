// 256 recovery words: one word per byte, so 24 words carry 192 bits.
// Never reorder or edit this list: existing recovery phrases depend on it.
export const WORDS = Object.freeze(`
acid acorn actor adult agent alarm album alley amber angel ankle apple apron arena armor arrow
atlas attic audio autumn badge bagel baker bamboo banjo barn basil basket beach beacon beard beetle
bell bench berry bike bison blade blanket bloom board boat bonus border bottle boxer branch bread
brick bridge brush bucket buffalo bugle butter button cabin cable cactus camel camera candle canoe canyon
carbon cargo carpet carrot castle cattle cave cedar cello chalk charm cheese cherry chess chimney cider
cinema circle citrus clam cliff clock cloud clover coach cobra cocoa comet copper coral cotton cougar
crab crane crater crayon cricket crown crystal cube cup curtain cycle daisy dance delta denim desert
diamond dingo dock dolphin donkey door dragon drum duck dune eagle easel echo eclipse elbow ember
engine falcon fern ferry fiber fiddle field finch fjord flame flute forest fossil fox frost garden
garlic gecko geyser ginger glacier globe glove goat gold gorilla grain grape gravel guitar hammer harbor
harp hawk hazel helmet heron hill honey hornet horse igloo inlet iris island ivory jacket jaguar
jasmine jelly jungle kayak kettle kiwi koala ladder lagoon lake lamp lantern laser lava lemon lily
lion lizard llama lobster locket lotus magnet mango maple marble meadow melon mirror mitten moon moose
mosaic moss motor mountain mule museum nectar needle nest noodle nutmeg oasis ocean olive onion orange
orbit orchid otter owl oyster paddle palm panda paper parrot peach pearl pebble pepper piano pigeon
pillow pine planet plum pony poppy prism pumpkin quartz quill rabbit radio raven reef ribbon river
`.trim().split(/\s+/));
