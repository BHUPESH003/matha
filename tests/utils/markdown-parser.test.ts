import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs/promises'
import * as path from 'path'
import * as os from 'os'
import { parseMarkdownFile } from '../../src/utils/markdown-parser.js'

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures')

describe('markdown-parser', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'matha-mdparser-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  // ──────────────────────────────────────────────────────────────
  // ERROR CASES
  // ──────────────────────────────────────────────────────────────

  it('file not found → throws correct error', async () => {
    await expect(
      parseMarkdownFile('/tmp/nonexistent-file-12345.md'),
    ).rejects.toThrow('File not found')
  })

  it('unsupported extension → throws correct error', async () => {
    const jsonFile = path.join(tmpDir, 'spec.json')
    await fs.writeFile(jsonFile, '{}')

    await expect(parseMarkdownFile(jsonFile)).rejects.toThrow(
      'Only .md and .txt files are supported',
    )
  })

  it('.pdf extension → throws correct error', async () => {
    const pdfFile = path.join(tmpDir, 'spec.pdf')
    await fs.writeFile(pdfFile, 'fake pdf')

    await expect(parseMarkdownFile(pdfFile)).rejects.toThrow(
      'Only .md and .txt files are supported',
    )
  })

  // ──────────────────────────────────────────────────────────────
  // SAMPLE BRD — FULL EXTRACTION
  // ──────────────────────────────────────────────────────────────

  it('sample-brd.md → extracts all 4 fields correctly', async () => {
    const result = await parseMarkdownFile(
      path.join(FIXTURE_DIR, 'sample-brd.md'),
    )

    expect(result.why).toContain('P&L')
    expect(result.why).toContain('PAMM')
    expect(result.rules).toHaveLength(5)
    expect(result.boundaries).toHaveLength(3)
    expect(result.owner).toBe('Bhupesh')
  })

  it('rules count matches bullet points under Business Rules heading', async () => {
    const result = await parseMarkdownFile(
      path.join(FIXTURE_DIR, 'sample-brd.md'),
    )

    expect(result.rules).toContain(
      'HWM: profit calculated above previous peak only',
    )
    expect(result.rules).toContain(
      'Commission uses slab-based percentage, not flat rate',
    )
    expect(result.rules).toContain(
      'Referral income applies to indirect chain',
    )
    expect(result.rules).toContain(
      'Promotional income applies to direct referrals only',
    )
    expect(result.rules).toContain(
      'Deposit events must not trigger profit cycles',
    )
  })

  it('boundaries count matches bullet points under Out of Scope heading', async () => {
    const result = await parseMarkdownFile(
      path.join(FIXTURE_DIR, 'sample-brd.md'),
    )

    expect(result.boundaries).toContain(
      'Tax calculation or liability reporting',
    )
    expect(result.boundaries).toContain(
      'Trade execution or broker integration',
    )
    expect(result.boundaries).toContain(
      'Regulatory compliance checking',
    )
  })

  // ──────────────────────────────────────────────────────────────
  // CASE-INSENSITIVE HEADING MATCHING
  // ──────────────────────────────────────────────────────────────

  it('heading match is case-insensitive', async () => {
    const mdFile = path.join(tmpDir, 'upper.md')
    await fs.writeFile(
      mdFile,
      `# My Project

## PURPOSE
Build something amazing for the world.

## BUSINESS RULES
- Rule Alpha
- Rule Beta

## LIMITATIONS
- No mobile app
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.why).toContain('amazing')
    expect(result.rules).toHaveLength(2)
    expect(result.rules).toContain('Rule Alpha')
    expect(result.boundaries).toHaveLength(1)
    expect(result.boundaries).toContain('No mobile app')
  })

  // ──────────────────────────────────────────────────────────────
  // NO MATCHING HEADINGS
  // ──────────────────────────────────────────────────────────────

  it('document with no matching headings → empty arrays, null fields', async () => {
    const mdFile = path.join(tmpDir, 'empty-headings.md')
    await fs.writeFile(
      mdFile,
      `# Random Document

## Chapter One
Some text here.

## Chapter Two
More text here.
`,
    )

    const result = await parseMarkdownFile(mdFile)
    // why should fallback to the first paragraph of the document
    expect(result.why).toContain('Some text here')
    expect(result.rules).toEqual([])
    expect(result.boundaries).toEqual([])
    expect(result.owner).toBeNull()
  })

  it('empty file → returns empty seed', async () => {
    const mdFile = path.join(tmpDir, 'empty.md')
    await fs.writeFile(mdFile, '')

    const result = await parseMarkdownFile(mdFile)
    expect(result.why).toBeNull()
    expect(result.rules).toEqual([])
    expect(result.boundaries).toEqual([])
    expect(result.owner).toBeNull()
  })

  // ──────────────────────────────────────────────────────────────
  // MALFORMED MARKDOWN
  // ──────────────────────────────────────────────────────────────

  it('malformed markdown → returns empty seed, does not throw', async () => {
    const mdFile = path.join(tmpDir, 'malformed.md')
    await fs.writeFile(
      mdFile,
      `######## Too many hashes
- orphan bullet
- another orphan
`,
    )

    const result = await parseMarkdownFile(mdFile)
    // Should not throw — just return best-effort
    expect(result).toBeDefined()
    expect(Array.isArray(result.rules)).toBe(true)
    expect(Array.isArray(result.boundaries)).toBe(true)
  })

  // ──────────────────────────────────────────────────────────────
  // ALTERNATIVE HEADING NAMES
  // ──────────────────────────────────────────────────────────────

  it('"Non-Negotiable" heading → correctly identified as rules section', async () => {
    const mdFile = path.join(tmpDir, 'alt-headings.md')
    await fs.writeFile(
      mdFile,
      `# Spec

## Non-Negotiable Requirements
- Must support offline mode
- Must encrypt all data at rest

## Exclusions
- No Windows support
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.rules).toHaveLength(2)
    expect(result.rules).toContain('Must support offline mode')
    expect(result.boundaries).toHaveLength(1)
    expect(result.boundaries).toContain('No Windows support')
  })

  it('"Constraints" heading → correctly identified as rules section', async () => {
    const mdFile = path.join(tmpDir, 'constraints.md')
    await fs.writeFile(
      mdFile,
      `# My App

## Constraints
- Max 100ms response time
- No external API calls
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.rules).toHaveLength(2)
  })

  it('"Maintainer" heading → correctly identified as owner section', async () => {
    const mdFile = path.join(tmpDir, 'maintainer.md')
    await fs.writeFile(
      mdFile,
      `# My App

## Maintainer
Alice Smith
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.owner).toBe('Alice Smith')
  })

  // ──────────────────────────────────────────────────────────────
  // .txt FILES
  // ──────────────────────────────────────────────────────────────

  it('.txt files are supported', async () => {
    const txtFile = path.join(tmpDir, 'spec.txt')
    await fs.writeFile(
      txtFile,
      `# Project Spec

## Overview
A simple utility tool.

## Rules
- Rule 1
- Rule 2
`,
    )

    const result = await parseMarkdownFile(txtFile)
    expect(result.why).toContain('utility tool')
    expect(result.rules).toHaveLength(2)
  })

  // ──────────────────────────────────────────────────────────────
  // ASTERISK BULLETS
  // ──────────────────────────────────────────────────────────────

  it('asterisk bullets (* item) are parsed correctly', async () => {
    const mdFile = path.join(tmpDir, 'asterisks.md')
    await fs.writeFile(
      mdFile,
      `# Spec

## Business Rules
* Star rule one
* Star rule two
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.rules).toHaveLength(2)
    expect(result.rules).toContain('Star rule one')
    expect(result.rules).toContain('Star rule two')
  })

  // ──────────────────────────────────────────────────────────────
  // WHY FALLBACK
  // ──────────────────────────────────────────────────────────────

  it('no overview heading → falls back to first paragraph', async () => {
    const mdFile = path.join(tmpDir, 'no-overview.md')
    await fs.writeFile(
      mdFile,
      `# My Cool Project

This is the first paragraph describing the project.

## Some Other Section
Details here.
`,
    )

    const result = await parseMarkdownFile(mdFile)
    expect(result.why).toContain('first paragraph describing')
  })
})
