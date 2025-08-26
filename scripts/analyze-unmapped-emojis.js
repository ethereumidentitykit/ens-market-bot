const fs = require('fs');
const path = require('path');

console.log('🔍 Analyzing unmapped emoji files...');

// Load current mapping
const emojiMapPath = path.join(__dirname, '..', 'assets', 'emoji-map.json');
const emojiMap = JSON.parse(fs.readFileSync(emojiMapPath, 'utf-8'));

// Get all SVG files
const emojiDir = path.join(__dirname, '..', 'assets', 'emojis', 'all');
const allFiles = fs.readdirSync(emojiDir).filter(file => file.endsWith('.svg'));

// Find unmapped files
const mappedFiles = new Set(Object.values(emojiMap));
const unmappedFiles = allFiles.filter(file => !mappedFiles.has(file));

console.log(`📊 Analysis Results:`);
console.log(`Total files: ${allFiles.length}`);
console.log(`Mapped files: ${mappedFiles.size}`);
console.log(`Unmapped files: ${unmappedFiles.length}`);

// Categorize unmapped files by pattern
const categories = {
  'skin-tone': [],
  'people': [],
  'animals': [],
  'food': [],
  'objects': [],
  'symbols': [],
  'flags': [],
  'activities': [],
  'travel': [],
  'other': []
};

const skinTonePattern = /(Dark|Light|Medium)\s*Skin\s*Tone/i;
const peoplePatterns = /(Man|Woman|Person|Boy|Girl|Child|Adult|Baby)\s/i;
const animalPatterns = /(Cat|Dog|Bird|Fish|Bear|Lion|Tiger|Elephant|Horse|Cow|Pig|Sheep|Monkey|Fox|Wolf|Rabbit)/i;
const foodPatterns = /(Food|Fruit|Vegetable|Drink|Coffee|Tea|Beer|Wine|Cake|Pizza|Burger|Apple|Orange|Banana)/i;
const objectPatterns = /(Computer|Phone|Car|House|Book|Pen|Chair|Table|Clock|Key|Lock|Door|Window)/i;
const symbolPatterns = /(Symbol|Sign|Mark|Arrow|Star|Heart|Circle|Square|Triangle)/i;
const flagPatterns = /Flag/i;
const activityPatterns = /(Sport|Game|Music|Dance|Swimming|Running|Playing|Ball|Guitar|Piano)/i;
const travelPatterns = /(Airplane|Car|Bus|Train|Ship|Boat|Bicycle|Motorcycle|Road|Bridge)/i;

for (const file of unmappedFiles) {
  if (skinTonePattern.test(file)) {
    categories['skin-tone'].push(file);
  } else if (peoplePatterns.test(file)) {
    categories['people'].push(file);
  } else if (animalPatterns.test(file)) {
    categories['animals'].push(file);
  } else if (foodPatterns.test(file)) {
    categories['food'].push(file);
  } else if (objectPatterns.test(file)) {
    categories['objects'].push(file);
  } else if (symbolPatterns.test(file)) {
    categories['symbols'].push(file);
  } else if (flagPatterns.test(file)) {
    categories['flags'].push(file);
  } else if (activityPatterns.test(file)) {
    categories['activities'].push(file);
  } else if (travelPatterns.test(file)) {
    categories['travel'].push(file);
  } else {
    categories['other'].push(file);
  }
}

console.log(`\n📂 Unmapped files by category:`);
for (const [category, files] of Object.entries(categories)) {
  if (files.length > 0) {
    console.log(`${category}: ${files.length} files`);
    // Show first few examples
    files.slice(0, 3).forEach(file => {
      console.log(`  - ${file}`);
    });
    if (files.length > 3) {
      console.log(`  ... and ${files.length - 3} more`);
    }
  }
}

// Find critical missing emojis that might be commonly used
const criticalMissing = [];
const commonEmojiPatterns = [
  /^OK\s*Hand/i,
  /^Waving\s*Hand/i,
  /^Raised\s*Hand/i,
  /^Thumbs\s*Up/i,
  /^Thumbs\s*Down/i,
  /^Peace\s*Sign/i,
  /^Victory\s*Hand/i,
  /^Love\s*You\s*Gesture/i,
  /^Middle\s*Finger/i,
  /^Index\s*Pointing/i,
  /^Clapping\s*Hands/i,
  /^Folded\s*Hands/i,
  /^Face\s*With/i,
  /^Smiling\s*Face/i,
  /^Crying\s*Face/i,
  /^Thinking\s*Face/i,
  /^Money/i,
  /^Dollar/i,
  /^Fire/i,
  /^Rocket/i,
  /^Star/i,
  /^Heart/i,
  /^Crown/i,
  /^Diamond/i,
  /^Trophy/i
];

for (const file of unmappedFiles) {
  if (criticalMissing.length < 50 && commonEmojiPatterns.some(pattern => pattern.test(file))) {
    criticalMissing.push(file);
  }
}

if (criticalMissing.length > 0) {
  console.log(`\n⚠️  Critical missing emojis (commonly used):`);
  criticalMissing.forEach(file => {
    console.log(`  - ${file}`);
  });
}

console.log(`\n💡 Recommendations:`);
console.log(`1. Skin tone variants (${categories['skin-tone'].length} files) can be batch-mapped`);
console.log(`2. People emojis (${categories['people'].length} files) need individual attention`);
console.log(`3. Common gestures and faces should be prioritized`);
console.log(`4. Flag emojis (${categories['flags'].length} files) can be batch-mapped by country codes`);

console.log(`\n✅ Analysis complete!`);
