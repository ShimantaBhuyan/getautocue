import Fuse from 'fuse.js';

interface FuseMatchResult {
    index: number;
    score: number;
    spokenWordIndices: number[];
    nextWordIndex: number;
    matchedText: string;
}

export class FuseTextMatcher {
    private fuse: Fuse<string>;
    private words: string[];
    private sentences: string[];
    private sentenceWordOffsets: number[];

    constructor(text: string) {
        this.words = text.split(/\s+/).filter(word => word.trim().length > 0);
        this.sentences = text.split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 0);

        // Calculate word offsets for each sentence
        this.sentenceWordOffsets = [];
        let wordOffset = 0;
        for (const sentence of this.sentences) {
            this.sentenceWordOffsets.push(wordOffset);
            wordOffset += sentence.split(/\s+/).filter(w => w.trim()).length;
        }

        // Create Fuse instance for sentence matching
        const fuseOptions = {
            includeScore: true,
            includeMatches: true,
            threshold: 0.4, // More lenient than default 0.6
            location: 0,
            distance: 1000,
            minMatchCharLength: 3,
            ignoreLocation: true, // Don't care about position within sentence
            keys: [] as string[], // We're searching strings directly
        };

        this.fuse = new Fuse(this.sentences, fuseOptions);
    }

    /**
     * Find the best match for a transcript using sentence-level fuzzy matching
     * then narrow down to word-level matching within the sentence
     */
    findBestMatch(transcript: string, currentPosition: number = -1): FuseMatchResult | null {
        if (!transcript.trim() || !this.words.length) return null;

        const transcriptWords = transcript.toLowerCase().split(/\s+/).filter(w => w.trim());
        if (!transcriptWords.length) return null;

        // First, find the best matching sentence
        const sentenceResults = this.fuse.search(transcript);

        if (!sentenceResults.length) return null;

        let bestMatch: FuseMatchResult | null = null;
        let bestScore = 0;

        // Try the top sentence matches
        for (let i = 0; i < Math.min(3, sentenceResults.length); i++) {
            const sentenceResult = sentenceResults[i];
            const sentenceIndex = sentenceResult.refIndex;
            const sentenceWordOffset = this.sentenceWordOffsets[sentenceIndex];
            const sentence = this.sentences[sentenceIndex];

            // Now do word-level matching within this sentence
            const wordMatch = this.findWordLevelMatch(
                sentence,
                transcript,
                sentenceWordOffset,
                currentPosition
            );

            if (wordMatch && wordMatch.score > bestScore) {
                bestScore = wordMatch.score;
                bestMatch = wordMatch;
            }
        }

        // Additional validation: prevent large jumps
        if (bestMatch && currentPosition !== -1) {
            const jumpDistance = Math.abs(bestMatch.index - currentPosition);
            const maxAllowedJump = 20;

            if (jumpDistance > maxAllowedJump && bestScore < 0.8) {
                return null;
            }
        }

        return bestMatch;
    }

    /**
     * Find word-level matches within a specific sentence
     */
    private findWordLevelMatch(
        sentence: string,
        transcript: string,
        sentenceWordOffset: number,
        currentPosition: number
    ): FuseMatchResult | null {
        const sentenceWords = sentence.toLowerCase().split(/\s+/).filter(w => w.trim());
        const transcriptWords = transcript.toLowerCase().split(/\s+/).filter(w => w.trim());

        if (!sentenceWords.length || !transcriptWords.length) return null;

        // Create sliding windows of the sentence to match against transcript
        let bestMatch: FuseMatchResult | null = null;
        let bestScore = 0;

        // Try different window sizes around the transcript length
        const windowSizes = [
            transcriptWords.length,
            Math.max(1, transcriptWords.length - 1),
            transcriptWords.length + 1,
            transcriptWords.length + 2
        ];

        for (const windowSize of windowSizes) {
            for (let i = 0; i <= sentenceWords.length - windowSize; i++) {
                const windowWords = sentenceWords.slice(i, i + windowSize);
                const windowText = windowWords.join(' ');

                // Use Fuse to score this window against the transcript
                const windowFuse = new Fuse([windowText], {
                    includeScore: true,
                    threshold: 0.6,
                    ignoreLocation: true,
                });

                const windowResult = windowFuse.search(transcript);
                if (!windowResult.length) continue;

                let score = 1 - (windowResult[0].score || 0); // Convert to 0-1 scale where 1 is best

                // Apply positional bonus for forward movement
                if (currentPosition !== -1) {
                    const wordIndex = sentenceWordOffset + i;
                    const forwardBonus = wordIndex >= currentPosition ? 0.1 : 0;
                    const proximityBonus = Math.max(0, 0.1 - Math.abs(wordIndex - currentPosition) * 0.01);
                    score += forwardBonus + proximityBonus;
                }

                if (score > bestScore) {
                    bestScore = score;
                    bestMatch = {
                        index: sentenceWordOffset + i,
                        score,
                        spokenWordIndices: Array.from(
                            { length: windowSize },
                            (_, idx) => sentenceWordOffset + i + idx
                        ),
                        nextWordIndex: sentenceWordOffset + i + windowSize < this.words.length
                            ? sentenceWordOffset + i + windowSize
                            : -1,
                        matchedText: windowText
                    };
                }
            }
        }

        return bestMatch;
    }

    /**
     * Get total word count
     */
    getWordCount(): number {
        return this.words.length;
    }

    /**
     * Get word at specific index
     */
    getWordAt(index: number): string | null {
        return index >= 0 && index < this.words.length ? this.words[index] : null;
    }

    /**
     * Get words array
     */
    getWords(): string[] {
        return [...this.words];
    }
}

// Backwards compatibility with existing fuzzy matching interface
const fuseMatch = {
    token_sort_ratio: (str1: string, str2: string): number => {
        const fuse = new Fuse([str1], {
            includeScore: true,
            threshold: 0.6,
            ignoreLocation: true,
        });

        const result = fuse.search(str2);
        if (!result.length) return 0;

        // Convert score to 0-100 scale (higher is better)
        return Math.round((1 - (result[0].score || 0)) * 100);
    }
};
