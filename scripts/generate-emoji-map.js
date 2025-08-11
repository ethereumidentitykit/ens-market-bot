const fs = require('fs');
const path = require('path');

// Common emoji mappings to try
const commonEmojis = {
  "🔥": ["Fire.svg"],
  "👨‍⚖️": ["Judge.svg", "Man Judge.svg"],
  "⚡": ["High Voltage.svg"],
  "❤️": ["Red Heart.svg"],
  "😀": ["Grinning Face.svg"],
  "😂": ["Face With Tears Of Joy.svg"],
  "🚀": ["Rocket.svg"],
  "💎": ["Gem Stone.svg"],
  "🏆": ["Trophy.svg"],
  "🎉": ["Party Popper.svg"],
  "⭐": ["Star.svg"],
  "💰": ["Money Bag.svg"],
  "📈": ["Chart Increasing.svg"],
  "🔴": ["Red Circle.svg", "Large Red Circle.svg"],
  "🟢": ["Green Circle.svg", "Large Green Circle.svg"],
  "🔵": ["Blue Circle.svg", "Large Blue Circle.svg"],
  "💯": ["Hundred Points.svg"],
  "🎯": ["Direct Hit.svg"],
  "🌈": ["Rainbow.svg"],
  "⚽": ["Soccer Ball.svg"],
  "🏀": ["Basketball.svg"],
  "🎮": ["Video Game.svg"],
  "🎸": ["Guitar.svg"],
  "📱": ["Mobile Phone.svg"],
  "💻": ["Laptop.svg"],
  "🚗": ["Automobile.svg"],
  "✈️": ["Airplane.svg"],
  "🏠": ["House.svg"],
  "🌍": ["Globe Showing Europe Africa.svg"],
  "🌎": ["Globe Showing Americas.svg"],
  "🌏": ["Globe Showing Asia Australia.svg"],
  "🌙": ["Crescent Moon.svg"],
  "☀️": ["Sun.svg"],
  "⛅": ["Sun Behind Cloud.svg"],
  "🌧️": ["Cloud With Rain.svg"],
  "❄️": ["Snowflake.svg"],
  "🍎": ["Red Apple.svg"],
  "🍕": ["Pizza.svg"],
  "🍔": ["Hamburger.svg"],
  "☕": ["Hot Beverage.svg"],
  "🍺": ["Beer Mug.svg"],
  "🎂": ["Birthday Cake.svg"],
  "🐶": ["Dog Face.svg"],
  "🐱": ["Cat Face.svg"],
  "🦄": ["Unicorn.svg"],
  "🌸": ["Cherry Blossom.svg"],
  "🌹": ["Rose.svg"],
  "🌻": ["Sunflower.svg"],
  "👍": ["Thumbs Up.svg"],
  "👎": ["Thumbs Down.svg"],
  "👏": ["Clapping Hands.svg"],
  "🤝": ["Handshake.svg"],
  "💪": ["Flexed Biceps.svg"],
  "👀": ["Eyes.svg"],
  "👂": ["Ear.svg"],
  "👃": ["Nose.svg"],
  "👄": ["Mouth.svg"],
  "🧠": ["Brain.svg"],
  "💘": ["Heart With Arrow.svg"],
  "💕": ["Two Hearts.svg"],
  "💖": ["Sparkling Heart.svg"],
  "💗": ["Growing Heart.svg"],
  "💙": ["Blue Heart.svg"],
  "💚": ["Green Heart.svg"],
  "💛": ["Yellow Heart.svg"],
  "🧡": ["Orange Heart.svg"],
  "💜": ["Purple Heart.svg"],
  "🖤": ["Black Heart.svg"],
  "🤍": ["White Heart.svg"],
  "🤎": ["Brown Heart.svg"],
  "🐸": ["Frog.svg"],
  "🐢": ["Turtle.svg"],
  "🦊": ["Fox.svg"],
  "🐯": ["Tiger Face.svg"],
  "🦁": ["Lion.svg"],
  "🐨": ["Koala.svg"],
  "🐼": ["Panda.svg"],
  "🐵": ["Monkey Face.svg"],
  "🙈": ["See No Evil Monkey.svg"],
  "🙉": ["Hear No Evil Monkey.svg"],
  "🙊": ["Speak No Evil Monkey.svg"],
  "🌟": ["Glowing Star.svg"],
  "💫": ["Dizzy.svg"],
  "⚡": ["High Voltage.svg"],
  "🔆": ["Bright Button.svg"],
  "🌞": ["Sun With Face.svg"],
  "🌝": ["Full Moon Face.svg"],
  "🌛": ["First Quarter Moon Face.svg"],
  "🌜": ["Last Quarter Moon Face.svg"],
  "🌚": ["New Moon Face.svg"],
  "🌕": ["Full Moon.svg"],
  "🌖": ["Waning Gibbous Moon.svg"],
  "🌗": ["Last Quarter Moon.svg"],
  "🌘": ["Waning Crescent Moon.svg"],
  "🌑": ["New Moon.svg"],
  "🌒": ["Waxing Crescent Moon.svg"],
  "🌓": ["First Quarter Moon.svg"],
  "🌔": ["Waxing Gibbous Moon.svg"]
};

// Path to emoji folder
const emojiDir = path.join(__dirname, '..', 'assets', 'emojis', 'all');

// Get all SVG files
const allFiles = fs.readdirSync(emojiDir).filter(file => file.endsWith('.svg'));

console.log(`Found ${allFiles.length} emoji files`);

// Generate mapping
const emojiMap = {};
let found = 0;
let notFound = 0;

for (const [emoji, possibleFiles] of Object.entries(commonEmojis)) {
  let foundFile = null;
  
  for (const fileName of possibleFiles) {
    if (allFiles.includes(fileName)) {
      foundFile = fileName;
      break;
    }
  }
  
  if (foundFile) {
    emojiMap[emoji] = foundFile;
    found++;
    console.log(`✅ ${emoji} -> ${foundFile}`);
  } else {
    notFound++;
    console.log(`❌ ${emoji} -> Not found (tried: ${possibleFiles.join(', ')})`);
  }
}

console.log(`\nFound: ${found}, Not found: ${notFound}`);

// Write the emoji map
const outputPath = path.join(__dirname, '..', 'assets', 'emoji-map.json');
fs.writeFileSync(outputPath, JSON.stringify(emojiMap, null, 2));

console.log(`\nEmoji map written to: ${outputPath}`);
console.log(`\nExample mapping:`);
console.log(JSON.stringify(emojiMap, null, 2).slice(0, 500) + '...');
