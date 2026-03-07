import * as fs from 'fs/promises';
import * as path from 'path';
// ──────────────────────────────────────────────────────────────
// HEADING KEYWORD GROUPS (case-insensitive substring match)
// ──────────────────────────────────────────────────────────────
const WHY_KEYWORDS = ['overview', 'purpose', 'why', 'problem', 'about'];
const RULES_KEYWORDS = [
    'business rules',
    'non-negotiable',
    'constraints',
    'requirements',
    'rules',
];
const BOUNDARIES_KEYWORDS = [
    'out of scope',
    'not in scope',
    'exclusions',
    'not doing',
    'boundaries',
    'limitations',
];
const OWNER_KEYWORDS = ['owner', 'team', 'contact', 'maintainer'];
const SUPPORTED_EXTENSIONS = new Set(['.md', '.txt']);
/**
 * Parse a markdown or text file and extract brain seed data.
 *
 * **Throws** only on:
 * - File not found
 * - Unsupported file extension
 *
 * **Never throws** on parse failures — returns empty/partial seed.
 */
export async function parseMarkdownFile(filepath) {
    // Validate extension
    const ext = path.extname(filepath).toLowerCase();
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
        throw new Error('Only .md and .txt files are supported');
    }
    // Read file (throws on not found)
    let content;
    try {
        content = await fs.readFile(filepath, 'utf-8');
    }
    catch (err) {
        if (err.code === 'ENOENT') {
            throw new Error(`File not found: ${filepath}`);
        }
        throw err;
    }
    // Parse — never throw from here
    try {
        return parseContent(content);
    }
    catch {
        return { why: null, rules: [], boundaries: [], owner: null };
    }
}
/**
 * Split markdown content into sections keyed by heading.
 * Returns an array of { heading, lines } where lines are the
 * content lines under that heading (not including the heading itself).
 * The first section has heading '' (content before any heading).
 */
function splitSections(content) {
    const lines = content.split('\n');
    const sections = [];
    let current = { heading: '', lines: [] };
    for (const line of lines) {
        const headingMatch = line.match(/^#{1,6}\s+(.+)$/);
        if (headingMatch) {
            sections.push(current);
            current = { heading: headingMatch[1].trim(), lines: [] };
        }
        else {
            current.lines.push(line);
        }
    }
    sections.push(current);
    return sections;
}
/**
 * Find a section whose heading contains one of the given keywords
 * (case-insensitive substring match).
 */
function findSection(sections, keywords) {
    for (const section of sections) {
        const lower = section.heading.toLowerCase();
        for (const kw of keywords) {
            if (lower.includes(kw)) {
                return section;
            }
        }
    }
    return null;
}
/**
 * Extract the first non-empty paragraph (consecutive non-blank lines)
 * from an array of lines.
 */
function firstParagraph(lines) {
    const paraLines = [];
    let started = false;
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === '') {
            if (started)
                break;
            continue;
        }
        // Skip bullet lines
        if (/^[-*]\s+/.test(trimmed)) {
            if (started)
                break;
            continue;
        }
        started = true;
        paraLines.push(trimmed);
    }
    return paraLines.length > 0 ? paraLines.join(' ') : null;
}
/**
 * Extract all bullet points (- item or * item) from an array of lines.
 * Strips leading -/* and whitespace.
 */
function extractBullets(lines) {
    const bullets = [];
    for (const line of lines) {
        const match = line.match(/^\s*[-*]\s+(.+)$/);
        if (match) {
            const text = match[1].trim();
            if (text)
                bullets.push(text);
        }
    }
    return bullets;
}
/**
 * Extract the first non-empty line from an array of lines.
 */
function firstNonEmptyLine(lines) {
    for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed)
            return trimmed;
    }
    return null;
}
function parseContent(content) {
    const sections = splitSections(content);
    // WHY: look for matching heading, fall back to first paragraph of document
    let why = null;
    const whySection = findSection(sections, WHY_KEYWORDS);
    if (whySection) {
        why = firstParagraph(whySection.lines);
    }
    if (!why) {
        // Fallback: first paragraph of the entire document (all sections)
        const allLines = sections.flatMap((s) => s.lines);
        why = firstParagraph(allLines);
    }
    // RULES
    const rulesSection = findSection(sections, RULES_KEYWORDS);
    const rules = rulesSection ? extractBullets(rulesSection.lines) : [];
    // BOUNDARIES
    const boundariesSection = findSection(sections, BOUNDARIES_KEYWORDS);
    const boundaries = boundariesSection
        ? extractBullets(boundariesSection.lines)
        : [];
    // OWNER
    const ownerSection = findSection(sections, OWNER_KEYWORDS);
    const owner = ownerSection ? firstNonEmptyLine(ownerSection.lines) : null;
    return { why, rules, boundaries, owner };
}
