# Helixbytes Blog Importer (Headless Sanity CLI)

A **headless Node.js CLI** for importing Markdown blog posts into **Sanity CMS**, designed for:

- Zero frontend UI
- No secrets in the browser
- Deterministic, repeatable imports
- Strong formatting preservation (bold, italics, links, code)
- First-class image handling (cover + inline images)

This tool converts Markdown files into **Sanity Portable Text**, uploads required images as assets, and creates/updates documents according to the Helixbytes blog schemas.

---

## Why this exists

Sanity Studio is great for editing, but it's not ideal for:

- bulk Markdown migrations
- version-controlled content
- authoring outside the Studio UI
- automated / CI-driven publishing

This CLI lets you treat Markdown as the **source of truth**, while Sanity remains the structured CMS backend for your Next.js site.

---

## Features

- Dry-run by default (safe)
- Explicit `--write` flag to mutate Sanity
- `--draft` flag to create draft documents
- Required cover image enforcement
- Inline Markdown images -> Portable Text image blocks
- Preserves text styling (bold, italic, links, code)
- Idempotent imports (`post.<slug>` IDs)
- Author auto-creation (with required slug)
- `--check` mode for validation / CI
- `--only <slug>` for targeted imports
- Slug collision detection
- Image type validation
- Parallel image uploads for performance
- Progress indicator for batch imports

---

## Project structure

```
hlyx-blog-cli/
  content/
    posts/
      my-first-post.md
      another-post.md
    assets/
      cover.png
      diagram.png
  scripts/
    import-posts.mjs
  .env.example
  package.json
  README.md
```

---

## Installation

```bash
npm install
```

### Required dependencies

Already listed in `package.json`:

- `@sanity/client`
- `@portabletext/markdown`
- `gray-matter`
- `mime`
- `glob`
- `dotenv`

---

## Environment variables

Create a `.env` file (never commit this):

```bash
SANITY_PROJECT_ID=xxxx
SANITY_DATASET=production
SANITY_TOKEN=your_write_token
SANITY_API_VERSION=2024-01-01
POSTS_DIR=./content/posts
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `SANITY_PROJECT_ID` | Yes | - | Your Sanity project ID |
| `SANITY_DATASET` | Yes | - | Target dataset (e.g., "production") |
| `SANITY_TOKEN` | Yes | - | Sanity write token |
| `SANITY_API_VERSION` | No | `2024-01-01` | Sanity API version |
| `POSTS_DIR` | No | `./content/posts` | Directory containing Markdown files |

> **Important**: This tool requires a **Sanity write token**.
> It must never be used in browser-based tooling.

---

## Markdown frontmatter contract

Every post **must** include a cover image.

### Minimal example

```md
---
title: "My First Helixbytes Post"
author: "Doc Spinard"
mainImage: "../assets/cover.png"
mainImageAlt: "Cover image showing cloud architecture"
publishedAt: "2025-01-15T10:00:00Z"
excerpt: "A tiny starter post to prove the pipeline works."
categories:
  - Next.js
  - Firebase

---

This is **bold text**, a [link](https://example.com),
and an inline image:

![Diagram](../assets/diagram.png "High-level flow")

More content here.
```

### Required fields

| Field | Required | Notes |
|-------|----------|-------|
| `title` | Yes | Used for slug if none provided |
| `author` or `authorId` | Yes | Author auto-created if missing |
| `mainImage` | Yes | Local path, relative to file |
| `mainImageAlt` | Yes | Required for accessibility/SEO |

### Optional fields

- `slug` - explicit URL slug (auto-generated from title if omitted)
- `publishedAt` - ISO timestamp (defaults to now)
- `excerpt` - short summary
- `categories` - array of strings

---

## Image handling

### Cover image

- Uploaded as `post.mainImage`
- `alt` text enforced

### Inline images

Markdown syntax supported:

```md
![Alt text](./path/to/image.png "Optional caption")
![Alt](</path with spaces/image.png>)
```

Converted into Portable Text:

```js
{
  _type: "image",
  asset: { _type: "reference", _ref },
  alt,
  caption
}
```

### Supported image types

- JPEG (`image/jpeg`)
- PNG (`image/png`)
- GIF (`image/gif`)
- WebP (`image/webp`)
- SVG (`image/svg+xml`)
- AVIF (`image/avif`)

### Asset deduplication

Images are deduplicated **within a single run** to avoid repeated uploads.

---

## Usage

### Dry-run (default, safe)

```bash
npm run import
```

Outputs what **would** be imported without touching Sanity.

### Write to Sanity

```bash
npm run import -- --write
```

Creates/updates:

- `post.<slug>` documents
- `author.<slug>` documents (if missing)
- image assets

### Create drafts instead of published documents

```bash
npm run import -- --write --draft
```

Creates documents with `drafts.` prefix (e.g., `drafts.post.my-post`).

### Validate only (CI-friendly)

```bash
npm run check
```

- Parses all Markdown
- Validates required fields and file paths
- Detects slug collisions
- Exits non-zero on failure
- Does **not** write anything

### Import a single post

```bash
npm run import -- --only my-post-slug
```

Useful for quick iteration while authoring.

---

## CLI flags

| Flag | Description |
|------|-------------|
| `--write` | Actually write to Sanity (default is dry-run) |
| `--draft` | Create draft documents instead of published |
| `--check` | Validation-only mode, exits non-zero on failure |
| `--only <slug>` | Import only the post with matching slug |

---

## Package.json scripts

```json
{
  "scripts": {
    "import": "node scripts/import-posts.mjs",
    "check": "node scripts/import-posts.mjs --check"
  }
}
```

---

## Safety guarantees

- No UI, no browser execution
- Secrets loaded only via `.env`
- Dry-run by default
- Deterministic IDs prevent duplication
- Formatting preserved across image boundaries
- Image type validation prevents invalid uploads
- Slug collision warnings

---

## Example output

```
Helixbytes Blog Importer
========================
Mode: DRY-RUN
Posts directory: ./content/posts
Dataset: production
Found 3 markdown file(s)

[1/3] hello-world.md
  [dry] would upload image asset: cover.jpg
  [dry] would create author: Doc Spinard -> author.doc-spinard
  [dry] would upsert: post.hello-world

[2/3] getting-started.md
  [dry] would upload image asset: intro.png
  [dry] would upsert: post.getting-started

[3/3] advanced-topics.md
  [dry] would upload image asset: diagram.png
  [dry] would upsert: post.advanced-topics

------------------------
Summary:
  Success: 3
  Skipped: 0
  Failed:  0
  Mode:    DRY-RUN
```

---

## Known limitations (by design)

- No support for reference-style Markdown images
- No support for tables / custom shortcodes
- Author name matching is case-sensitive
- Dataset switching via CLI not implemented (env-based)

These can be added incrementally if needed.

---

## Recommended authoring rules

To ensure best formatting fidelity:

- Put images on their own line when possible
- Avoid exotic Markdown extensions
- Keep filenames stable (for idempotency)
- Use consistent author names across posts

---

## Typical workflow

1. Write/edit Markdown in `content/posts/`
2. Run `npm run import` (dry-run)
3. Fix validation errors if any
4. Run `npm run import -- --write`
5. Rebuild/deploy Next.js site

---

## CI/CD integration

Add to your GitHub Actions workflow:

```yaml
- name: Validate blog posts
  run: npm run check
  env:
    SANITY_PROJECT_ID: ${{ secrets.SANITY_PROJECT_ID }}
    SANITY_DATASET: production
    SANITY_TOKEN: ${{ secrets.SANITY_TOKEN }}
```

---

## Troubleshooting

| Error | Solution |
|-------|----------|
| `Missing env vars` | Ensure `.env` file exists with all required variables |
| `mainImage file not found` | Check the path is relative to the markdown file |
| `Invalid image type` | Use supported formats: JPEG, PNG, GIF, WebP, SVG, AVIF |
| `authorId not found` | Verify the author document exists in Sanity |
| `Slug collision` | Two posts have the same title/slug - add explicit `slug` to one |

---

## License / usage

Internal tooling for Helixbytes Digital Solutions.
Adapt freely within the organization.
