const fs = require('fs');
const path = require('path');

console.log('🔄 Regenerating complete emoji mapping...');

// Path to emoji folder
const emojiDir = path.join(__dirname, '..', 'assets', 'emojis', 'all');

// Get all SVG files
const allFiles = fs.readdirSync(emojiDir).filter(file => file.endsWith('.svg'));
console.log(`Found ${allFiles.length} emoji SVG files`);

// Load existing mapping to preserve manual fixes
const existingMapPath = path.join(__dirname, '..', 'assets', 'emoji-map.json');
let existingMap = {};
try {
  const existingData = fs.readFileSync(existingMapPath, 'utf-8');
  existingMap = JSON.parse(existingData);
  console.log(`Loaded existing mapping with ${Object.keys(existingMap).length} entries`);
} catch (error) {
  console.log('No existing mapping found, starting fresh');
}

// Common filename to emoji mappings - this is the key part we need to expand
const fileNameToEmoji = {
  // People & Body
  "Bust In Silhouette.svg": "👤",
  "Busts In Silhouette.svg": "👥",
  "Person Taking Bath.svg": "🛀",
  "Shower.svg": "🚿",
  "Bathtub.svg": "🛁",
  
  // Basic smileys
  "Grinning Face.svg": "😀",
  "Grinning Face With Big Eyes.svg": "😃",
  "Grinning Face With Smiling Eyes.svg": "😄",
  "Beaming Face With Smiling Eyes.svg": "😁",
  "Grinning Squinting Face.svg": "😆",
  "Grinning Face With Sweat.svg": "😅",
  "Rolling On The Floor Laughing.svg": "🤣",
  "Face With Tears Of Joy.svg": "😂",
  "Slightly Smiling Face.svg": "🙂",
  "Upside Down Face.svg": "🙃",
  "Winking Face.svg": "😉",
  "Smiling Face With Smiling Eyes.svg": "😊",
  "Smiling Face With Halo.svg": "😇",
  
  // Hearts
  "Red Heart.svg": "❤️",
  "Orange Heart.svg": "🧡", 
  "Yellow Heart.svg": "💛",
  "Green Heart.svg": "💚",
  "Blue Heart.svg": "💙",
  "Purple Heart.svg": "💜",
  "Brown Heart.svg": "🤎",
  "Black Heart.svg": "🖤",
  "White Heart.svg": "🤍",
  "Heart With Arrow.svg": "💘",
  "Heart With Ribbon.svg": "💝",
  "Sparkling Heart.svg": "💖",
  "Growing Heart.svg": "💗",
  "Beating Heart.svg": "💓",
  "Revolving Hearts.svg": "💞",
  "Two Hearts.svg": "💕",
  "Heart Decoration.svg": "💟",
  "Broken Heart.svg": "💔",
  
  // Fire and energy
  "Fire.svg": "🔥",
  "High Voltage.svg": "⚡",
  "Rocket.svg": "🚀",
  "Star.svg": "⭐",
  "Glowing Star.svg": "🌟",
  "Sparkles.svg": "✨",
  "Collision.svg": "💥",
  
  // Crown and royalty
  "Crown.svg": "👑",
  "Gem Stone.svg": "💎",
  "Ring.svg": "💍",
  "Trophy.svg": "🏆",
  "Sports Medal.svg": "🏅",
  "1st Place Medal.svg": "🥇",
  "2nd Place Medal.svg": "🥈", 
  "3rd Place Medal.svg": "🥉",
  
  // Money and success
  "Money Bag.svg": "💰",
  "Dollar Banknote.svg": "💵",
  "Yen Banknote.svg": "💴",
  "Euro Banknote.svg": "💶",
  "Pound Banknote.svg": "💷",
  "Coin.svg": "🪙",
  "Chart Increasing.svg": "📈",
  "Chart Decreasing.svg": "📉",
  "Hundred Points.svg": "💯",
  
  // Gaming
  "Video Game.svg": "🎮",
  "Joystick.svg": "🕹️",
  "Game Die.svg": "🎲",
  "Direct Hit.svg": "🎯",
  
  // Tech
  "Mobile Phone.svg": "📱",
  "Laptop.svg": "💻",
  "Desktop Computer.svg": "🖥️",
  "Computer Mouse.svg": "🖱️",
  "Keyboard.svg": "⌨️",
  
  // Common gestures
  "Thumbs Up.svg": "👍",
  "Thumbs Down.svg": "👎", 
  "Clapping Hands.svg": "👏",
  "Waving Hand.svg": "👋",
  "Raised Hand.svg": "✋",
  "Victory Hand.svg": "✌️",
  "Crossed Fingers.svg": "🤞",
  "OK Hand.svg": "👌",
  "Pinched Fingers.svg": "🤌",
  "Pinching Hand.svg": "🤏",
  "Index Pointing Up.svg": "☝️",
  "Index Pointing Right.svg": "👉",
  "Index Pointing Down.svg": "👇",
  "Index Pointing Left.svg": "👈",
  
  // Animals
  "Dog Face.svg": "🐶",
  "Cat Face.svg": "🐱", 
  "Mouse Face.svg": "🐭",
  "Hamster.svg": "🐹",
  "Rabbit Face.svg": "🐰",
  "Fox.svg": "🦊",
  "Bear.svg": "🐻",
  "Panda.svg": "🐼",
  "Koala.svg": "🐨",
  "Tiger Face.svg": "🐯",
  "Lion.svg": "🦁",
  "Cow Face.svg": "🐮",
  "Pig Face.svg": "🐷",
  "Frog.svg": "🐸",
  "Monkey Face.svg": "🐵",
  
  // Nature
  "Sun.svg": "☀️",
  "Moon.svg": "🌙",
  "Crescent Moon.svg": "🌙",
  "Full Moon.svg": "🌕",
  "Rainbow.svg": "🌈",
  "Cloud.svg": "☁️",
  "Snowflake.svg": "❄️",
  "Tree.svg": "🌳",
  "Evergreen Tree.svg": "🌲",
  "Rose.svg": "🌹",
  "Tulip.svg": "🌷",
  "Sunflower.svg": "🌻",
  "Cherry Blossom.svg": "🌸",
  
  // Food
  "Red Apple.svg": "🍎",
  "Green Apple.svg": "🍏",
  "Banana.svg": "🍌",
  "Orange.svg": "🍊",
  "Grapes.svg": "🍇",
  "Strawberry.svg": "🍓",
  "Pizza.svg": "🍕",
  "Hamburger.svg": "🍔",
  "Hot Dog.svg": "🌭",
  "Taco.svg": "🌮",
  "Birthday Cake.svg": "🎂",
  "Cookie.svg": "🍪",
  "Doughnut.svg": "🍩",
  "Ice Cream.svg": "🍦",
  
  // Drinks
  "Hot Beverage.svg": "☕",
  "Beer Mug.svg": "🍺",
  "Wine Glass.svg": "🍷",
  "Cocktail Glass.svg": "🍸",
  "Tropical Drink.svg": "🍹",
  
  // Transport
  "Automobile.svg": "🚗",
  "Taxi.svg": "🚕",
  "Bus.svg": "🚌",
  "Airplane.svg": "✈️",
  "Ship.svg": "🚢",
  "Bicycle.svg": "🚲",
  "Motorcycle.svg": "🏍️",
  "Train.svg": "🚂",
  
  // Objects
  "House.svg": "🏠",
  "School.svg": "🏫",
  "Hospital.svg": "🏥",
  "Bank.svg": "🏦",
  "Key.svg": "🔑",
  "Lock.svg": "🔒",
  "Unlocked.svg": "🔓",
  "Bell.svg": "🔔",
  "Light Bulb.svg": "💡",
  "Candle.svg": "🕯️",
  
  // Symbols
  "Check Mark.svg": "✅",
  "Cross Mark.svg": "❌",
  "Warning.svg": "⚠️",
  "Exclamation Mark.svg": "❗",
  "Question Mark.svg": "❓",
  "Plus.svg": "➕",
  "Minus.svg": "➖",
  "Multiply.svg": "✖️",
  "Divide.svg": "➗"
};

// Generate the new mapping
const newEmojiMap = {};
let mappedCount = 0;
let preservedCount = 0;
let unmappedCount = 0;

// First, preserve existing real emoji mappings (not placeholders)
for (const [key, value] of Object.entries(existingMap)) {
  if (!key.startsWith('📄_')) {
    newEmojiMap[key] = value;
    preservedCount++;
  }
}

// Then add mappings from our filename dictionary
for (const [fileName, emoji] of Object.entries(fileNameToEmoji)) {
  if (allFiles.includes(fileName)) {
    newEmojiMap[emoji] = fileName;
    mappedCount++;
    console.log(`✅ ${emoji} -> ${fileName}`);
  } else {
    console.log(`⚠️  ${emoji} -> ${fileName} (file not found)`);
  }
}

// For files we couldn't map, create placeholder entries for manual mapping later
const mappedFiles = new Set(Object.values(newEmojiMap));
const unmappedFiles = allFiles.filter(file => !mappedFiles.has(file));

console.log(`\n📊 Mapping Results:`);
console.log(`✅ Preserved existing mappings: ${preservedCount}`);
console.log(`✅ New mappings created: ${mappedCount}`);
console.log(`⚠️  Files still unmapped: ${unmappedFiles.length}`);
console.log(`📁 Total emoji files: ${allFiles.length}`);
console.log(`🎯 Total mapped emojis: ${Object.keys(newEmojiMap).length}`);

// Write the new emoji map
const outputPath = path.join(__dirname, '..', 'assets', 'emoji-map.json');
const backupPath = path.join(__dirname, '..', 'assets', 'emoji-map-backup.json');

// Backup existing file
if (fs.existsSync(outputPath)) {
  fs.copyFileSync(outputPath, backupPath);
  console.log(`📄 Backed up existing mapping to: emoji-map-backup.json`);
}

fs.writeFileSync(outputPath, JSON.stringify(newEmojiMap, null, 2));

console.log(`\n✅ New emoji map written to: ${outputPath}`);
console.log(`\n🎯 Critical emojis now mapped:`);
console.log(`   👤 (bust in silhouette): ${newEmojiMap['👤'] || 'NOT FOUND'}`);
console.log(`   🛀 (person taking bath): ${newEmojiMap['🛀'] || 'NOT FOUND'}`);
console.log(`   🚿 (shower): ${newEmojiMap['🚿'] || 'NOT FOUND'}`);
console.log(`   🛁 (bathtub): ${newEmojiMap['🛁'] || 'NOT FOUND'}`);

if (unmappedFiles.length > 0) {
  console.log(`\n⚠️  Note: ${unmappedFiles.length} files still need manual mapping.`);
  console.log(`   First 10 unmapped files:`);
  unmappedFiles.slice(0, 10).forEach(file => {
    console.log(`   - ${file}`);
  });
}

console.log(`\n🚀 Emoji mapping regeneration complete!`);
