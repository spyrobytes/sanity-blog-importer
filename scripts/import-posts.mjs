
/**
 * Helixbytes Sanity Importer (Headless Node CLI)
 *
 * Imports Markdown posts into Sanity according to your schemas:
 * - post:
 *   - title (required)
 *   - slug (required)
 *   - author (reference, required)
 *   - mainImage (required by your workflow; alt required)
 *   - publishedAt (required; defaults to now)
 *   - excerpt (optional)
 *   - body (Portable Text, with inline images converted to PT image blocks)
 *   - categories (optional string tags)
 *
 * - author:
 *   - name (required)
 *   - slug (required)
 *
 * Key properties:
 * - Dry-run by default (no writes unless --write)
 * - --check exits non-zero if any file fails validation/import preparation
 * - --only <slug> imports a single post (by computed/explicit slug)
 * - --draft creates draft documents instead of published ones
 *
 * Inline image support:
 * - Recognizes Markdown images:
 *     ![alt](path "caption")
 *     ![alt](<path with spaces> "caption")
 *   Caption is optional.
 * - Uploads the referenced image file to Sanity as an image asset
 * - Replaces the image with a Portable Text `image` block:
 *     { _type: "image", asset: { _type: "reference", _ref }, alt, caption }
 *
 * Styling preservation:
 * - We convert Markdown -> Portable Text, but replace image placeholders (tokens)
 *   in a way that preserves span marks and markDefs (bold/italic/links/code).
 */

import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { globSync } from "glob";
import matter from "gray-matter";
import mime from "mime";
import { createClient } from "@sanity/client";
import { markdownToPortableText } from "@portabletext/markdown";

// ------------------------------
// Env + CLI args
// ------------------------------
const {
  SANITY_PROJECT_ID,
  SANITY_DATASET,
  SANITY_TOKEN,
  SANITY_API_VERSION = "2025-12-14",
  POSTS_DIR = "./content/posts",
} = process.env;

if (!SANITY_PROJECT_ID || !SANITY_DATASET || !SANITY_TOKEN) {
  console.error("Missing env vars: SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN");
  process.exit(1);
}

const args = process.argv.slice(2);
const WRITE = args.includes("--write");
const CHECK = args.includes("--check");
const DRAFT = args.includes("--draft");
const onlyIdx = args.indexOf("--only");

// Validate --only argument: must have a value that isn't another flag
let ONLY = null;
if (onlyIdx >= 0) {
  const onlyValue = args[onlyIdx + 1];
  if (!onlyValue || onlyValue.startsWith("--")) {
    console.error("Error: --only requires a slug argument");
    console.error("Usage: node import-posts.mjs --only <slug>");
    process.exit(1);
  }
  ONLY = onlyValue;
}

const client = createClient({
  projectId: SANITY_PROJECT_ID,
  dataset: SANITY_DATASET,
  token: SANITY_TOKEN,
  apiVersion: SANITY_API_VERSION,
  useCdn: false,
});

// Valid image MIME types
const VALID_IMAGE_TYPES = new Set([
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
  "image/avif",
]);

// Track slugs across files to detect collisions
const slugToFile = new Map();

// ------------------------------
// Utilities
// ------------------------------

/**
 * Generate a unique key for Portable Text blocks/spans.
 * Sanity requires _key on all array items in Portable Text.
 */
function generateKey() {
  return crypto.randomBytes(6).toString("hex");
}

function slugify(input) {
  const slug = String(input || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

  if (!slug) {
    throw new Error(`Cannot generate valid slug from input: "${input}"`);
  }
  return slug;
}

/**
 * Resolve a path relative to the Markdown file location.
 * This makes `mainImage: "./assets/cover.png"` work reliably per file.
 */
function resolvePath(mdFilePath, maybeRelativePath) {
  if (!maybeRelativePath) return null;
  if (path.isAbsolute(maybeRelativePath)) return maybeRelativePath;
  return path.resolve(path.dirname(mdFilePath), maybeRelativePath);
}

/**
 * Validate that a file is an allowed image type.
 * Throws if the file is not a valid image.
 */
function validateImageType(absPath) {
  const contentType = mime.getType(absPath) || "application/octet-stream";
  if (!VALID_IMAGE_TYPES.has(contentType)) {
    throw new Error(
      `Invalid image type "${contentType}" for file: ${absPath}. ` +
      `Allowed types: ${[...VALID_IMAGE_TYPES].join(", ")}`
    );
  }
  return contentType;
}

/**
 * Generate document ID with optional draft prefix.
 * NOTE: Using dash separator, NOT dot. Dots are reserved for Sanity namespaces
 * (e.g., drafts.) and cause documents to be invisible via the public API.
 */
function makeDocumentId(type, slug) {
  const baseId = `${type}-${slug}`;
  return DRAFT ? `drafts.${baseId}` : baseId;
}

/**
 * Retry wrapper for async operations with exponential backoff.
 * Retries on transient network errors and server errors (5xx).
 */
async function withRetry(fn, { maxRetries = 3, baseDelay = 1000, context = "operation" } = {}) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const isRetryable =
        err.statusCode >= 500 ||
        err.code === "ECONNRESET" ||
        err.code === "ETIMEDOUT" ||
        err.code === "ENOTFOUND" ||
        err.code === "ECONNREFUSED" ||
        err.message?.includes("socket hang up");

      if (attempt === maxRetries || !isRetryable) {
        throw err;
      }

      const delay = baseDelay * Math.pow(2, attempt - 1);
      console.log(`  [retry] ${context}: attempt ${attempt + 1}/${maxRetries} in ${delay}ms...`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

/**
 * Read a file with descriptive error handling.
 * Wraps fs.readFileSync to provide better context on failure.
 */
function readFileWithContext(filePath, context, encoding = null) {
  try {
    return encoding ? fs.readFileSync(filePath, encoding) : fs.readFileSync(filePath);
  } catch (err) {
    const code = err.code || "UNKNOWN";
    const details = {
      ENOENT: "file not found",
      EACCES: "permission denied",
      EMFILE: "too many open files",
      EISDIR: "path is a directory",
    }[code] || err.message;
    throw new Error(`Failed to read ${context}: ${filePath} (${code}: ${details})`);
  }
}

// ------------------------------
// Image asset upload with dedupe
// ------------------------------

/**
 * Dedupe image uploads within a single run:
 * absPath -> assetId
 *
 * This avoids uploading the same file multiple times if:
 * - a post references the same image repeatedly, or
 * - multiple posts share the same asset (logo/diagram/etc.).
 */
const assetCache = new Map();

/**
 * Track in-flight upload promises to prevent race conditions.
 * Multiple concurrent calls for the same path will share a single upload.
 */
const uploadPromises = new Map();

/**
 * Upload a local image file into Sanity as an image asset.
 * Returns the asset document (at least contains _id).
 *
 * In dry-run mode, we do not upload; we return a synthetic id for continuity.
 *
 * Race condition protection: If an upload is already in progress for the same
 * path, returns the existing promise instead of starting a duplicate upload.
 */
async function uploadImageAsset(absPath) {
  // Check completed cache first
  if (assetCache.has(absPath)) {
    return { _id: assetCache.get(absPath) };
  }

  // Check for in-flight upload (race condition prevention)
  if (uploadPromises.has(absPath)) {
    return uploadPromises.get(absPath);
  }

  // Create the upload promise and track it
  const uploadPromise = (async () => {
    // Validate image type before reading
    const contentType = validateImageType(absPath);

    const buf = readFileWithContext(absPath, "image asset");
    const filename = path.basename(absPath);

    if (!WRITE) {
      // Dry-run: do not upload. Still cache a deterministic-ish id so repeated
      // references reuse the same fake asset id during this run.
      const fakeId = `dry.asset.${slugify(filename)}`;
      assetCache.set(absPath, fakeId);
      console.log(`  [dry] would upload image asset: ${path.basename(absPath)}`);
      return { _id: fakeId };
    }

    const asset = await withRetry(
      () => client.assets.upload("image", buf, { filename, contentType }),
      { context: `upload ${filename}` }
    );
    assetCache.set(absPath, asset._id);
    console.log(`  [upload] ${path.basename(absPath)} -> ${asset._id}`);
    return asset; // includes _id
  })();

  uploadPromises.set(absPath, uploadPromise);

  try {
    return await uploadPromise;
  } finally {
    // Clean up the in-flight tracker once complete (success or failure)
    uploadPromises.delete(absPath);
  }
}

// ------------------------------
// Author ensure
// ------------------------------

/**
 * Ensure an author reference exists:
 * - If `authorId` provided: verify it exists and return it.
 * - Else use `author` name: find author by name; create if missing.
 *
 * NOTE: author name matching is exact; keep naming consistent in your frontmatter.
 */
async function ensureAuthor({ authorId, author }) {
  if (authorId) {
    const exists = await withRetry(
      () => client.fetch(`*[_id==$id][0]{_id}`, { id: authorId }),
      { context: `fetch author ${authorId}` }
    );
    if (!exists?._id) throw new Error(`authorId not found: ${authorId}`);
    return authorId;
  }

  if (!author) throw new Error("Frontmatter must include 'author' (name) or 'authorId'.");

  const existing = await withRetry(
    () => client.fetch(`*[_type=="author" && name==$name][0]{_id}`, { name: author }),
    { context: `fetch author by name "${author}"` }
  );
  if (existing?._id) return existing._id;

  const s = slugify(author);
  const id = makeDocumentId("author", s);

  if (!WRITE) {
    console.log(`  [dry] would create author: ${author} -> ${id}`);
    return id;
  }

  await withRetry(
    () => client.createIfNotExists({
      _id: id,
      _type: "author",
      name: author,
      slug: { _type: "slug", current: s },
    }),
    { context: `create author "${author}"` }
  );

  console.log(`  [create] author: ${author} -> ${id}`);
  return id;
}

// ------------------------------
// Validation
// ------------------------------

/**
 * Validate required frontmatter fields for your workflow and schemas.
 * Throws on invalid input.
 */
function validateFrontmatter(fm, file) {
  const errors = [];

  if (!fm.title) errors.push("missing 'title'");
  if (!fm.author && !fm.authorId) errors.push("missing 'author' or 'authorId'");
  if (!fm.mainImage) errors.push("missing 'mainImage'");
  if (!fm.mainImageAlt) errors.push("missing 'mainImageAlt'");

  // If publishedAt is provided, enforce it's parseable as a date.
  if (fm.publishedAt) {
    const parsed = Date.parse(fm.publishedAt);
    if (Number.isNaN(parsed)) {
      errors.push(`invalid 'publishedAt' date: ${fm.publishedAt}`);
    }
  }

  if (errors.length > 0) {
    throw new Error(`Frontmatter validation failed in ${file}: ${errors.join(", ")}`);
  }
}

/**
 * Check for slug collisions across files.
 * Returns true if collision detected, false otherwise.
 */
function checkSlugCollision(slug, currentFile) {
  if (slugToFile.has(slug)) {
    const existingFile = slugToFile.get(slug);
    if (existingFile !== currentFile) {
      console.warn(
        `  [warn] Slug collision: "${slug}" used by both:\n` +
        `         - ${existingFile}\n` +
        `         - ${currentFile}\n` +
        `         The second file will overwrite the first!`
      );
      return true;
    }
  }
  slugToFile.set(slug, currentFile);
  return false;
}

// ------------------------------
// Inline image extraction + token replacement (format-preserving)
// ------------------------------

/**
 * Extract markdown images and replace them with unique tokens so we can:
 * 1) convert markdown -> Portable Text
 * 2) upload images
 * 3) replace token blocks/spans with PT `image` blocks
 *
 * Supported forms:
 *   ![alt](path "caption")
 *   ![alt](<path with spaces> "caption")
 *
 * NOTE: This is intentionally "good enough" without a full markdown parser.
 */
function extractInlineImages(markdown) {
  const images = [];

  // Regex supports:
  // - alt text: [....]
  // - src: either <...> (allows spaces) OR a plain token without spaces
  // - optional title/caption: "..."
  //
  // Examples:
  //   ![Alt](./img.png)
  //   ![Alt](./img.png "Caption")
  //   ![Alt](</path with spaces/img.png> "Caption")
  const IMG_RE = /!\[([^\]]*)\]\(\s*(?:<([^>]+)>|([^\s)]+))\s*(?:"([^"]+)")?\s*\)/g;

  const rewrittenMarkdown = markdown.replace(IMG_RE, (_, alt, angleSrc, plainSrc, caption) => {
    const token = `[[[SANITY_IMAGE_${images.length}]]]`;
    const src = (angleSrc || plainSrc || "").trim();

    images.push({
      token,
      alt: (alt || "").trim(),
      src,
      caption: (caption || "").trim(),
    });

    // Put token on its own paragraph so markdown->PT likely yields a clean token-only block.
    // If it still ends up embedded, we have a safe "split while preserving marks" fallback.
    return `\n\n${token}\n\n`;
  });

  return { rewrittenMarkdown, images };
}

/**
 * True if the Portable Text block is just the token text (ignoring whitespace).
 * If so, we can safely replace the entire block with an image block.
 */
function isTokenOnlyBlock(block, token) {
  if (block?._type !== "block" || !Array.isArray(block.children)) return false;

  const text = block.children
    .filter((c) => c && c._type === "span")
    .map((c) => (typeof c.text === "string" ? c.text : ""))
    .join("");

  return text.trim() === token;
}

/**
 * Detect tokens in the *concatenated* span text of the block.
 * This is more robust than checking each span individually because
 * the converter could (rarely) split token text across spans.
 */
function blockContainsAnyToken(block, tokens) {
  if (block?._type !== "block" || !Array.isArray(block.children)) return false;

  const full = block.children
    .filter((c) => c && c._type === "span" && typeof c.text === "string")
    .map((c) => c.text)
    .join("");

  return tokens.some((t) => full.includes(t));
}

/**
 * Return true if a Portable Text block contains meaningful content.
 * This prevents accidental dropping of blocks that have non-span children
 * (rare, but possible depending on conversion output).
 */
function hasMeaningfulChildren(block) {
  if (!block || !Array.isArray(block.children)) return false;

  return block.children.some((c) => {
    if (!c) return false;
    if (c._type !== "span") return true; // non-span child: keep
    if (typeof c.text !== "string") return false;
    return c.text.trim().length > 0;
  });
}

/**
 * Split a single PT text block by inserting image blocks wherever tokens occur,
 * while preserving:
 * - span marks (bold/italic/code/link keys)
 * - markDefs (link definitions)
 *
 * Result is a sequence: [block?, image, block?, image, ...]
 * Each block is a normal PT "block" with children spans.
 */
function splitBlockByTokensPreserveMarks(block, tokens, tokenToImageBlock) {
  const out = [];

  // We'll rebuild paragraphs as we go.
  let current = {
    _key: generateKey(),
    _type: "block",
    style: block.style || "normal",
    markDefs: Array.isArray(block.markDefs) ? block.markDefs : [],
    children: [],
  };

  function flushCurrent() {
    // Push only if it has meaningful content (text or non-span children).
    if (hasMeaningfulChildren(current)) out.push(current);

    current = {
      _key: generateKey(),
      _type: "block",
      style: block.style || "normal",
      markDefs: Array.isArray(block.markDefs) ? block.markDefs : [],
      children: [],
    };
  }

  for (const child of block.children) {
    if (!child || child._type !== "span" || typeof child.text !== "string") {
      // Conservatively keep non-span children inside the current block.
      // Ensure child has a key
      const childWithKey = child._key ? child : { ...child, _key: generateKey() };
      current.children.push(childWithKey);
      continue;
    }

    let text = child.text;

    // Repeatedly split this span until it contains no tokens.
    while (true) {
      let nearestToken = null;
      let nearestIdx = Infinity;

      for (const t of tokens) {
        const idx = text.indexOf(t);
        if (idx !== -1 && idx < nearestIdx) {
          nearestIdx = idx;
          nearestToken = t;
        }
      }

      // No tokens in this span chunk => append remainder and move on.
      if (!nearestToken) {
        if (text.length > 0) {
          current.children.push({ ...child, _key: generateKey(), text });
        }
        break;
      }

      // Split into: before token, (token => image), after token
      const before = text.slice(0, nearestIdx);
      const after = text.slice(nearestIdx + nearestToken.length);

      if (before.length > 0) {
        current.children.push({ ...child, _key: generateKey(), text: before });
      }

      // Emit current paragraph (if any), then the image block
      flushCurrent();
      out.push({ ...tokenToImageBlock[nearestToken], _key: generateKey() });

      // Continue with "after" in a new paragraph, preserving marks
      text = after;
    }
  }

  flushCurrent();
  return out;
}

/**
 * Replace tokens inside Portable Text blocks with image blocks while preserving formatting.
 *
 * Strategy:
 * - If block is token-only: replace whole block with image block.
 * - Else if block contains token: split the block preserving marks.
 * - Else: keep block unchanged.
 */
function replaceTokensWithImageBlocksPreserveMarks(ptBlocks, tokenToImageBlock) {
  const tokens = Object.keys(tokenToImageBlock);
  const out = [];

  for (const block of ptBlocks) {
    if (block?._type !== "block") {
      // Non-block items (shouldn't happen often) - ensure they have keys
      const blockWithKey = block._key ? block : { ...block, _key: generateKey() };
      out.push(blockWithKey);
      continue;
    }

    const tokenOnly = tokens.find((t) => isTokenOnlyBlock(block, t));
    if (tokenOnly) {
      // Replace entire block with image block (with key)
      out.push({ ...tokenToImageBlock[tokenOnly], _key: generateKey() });
      continue;
    }

    if (blockContainsAnyToken(block, tokens)) {
      out.push(...splitBlockByTokensPreserveMarks(block, tokens, tokenToImageBlock));
      continue;
    }

    out.push(block);
  }

  return out;
}

/**
 * Ensure all blocks and their children have _key properties.
 * This is required by Sanity for Portable Text arrays.
 */
function ensureKeys(ptBlocks) {
  return ptBlocks.map((block) => {
    const blockWithKey = block._key ? block : { ...block, _key: generateKey() };

    // If block has children (spans), ensure they have keys too
    if (Array.isArray(blockWithKey.children)) {
      blockWithKey.children = blockWithKey.children.map((child) => {
        return child._key ? child : { ...child, _key: generateKey() };
      });
    }

    return blockWithKey;
  });
}

/**
 * Block types to filter out during conversion.
 * These are valid Portable Text but may not be in the target Sanity schema.
 */
const UNSUPPORTED_BLOCK_TYPES = new Set(["horizontal-rule"]);

/**
 * Filter out block types that aren't supported by the target Sanity schema.
 */
function filterUnsupportedBlocks(ptBlocks) {
  return ptBlocks.filter((block) => {
    if (UNSUPPORTED_BLOCK_TYPES.has(block?._type)) {
      return false;
    }
    return true;
  });
}

/**
 * Convert Markdown -> Portable Text, uploading inline images and replacing them with
 * Portable Text `image` blocks (alt/caption preserved), while preserving text formatting.
 */
async function markdownToPortableTextWithInlineImages(mdFilePath, markdown) {
  const { rewrittenMarkdown, images } = extractInlineImages(markdown);

  // Convert to portable text first (tokens become literal text spans/blocks).
  let pt = markdownToPortableText(rewrittenMarkdown);

  // Ensure all blocks have keys
  pt = ensureKeys(pt);

  // Filter out unsupported block types (e.g., horizontal-rule)
  pt = filterUnsupportedBlocks(pt);

  if (images.length === 0) return pt;

  // Validate and resolve all image paths first
  const imageData = images.map((img) => {
    const absPath = resolvePath(mdFilePath, img.src);
    if (!absPath || !fs.existsSync(absPath)) {
      throw new Error(`Inline image not found: ${img.src} (resolved: ${absPath})`);
    }
    return { ...img, absPath };
  });

  // Upload images in parallel for better performance
  const uploadResults = await Promise.all(
    imageData.map(async (img) => {
      const asset = await uploadImageAsset(img.absPath);
      return { token: img.token, asset, alt: img.alt, caption: img.caption };
    })
  );

  // Build token -> PT image block mapping
  const tokenToImageBlock = {};
  for (const { token, asset, alt, caption } of uploadResults) {
    tokenToImageBlock[token] = {
      _type: "image",
      asset: { _type: "reference", _ref: asset._id },
      alt: alt || "Image",
      caption: caption || "",
    };
  }

  // Replace tokens with image blocks and ensure all blocks have keys
  const result = replaceTokensWithImageBlocksPreserveMarks(pt, tokenToImageBlock);
  return filterUnsupportedBlocks(ensureKeys(result));
}

// ------------------------------
// Import per file
// ------------------------------

async function importFile(mdFilePath, index, total) {
  const filename = path.basename(mdFilePath);
  console.log(`\n[${index + 1}/${total}] ${filename}`);

  const raw = readFileWithContext(mdFilePath, "markdown post", "utf8");
  const { data: fm, content } = matter(raw);

  validateFrontmatter(fm, mdFilePath);

  const title = fm.title;
  const slug = fm.slug || slugify(title);

  // Check for slug collisions
  checkSlugCollision(slug, mdFilePath);

  // publishedAt required by schema; default to now if omitted
  const publishedAt = fm.publishedAt || new Date().toISOString();

  const excerpt = fm.excerpt || null;

  // Normalize categories to an array of strings
  const categories = Array.isArray(fm.categories) ? fm.categories.map(String) : [];

  if (ONLY && slug !== ONLY) {
    console.log(`  [skip] slug "${slug}" does not match --only "${ONLY}"`);
    return { skipped: true };
  }

  // Author reference (required by schema)
  const authorRef = await ensureAuthor({ authorId: fm.authorId, author: fm.author });

  // Cover image (required by your workflow)
  const absCover = resolvePath(mdFilePath, fm.mainImage);
  if (!absCover || !fs.existsSync(absCover)) {
    throw new Error(`mainImage file not found: ${fm.mainImage} (resolved: ${absCover})`);
  }

  const coverAsset = await uploadImageAsset(absCover);

  const mainImage = {
    _type: "image",
    asset: { _type: "reference", _ref: coverAsset._id },
    alt: String(fm.mainImageAlt),
  };

  // Body Portable Text with inline images
  const body = await markdownToPortableTextWithInlineImages(mdFilePath, content);

  // Deterministic ID for idempotency: re-running updates the same post
  const docId = makeDocumentId("post", slug);
  const doc = {
    _id: docId,
    _type: "post",
    title,
    slug: { _type: "slug", current: slug },
    author: { _type: "reference", _ref: authorRef },
    mainImage,
    publishedAt,
    excerpt,
    body,
    categories,
  };

  if (!WRITE) {
    console.log(`  [dry] would upsert: ${docId}`);
    return { dry: true, slug };
  }

  await withRetry(
    () => client.createOrReplace(doc),
    { context: `upsert post "${slug}"` }
  );
  console.log(`  [ok] upserted: ${docId}`);
  return { slug };
}

// ------------------------------
// Main
// ------------------------------

async function main() {
  console.log("Helixbytes Blog Importer");
  console.log("========================");
  console.log(`Mode: ${WRITE ? "WRITE" : "DRY-RUN"}${DRAFT ? " (drafts)" : ""}`);
  console.log(`Posts directory: ${POSTS_DIR}`);
  console.log(`Dataset: ${SANITY_DATASET}`);
  if (ONLY) console.log(`Filter: --only ${ONLY}`);

  const files = globSync(path.join(POSTS_DIR, "**/*.md"));
  if (!files.length) {
    console.log(`\nNo markdown files found in ${POSTS_DIR}`);
    return;
  }

  console.log(`Found ${files.length} markdown file(s)`);

  let ok = 0;
  let fail = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    try {
      const res = await importFile(f, i, files.length);
      if (res?.skipped) skipped++;
      else ok++;
    } catch (e) {
      fail++;
      console.error(`  [error] ${e.message}`);
      // In --check mode, keep scanning all files and then exit non-zero at end.
      if (CHECK) continue;
    }
  }

  console.log("\n------------------------");
  console.log("Summary:");
  console.log(`  Success: ${ok}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Failed:  ${fail}`);
  console.log(`  Mode:    ${WRITE ? "WRITE" : "DRY-RUN"}${DRAFT ? " (drafts)" : ""}`);

  if (CHECK && fail > 0) process.exit(2);
}

main().catch((e) => {
  console.error("\nFatal error:", e.message);
  process.exit(1);
});
