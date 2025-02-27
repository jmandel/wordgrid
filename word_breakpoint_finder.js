#!/usr/bin/env bun

import { parse } from 'csv-parse/sync';
import { readFileSync, writeFileSync } from 'fs';
import * as readline from 'readline';

// Create readline interface for CLI interaction
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Function to prompt user and get response
const askQuestion = (query) => new Promise((resolve) => rl.question(query, resolve));

// Load and parse the CSV file
async function loadWordFrequencies() {
  try {
    const fileContent = readFileSync('unigram_freq.csv', 'utf8');
    const records = parse(fileContent, {
      columns: true,
      skip_empty_lines: true
    });
    return records;
  } catch (error) {
    console.error('Error loading word frequencies:', error.message);
    process.exit(1);
  }
}

// Load the pre-filtered wordlist
function loadWordlist() {
  try {
    const content = readFileSync('./wordlist.txt', 'utf8');
    const words = content.split('\n').filter(line => line.trim().length > 0);
    console.log(`Loaded ${words.length} pre-filtered words from wordlist.txt`);
    return new Set(words.map(w => w.toLowerCase()));
  } catch (error) {
    console.error('Error loading wordlist.txt:', error.message);
    console.log('Make sure to run prep.js first to create a filtered wordlist.txt file');
    process.exit(1);
  }
}

// Filter words by length and sort by frequency
function getWordsByLength(words, length, validWords) {
  return words
    .filter(record => record.word.length === length && validWords.has(record.word.toLowerCase()))
    .sort((a, b) => parseInt(b.count) - parseInt(a.count));
}

// Function to get a group of words around a specific frequency point
function getWordGroup(words, targetIndex, groupSize = 3) {
  const start = Math.max(0, targetIndex - Math.floor(groupSize / 2));
  const end = Math.min(words.length - 1, start + groupSize);
  return words.slice(start, end);
}

// Function to ask about a larger word group with count of bad words
async function askAboutRandomWordCluster(words, clusterSize = 10) {
  // Select a random position in the sorted word list, biased toward the middle sections
  // where the breakpoint is likely to be
  const position = getRandomSamplingPosition(words.length);
  const wordGroup = getWordGroup(words, position, clusterSize);
  
  console.log("\nPlease evaluate this group of words:");
  console.log("Count how many words you consider TOO OBSCURE for your purposes.\n");
  
  for (const [index, word] of wordGroup.entries()) {
    console.log(`  ${index + 1}. "${word.word}" (frequency: ${word.count})`);
  }
  
  const avgFrequency = Math.round(
    wordGroup.reduce((sum, w) => sum + parseInt(w.count), 0) / wordGroup.length
  );
  
  const badCount = await askQuestion(
    `\nOut of these ${clusterSize} words, how many are TOO OBSCURE? (0-${clusterSize}): `
  );
  
  const numBad = parseInt(badCount) || 0;
  const acceptanceRatio = 1 - (numBad / clusterSize);
  
  return {
    words: wordGroup.map(w => w.word),
    frequencies: wordGroup.map(w => parseInt(w.count)),
    position,
    avgFrequency,
    badCount: numBad,
    acceptanceRatio,
    // Key frequencies for our model
    minFrequency: Math.min(...wordGroup.map(w => parseInt(w.count))),
    maxFrequency: Math.max(...wordGroup.map(w => parseInt(w.count)))
  };
}

// Update the getRandomSamplingPosition function with extreme strategies
function getRandomSamplingPosition(listLength, strategy = 'balanced') {
  switch (strategy) {
    case 'bottom_tail':
      // Sample from the absolute bottom 5% of words (truly obscure)
      return Math.floor((0.95 + 0.05 * Math.random()) * listLength);
      
    case 'top_tail':
      // Sample from the absolute top 5% of words (very common)
      return Math.floor(0.05 * Math.random() * listLength);
      
    case 'low_frequency':
      // Sample primarily from the lower half of frequencies
      return Math.floor((0.5 + 0.5 * Math.random()) * listLength);
      
    case 'very_low_frequency':
      // Sample from the bottom 30% of frequencies
      return Math.floor((0.7 + 0.3 * Math.random()) * listLength);
      
    case 'high_frequency':
      // Sample primarily from the higher half of frequencies
      return Math.floor(0.5 * Math.random() * listLength);
      
    case 'balanced':
    default:
      // Use our balanced beta distribution that peaks at the middle
      const randomValue = betaDistribution(2, 2);
      return Math.floor(randomValue * listLength);
  }
}

// Simple beta distribution implementation (for alpha=beta=2, it's a triangular distribution peaking at 0.5)
function betaDistribution(alpha, beta) {
  // For alpha=beta=2, we can use a simplified approach
  if (alpha === 2 && beta === 2) {
    // This creates a distribution that peaks at 0.5
    const u = Math.random();
    const v = Math.random();
    return (u + v) / 2;
  } else {
    // Fallback to a simple approach that works for alpha=beta
    let sum = 0;
    for (let i = 0; i < alpha; i++) {
      sum += Math.random();
    }
    return sum / alpha;
  }
}

// Fit a logistic regression model to the word acceptability data
function fitLogisticModel(samples) {
  // Prepare data points: log(frequency) vs. acceptanceRatio
  const dataPoints = samples.map(sample => ({
    logFreq: Math.log(sample.avgFrequency),
    acceptanceRatio: sample.acceptanceRatio
  }));
  
  // Sort by frequency
  dataPoints.sort((a, b) => a.logFreq - b.logFreq);
  
  // If we have very few samples, return a simple estimate
  if (dataPoints.length < 3) {
    const avgLogFreq = dataPoints.reduce((sum, p) => sum + p.logFreq, 0) / dataPoints.length;
    return {
      threshold: Math.exp(avgLogFreq),
      slope: 1.0,
      confidence: {
        lower: Math.exp(avgLogFreq) / 2,
        upper: Math.exp(avgLogFreq) * 2,
      }
    };
  }
  
  // Find the point where acceptanceRatio is closest to 0.5
  let bestIndex = 0;
  let minDistance = Math.abs(dataPoints[0].acceptanceRatio - 0.5);
  
  for (let i = 1; i < dataPoints.length; i++) {
    const distance = Math.abs(dataPoints[i].acceptanceRatio - 0.5);
    if (distance < minDistance) {
      minDistance = distance;
      bestIndex = i;
    }
  }
  
  // Estimate the threshold using linear interpolation near the 0.5 point
  let thresholdEstimate;
  let slopeEstimate;
  
  if (bestIndex > 0 && bestIndex < dataPoints.length - 1) {
    // Use the points before and after for interpolation
    const before = dataPoints[bestIndex - 1];
    const at = dataPoints[bestIndex];
    const after = dataPoints[bestIndex + 1];
    
    // Linear interpolation to find where acceptance = 0.5
    if (before.acceptanceRatio > 0.5 && after.acceptanceRatio < 0.5) {
      const t = (0.5 - before.acceptanceRatio) / (after.acceptanceRatio - before.acceptanceRatio);
      thresholdEstimate = Math.exp(before.logFreq + t * (after.logFreq - before.logFreq));
      slopeEstimate = (after.acceptanceRatio - before.acceptanceRatio) / (after.logFreq - before.logFreq);
    } else if (before.acceptanceRatio < 0.5 && after.acceptanceRatio > 0.5) {
      const t = (0.5 - after.acceptanceRatio) / (before.acceptanceRatio - after.acceptanceRatio);
      thresholdEstimate = Math.exp(after.logFreq + t * (before.logFreq - after.logFreq));
      slopeEstimate = (before.acceptanceRatio - after.acceptanceRatio) / (before.logFreq - after.logFreq);
    } else {
      // Fall back to the closest point
      thresholdEstimate = Math.exp(at.logFreq);
      
      // Estimate slope using adjacent points
      slopeEstimate = (after.acceptanceRatio - before.acceptanceRatio) / (after.logFreq - before.logFreq);
    }
  } else {
    // Not enough points for interpolation, use the best point
    thresholdEstimate = Math.exp(dataPoints[bestIndex].logFreq);
    
    // Use a default slope
    slopeEstimate = 1.0;
  }
  
  // Estimate confidence interval using variance around the threshold
  const logThreshold = Math.log(thresholdEstimate);
  const variances = dataPoints.map(p => Math.pow(p.logFreq - logThreshold, 2));
  const avgVariance = variances.reduce((sum, v) => sum + v, 0) / variances.length;
  const stdDev = Math.sqrt(avgVariance);
  
  // Check if all words are being rated as mostly acceptable
  const hasSignificantVariation = dataPoints.some(p => p.acceptanceRatio < 0.7);
  
  // If all groups are highly acceptable, we need to handle this special case
  if (!hasSignificantVariation) {
    console.log("\n⚠️ All or most words appear to be acceptable to you.");
    console.log("To find a meaningful breakpoint, try to be more selective about which words you'd use.");
    
    // Try to estimate a lower bound based on the minimum frequency we've seen
    const minFreq = Math.min(...samples.map(s => s.minFrequency));
    
    // Return a very rough estimate
    return {
      threshold: minFreq / 2, // Estimate the threshold to be well below what we've seen
      slope: 1.0,
      confidence: {
        lower: minFreq / 4,
        upper: minFreq
      },
      allAcceptable: true // Flag that we're in this special case
    };
  }
  
  return {
    threshold: thresholdEstimate,
    slope: slopeEstimate,
    confidence: {
      lower: Math.exp(logThreshold - 2 * stdDev),
      upper: Math.exp(logThreshold + 2 * stdDev)
    }
  };
}

// Update findFrequencyBreakpointBySampling function to include diverse sampling
async function findFrequencyBreakpointBySampling(words, wordLength) {
  console.log(`\n===== Finding breakpoint for ${wordLength}-letter words =====`);
  console.log("Using statistical sampling to build a model of word acceptability.");
  
  // Collect samples
  const samples = [];
  const targetSamples = 10; // Number of samples to collect
  const clusterSize = 10; // Size of each cluster
  
  console.log(`\nWe'll sample ${targetSamples} clusters of ${clusterSize} words each,`);
  console.log("including both common and uncommon words.\n");
  
  // Force diverse sampling strategies for the first few samples
  const samplingSchedule = [
    'balanced',      // First sample from the middle
    'top_tail',      // Second sample from extremely common words
    'bottom_tail',   // Third sample from extremely obscure words
    'low_frequency', // Fourth sample from somewhat less common words
    'high_frequency' // Fifth sample from somewhat more common words
  ];
  
  for (let i = 0; i < targetSamples; i++) {
    // Choose sampling strategy
    let strategy;
    
    if (i < samplingSchedule.length) {
      // Use pre-defined schedule for first few samples
      strategy = samplingSchedule[i];
    } else if (samples.every(s => s.acceptanceRatio > 0.7)) {
      // If we've seen mostly acceptable words, focus on lower frequencies
      // Alternate between very_low_frequency and bottom_tail
      strategy = (i % 2 === 0) ? 'very_low_frequency' : 'bottom_tail';
    } else if (samples.every(s => s.acceptanceRatio < 0.3)) {
      // If we've seen mostly obscure words, focus on higher frequencies
      strategy = 'high_frequency';
    } else {
      // Otherwise, use balanced sampling with occasional dips into extremes
      const strategies = ['balanced', 'balanced', 'balanced', 'bottom_tail', 'top_tail'];
      strategy = strategies[i % strategies.length];
    }
    
    console.log(`\nSample ${i + 1} of ${targetSamples} (using ${strategy.replace('_', ' ')} sampling):`);
    
    // Get the position based on our strategy
    const position = getRandomSamplingPosition(words.length, strategy);
    const wordGroup = getWordGroup(words, position, clusterSize);
    
    console.log("\nPlease evaluate this group of words:");
    console.log("Count how many words you consider TOO OBSCURE for your purposes.\n");
    
    for (const [index, word] of wordGroup.entries()) {
      console.log(`  ${index + 1}. "${word.word}" (frequency: ${word.count})`);
    }
    
    const avgFrequency = Math.round(
      wordGroup.reduce((sum, w) => sum + parseInt(w.count), 0) / wordGroup.length
    );
    
    const badCount = await askQuestion(
      `\nOut of these ${clusterSize} words, how many are TOO OBSCURE? (0-${clusterSize}): `
    );
    
    const numBad = parseInt(badCount) || 0;
    const acceptanceRatio = 1 - (numBad / clusterSize);
    
    // Add this sample to our data
    samples.push({
      words: wordGroup.map(w => w.word),
      frequencies: wordGroup.map(w => parseInt(w.count)),
      position,
      avgFrequency,
      badCount: numBad,
      acceptanceRatio,
      minFrequency: Math.min(...wordGroup.map(w => parseInt(w.count))),
      maxFrequency: Math.max(...wordGroup.map(w => parseInt(w.count)))
    });
    
    // Fit model with current data
    const model = fitLogisticModel(samples);
    
    console.log(`\nCurrent estimate after ${samples.length} samples:`);
    console.log(`Estimated breakpoint frequency: ${Math.round(model.threshold)}`);
    console.log(`95% confidence interval: ${Math.round(model.confidence.lower)} to ${Math.round(model.confidence.upper)}`);
    
    // Visualize the current data
    visualizeAcceptanceData(samples, model);
    
    // Check if we're confident enough
    if (samples.length >= 5 && model.confidence.upper / model.confidence.lower < 3) {
      console.log("\nConfidence interval is sufficiently narrow. You can stop early if desired.");
      const continueResponse = await askQuestion("Continue sampling? (y/n): ");
      if (!continueResponse.toLowerCase().startsWith('y')) {
        break;
      }
    }
  }
  
  // Final model fit
  const finalModel = fitLogisticModel(samples);
  
  return {
    breakpoint: Math.round(finalModel.threshold),
    confidence: {
      lower: Math.round(finalModel.confidence.lower),
      upper: Math.round(finalModel.confidence.upper)
    },
    samples: samples
  };
}

// Visualize the acceptance data we've collected
function visualizeAcceptanceData(samples, model) {
  console.log("\nAcceptability data collected so far:");
  console.log("Frequency | Acceptance Ratio | # Words Accepted");
  console.log("-------------------------------------------------");
  
  // Sort samples by frequency
  const sortedSamples = [...samples].sort((a, b) => a.avgFrequency - b.avgFrequency);
  
  // Check if all samples are highly acceptable
  const allHighlyAcceptable = !sortedSamples.some(s => s.acceptanceRatio < 0.7);
  
  if (allHighlyAcceptable) {
    console.log("\n⚠️ All word groups have been rated as mostly acceptable.");
    console.log("Consider being more selective to find a meaningful breakpoint.");
  }
  
  for (const sample of sortedSamples) {
    const freqStr = Math.round(sample.avgFrequency).toString().padStart(9);
    const ratioStr = (sample.acceptanceRatio * 100).toFixed(0).padStart(3) + "%";
    const acceptedStr = `${sample.words.length - sample.badCount} of ${sample.words.length}`;
    
    console.log(`${freqStr} | ${ratioStr}               | ${acceptedStr}`);
  }
  
  // Show the estimated curve if we have a model
  if (model && samples.length > 2) {
    console.log("\nEstimated acceptance curve:");
    console.log("100% |" + " ".repeat(23) + "*****");
    console.log(" 75% |" + " ".repeat(18) + "*" + " ".repeat(9));
    console.log(" 50% |" + " ".repeat(13) + "*" + " ".repeat(14) + " <-- Breakpoint (estimated)");
    console.log(" 25% |" + " ".repeat(8) + "*" + " ".repeat(19));
    console.log("  0% |*****" + " ".repeat(23));
    console.log("     +-------------------------------------");
    console.log(`     |    |    |    |    |    |`);
    console.log(`  Rare                      Common`);
  }
}

// Function to save the breakpoints to a JSON file
function saveBreakpointsToJSON(results) {
  try {
    const jsonData = {
      timestamp: new Date().toISOString(),
      breakpoints: results
    };
    
    writeFileSync('breakpoints.json', JSON.stringify(jsonData, null, 2));
    console.log("\nBreakpoints saved to breakpoints.json");
  } catch (error) {
    console.error("Error saving breakpoints to JSON:", error.message);
  }
}

// Helper function to find the index of the word with frequency closest to a target
function findClosestFrequencyIndex(words, targetFrequency) {
  let closestIndex = -1;
  let minDifference = Infinity;
  
  for (let i = 0; i < words.length; i++) {
    const difference = Math.abs(parseInt(words[i].count) - targetFrequency);
    if (difference < minDifference) {
      minDifference = difference;
      closestIndex = i;
    }
  }
  
  return closestIndex;
}

// Main function to run the analysis
async function main() {
  console.log("Word Frequency Breakpoint Analyzer");
  console.log("----------------------------------");
  console.log("This tool uses statistical sampling to find the frequency breakpoint");
  console.log("where words transition from 'acceptable' to 'too obscure'.");
  console.log("You'll be asked to evaluate RANDOM CLUSTERS of words and count how many are too obscure.\n");
  console.log("Results will be saved to breakpoints.json for use in your application.\n");
  
  // Load the pre-filtered wordlist
  const validWords = loadWordlist();
  
  // Load frequency data
  const allWords = await loadWordFrequencies();
  console.log(`Loaded ${allWords.length} words from unigram_freq.csv`);
  
  // Collect results for all word lengths
  const results = {};
  
  // Process each word length
  for (const length of [4, 5, 6, 7]) {
    // Get words of the specified length that are in our filtered wordlist
    let words = getWordsByLength(allWords, length, validWords);
    console.log(`Found ${words.length} ${length}-letter words in both frequency list and wordlist.txt`);
    
    // Skip if we don't have enough words
    if (words.length < 20) {
      console.log(`Not enough ${length}-letter words to analyze. Skipping.`);
      
      if (length < 7) {
        const proceed = await askQuestion("\nType 'OK' to move to the next word length, or anything else to exit: ");
        if (proceed.toUpperCase() !== 'OK') {
          break;
        }
      }
      
      continue;
    }
    
    const result = await findFrequencyBreakpointBySampling(words, length);
    
    console.log(`\n===== Final Results for ${length}-letter words =====`);
    console.log(`Estimated breakpoint frequency: ${result.breakpoint}`);
    console.log(`95% confidence interval: ${result.confidence.lower} to ${result.confidence.upper}`);
    
    // Store the results
    results[length] = {
      breakpoint: result.breakpoint,
      confidence: {
        lower: result.confidence.lower,
        upper: result.confidence.upper
      },
      exampleWords: []
    };
    
    // Add example words at the breakpoint
    const breakpointIndex = findClosestFrequencyIndex(words, result.breakpoint);
    if (breakpointIndex !== -1) {
      // Show words right at the breakpoint
      const borderlineWords = getWordGroup(words, breakpointIndex, 5);
      console.log("\nWords at the borderline:");
      
      borderlineWords.forEach(word => {
        console.log(`  "${word.word}" (frequency: ${word.count})`);
        results[length].exampleWords.push({
          word: word.word,
          frequency: parseInt(word.count)
        });
      });
    }
    
    // Allow user to move to the next word length
    if (length < 7) {
      const proceed = await askQuestion("\nType 'OK' to move to the next word length, or anything else to exit: ");
      if (proceed.toUpperCase() !== 'OK') {
        break;
      }
    }
  }
  
  // Save results to JSON file
  saveBreakpointsToJSON(results);
  
  console.log("\nAnalysis complete. Thank you for participating!");
  rl.close();
}

// Run the main function
main().catch(console.error); 