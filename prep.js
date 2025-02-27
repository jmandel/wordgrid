/**
 * Bun.js script to output:
 * 1. All seven-letter words with no anagrams from the first file
 * 2. All four-letter words from the second file
 * 3. All five-letter words from the second file
 * 4. All six-letter words from the second file
 * All normalized to lowercase with no headers or counts
 * 
 * Usage:
 * bun run list-words-raw.js path/to/wordlist.txt path/to/auxiliary_wordlist.txt
 */

// Function to generate anagram signature
const getAnagramSignature = (word) => {
  return word.split('').sort().join('');
};

async function findUniqueSevenLetterWords(filePath) {
  const file = Bun.file(filePath);
  const fileContent = await file.text();
  
  // Get seven-letter words and normalize to lowercase
  const words = fileContent.split('\n')
                          .map(line => line.trim().toLowerCase())
                          .filter(word => word.length === 7 && word.match(/^[a-z]+$/));
  
  // Group by anagram signature
  const anagramGroups = {};
  for (const word of words) {
    const signature = getAnagramSignature(word);
    if (!anagramGroups[signature]) {
      anagramGroups[signature] = [];
    }
    anagramGroups[signature].push(word);
  }
  
  // Find words with no anagrams
  const uniqueWords = [];
  for (const signature in anagramGroups) {
    if (anagramGroups[signature].length === 1) {
      uniqueWords.push(anagramGroups[signature][0]);
    }
  }
  
  return uniqueWords.sort();
}

async function listFiveAndSixLetterWords(filePath) {
  const file = Bun.file(filePath);
  const fileContent = await file.text();
  
  // Extract five and six letter words and normalize to lowercase
  const lines = fileContent.split('\n').map(line => line.trim().toLowerCase());
  
  const fourLetterWords = lines
    .filter(word => word.length === 4 && word.match(/^[a-z]+$/))
    .sort();

   const fiveLetterWords = lines
    .filter(word => word.length === 5 && word.match(/^[a-z]+$/))
    .sort();
    
  const sixLetterWords = lines
    .filter(word => word.length === 6 && word.match(/^[a-z]+$/))
    .sort();
  
  return { fourLetterWords, fiveLetterWords, sixLetterWords };
}

// Main execution
async function main() {
  const mainFilePath = process.argv[2];
  const auxiliaryFilePath = process.argv[3];
  
  if (!mainFilePath || !auxiliaryFilePath) {
    console.error('Please provide both file paths as arguments.');
    console.error('Usage: bun run list-words-raw.js path/to/wordlist.txt path/to/auxiliary_wordlist.txt');
    process.exit(1);
  }
  
  try {
    // Get unique seven-letter words
    const uniqueWords = await findUniqueSevenLetterWords(mainFilePath);
    
    // Get all four, five and six letter words
    const { fourLetterWords, fiveLetterWords, sixLetterWords } = await listFiveAndSixLetterWords(auxiliaryFilePath);
    
    // Output just the words, one per line
    console.log(uniqueWords.join('\n'));
    console.log(fourLetterWords.join('\n'));
    console.log(fiveLetterWords.join('\n'));
    console.log(sixLetterWords.join('\n'));
    
  } catch (error) {
    console.error("Error processing files:", error.message);
    process.exit(1);
  }
}

main();
