/**
 * TheFuzz.ts - Fuzzy string matching in TypeScript.
 *
 * @license MIT
 * Copyright (c) 2014 SeatGeek
 *
 * This is a TypeScript port of the Python library `thefuzz`, which in turn
 * is a wrapper around `rapidfuzz`. This implementation aims to replicate the
 * core functionality of `thefuzz` in a single, dependency-free TypeScript file,
 * using classic algorithms for string comparison.
 */

// ---------------------------------
//          TYPE DEFINITIONS
// ---------------------------------

type Scorer = (s1: string, s2: string, options?: ScorerOptions) => number;
type Processor = (s: string, options?: FullProcessOptions) => string;

type Choices = string[] | Record<string | number, string>;
type Result = [string, number];
type MappedResult = [string, number, string | number];

interface FullProcessOptions {
    force_ascii?: boolean;
}

interface ScorerOptions extends FullProcessOptions {
    full_process?: boolean;
}

interface ExtractOptions {
    processor?: Processor;
    scorer?: Scorer;
    limit?: number | null;
    score_cutoff?: number;
}

interface ExtractOneOptions {
    processor?: Processor;
    scorer?: Scorer;
    score_cutoff?: number;
}

interface DedupeOptions {
    threshold?: number;
    scorer?: Scorer;
}


const thefuzz = (() => {

    // ---------------------------------
    //          PRIVATE UTILS
    // ---------------------------------

    /**
     * Processes a string by lowercasing, removing non-alphanumeric characters,
     * and trimming whitespace. This is a core part of many scoring functions.
     * @param s The string to process.
     * @param options Optional settings.
     * @param options.force_ascii If true, remove non-ASCII chars.
     * @returns The processed string.
     */
    const full_process = (s: string | null | undefined, { force_ascii = false }: FullProcessOptions = {}): string => {
        if (s === null || typeof s === 'undefined') {
            return "";
        }
        let str = String(s);

        if (force_ascii) {
            str = str.replace(/[^\x00-\x7F]/g, ""); // Remove non-ASCII characters
        }

        // Lowercase, replace non-alphanumeric with space, and trim
        str = str.toLowerCase();
        str = str.replace(/[^a-z0-9\s]/g, ' ').trim();
        // Condense multiple whitespace characters to a single space
        return str.replace(/\s+/g, ' ').trim();
    };

    /**
     * Calculates the Levenshtein distance between two strings.
     * @param s1 The first string.
     * @param s2 The second string.
     * @returns The Levenshtein distance.
     */
    const levenshtein = (s1: string, s2: string): number => {
        if (s1 === s2) return 0;
        const len1 = s1.length;
        const len2 = s2.length;
        if (len1 === 0) return len2;
        if (len2 === 0) return len1;

        let v0 = new Array(len2 + 1);
        let v1 = new Array(len2 + 1);

        for (let i = 0; i <= len2; i++) {
            v0[i] = i;
        }

        for (let i = 0; i < len1; i++) {
            v1[0] = i + 1;
            for (let j = 0; j < len2; j++) {
                const cost = s1[i] === s2[j] ? 0 : 1;
                v1[j + 1] = Math.min(v1[j] + 1, v0[j + 1] + 1, v0[j] + cost);
            }
            v0 = [...v1];
        }
        return v1[len2];
    };

    /**
     * A helper to sort and join tokens from a processed string.
     * @param s The string to tokenize, sort, and join.
     * @returns The sorted-token string.
     */
    const _sort_tokens = (s: string): string => {
        if (!s) return "";
        return s.split(' ').filter(t => t).sort().join(' ');
    };

    /**
     * Handles null/undefined inputs for scorers, returning 0.
     * @param scorer The scoring function to wrap.
     * @returns The wrapped scorer.
     */
    const _handle_nulls = (scorer: (s1: string, s2: string, options?: ScorerOptions) => number): Scorer => {
        return (s1: string | null | undefined, s2: string | null | undefined, options?: ScorerOptions): number => {
            if (s1 === null || s2 === null || typeof s1 === 'undefined' || typeof s2 === 'undefined') {
                return 0;
            }
            return scorer(String(s1), String(s2), options);
        };
    };

    // ---------------------------------
    //      PRIVATE SCORING ALGORITHMS
    // ---------------------------------

    const _fuzz = {
        /**
         * Calculates a simple ratio based on Levenshtein distance.
         * @param s1 The first string.
         * @param s2 The second string.
         * @returns A score from 0 to 100.
         */
        ratio: _handle_nulls((s1: string, s2: string): number => {
            const len1 = s1.length;
            const len2 = s2.length;
            if (len1 === 0 && len2 === 0) return 100;
            if (len1 === 0 || len2 === 0) return 0;
            const dist = levenshtein(s1, s2);
            return Math.round(((len1 + len2 - dist) / (len1 + len2)) * 100);
        }),

        /**
         * Calculates the ratio of the most similar substring.
         * @param s1 The first string.
         * @param s2 The second string.
         * @returns A score from 0 to 100.
         */
        partial_ratio: _handle_nulls((s1: string, s2: string): number => {
            if (s1.length === 0 || s2.length === 0) return 0;
            const [shorter, longer] = s1.length < s2.length ? [s1, s2] : [s2, s1];

            let bestScore = 0;
            for (let i = 0; i <= longer.length - shorter.length; i++) {
                const sub = longer.substring(i, i + shorter.length);
                const score = _fuzz.ratio(shorter, sub);
                if (score > bestScore) {
                    bestScore = score;
                }
            }
            return bestScore;
        }),

        /**
         * Sorts tokens in strings and then calculates the ratio.
         * @param s1 The first string.
         * @param s2 The second string.
         * @returns A score from 0 to 100.
         */
        token_sort_ratio: _handle_nulls((s1: string, s2: string, { force_ascii = true, full_process: do_process = true }: ScorerOptions = {}): number => {
            const p1 = do_process ? full_process(s1, { force_ascii }) : s1;
            const p2 = do_process ? full_process(s2, { force_ascii }) : s2;
            const sorted1 = _sort_tokens(p1);
            const sorted2 = _sort_tokens(p2);
            return _fuzz.ratio(sorted1, sorted2);
        }),

        /**
         * Calculates a ratio based on the intersection and differences of token sets.
         * @param s1 The first string.
         * @param s2 The second string.
         * @returns A score from 0 to 100.
         */
        token_set_ratio: _handle_nulls((s1: string, s2: string, { force_ascii = true, full_process: do_process = true }: ScorerOptions = {}): number => {
            const p1 = do_process ? full_process(s1, { force_ascii }) : s1;
            const p2 = do_process ? full_process(s2, { force_ascii }) : s2;

            const tokens1 = new Set(p1.split(' ').filter(t => t));
            const tokens2 = new Set(p2.split(' ').filter(t => t));

            if (tokens1.size === 0 && tokens2.size === 0) return 100;
            if (tokens1.size === 0 || tokens2.size === 0) return 0;

            const intersection = new Set([...tokens1].filter(x => tokens2.has(x)));
            const diff1_2 = new Set([...tokens1].filter(x => !tokens2.has(x)));
            const diff2_1 = new Set([...tokens2].filter(x => !tokens2.has(x)));

            const sorted_sect = [...intersection].sort().join(' ').trim();
            const sorted_diff1 = [...diff1_2].sort().join(' ').trim();
            const sorted_diff2 = [...diff2_1].sort().join(' ').trim();

            const combined1 = (sorted_sect + ' ' + sorted_diff1).trim();
            const combined2 = (sorted_sect + ' ' + sorted_diff2).trim();

            if (sorted_sect.length === 0) return 0;

            return Math.max(
                _fuzz.ratio(sorted_sect, combined1),
                _fuzz.ratio(sorted_sect, combined2),
                _fuzz.ratio(combined1, combined2)
            );
        }),
    };

    // ---------------------------------
    //          PUBLIC FUZZ API
    // ---------------------------------

    const fuzz = {
        ratio: _fuzz.ratio,
        partial_ratio: _fuzz.partial_ratio,
        token_sort_ratio: _fuzz.token_sort_ratio,
        token_set_ratio: _fuzz.token_set_ratio,

        partial_token_sort_ratio: _handle_nulls((s1: string, s2: string, options: ScorerOptions = {}): number => {
            const { force_ascii = true, full_process: do_process = true } = options;
            const p1 = do_process ? full_process(s1, { force_ascii }) : s1;
            const p2 = do_process ? full_process(s2, { force_ascii }) : s2;
            const sorted1 = _sort_tokens(p1);
            const sorted2 = _sort_tokens(p2);
            return _fuzz.partial_ratio(sorted1, sorted2);
        }),

        partial_token_set_ratio: _fuzz.token_set_ratio,

        QRatio: _handle_nulls((s1: string, s2: string, options: ScorerOptions = {}): number => {
            const { force_ascii = true, full_process: do_process = true } = options;
            const p1 = do_process ? full_process(s1, { force_ascii }) : s1;
            const p2 = do_process ? full_process(s2, { force_ascii }) : s2;
            return _fuzz.ratio(p1, p2);
        }),

        UWRatio: (s1: string, s2: string, options: ScorerOptions = {}): number => fuzz.WRatio(s1, s2, { ...options, force_ascii: false }),
        UQRatio: (s1: string, s2: string, options: ScorerOptions = {}): number => fuzz.QRatio(s1, s2, { ...options, force_ascii: false }),

        WRatio: _handle_nulls((s1: string, s2: string, options: ScorerOptions = {}): number => {
            const { force_ascii = true, full_process: do_process = true } = options;
            const p1 = do_process ? full_process(s1, { force_ascii }) : s1;
            const p2 = do_process ? full_process(s2, { force_ascii }) : s2;
            if (p1.length === 0 || p2.length === 0) return 0;

            const len_ratio = p1.length > p2.length ? p1.length / p2.length : p2.length / p1.length;
            const base_ratio = _fuzz.ratio(p1, p2);

            let scores = [base_ratio];
            let partial_scale = len_ratio > 1.5 ? 0.9 : 1;

            scores.push(fuzz.token_sort_ratio(p1, p2, { full_process: false }) * 0.95);
            scores.push(fuzz.token_set_ratio(p1, p2, { full_process: false }) * 0.95);

            if (len_ratio > 1.5) {
                scores.push(_fuzz.partial_ratio(p1, p2) * partial_scale);
                scores.push(fuzz.partial_token_sort_ratio(p1, p2, { full_process: false }) * 0.95 * partial_scale);
                scores.push(fuzz.partial_token_set_ratio(p1, p2, { full_process: false }) * 0.95 * partial_scale);
            }

            return Math.round(Math.max(...scores));
        }),
    };

    // ---------------------------------
    //          PUBLIC PROCESS API
    // ---------------------------------

    const process = {
        /**
         * Find the best matches in a collection of choices.
         * @param query The string to match against.
         * @param choices A list of strings or a mapping object.
         * @param options
         * @returns A list of matches, sorted by score.
         */
        // extractBests(query: string, choices: string[], options?: ExtractOptions): Result[];
        // extractBests(query: string, choices: Record<string | number, string>, options?: ExtractOptions): MappedResult[];
        extractBests(query: string, choices: Choices, {
            processor = full_process,
            scorer = fuzz.WRatio,
            limit = 5,
            score_cutoff = 0
        }: ExtractOptions = {}): (Result | MappedResult)[] {
            const results: (Result | MappedResult)[] = [];
            const isMapping = !Array.isArray(choices);
            const choice_keys: (string | number)[] = isMapping ? Object.keys(choices) : choices as any;

            const processed_query = processor(query);
            if (processed_query.length === 0) {
                console.warn(`Applied processor reduces input query to empty string, all comparisons will have score 0. [Query: '${query}']`);
            }

            for (const key of choice_keys) {
                const choice = isMapping ? choices[key] : key as string;
                if (choice === null || typeof choice === 'undefined') continue;

                const processed_choice = processor(String(choice));
                const score = scorer(processed_query, processed_choice, { full_process: false });

                if (score >= score_cutoff) {
                    results.push(isMapping ? [choice, score, key] : [choice, score]);
                }
            }
            results.sort((a, b) => b[1] - a[1]);
            return limit === null ? results : results.slice(0, limit);
        },

        // extract(query: string, choices: string[], options?: ExtractOptions): Result[];
        // extract(query: string, choices: Record<string | number, string>, options?: ExtractOptions): MappedResult[];
        extract(query: string, choices: Choices, options?: ExtractOptions): (Result | MappedResult)[] {
            return process.extractBests(query, choices, options);
        },

        /**
         * Find the single best match from a collection of choices.
         * @param query The string to match against.
         * @param choices A list of strings or a mapping object.
         * @param options
         * @returns The best match tuple, or null if score is below cutoff.
         */
        // extractOne(query: string, choices: string[], options?: ExtractOneOptions): Result | null;
        // extractOne(query: string, choices: Record<string | number, string>, options?: ExtractOneOptions): MappedResult | null;
        extractOne(query: string, choices: Choices, {
            processor = full_process,
            scorer = fuzz.WRatio,
            score_cutoff = 0
        }: ExtractOneOptions = {}): Result | MappedResult | null {
            const results = process.extractBests(query, choices, {
                processor,
                scorer,
                limit: 1,
                score_cutoff
            });
            return results.length > 0 ? results[0] : null;
        },

        /**
         * Deduplicates a list of strings using fuzzy matching.
         * @param contains_dupes List of strings to deduplicate.
         * @param options
         * @returns A deduplicated list of strings.
         */
        dedupe(contains_dupes: string[], {
            threshold = 70,
            scorer = fuzz.token_set_ratio
        }: DedupeOptions = {}): string[] {
            if (!Array.isArray(contains_dupes) || contains_dupes.length === 0) {
                return [];
            }

            const extractor = (item: string) => process.extractBests(item, contains_dupes, {
                scorer,
                score_cutoff: threshold,
                processor: full_process,
                limit: null,
            });

            const clusters: Record<string, number> = {};
            const processed: Set<string> = new Set();

            for (const item of contains_dupes) {
                if (processed.has(item)) continue;

                const matches = extractor(item);
                if (matches.length === 0) continue;

                matches.sort((a, b) => {
                    if (a[0].length !== b[0].length) return b[0].length - a[0].length;
                    return a[0].localeCompare(b[0]);
                });
                const canonical = matches[0][0];

                for (const match of matches) {
                    processed.add(match[0]);
                }

                if (!clusters[canonical]) {
                    clusters[canonical] = 1;
                }
            }

            const deduped_list = Object.keys(clusters);
            return deduped_list.length === contains_dupes.length ? contains_dupes : deduped_list;
        },
    };

    return {
        fuzz,
        process,
        full_process
    };
})();

export default thefuzz;